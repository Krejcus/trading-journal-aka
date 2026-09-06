import { del, get, set, update } from 'idb-keyval';
import { supabase } from './supabase';
import { getUserId } from './storageService';
import { createBacktestRuntime } from './backtestEngine';
import {
  DEFAULT_BACKTEST_CONFIG,
  type BacktestFill,
  type BacktestOrder,
  type BacktestRun,
  type BacktestRunConfig,
  type BacktestRuntimeState,
  type BacktestWorkspaceState,
} from './backtestTypes';

const LEGACY_INDEX_KEY = 'alphatrade:backtest-runs:index:v1';
const legacyRunKey = (id: string) => `alphatrade:backtest-run:${id}:v1`;
const indexKey = (userId: string) => `alphatrade:backtest-runs:${userId}:index:v2`;
const runKey = (userId: string, id: string) => `alphatrade:backtest-run:${userId}:${id}:v2`;

interface RunPersistence { userId: string; cloudRevision: number | null }
type StoredRun = BacktestRun & { persistence: RunPersistence };
const persistenceOf = (run: BacktestRun): RunPersistence | undefined => (run as StoredRun).persistence;
export const getBacktestCloudRevision = (run: BacktestRun): number | null => persistenceOf(run)?.cloudRevision ?? null;
export const getBacktestRunOwnerId = (run: BacktestRun): string | null => persistenceOf(run)?.userId ?? null;
const withPersistence = (run: BacktestRun, userId: string, cloudRevision: number | null): StoredRun => ({
  ...run, persistence: { userId, cloudRevision },
});
/** Carry the confirmed cloud base across local edits captured while a request
 * was in flight. The caller retains the newest runtime/workspace content. */
export const withBacktestCloudRevision = (run: BacktestRun, cloudRevision: number | null): BacktestRun => {
  const persistence = persistenceOf(run);
  if (!persistence) throw new Error('Session nemá ověřeného vlastníka. Otevři ji znovu ze seznamu sessions.');
  return withPersistence(run, persistence.userId, cloudRevision);
};

export class BacktestRunSyncError extends Error {
  constructor(message: string, public readonly confirmedRun: BacktestRun) {
    super(message);
    this.name = 'BacktestRunSyncError';
  }
}

export class BacktestRunConflictError extends Error {
  constructor(public readonly runId: string) {
    super('Session se v cloudu změnila nebo byla odstraněna. Lokální postup je zachovaný; otevři aktuální session a vyřeš konflikt před dalším ukládáním.');
    this.name = 'BacktestRunConflictError';
  }
}

const requireUser = async (run?: BacktestRun): Promise<string> => {
  const userId = await getUserId();
  if (!userId) throw new Error('Pro uložení backtestu se přihlas. Lokální postup zůstává zachovaný.');
  if (run && persistenceOf(run)?.userId !== userId) throw new Error('Tato session nepatří aktuálně přihlášenému uživateli. Otevři ji znovu ze seznamu sessions.');
  return userId;
};

const clone = <T,>(value: T): T => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value)) as T;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  return item;
});

const localIds = async (userId: string): Promise<string[]> => (await get<string[]>(indexKey(userId))) ?? [];

const saveLocal = async (run: StoredRun) => {
  const { userId } = run.persistence;
  // Persist the blob before publishing its ID; update() serializes index changes
  // in one IndexedDB transaction, including concurrent cloud hydration/tabs.
  await update<StoredRun>(runKey(userId, run.id), previous => {
    if (previous && (previous.revision > run.revision
      || (previous.revision === run.revision && previous.updatedAt > run.updatedAt))) return previous;
    return clone(run);
  });
  await update<string[]>(indexKey(userId), ids => ids?.includes(run.id) ? ids : [run.id, ...(ids ?? [])]);
};

const removeLocal = async (userId: string, id: string) => {
  await update<string[]>(indexKey(userId), ids => (ids ?? []).filter(value => value !== id));
  await del(runKey(userId, id));
};

const readLocal = async (userId: string): Promise<StoredRun[]> => (
  await Promise.all((await localIds(userId)).map(id => get<StoredRun>(runKey(userId, id))))
).filter((run): run is StoredRun => Boolean(run && run.persistence?.userId === userId));

/** Old blobs have no owner. Keep them untouched and hidden until a server row
 * or an owned account proves ownership; an offline guess could leak user A to B. */
const migrateOwnedLegacy = async (userId: string, cloud: BacktestRun[]): Promise<void> => {
  const legacy = (await Promise.all(((await get<string[]>(LEGACY_INDEX_KEY)) ?? [])
    .map(id => get<BacktestRun>(legacyRunKey(id)))))
    .filter((run): run is BacktestRun => Boolean(run));
  if (!legacy.length) return;
  const cloudById = new Map(cloud.map(run => [run.id, run]));
  const accountIds = [...new Set(legacy.filter(run => !cloudById.has(run.id)).map(run => run.accountId).filter(Boolean))];
  const ownedAccounts = new Set<string>();
  if (accountIds.length) {
    const { data, error } = await supabase.from('accounts').select('id').eq('user_id', userId).in('id', accountIds);
    if (!error) (data ?? []).forEach(row => ownedAccounts.add(row.id));
  }
  for (const run of legacy) {
    const remote = cloudById.get(run.id);
    if (!remote && !ownedAccounts.has(run.accountId)) continue;
    if (await get(runKey(userId, run.id))) continue;
    // A legacy local-ahead snapshot has no trustworthy cloud base. Use its
    // own revision so a divergent remote row conflicts instead of being erased.
    await saveLocal(withPersistence(run, userId, run.revision));
  }
};

const fromDb = (row: any): BacktestRun => ({
  id: row.id,
  accountId: row.account_id,
  name: row.name,
  status: row.status,
  initialCapital: Number(row.initial_capital),
  baseCurrency: row.base_currency,
  startAt: new Date(row.start_at).getTime(),
  endAt: new Date(row.end_at).getTime(),
  executionSymbol: row.execution_symbol,
  replayInterval: row.replay_interval,
  cursorAt: row.cursor_at ? new Date(row.cursor_at).getTime() : null,
  config: { ...DEFAULT_BACKTEST_CONFIG, ...(row.config ?? {}) },
  workspaceState: row.workspace_state ?? {},
  runtimeState: row.runtime_state ?? createBacktestRuntime(Number(row.initial_capital)),
  revision: Number(row.revision ?? 0),
  schemaVersion: Number(row.schema_version ?? 1),
  createdAt: new Date(row.created_at).getTime(),
  updatedAt: new Date(row.updated_at).getTime(),
  lastOpenedAt: new Date(row.last_opened_at).getTime(),
});

const toDb = (run: BacktestRun, userId: string) => ({
  id: run.id,
  user_id: userId,
  account_id: run.accountId,
  name: run.name,
  status: run.status,
  initial_capital: run.initialCapital,
  base_currency: run.baseCurrency,
  start_at: new Date(run.startAt).toISOString(),
  end_at: new Date(run.endAt).toISOString(),
  execution_symbol: run.executionSymbol,
  replay_interval: run.replayInterval,
  cursor_at: run.cursorAt ? new Date(run.cursorAt).toISOString() : null,
  config: run.config,
  workspace_state: run.workspaceState,
  runtime_state: run.runtimeState,
  revision: run.revision,
  schema_version: run.schemaVersion,
  last_opened_at: new Date(run.lastOpenedAt).toISOString(),
  created_at: new Date(run.createdAt).toISOString(),
  updated_at: new Date(run.updatedAt).toISOString(),
});

const orderToDb = (order: BacktestOrder, userId: string) => ({
  id: order.id, run_id: order.runId, user_id: userId, instrument: order.instrument,
  side: order.side, order_type: order.type, status: order.status, quantity: order.quantity,
  remaining_quantity: order.remainingQuantity, limit_price: order.limitPrice ?? null,
  stop_price: order.stopPrice ?? null, stop_loss: order.stopLoss ?? null,
  take_profit: order.takeProfit ?? null, reduce_only: order.reduceOnly ?? false,
  filled_at: order.filledAt ? new Date(order.filledAt * 1_000).toISOString() : null,
  cancelled_at: order.cancelledAt ? new Date(order.cancelledAt * 1_000).toISOString() : null,
  created_at: new Date(order.createdAt * 1_000).toISOString(),
  updated_at: new Date(order.updatedAt * 1_000).toISOString(),
});

const fillToDb = (fill: BacktestFill, userId: string) => ({
  id: fill.id, run_id: fill.runId, order_id: fill.orderId ?? null, user_id: userId,
  instrument: fill.instrument, side: fill.side, quantity: fill.quantity, price: fill.price,
  commission: fill.commission, realized_pnl: fill.realizedPnl, reason: fill.reason,
  filled_at: new Date(fill.filledAt * 1_000).toISOString(),
});

const cloudError = (error: unknown): Error => new Error(`Backtest se nepodařilo uložit do cloudu; lokální kopie zůstává zachovaná. ${String((error as { message?: string })?.message ?? error)}`);

/**
 * Kurzor přírůstkového ledgeru: co už cloud jednou přijal, znovu neposíláme.
 * Fills jsou neměnné (stačí id), orders se mění — pamatujeme si `updatedAt`,
 * pod kterým byl řádek naposledy synchronizovaný. Kurzor drží workspace po
 * dobu otevřené session; po chybě se prostě neposune a další pokus pošle
 * tytéž řádky znovu (upsert je idempotentní).
 */
export interface BacktestLedgerCursor {
  fillIds: Set<string>;
  orderStamps: Map<string, string>;
}

export const createBacktestLedgerCursor = (): BacktestLedgerCursor => ({
  fillIds: new Set(),
  orderStamps: new Map(),
});

const syncLedger = async (run: BacktestRun, userId: string, cursor?: BacktestLedgerCursor) => {
  const orders = run.runtimeState.orders
    .filter(order => cursor?.orderStamps.get(order.id) !== JSON.stringify(orderToDb(order, userId)));
  if (orders.length) {
    const { error } = await supabase.from('backtest_orders').upsert(orders.map(order => orderToDb(order, userId)));
    if (error) throw cloudError(error);
    if (cursor) orders.forEach(order => cursor.orderStamps.set(order.id, JSON.stringify(orderToDb(order, userId))));
  }
  const fills = run.runtimeState.fills.filter(fill => !cursor?.fillIds.has(fill.id));
  if (fills.length) {
    const { error } = await supabase.from('backtest_fills').upsert(
      fills.map(fill => fillToDb(fill, userId)),
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (error) throw cloudError(error);
    if (!error && cursor) fills.forEach(fill => cursor.fillIds.add(fill.id));
  }
};

export interface CreateBacktestRunInput {
  accountId: string;
  name: string;
  initialCapital: number;
  startAt: number;
  endAt: number;
  config?: Partial<BacktestRunConfig>;
  workspaceState?: BacktestWorkspaceState;
}

export const createBacktestRun = async (input: CreateBacktestRunInput): Promise<BacktestRun> => {
  const userId = await requireUser();
  if (!input.name.trim() || input.name.length > 120) throw new Error('Název session musí mít 1–120 znaků.');
  const now = Date.now();
  const config: BacktestRunConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...input.config,
    commissionPerSide: { ...DEFAULT_BACKTEST_CONFIG.commissionPerSide, ...input.config?.commissionPerSide },
    slippageTicks: { ...DEFAULT_BACKTEST_CONFIG.slippageTicks, ...input.config?.slippageTicks },
  };
  const run: StoredRun = {
    id: crypto.randomUUID(), accountId: input.accountId, name: input.name, status: 'active',
    initialCapital: input.initialCapital, baseCurrency: 'USD', startAt: input.startAt,
    endAt: input.endAt, executionSymbol: config.executionInstrument, replayInterval: '1m',
    cursorAt: null, config, workspaceState: clone(input.workspaceState ?? {}), runtimeState: createBacktestRuntime(input.initialCapital),
    revision: 0, schemaVersion: 1, createdAt: now, updatedAt: now, lastOpenedAt: now,
    persistence: { userId, cloudRevision: null },
  };
  await saveLocal(run);
  const { data, error } = await supabase.from('backtest_runs').insert(toDb(run, userId)).select().single();
  if (error || !data) throw cloudError(error ?? 'Server nevrátil uloženou session.');
  const saved = withPersistence(fromDb(data), userId, Number(data.revision));
  await saveLocal(saved);
  return saved;
};

export const listBacktestRuns = async (): Promise<BacktestRun[]> => {
  const userId = await getUserId();
  if (!userId) return [];
  let local = await readLocal(userId);
  const { data, error } = await supabase.from('backtest_runs').select('*').eq('user_id', userId).order('last_opened_at', { ascending: false });
  if (error) {
    console.error('[Backtest] Cloud list failed, using owned local sessions:', error);
    if (await getUserId() !== userId) return [];
    return local.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }
  const cloud = (data ?? []).filter(row => row.user_id === userId).map(row => withPersistence(fromDb(row), userId, Number(row.revision)));
  await migrateOwnedLegacy(userId, cloud);
  local = await readLocal(userId);
  const mergedById = new Map<string, StoredRun>(cloud.map(run => [run.id, run]));
  local.forEach(run => {
    const remote = mergedById.get(run.id);
    const hasUnsyncedChanges = run.persistence.cloudRevision === null || run.revision !== run.persistence.cloudRevision;
    // A divergent local branch remains recoverable and must surface a conflict
    // on sync. A fresh cloud list must never silently erase it.
    if (!remote || hasUnsyncedChanges || run.revision > remote.revision) mergedById.set(run.id, run);
  });
  const merged = [...mergedById.values()];
  await Promise.all(merged.map(saveLocal));
  if (await getUserId() !== userId) return [];
  return merged.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
};

export const getBacktestRun = async (id: string): Promise<BacktestRun | null> => {
  const userId = await getUserId();
  if (!userId) return null;
  return (await listBacktestRuns()).find(run => run.id === id) ?? null;
};

export type BacktestRunChanges =
  Partial<Pick<BacktestRun, 'name' | 'status' | 'cursorAt' | 'config' | 'workspaceState' | 'runtimeState' | 'lastOpenedAt'>>;

/**
 * Rychlý lokální checkpoint — jen IndexedDB, žádná síť. Crash-recovery vrstva,
 * kterou workspace volá každých pár sekund; cloud má vlastní, řidší kadenci
 * přes `syncBacktestRunToCloud`.
 */
export const saveBacktestRunLocal = async (
  run: BacktestRun,
  changes: BacktestRunChanges,
): Promise<BacktestRun> => {
  await requireUser(run);
  const next: StoredRun = { ...run, ...clone(changes), persistence: persistenceOf(run)!, revision: run.revision + 1, updatedAt: Date.now() };
  await saveLocal(next);
  return next;
};

/**
 * Cloudová polovina checkpointu. `expectedCloudRevision` je revize, kterou má
 * cloudový řádek od posledního úspěšného syncu — lokální revize mezitím klidně
 * poskočila o desítky (lokální checkpointy jedou častěji). Nesedne-li, řádek
 * přepsala jiná záložka. Konflikt se vrátí uživateli, nikdy se neřeší přepsáním.
 */
export const syncBacktestRunToCloud = async (
  run: BacktestRun,
  expectedCloudRevision: number | null,
  cursor?: BacktestLedgerCursor,
): Promise<BacktestRun> => {
  const userId = await requireUser(run);
  if (expectedCloudRevision === null && getBacktestCloudRevision(run) !== null) throw new BacktestRunConflictError(run.id);
  const payload = toDb(run, userId);
  const result = expectedCloudRevision === null
    ? await supabase.from('backtest_runs').insert(payload).select().single()
    : await supabase.from('backtest_runs').update(payload).eq('id', run.id).eq('user_id', userId)
      .eq('revision', expectedCloudRevision).select().maybeSingle();
  let data = result.data;
  if (!data) {
    // A transport may fail after the server committed. Accept only the exact
    // same snapshot (also covers ledger retry); every other version conflicts.
    const { data: current, error: readError } = await supabase.from('backtest_runs').select('*')
      .eq('id', run.id).eq('user_id', userId).maybeSingle();
    if (readError) throw cloudError(result.error ?? readError);
    if (current && canonical(toDb(fromDb(current), userId)) === canonical(payload)) data = current;
    else if (result.error && String(result.error.code) !== '23505') throw cloudError(result.error);
    else throw new BacktestRunConflictError(run.id);
  }
  const saved = withPersistence(fromDb(data), userId, Number(data.revision));
  await requireUser(saved);
  try {
    await saveLocal(saved);
    await syncLedger(saved, userId, cursor);
  } catch (reason) {
    // The snapshot CAS already committed. Expose that acknowledgement even if
    // the independently retriable ledger write fails, so later local edits use
    // the correct base instead of conflicting with our own previous checkpoint.
    throw new BacktestRunSyncError(reason instanceof Error ? reason.message : String(reason), saved);
  }
  return saved;
};

export const saveBacktestRun = async (
  run: BacktestRun,
  changes: BacktestRunChanges,
): Promise<BacktestRun> => {
  const next = await saveBacktestRunLocal(run, changes);
  return syncBacktestRunToCloud(next, getBacktestCloudRevision(run));
};

export const archiveBacktestRun = async (run: BacktestRun) => saveBacktestRun(run, { status: 'archived' });

export const deleteBacktestRun = async (id: string) => {
  const userId = await requireUser();
  const { error } = await supabase.from('backtest_runs').delete().eq('id', id).eq('user_id', userId);
  if (error) throw cloudError(error);
  await removeLocal(userId, id);
};

export interface BacktestRunConflictCopy { id: string; savedAt: number; run: BacktestRun }
const conflictKey = (userId: string) => `alphatrade:backtest-conflicts:${userId}:v1`;
export const listBacktestRunConflictCopies = async (runId?: string): Promise<BacktestRunConflictCopy[]> => {
  const userId = await getUserId();
  if (!userId) return [];
  return ((await get<BacktestRunConflictCopy[]>(conflictKey(userId))) ?? []).filter(copy => !runId || copy.run.id === runId);
};

/** Explicit conflict resolution only: archive the local branch before replacing
 * it with the owned remote row. Archives remain available for JSON export. */
export const loadBacktestRunFromCloud = async (id: string): Promise<BacktestRun> => {
  const userId = await requireUser();
  const { data, error } = await supabase.from('backtest_runs').select('*').eq('id', id).eq('user_id', userId).single();
  if (error || !data || data.user_id !== userId) throw cloudError(error ?? 'Cloudová session není dostupná.');
  const remote = withPersistence(fromDb(data), userId, Number(data.revision));
  const local = await get<StoredRun>(runKey(userId, id));
  if (local && canonical(toDb(local, userId)) !== canonical(toDb(remote, userId))) {
    const copy = { id: crypto.randomUUID(), savedAt: Date.now(), run: clone(local) };
    await update<BacktestRunConflictCopy[]>(conflictKey(userId), copies => [copy, ...(copies ?? [])]);
  }
  await requireUser(remote);
  await set(runKey(userId, id), remote);
  await update<string[]>(indexKey(userId), ids => ids?.includes(id) ? ids : [id, ...(ids ?? [])]);
  return remote;
};

export const updateBacktestWorkspaceState = (
  run: BacktestRun,
  workspaceState: BacktestWorkspaceState,
  runtimeState: BacktestRuntimeState,
): BacktestRun => ({ ...run, workspaceState, runtimeState, cursorAt: runtimeState.replay.cursorTime ? runtimeState.replay.cursorTime * 1_000 : null });

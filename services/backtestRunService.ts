import { del, get, set } from 'idb-keyval';
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

const INDEX_KEY = 'alphatrade:backtest-runs:index:v1';
const runKey = (id: string) => `alphatrade:backtest-run:${id}:v1`;
const CLOUD_UNAVAILABLE_CODES = new Set(['42P01', 'PGRST205', 'PGRST204']);
let cloudTablesAvailable: boolean | null = null;

const clone = <T,>(value: T): T => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value)) as T;

const localIds = async (): Promise<string[]> => (await get<string[]>(INDEX_KEY)) ?? [];

const saveLocal = async (run: BacktestRun) => {
  const ids = await localIds();
  if (!ids.includes(run.id)) await set(INDEX_KEY, [run.id, ...ids]);
  await set(runKey(run.id), clone(run));
};

const removeLocal = async (id: string) => {
  await set(INDEX_KEY, (await localIds()).filter(value => value !== id));
  await del(runKey(id));
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

const isCloudUnavailable = (error: any) => CLOUD_UNAVAILABLE_CODES.has(String(error?.code))
  || /backtest_runs|schema cache|does not exist/i.test(String(error?.message || ''));

const noteCloudError = (error: any) => {
  if (isCloudUnavailable(error)) cloudTablesAvailable = false;
};

/**
 * Kurzor přírůstkového ledgeru: co už cloud jednou přijal, znovu neposíláme.
 * Fills jsou neměnné (stačí id), orders se mění — pamatujeme si `updatedAt`,
 * pod kterým byl řádek naposledy synchronizovaný. Kurzor drží workspace po
 * dobu otevřené session; po chybě se prostě neposune a další pokus pošle
 * tytéž řádky znovu (upsert je idempotentní).
 */
export interface BacktestLedgerCursor {
  fillIds: Set<string>;
  orderStamps: Map<string, number>;
}

export const createBacktestLedgerCursor = (): BacktestLedgerCursor => ({
  fillIds: new Set(),
  orderStamps: new Map(),
});

const syncLedger = async (run: BacktestRun, userId: string, cursor?: BacktestLedgerCursor) => {
  const orders = run.runtimeState.orders
    .filter(order => cursor?.orderStamps.get(order.id) !== order.updatedAt);
  if (orders.length) {
    const { error } = await supabase.from('backtest_orders').upsert(orders.map(order => orderToDb(order, userId)));
    if (error && !isCloudUnavailable(error)) throw error;
    if (!error && cursor) orders.forEach(order => cursor.orderStamps.set(order.id, order.updatedAt));
  }
  const fills = run.runtimeState.fills.filter(fill => !cursor?.fillIds.has(fill.id));
  if (fills.length) {
    const { error } = await supabase.from('backtest_fills').upsert(
      fills.map(fill => fillToDb(fill, userId)),
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (error && !isCloudUnavailable(error)) throw error;
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
  const now = Date.now();
  const config: BacktestRunConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...input.config,
    commissionPerSide: { ...DEFAULT_BACKTEST_CONFIG.commissionPerSide, ...input.config?.commissionPerSide },
    slippageTicks: { ...DEFAULT_BACKTEST_CONFIG.slippageTicks, ...input.config?.slippageTicks },
  };
  const run: BacktestRun = {
    id: crypto.randomUUID(), accountId: input.accountId, name: input.name, status: 'active',
    initialCapital: input.initialCapital, baseCurrency: 'USD', startAt: input.startAt,
    endAt: input.endAt, executionSymbol: config.executionInstrument, replayInterval: '1m',
    cursorAt: null, config, workspaceState: clone(input.workspaceState ?? {}), runtimeState: createBacktestRuntime(input.initialCapital),
    revision: 0, schemaVersion: 1, createdAt: now, updatedAt: now, lastOpenedAt: now,
  };
  await saveLocal(run);
  const userId = await getUserId();
  if (!userId || cloudTablesAvailable === false) return run;
  const { data, error } = await supabase.from('backtest_runs').insert(toDb(run, userId)).select().single();
  if (error) {
    noteCloudError(error);
    if (!isCloudUnavailable(error)) console.error('[Backtest] Cloud create failed, local copy remains available:', error);
    return run;
  }
  cloudTablesAvailable = true;
  const saved = fromDb(data);
  await saveLocal(saved);
  return saved;
};

export const listBacktestRuns = async (): Promise<BacktestRun[]> => {
  const local = (await Promise.all((await localIds()).map(id => get<BacktestRun>(runKey(id)))))
    .filter((run): run is BacktestRun => Boolean(run));
  const userId = await getUserId();
  if (!userId || cloudTablesAvailable === false) return local.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  const { data, error } = await supabase.from('backtest_runs').select('*').order('last_opened_at', { ascending: false });
  if (error) {
    noteCloudError(error);
    if (!isCloudUnavailable(error)) console.error('[Backtest] Cloud list failed, using local sessions:', error);
    return local.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }
  cloudTablesAvailable = true;
  const cloud = (data ?? []).map(fromDb);
  const mergedById = new Map<string, BacktestRun>();
  [...cloud, ...local].forEach(run => {
    const current = mergedById.get(run.id);
    if (!current || run.revision > current.revision || (run.revision === current.revision && run.updatedAt > current.updatedAt)) {
      mergedById.set(run.id, run);
    }
  });
  const merged = [...mergedById.values()];
  await Promise.all(merged.map(saveLocal));
  return merged.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
};

export const getBacktestRun = async (id: string): Promise<BacktestRun | null> => {
  const local = await get<BacktestRun>(runKey(id));
  const userId = await getUserId();
  if (!userId || cloudTablesAvailable === false) return local ?? null;
  const { data, error } = await supabase.from('backtest_runs').select('*').eq('id', id).maybeSingle();
  if (error || !data) {
    if (error) noteCloudError(error);
    return local ?? null;
  }
  cloudTablesAvailable = true;
  const cloud = fromDb(data);
  const selected = local && (local.revision > cloud.revision || (local.revision === cloud.revision && local.updatedAt > cloud.updatedAt))
    ? local
    : cloud;
  await saveLocal(selected);
  return selected;
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
  const next: BacktestRun = { ...run, ...clone(changes), revision: run.revision + 1, updatedAt: Date.now() };
  await saveLocal(next);
  return next;
};

/**
 * Cloudová polovina checkpointu. `expectedCloudRevision` je revize, kterou má
 * cloudový řádek od posledního úspěšného syncu — lokální revize mezitím klidně
 * poskočila o desítky (lokální checkpointy jedou častěji). Nesedne-li, řádek
 * přepsala jiná záložka a fallback upsert rozhodne last-write-wins jako dosud.
 */
export const syncBacktestRunToCloud = async (
  run: BacktestRun,
  expectedCloudRevision: number,
  cursor?: BacktestLedgerCursor,
): Promise<BacktestRun> => {
  const userId = await getUserId();
  if (!userId || cloudTablesAvailable === false) return run;
  const payload = toDb(run, userId);
  const { data, error } = await supabase.from('backtest_runs')
    .update(payload)
    .eq('id', run.id)
    .eq('revision', expectedCloudRevision)
    .select()
    .maybeSingle();
  if (error) {
    noteCloudError(error);
    if (!isCloudUnavailable(error)) console.error('[Backtest] Cloud checkpoint failed, local checkpoint is safe:', error);
    return run;
  }
  cloudTablesAvailable = true;
  let saved = data ? fromDb(data) : run;
  if (!data) {
    const { data: inserted, error: insertError } = await supabase.from('backtest_runs').upsert(payload).select().single();
    if (!insertError && inserted) saved = fromDb(inserted);
  }
  await syncLedger(saved, userId, cursor);
  await saveLocal(saved);
  return saved;
};

export const saveBacktestRun = async (
  run: BacktestRun,
  changes: BacktestRunChanges,
): Promise<BacktestRun> => {
  const next = await saveBacktestRunLocal(run, changes);
  return syncBacktestRunToCloud(next, run.revision);
};

export const archiveBacktestRun = async (run: BacktestRun) => saveBacktestRun(run, { status: 'archived' });

export const deleteBacktestRun = async (id: string) => {
  await removeLocal(id);
  const userId = await getUserId();
  if (!userId || cloudTablesAvailable === false) return;
  const { error } = await supabase.from('backtest_runs').delete().eq('id', id);
  if (error) {
    noteCloudError(error);
    if (!isCloudUnavailable(error)) throw error;
  }
};

export const updateBacktestWorkspaceState = (
  run: BacktestRun,
  workspaceState: BacktestWorkspaceState,
  runtimeState: BacktestRuntimeState,
): BacktestRun => ({ ...run, workspaceState, runtimeState, cursorAt: runtimeState.replay.cursorTime ? runtimeState.replay.cursorTime * 1_000 : null });

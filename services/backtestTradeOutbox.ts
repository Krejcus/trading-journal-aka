import { get, update } from 'idb-keyval';
import type { Trade } from '../types';
import { getUserId } from './storageService';

interface PendingTrade { trade: Trade; queuedAt: number }
export interface BacktestClosedTradeIdentity {
  tradeId: string;
  runId: string;
  accountId: string;
  instrument: string;
}
/** An identity mismatch must stop recovery, never become an offline fallback. */
export class BacktestTradeIdentityError extends Error {
  constructor(message: string) { super(message); this.name = 'BacktestTradeIdentityError'; }
}
interface IdentityReceipt extends BacktestClosedTradeIdentity { acknowledgedAt: number }
interface OutboxState {
  pending: Record<string, PendingTrade>;
  /** An acknowledged trade may later be deliberately deleted from the journal.
   * Keep receipts so reopening its run does not resurrect it. */
  acknowledged: Record<string, number | IdentityReceipt>;
}
const empty = (): OutboxState => ({ pending: {}, acknowledged: {} });
const keyOf = (userId: string) => `alphatrade:backtest-trade-outbox:${userId}:v1`;
const clone = <T,>(value: T): T => structuredClone(value);
const inFlight = new Map<string, Promise<BacktestTradeOutboxResult>>();
const identityOf = (trade: Trade): BacktestClosedTradeIdentity => ({ tradeId: String(trade.id),
  runId: trade.backtestRunId ?? '', accountId: trade.accountId, instrument: trade.instrument });
const sameIdentity = (a: BacktestClosedTradeIdentity, b: BacktestClosedTradeIdentity) =>
  a.tradeId === b.tradeId && a.runId === b.runId && a.accountId === b.accountId && a.instrument === b.instrument;
const validIdentity = (value: BacktestClosedTradeIdentity) => Boolean(value
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.tradeId)
  && typeof value.runId === 'string' && value.runId && typeof value.accountId === 'string' && value.accountId
  && typeof value.instrument === 'string' && value.instrument);
const readState = (value: OutboxState | undefined): OutboxState => {
  if (value === undefined) return empty();
  if (!value || !value.pending || Array.isArray(value.pending) || typeof value.pending !== 'object'
    || !value.acknowledged || Array.isArray(value.acknowledged) || typeof value.acknowledged !== 'object') {
    throw new Error('Lokální frontu obchodů nelze přečíst. Původní data zůstala zachovaná.');
  }
  return value;
};
const checkCurrent = (signal?: AbortSignal, isCurrent?: () => boolean) => {
  if (signal?.aborted || (isCurrent && !isCurrent())) throw new DOMException('Obnova obchodů byla zrušena.', 'AbortError');
};
const localDurability = (state: OutboxState, identity: BacktestClosedTradeIdentity): 'pending' | 'acknowledged' | undefined => {
  const receipt = state.acknowledged[identity.tradeId];
  if (receipt !== undefined) {
    // v1 receipts recorded only the owner-scoped UUID. Preserve their existing
    // deletion semantics; never invent run/account metadata for an old receipt.
    if (typeof receipt === 'number' ? !Number.isFinite(receipt)
      : !validIdentity(receipt) || !sameIdentity(receipt, identity) || !Number.isFinite(receipt.acknowledgedAt)) {
      throw new Error('Potvrzení obchodu má jinou nebo poškozenou identitu.');
    }
    return 'acknowledged';
  }
  const pending = state.pending[identity.tradeId];
  if (pending) {
    if (!pending.trade || !sameIdentity(identityOf(pending.trade), identity)) throw new Error('Čekající obchod patří jiné session nebo účtu.');
    return 'pending';
  }
  return undefined;
};

const requireOwner = async (expectedUserId?: string): Promise<string> => {
  const current = await getUserId();
  if (!current || (expectedUserId && current !== expectedUserId)) {
    throw new Error('Přihlášený uživatel se změnil. Neuložené backtest obchody zůstávají bezpečně ve frontě původního uživatele.');
  }
  return current;
};

export interface BacktestTradeOutboxStorage {
  /** Read existing IDs from the server, not the optimistic UI/cache. This keeps
   * retries after an uncertain response from overwriting later trade reviews. */
  findExistingIds: (tradeIds: string[], userId: string) => Promise<string[]>;
  /** The callback must verify/capture userId before starting the write. Only
   * IDs actually returned by the server count as a successful acknowledgement. */
  saveTrades: (trades: Trade[], userId: string) => Promise<Trade[]>;
}

export interface BacktestTradeOutboxResult {
  savedTrades: Trade[];
  acknowledgedIds: string[];
  pendingCount: number;
}

export class BacktestTradeOutboxError extends Error {
  constructor(message: string, public readonly result: BacktestTradeOutboxResult) {
    super(message);
    this.name = 'BacktestTradeOutboxError';
  }
}

/** Resolves only after the complete generated trade is durable in IndexedDB. */
export const enqueueBacktestTrade = async (trade: Trade, expectedUserId?: string): Promise<{ pendingCount: number; durability: 'pending' | 'acknowledged' }> => {
  const userId = await requireOwner(expectedUserId);
  const id = String(trade.id);
  const identity = identityOf(trade);
  if (!validIdentity(identity)) {
    throw new Error('Backtest obchod nemá stabilní ID nebo ID replay session. Nelze bezpečně opakovat uložení.');
  }
  const pending: PendingTrade = { trade: clone(trade), queuedAt: Date.now() };
  let pendingCount = 0;
  let durability: 'pending' | 'acknowledged' = 'pending';
  await update<OutboxState>(keyOf(userId), previous => {
    const state = readState(previous);
    // Never replace the original generated snapshot with a later partial UI object.
    const existing = localDurability(state, identity);
    pendingCount = Object.keys(state.pending).length + (existing ? 0 : 1);
    if (existing) { durability = existing; return state; }
    return { ...state, pending: { ...state.pending, [id]: pending } };
  });
  await requireOwner(userId);
  return { pendingCount, durability };
};

export interface BacktestTradeDurabilityRequest {
  ownerId: string;
  runId: string;
  accountId: string;
  identities: readonly BacktestClosedTradeIdentity[];
  signal?: AbortSignal;
  /** Must include the caller's auth/run generation, including A -> B -> A. */
  isCurrent?: () => boolean;
}
export interface BacktestTradeDurabilityResult {
  durableIds: ReadonlySet<string>;
  lookupError: string | null;
  pendingCount: number;
}
export type BacktestTradeIdentityLookup = (
  identities: readonly BacktestClosedTradeIdentity[], ownerId: string, signal?: AbortSignal,
) => Promise<readonly BacktestClosedTradeIdentity[]>;

/** Identity-only preflight, before costly mapping. The lookup MUST query the
 * current owner's server rows; optimistic React state is not durable evidence.
 * A failed remote read leaves unknown rows eligible for local recovery. */
export const resolveBacktestClosedTradeDurability = async (
  request: BacktestTradeDurabilityRequest,
  lookup?: BacktestTradeIdentityLookup,
): Promise<BacktestTradeDurabilityResult> => {
  const guard = async () => {
    checkCurrent(request.signal, request.isCurrent);
    await requireOwner(request.ownerId);
    checkCurrent(request.signal, request.isCurrent);
  };
  await guard();
  const identities = new Map<string, BacktestClosedTradeIdentity>();
  for (const identity of request.identities) {
    if (!validIdentity(identity) || identity.runId !== request.runId || identity.accountId !== request.accountId
      || (identities.has(identity.tradeId) && !sameIdentity(identities.get(identity.tradeId)!, identity))) {
      throw new Error('Obnova obsahuje obchod jiné session nebo účtu.');
    }
    identities.set(identity.tradeId, { ...identity });
  }
  const state = readState(await get<OutboxState>(keyOf(request.ownerId)));
  await guard();
  const durableIds = new Set<string>();
  const unknown = [...identities.values()].filter(identity => {
    if (!localDurability(state, identity)) return true;
    durableIds.add(identity.tradeId); return false;
  });
  const result: BacktestTradeDurabilityResult = { durableIds, lookupError: null, pendingCount: Object.keys(state.pending).length };
  if (!lookup) return result;
  for (let offset = 0; offset < unknown.length; offset += 100) {
    await guard();
    const chunk = unknown.slice(offset, offset + 100);
    let confirmed: readonly BacktestClosedTradeIdentity[];
    try { confirmed = await lookup(chunk, request.ownerId, request.signal); }
    catch (reason) {
      await guard();
      if (reason instanceof BacktestTradeIdentityError || (reason instanceof Error && reason.name === 'AbortError')) throw reason;
      result.lookupError = reason instanceof Error ? reason.message : String(reason);
      break;
    }
    await guard();
    const requested = new Map(chunk.map(identity => [identity.tradeId, identity]));
    if (!Array.isArray(confirmed) || confirmed.some(identity => !validIdentity(identity)
      || !requested.has(identity.tradeId) || !sameIdentity(requested.get(identity.tradeId)!, identity))) {
      throw new Error('Server vrátil obchod s neodpovídající identitou.');
    }
    if (!confirmed.length) continue;
    const unique = [...new Map(confirmed.map(identity => [identity.tradeId, identity])).values()];
    await update<OutboxState>(keyOf(request.ownerId), previous => {
      checkCurrent(request.signal, request.isCurrent);
      const latest = readState(previous);
      const pending = { ...latest.pending }, acknowledged = { ...latest.acknowledged };
      for (const identity of unique) {
        localDurability(latest, identity); // Reject a raced identity collision.
        delete pending[identity.tradeId];
        acknowledged[identity.tradeId] = { ...identity, acknowledgedAt: Date.now() };
      }
      result.pendingCount = Object.keys(pending).length;
      return { ...latest, pending, acknowledged };
    });
    await guard();
    unique.forEach(identity => durableIds.add(identity.tradeId));
  }
  return result;
};

/** Count only: do not clone every rich pending Trade just to render a badge. */
export const getPendingBacktestTradeCount = async (expectedUserId?: string): Promise<number> => {
  const owner = await requireOwner(expectedUserId);
  const state = readState(await get<OutboxState>(keyOf(owner)));
  await requireOwner(owner);
  return Object.keys(state.pending).length;
};

/** Rebuild the durable queue after reload from closed runtime trades. Confirmed
 * journal IDs get a receipt; missing trades are retried with their original UUID. */
export const reconcileBacktestClosedTrades = async (
  trades: Trade[],
  knownJournalIds: ReadonlySet<string>,
  expectedUserId?: string,
): Promise<void> => {
  const userId = await requireOwner(expectedUserId);
  const confirmed = trades.filter(trade => knownJournalIds.has(String(trade.id))).map(trade => String(trade.id));
  if (confirmed.length) await acknowledge(userId, confirmed);
  for (const trade of trades) {
    if (!knownJournalIds.has(String(trade.id))) await enqueueBacktestTrade(trade, userId);
  }
};

export const getPendingBacktestTrades = async (): Promise<Trade[]> => {
  const userId = await getUserId();
  if (!userId) return [];
  const state = await get<OutboxState>(keyOf(userId));
  if (await getUserId() !== userId) return [];
  return Object.values(state?.pending ?? {}).map(entry => clone(entry.trade));
};

const acknowledge = async (userId: string, ids: string[]): Promise<void> => {
  if (!ids.length) return;
  await update<OutboxState>(keyOf(userId), previous => {
    const state = readState(previous);
    const pending = { ...state.pending };
    const acknowledged = { ...state.acknowledged };
    for (const id of ids) {
      const identity = pending[id]?.trade ? identityOf(pending[id].trade) : undefined;
      delete pending[id];
      acknowledged[id] = identity && validIdentity(identity)
        ? { ...identity, acknowledgedAt: Date.now() } : acknowledged[id] ?? Date.now();
    }
    return { ...state, pending, acknowledged };
  });
};

const flushForOwner = async (storage: BacktestTradeOutboxStorage, userId: string): Promise<BacktestTradeOutboxResult> => {
  const pending = Object.values((await get<OutboxState>(keyOf(userId)))?.pending ?? {}).map(entry => entry.trade);
  const result: BacktestTradeOutboxResult = { savedTrades: [], acknowledgedIds: [], pendingCount: pending.length };
  if (!pending.length) return result;
  try {
    await requireOwner(userId);
    const ids = new Set(pending.map(trade => String(trade.id)));
    const existing = (await storage.findExistingIds([...ids], userId)).filter(id => ids.has(id));
    await requireOwner(userId);
    await acknowledge(userId, existing);
    result.acknowledgedIds.push(...existing);
    const existingIds = new Set(existing);
    const missing = pending.filter(trade => !existingIds.has(String(trade.id)));
    if (missing.length) {
      await requireOwner(userId);
      const saved = await storage.saveTrades(missing, userId);
      await requireOwner(userId);
      const missingIds = new Set(missing.map(trade => String(trade.id)));
      result.savedTrades = saved.filter(trade => missingIds.has(String(trade.id)));
      const savedIds = result.savedTrades.map(trade => String(trade.id));
      await acknowledge(userId, savedIds);
      result.acknowledgedIds.push(...savedIds);
      const savedSet = new Set(savedIds);
      const unreturned = [...missingIds].filter(id => !savedSet.has(id));
      if (unreturned.length) {
        // An insert-only write can skip a row just inserted by another tab.
        // Confirm those IDs on the server; never turn an empty response into ACK.
        const appeared = (await storage.findExistingIds(unreturned, userId)).filter(id => unreturned.includes(id));
        await requireOwner(userId);
        await acknowledge(userId, appeared);
        result.acknowledgedIds.push(...appeared);
        if (new Set(appeared).size !== unreturned.length) throw new Error('Server nepotvrdil uložení všech backtest obchodů.');
      }
    }
  } catch (reason) {
    result.pendingCount = Object.keys((await get<OutboxState>(keyOf(userId)))?.pending ?? {}).length;
    throw new BacktestTradeOutboxError(
      `Backtest obchody čekají na uložení; další pokus proběhne automaticky. ${reason instanceof Error ? reason.message : String(reason)}`,
      result,
    );
  }
  result.pendingCount = Object.keys((await get<OutboxState>(keyOf(userId)))?.pending ?? {}).length;
  return result;
};

/** Coalesces overlapping timers/close/online retries for the current user. */
export const flushBacktestTradeOutbox = async (storage: BacktestTradeOutboxStorage): Promise<BacktestTradeOutboxResult> => {
  const userId = await requireOwner();
  const active = inFlight.get(userId);
  if (active) return active;
  const promise = flushForOwner(storage, userId).finally(() => { inFlight.delete(userId); });
  inFlight.set(userId, promise);
  return promise;
};

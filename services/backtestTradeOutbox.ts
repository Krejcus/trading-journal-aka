import { get, update } from 'idb-keyval';
import type { Trade } from '../types';
import { getUserId } from './storageService';

interface PendingTrade { trade: Trade; queuedAt: number }
interface OutboxState {
  pending: Record<string, PendingTrade>;
  /** An acknowledged trade may later be deliberately deleted from the journal.
   * Keep receipts so reopening its run does not resurrect it. */
  acknowledged: Record<string, number>;
}
const empty = (): OutboxState => ({ pending: {}, acknowledged: {} });
const keyOf = (userId: string) => `alphatrade:backtest-trade-outbox:${userId}:v1`;
const clone = <T,>(value: T): T => structuredClone(value);
const inFlight = new Map<string, Promise<BacktestTradeOutboxResult>>();

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
export const enqueueBacktestTrade = async (trade: Trade, expectedUserId?: string): Promise<void> => {
  const userId = await requireOwner(expectedUserId);
  const id = String(trade.id);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !trade.backtestRunId) {
    throw new Error('Backtest obchod nemá stabilní ID nebo ID replay session. Nelze bezpečně opakovat uložení.');
  }
  const pending: PendingTrade = { trade: clone(trade), queuedAt: Date.now() };
  await update<OutboxState>(keyOf(userId), previous => {
    const state = previous ?? empty();
    // Never replace the original generated snapshot with a later partial UI object.
    if (state.acknowledged[id] || state.pending[id]) return state;
    return { ...state, pending: { ...state.pending, [id]: pending } };
  });
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
    const state = previous ?? empty();
    const pending = { ...state.pending };
    const acknowledged = { ...state.acknowledged };
    for (const id of ids) { delete pending[id]; acknowledged[id] = Date.now(); }
    return { pending, acknowledged };
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

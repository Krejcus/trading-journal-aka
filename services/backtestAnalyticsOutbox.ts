import { get, update } from 'idb-keyval';
import type { Trade } from '../types';
import { getUserId } from './storageService';
import type { BacktestAnalyticsRefreshCandidate } from './backtestAnalyticsRefresh';
import type { BacktestTradeReviewStorage } from './backtestTradeReview';
import { buildBacktestTradeRecalculationUpdates } from './backtestTradeRecalculation';
import { changedTradeFields } from './tradePatch';

interface Pending { candidate: BacktestAnalyticsRefreshCandidate; token: string }
type State = Record<string, Pending>;
const keyOf = (owner: string) => `alphatrade:backtest-analytics-outbox:${owner}:v1`;
const newerThan = (left: BacktestAnalyticsRefreshCandidate['stamp'], right: BacktestAnalyticsRefreshCandidate['stamp']) => left.schemaVersion > right.schemaVersion || (left.schemaVersion === right.schemaVersion && left.horizonTime > right.horizonTime);
const inFlight = new Map<string, Promise<AnalyticsFlushResult>>();
export interface AnalyticsFlushResult {
  confirmed: BacktestAnalyticsRefreshCandidate[];
  pendingCount: number;
  error: string | null;
}
const requireOwner = async (expected?: string) => {
  const owner = await getUserId();
  if (!owner || (expected && owner !== expected)) throw new Error('Přihlášený uživatel se změnil. Analýzy zůstávají ve frontě původního uživatele.');
  return owner;
};
export async function enqueueBacktestAnalytics(candidates: readonly BacktestAnalyticsRefreshCandidate[], expectedOwner: string): Promise<void> {
  const owner = await requireOwner(expectedOwner);
  for (const item of candidates) {
    if (!item.tradeId || !item.runId || item.recalculated.id !== item.tradeId
      || item.recalculated.backtestRunId !== item.runId || !Number.isFinite(item.stamp.horizonTime)) {
      throw new Error('Neplatná identita nebo horizont analýzy replaye.');
    }
  }
  const entries = candidates.map(candidate => ({ candidate: structuredClone(candidate), token: crypto.randomUUID() }));
  await update<State>(keyOf(owner), previous => {
    const next = { ...previous };
    for (const entry of entries) {
      const previousEntry = next[entry.candidate.tradeId];
      if (previousEntry && (newerThan(previousEntry.candidate.stamp, entry.candidate.stamp) || (previousEntry.candidate.stamp.sourceHash === entry.candidate.stamp.sourceHash && previousEntry.candidate.expectedSourceHash === entry.candidate.expectedSourceHash))) continue;
      next[entry.candidate.tradeId] = entry;
    }
    return next;
  });
  await requireOwner(owner);
}
export async function getPendingBacktestAnalytics(expectedOwner: string): Promise<BacktestAnalyticsRefreshCandidate[]> {
  const owner = await requireOwner(expectedOwner);
  const pending = await get<State>(keyOf(owner));
  await requireOwner(owner);
  return Object.values(pending ?? {}).map(entry => structuredClone(entry.candidate));
}
const flushOwner = async (storage: Pick<BacktestTradeReviewStorage, 'prepareBacktestTradeReview' | 'updateBacktestTradeReview'>, owner: string): Promise<AnalyticsFlushResult> => {
  const result: AnalyticsFlushResult = { confirmed: [], pendingCount: 0, error: null };
  const entries = Object.values((await get<State>(keyOf(owner))) ?? {});
  for (const entry of entries) {
    try {
      await requireOwner(owner);
      const snapshot = await storage.prepareBacktestTradeReview(entry.candidate.tradeId);
      await requireOwner(owner);
      const latest = snapshot.data as Trade;
      if (snapshot.ownerId !== owner || latest.backtestRunId !== entry.candidate.runId
        || latest.accountId !== entry.candidate.recalculated.accountId) {
        throw new Error('Změnila se identita obchodu; analýzu nelze bezpečně připojit.');
      }
      const latestStamp = latest.backtestAnalyticsRefresh;
      const superseded = latestStamp && newerThan(latestStamp, entry.candidate.stamp);
      const currentPending = (await get<State>(keyOf(owner)))?.[entry.candidate.tradeId];
      if (currentPending?.token !== entry.token) continue;
      if (latestStamp && !superseded && latestStamp.schemaVersion === entry.candidate.stamp.schemaVersion
        && latestStamp.horizonTime === entry.candidate.stamp.horizonTime
        && latestStamp.sourceHash !== entry.candidate.stamp.sourceHash
        && latestStamp.sourceHash !== entry.candidate.expectedSourceHash) {
        throw new Error('Stejný úsek má na jiném zařízení jinou verzi dat. Obnovte session a porovnejte analýzu.');
      }
      // Rebase only computed values against the fresh server review. A same-field
      // race is rejected atomically by the RPC and retried from a new snapshot.
      const updates = changedTradeFields(latest, {
        ...buildBacktestTradeRecalculationUpdates(latest, entry.candidate.recalculated),
        backtestAnalyticsRefresh: entry.candidate.stamp,
      });
      if (!superseded && Object.keys(updates).length) {
        await storage.updateBacktestTradeReview(entry.candidate.tradeId, updates, snapshot, undefined, latest);
        await requireOwner(owner);
      }
      await update<State>(keyOf(owner), previous => {
        if (previous?.[entry.candidate.tradeId]?.token !== entry.token) return previous ?? {};
        const next = { ...previous }; delete next[entry.candidate.tradeId]; return next;
      });
      if (!superseded) result.confirmed.push(entry.candidate);
    } catch (reason) {
      result.error = `Dopočet analýz čeká na uložení. ${reason instanceof Error ? reason.message : String(reason)}`;
      // Offline/missing migration should not generate one failing request per trade.
      break;
    }
  }
  result.pendingCount = Object.keys((await get<State>(keyOf(owner))) ?? {}).length;
  return result;
};
/** Serialized per user, durable across reloads; an old ACK cannot delete newer work. */
export async function flushBacktestAnalytics(storage: Pick<BacktestTradeReviewStorage, 'prepareBacktestTradeReview' | 'updateBacktestTradeReview'>): Promise<AnalyticsFlushResult> {
  const owner = await requireOwner();
  const active = inFlight.get(owner);
  if (active) return active;
  const promise = flushOwner(storage, owner).finally(() => inFlight.delete(owner));
  inFlight.set(owner, promise);
  return promise;
}

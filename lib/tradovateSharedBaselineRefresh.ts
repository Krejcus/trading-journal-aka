import type { TradovateAccountDataResult } from './tradovateAccountDataTypes.js';

const BASELINE_INTERVAL_MS = 10 * 60_000;
// Allow the bounded baseline collection to finish before all clients renew it.
const COLLECTION_GRACE_MS = 5_000;

/** Receiving a shared snapshot must never give its source another ten minutes of life. */
export function tradovateSharedBaselineRefresh(shared: TradovateAccountDataResult['sharedRead'], now: number): {
  lastFullSuccessAt: number; retryAt: number | null;
} {
  if (!shared || shared.refreshPending) return { lastFullSuccessAt: now, retryAt: null };
  const sourceAt = Date.parse(shared.baselineAsOf);
  if (!Number.isFinite(sourceAt) || sourceAt > now + 1_000) return { lastFullSuccessAt: now, retryAt: now + BASELINE_INTERVAL_MS };
  return { lastFullSuccessAt: Math.min(now, sourceAt),
    retryAt: Math.max(now + 1_000, sourceAt + BASELINE_INTERVAL_MS + COLLECTION_GRACE_MS) };
}

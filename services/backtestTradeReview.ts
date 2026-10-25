import type { Trade } from '../types';

export interface BacktestTradeReviewStorage {
  prepareBacktestTradeReview: (tradeId: string, updates?: Partial<Trade>) => Promise<import('./backtestReviewPersistence').BacktestReviewSnapshot>;
  uploadScreenshot: (dataUrl: string, tradeId: string, expectedOwner?: string) => Promise<string>;
  updateBacktestTradeReview: (
    tradeId: string, updates: Partial<Trade>, snapshot: import('./backtestReviewPersistence').BacktestReviewSnapshot,
    appendScreenshot?: string, expected?: Partial<Trade>,
  ) => Promise<Partial<Trade>>;
}

export const mergeTradeSnapshotUrls = (
  existing: { screenshot?: string; screenshots?: string[] } | undefined,
  uploadedUrl: string,
): Pick<Trade, 'screenshot' | 'screenshots'> => {
  const previousUrls = [
    ...(existing?.screenshots ?? []),
    ...(existing?.screenshot ? [existing.screenshot] : []),
  ];
  return {
    screenshot: existing?.screenshot ?? uploadedUrl,
    screenshots: [...new Set([...previousUrls, uploadedUrl])],
  };
};

/**
 * Uložené review obchod odškrtne z „čeká na review“ — ale jen když tam opravdu
 * byl. Většina backtest obchodů pole `needsReview` vůbec nemá a klient z něj
 * dělá `false`; poslat ho by CAS na serveru porovnal `false` s prázdnou
 * hodnotou a hlásil falešný souběžný konflikt (retry bouře 25. 10. 2026).
 */
export const withReviewedFlag = (patch: Partial<Trade>, baseline: { needsReview?: boolean }): Partial<Trade> => (
  baseline.needsReview === true ? { ...patch, needsReview: false } : patch
);

/** Jeden krok ukládání nesmí viset donekonečna (server bez odpovědi = tlačítko točí navždy). */
export const BACKTEST_REVIEW_STEP_TIMEOUT_MS = 30_000;
const withTimeout = <T,>(promise: Promise<T>, message: string, ms = BACKTEST_REVIEW_STEP_TIMEOUT_MS): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, reason => { clearTimeout(timer); reject(reason); });
});

// Opakované uložení po chybě použije už nahraný snímek — žádná kopie obrázku navíc.
const uploadedSnapshots = new Map<string, string>();

/** Persist review fields, uploading a pending local snapshot only on Save. */
export const persistBacktestTradeReview = async (
  storage: BacktestTradeReviewStorage,
  tradeId: string,
  updates: Partial<Trade>,
  snapshotDataUrl?: string,
  expected?: Partial<Trade>,
  timeoutMs = BACKTEST_REVIEW_STEP_TIMEOUT_MS,
): Promise<Partial<Trade>> => {
  // A failed/missing database prerequisite stops before upload or any write.
  const snapshot = await withTimeout(storage.prepareBacktestTradeReview(tradeId, updates),
    'Server neodpověděl při načtení obchodu. Review zůstalo otevřené — zkus uložit znovu.', timeoutMs);
  let uploadedUrl: string | undefined;
  if (snapshotDataUrl) {
    const key = `${tradeId}:${snapshotDataUrl.length}:${snapshotDataUrl.slice(-64)}`;
    uploadedUrl = uploadedSnapshots.get(key);
    if (!uploadedUrl) {
      uploadedUrl = await withTimeout(storage.uploadScreenshot(snapshotDataUrl, tradeId, snapshot.ownerId),
        'Nahrání snímku trvá příliš dlouho. Review zůstalo otevřené — zkus uložit znovu.', timeoutMs);
      uploadedSnapshots.set(key, uploadedUrl);
    }
  }
  const committed = await withTimeout(storage.updateBacktestTradeReview(tradeId, updates, snapshot, uploadedUrl, expected),
    'Server neodpověděl při ukládání review. Zkus uložit znovu — snímek se znovu nenahraje.', timeoutMs);
  uploadedSnapshots.forEach((_, key) => { if (key.startsWith(`${tradeId}:`)) uploadedSnapshots.delete(key); });
  return committed;
};

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

/** Persist review fields, uploading a pending local snapshot only on Save. */
export const persistBacktestTradeReview = async (
  storage: BacktestTradeReviewStorage,
  tradeId: string,
  updates: Partial<Trade>,
  snapshotDataUrl?: string,
  expected?: Partial<Trade>,
): Promise<Partial<Trade>> => {
  // A failed/missing database prerequisite stops before upload or any write.
  const snapshot = await storage.prepareBacktestTradeReview(tradeId, updates);
  const uploadedUrl = snapshotDataUrl
    ? await storage.uploadScreenshot(snapshotDataUrl, tradeId, snapshot.ownerId)
    : undefined;
  return storage.updateBacktestTradeReview(tradeId, updates, snapshot, uploadedUrl, expected);
};

import type { Trade } from '../types';

export interface BacktestTradeReviewStorage {
  getTradeScreenshots: (tradeIds: string[]) => Promise<Map<string, { screenshot?: string; screenshots?: string[] }>>;
  uploadScreenshot: (dataUrl: string, tradeId: string) => Promise<string>;
  updateTrade: (tradeId: string, updates: Partial<Trade>) => Promise<void>;
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
): Promise<Partial<Trade>> => {
  let payload: Partial<Trade> = { ...updates };
  if (snapshotDataUrl) {
    const existing = (await storage.getTradeScreenshots([tradeId])).get(tradeId);
    const uploadedUrl = await storage.uploadScreenshot(snapshotDataUrl, tradeId);
    payload = { ...payload, ...mergeTradeSnapshotUrls(existing, uploadedUrl) };
  }
  await storage.updateTrade(tradeId, payload);
  return payload;
};

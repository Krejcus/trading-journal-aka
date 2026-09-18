import type { Trade } from '../types';

/** Per-trade analytics blobs the light dashboard read leaves out; Lab, the AI coach and the trade detail fetch them separately. */
export const TRADE_ANALYTICS_FIELDS = [
  'counterfactual', 'entryContext', 'excursion', 'aiSuggestions', 'executionPath', 'entryMap', 'visionAnalysis',
] as const;
export type TradeAnalyticsField = typeof TRADE_ANALYTICS_FIELDS[number];
export type TradeAnalytics = Partial<Pick<Trade, TradeAnalyticsField>>;

/** Rows from get_trade_analytics_v1 → map by trade id; null values mean "field absent", not "clear". */
export function tradeAnalyticsById(rows: unknown): Map<string, TradeAnalytics> {
  const byId = new Map<string, TradeAnalytics>();
  if (!Array.isArray(rows)) return byId;
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== 'object') continue;
    const row = candidate as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) continue;
    const analytics: TradeAnalytics = {};
    for (const field of TRADE_ANALYTICS_FIELDS) {
      if (row[field] != null) (analytics as Record<string, unknown>)[field] = row[field];
    }
    if (Object.keys(analytics).length > 0) byId.set(row.id, analytics);
  }
  return byId;
}

/**
 * Lays deferred analytics over the in-memory trades without touching any
 * other field. Trades that already carry a value (detail read, fresh
 * import) keep their own; a missing analytics row leaves the trade as is.
 */
export function mergeTradeAnalytics(trades: readonly Trade[], analytics: ReadonlyMap<string, TradeAnalytics>): Trade[] {
  if (analytics.size === 0) return [...trades];
  return trades.map(trade => {
    const extra = analytics.get(String(trade.id));
    if (!extra) return trade;
    let next: Trade | null = null;
    for (const field of TRADE_ANALYTICS_FIELDS) {
      if (trade[field] != null || extra[field] == null) continue;
      next = next ?? { ...trade };
      (next as unknown as Record<string, unknown>)[field] = extra[field];
    }
    return next ?? trade;
  });
}

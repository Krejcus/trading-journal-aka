import { describe, expect, it } from 'vitest';
import { aggregateCandles, timeframeBucketStart, type MarketCandle, type MarketTimeframe } from '../services/marketDataCalculations';
import { aggregateCandles as before, timeframeBucketStart as bucketBefore } from './qa/beforeLiveMarketCalculations';

function rows(start: string, n: number): MarketCandle[] {
  return Array.from({ length: n }, (_, i) => ({ time: Date.parse(start) / 1000 + i * 60,
    open: 20000 + i % 11, high: 20020 + i % 13, low: 19980 - i % 7, close: 20000 + i % 17, volume: i % 113 }));
}
describe('cached clock aggregation equals the frozen pre-optimization implementation', () => {
  it('preserves every OHLCV, ordering and bucket across DST, session/day/month/year boundaries and custom timeframes', () => {
    const sets = ['2026-03-08T05:00:00Z', '2026-11-01T04:00:00Z', '2026-12-31T20:00:00Z', '2026-10-30T20:00:00Z'];
    const tfs: MarketTimeframe[] = ['1m', '5m', '7m', '15m', '45m', '90m', '2h', '4h', '23h', '1d', 'W', 'M'];
    for (const start of sets) {
      const data = rows(start, 1500).filter((_, i) => i % 19 !== 0);
      for (const tf of tfs) expect(aggregateCandles(data, tf)).toEqual(before(data, tf));
    }
  });
  it('does not cache OHLCV: old row edits, volume correction, append, prepend and truncation remain visible', () => {
    const original = rows('2026-10-28T12:00:00Z', 1700);
    const edited = original.map((c, i) => i === 100 ? { ...c, high: 99999, low: 1, close: 35000, volume: 999999 } : c);
    for (const data of [original, edited, edited.slice(500), [...rows('2026-10-28T10:00:00Z', 120), ...edited], [...edited, ...rows('2026-10-29T16:20:00Z', 100)]]) {
      expect(aggregateCandles(data, '5m')).toEqual(before(data, '5m'));
    }
    expect(aggregateCandles(edited, '5m')).not.toEqual(aggregateCandles(original, '5m'));
  });
  it('handles cache eviction, shared timestamps between timeframes and subminute input without changing results', () => {
    const base = Date.parse('2026-01-01T00:00:00Z') / 1000;
    for (let i = 0; i < 34000; i++) timeframeBucketStart(base + i * 60, '5m');
    for (const offset of [0, 0.5, 37, 3600, 33999 * 60]) for (const tf of ['5m', '7m', '4h'] as const) {
      expect(timeframeBucketStart(base + offset, tf)).toBe(bucketBefore(base + offset, tf));
    }
  });
});

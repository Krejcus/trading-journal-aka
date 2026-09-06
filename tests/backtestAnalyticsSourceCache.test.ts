import { describe, expect, it } from 'vitest';
import { backtestChangeHash, createBacktestAnalyticsSourceCache } from '../services/backtestAnalyticsSourceCache';
const bars = Array.from({ length: 12 }, (_, i) => ({ time: i * 60, open: 100 + i / 13, high: 102 + i, low: 99 - i, close: 100, volume: i }));
describe('bounded analytics source hashes', () => {
  it('preserves the existing exact serialized hash for every prefix and HTF presence', () => {
    for (const htf of [undefined, [], bars.filter((_, i) => i % 3 === 0)]) {
      const cache = createBacktestAnalyticsSourceCache();
      for (const horizon of [-1, 0, 59, 60, 121, 500, 10000, 0]) {
        const actual = cache.get(bars, htf, horizon);
        const candles = bars.filter(bar => bar.time <= horizon);
        const htfCandles = htf?.filter(bar => bar.time <= horizon);
        expect(actual).toEqual({ candles, htfCandles, hash: backtestChangeHash({ candles, htfCandles }) });
      }
    }
  });
  it('serializes each known candle once across seven horizons and does no work on repeated polls', () => {
    const cache = createBacktestAnalyticsSourceCache();
    for (let i = 0; i < 7; i++) cache.get(bars, undefined, i * 60);
    expect(cache.diagnostics.candleSerializations).toBe(7);
    const before = { ...cache.diagnostics };
    for (let i = 0; i < 80; i++) cache.get(bars, undefined, (i % 7) * 60 + 1);
    expect(cache.diagnostics).toEqual(before);
  });
  it('never reads hidden OHLC and invalidates exact corrections without rounded fingerprints', () => {
    const future = { ...bars[2], get high(): number { throw new Error('Unrevealed high read'); } };
    const cache = createBacktestAnalyticsSourceCache();
    const before = cache.get([bars[0], bars[1], future], undefined, 60);
    const corrected = cache.get([{ ...bars[0], close: 100.00000000000003 }, bars[1]], undefined, 60);
    expect(corrected.hash).not.toBe(before.hash);
  });
  it('handles replacement, hole repair, prepend and unordered compatibility inputs', () => {
    const cache = createBacktestAnalyticsSourceCache();
    for (const candles of [[bars[0], bars[2]], bars.slice(0, 3), bars.slice(1, 4), [bars[2], bars[0], bars[1]]]) {
      expect(cache.get(candles, undefined, 120).hash).toBe(backtestChangeHash({ candles: candles.filter(c => c.time <= 120), htfCandles: undefined }));
    }
  });
});

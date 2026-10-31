import { describe, expect, it } from 'vitest';
import { aggregateVerifiedCandles } from '../services/verifiedCandleAggregation';
import { aggregateCandles, type MarketCandle } from '../services/marketDataCalculations';
describe('verified timeframe cache', () => {
  it('matches full OHLCV including DST, daily, weekly and monthly boundaries and older in-place corrections', () => {
    const rows: MarketCandle[] = Array.from({ length: 5000 }, (_, i) => ({ time: Date.UTC(2026, 9, 31, 18) / 1000 + i * 60, open: 28000 + i % 30, high: 28040, low: 27980, close: 28001 + i % 30, volume: 20 + i % 10 }));
    const check = () => { for (const tf of ['5m', '15m', '4h', '1d', 'W', 'M'] as const) expect(aggregateVerifiedCandles(rows, tf)).toEqual(aggregateCandles(rows, tf)); };
    check(); check();
    rows[100].high += 200; rows[101].low -= 200; rows[102].volume += 50;
    check();
    rows.at(-1)!.close += 2; check();
    rows.push({ ...rows.at(-1)!, time: rows.at(-1)!.time + 60 }); check();
    rows.splice(0, 500); check();
  });
  it('cannot be poisoned by a caller mutating a returned candle or array', () => {
    const rows: MarketCandle[] = Array.from({ length: 60 }, (_, i) => ({ time: 1700000040 + i * 60, open: 100, high: 110, low: 90, close: 105, volume: 5 }));
    const result = aggregateVerifiedCandles(rows, '5m');
    result[0].close = 10000; result.pop();
    expect(aggregateVerifiedCandles(rows, '5m')).toEqual(aggregateCandles(rows, '5m'));
  });
});

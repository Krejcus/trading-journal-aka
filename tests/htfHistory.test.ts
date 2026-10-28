import { describe, expect, it } from 'vitest';
import { htfHistoryDays, htfHistoryDaysFor, htfHistoryRange, withHtfHistory } from '../services/htfHistory';
import { aggregateCandles, type MarketCandle } from '../services/marketDataCalculations';

const candle = (time: number, close: number): MarketCandle => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 1 });

describe('hodinová historie pro vyšší timeframy grafu deníku', () => {
  it('jen timeframy skládané z hodin; M 3 roky, D/W 2 roky, hodinové 120 dní', () => {
    expect(htfHistoryDays('5m')).toBe(0);
    expect(htfHistoryDays('90m')).toBe(0);
    expect(htfHistoryDays('1h')).toBe(120);
    expect(htfHistoryDays('4h')).toBe(120);
    expect(htfHistoryDays('1d')).toBe(730);
    expect(htfHistoryDays('W')).toBe(730);
    expect(htfHistoryDays('M')).toBe(1_095);
    expect(htfHistoryDaysFor(['5m', '4h', 'M'])).toBe(1_095);
    expect(htfHistoryDaysFor(['1m', '15m'])).toBe(0);
  });

  it('okno končí celou hodinou, kde začínají 1m data, a začíná půlnocí UTC', () => {
    const first = Date.UTC(2026, 9, 13, 22, 0) / 1_000;
    const range = htfHistoryRange(first, 120)!;
    expect(range.endMs).toBe(first * 1_000);
    expect(new Date(range.startMs).toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(htfHistoryRange(null, 120)).toBeNull();
    expect(htfHistoryRange(first, 0)).toBeNull();
  });

  it('hodiny jen před 1m daty, žádná minuta dvakrát; pod hodinu beze změny', () => {
    const first = Date.UTC(2026, 9, 13, 22, 0) / 1_000;
    const hourly = [candle(first - 7_200, 100), candle(first - 3_600, 101), candle(first, 999)];
    const raw = [candle(first, 102), candle(first + 60, 103)];
    expect(withHtfHistory(raw, hourly, '1d').map(item => item.close)).toEqual([100, 101, 102, 103]);
    expect(withHtfHistory(raw, hourly, '15m')).toBe(raw);
    expect(withHtfHistory(raw, [], 'W')).toBe(raw);
  });

  it('měsíční svíčka z hodin a minut dohromady: open z historie, close z dneška', () => {
    const october = Date.UTC(2026, 9, 2, 14, 0) / 1_000;
    const recent = Date.UTC(2026, 9, 27, 14, 0) / 1_000;
    const bars = aggregateCandles(withHtfHistory([candle(recent, 120)], [candle(october, 90)], 'M'), 'M');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ open: 90, close: 120, high: 121, low: 89 });
  });
});

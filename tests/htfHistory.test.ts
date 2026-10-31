import { describe, expect, it } from 'vitest';
import { aggregateWithHtfHistory, htfHistoryBefore, htfHistoryDays, htfHistoryDaysFor, htfHistoryRange, withHtfHistory } from '../services/htfHistory';
import { aggregateCandles, type MarketCandle } from '../services/marketDataCalculations';

const candle = (time: number, close: number): MarketCandle => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 1 });

describe('hodinová historie pro vyšší timeframy grafu deníku', () => {
  it('joins a minute bridge at a mid-hour seam without losing or double-counting OHLCV', () => {
    const start = Date.UTC(2026, 9, 13, 0) / 1000;
    const all = Array.from({ length: 240 }, (_, i) => candle(start + i * 60, 28000 + i / 100));
    const hourly = aggregateCandles(all.slice(0, 120), '1h');
    const raw = all.slice(154);
    const bridge = all.slice(120, 154);
    const joined = [...bridge, ...raw];
    for (const tf of ['1h', '4h', '1d', 'W', 'M'] as const) {
      expect(aggregateWithHtfHistory(joined, hourly, tf)).toEqual(aggregateCandles(all, tf));
    }
  });
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
    const hourly = [candle(first - 7_200, 29_000), candle(first - 3_600, 29_001), candle(first, 29_999)];
    const raw = [candle(first, 29_002), candle(first + 60, 29_003)];
    expect(withHtfHistory(raw, hourly, '1d').map(item => item.close)).toEqual([29_000, 29_001, 29_002, 29_003]);
    expect(withHtfHistory(raw, hourly, '15m')).toBe(raw);
    expect(withHtfHistory(raw, [], 'W')).toBe(raw);
  });

  it('měsíční svíčka z hodin a minut dohromady: open z historie, close z dneška', () => {
    const october = Date.UTC(2026, 9, 2, 14, 0) / 1_000;
    const recent = Date.UTC(2026, 9, 27, 14, 0) / 1_000;
    const bars = aggregateCandles(withHtfHistory([candle(recent, 29_020)], [candle(october, 29_000)], 'M'), 'M');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ open: 29_000, close: 29_020, high: 29_021, low: 28_999 });
  });

  it('agregace po částech = agregace celé řady (hranice týdne/měsíce se sloučí)', () => {
    const start = Date.UTC(2026, 8, 1, 0, 0) / 1_000;
    const hourly = Array.from({ length: 24 * 40 }, (_, index) => candle(start + index * 3_600, 29_000 + (index % 17)));
    const first = start + 24 * 40 * 3_600;
    const raw = Array.from({ length: 600 }, (_, index) => candle(first + index * 60, 29_010 + (index % 7)));
    for (const tf of ['1d', 'W', 'M', '4h'] as const) {
      expect(aggregateWithHtfHistory(raw, hourly, tf), tf).toEqual(aggregateCandles(withHtfHistory(raw, hourly, tf), tf));
    }
    // Memo: stejná historie a stejný začátek dat = stejné pole (přehrávání nepřepočítává).
    expect(htfHistoryBefore(raw, hourly)).toBe(htfHistoryBefore(raw.slice(0, 10), hourly));
  });

  it('jiný kontrakt (skok mezi historií a 1m daty) = historie se nepřidá', () => {
    const first = Date.UTC(2026, 9, 13, 22, 0) / 1_000;
    const hourly = [candle(first - 3_600, 29_000)];
    expect(withHtfHistory([candle(first, 29_010)], hourly, '1d')).toHaveLength(2);
    expect(withHtfHistory([candle(first, 29_200)], hourly, '1d')).toHaveLength(1);
  });
});

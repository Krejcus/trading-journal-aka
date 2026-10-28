import { describe, expect, it } from 'vitest';
import {
  aggregateCandles,
  isMarketTimeframe,
  marketDataSchemaForTimeframe,
  nearestBuiltinTimeframe,
  parseMarketTimeframe,
  timeframeBucketStart,
  timeframeMinutes,
  type MarketCandle,
} from '../services/marketDataCalculations';
import { customTimeframeOption } from '../components/ChartTimeframePicker';

const at = (iso: string) => Date.parse(iso) / 1_000;
const candle = (time: number, close: number, volume = 1): MarketCandle => ({ time, open: close, high: close + 1, low: close - 1, close, volume });

describe('vlastní timeframy', () => {
  it('platné: pevné, N minut (1–720), N hodin (1–23), týden a měsíc', () => {
    for (const value of ['1m', '7m', '45m', '720m', '2h', '23h', '1d', 'W', 'M']) expect(isMarketTimeframe(value), value).toBe(true);
    for (const value of ['0m', '721m', '24h', '2d', '1.5m', '-3m', 'w', '', null, 42, '07m']) expect(isMarketTimeframe(value), String(value)).toBe(false);
    expect(parseMarketTimeframe('7m')).toEqual({ unit: 'm', count: 7 });
  });

  it('délka v minutách a nejbližší pevný timeframe pro tabulky grafu', () => {
    expect(timeframeMinutes('7m')).toBe(7);
    expect(timeframeMinutes('2h')).toBe(120);
    expect(timeframeMinutes('W')).toBe(7 * 1_440);
    expect(nearestBuiltinTimeframe('7m')).toBe('5m');
    expect(nearestBuiltinTimeframe('2h')).toBe('1h');
    expect(nearestBuiltinTimeframe('3h')).toBe('4h');
    expect(nearestBuiltinTimeframe('W')).toBe('1d');
    expect(nearestBuiltinTimeframe('15m')).toBe('15m');
  });

  it('hodinová data jen když se z nich timeframe dá přesně složit', () => {
    expect(marketDataSchemaForTimeframe('2h')).toBe('ohlcv-1h');
    expect(marketDataSchemaForTimeframe('120m')).toBe('ohlcv-1h');
    expect(marketDataSchemaForTimeframe('90m')).toBe('ohlcv-1m');
    expect(marketDataSchemaForTimeframe('W')).toBe('ohlcv-1h');
    expect(marketDataSchemaForTimeframe('45m')).toBe('ohlcv-1m');
  });

  it('7m svíčky od otevření CME session (18:00 New York)', () => {
    // 28. 10. 2026 je NY v EDT (UTC−4): session otevřela 27. 10. ve 22:00 UTC.
    const open = at('2026-10-27T22:00:00Z');
    const minutes = Array.from({ length: 15 }, (_, index) => candle(open + index * 60, 100 + index));
    const bars = aggregateCandles(minutes, '7m');
    expect(bars.map(bar => bar.time)).toEqual([open, open + 7 * 60, open + 14 * 60]);
    expect(bars[0]).toMatchObject({ open: 100, close: 106, high: 107, low: 99, volume: 7 });
  });

  it('týden: neděle večer patří k pondělí, celý týden jedna svíčka se stejným časem', () => {
    const sundayEvening = at('2026-10-25T22:30:00Z'); // neděle 18:30 NY → obchodní den pondělí 26. 10.
    const friday = at('2026-10-30T19:00:00Z');
    const nextSunday = at('2026-11-01T23:30:00Z'); // další týden
    expect(timeframeBucketStart(sundayEvening, 'W')).toBe(timeframeBucketStart(friday, 'W'));
    expect(timeframeBucketStart(nextSunday, 'W')).toBeGreaterThan(timeframeBucketStart(friday, 'W'));
    const bars = aggregateCandles([candle(sundayEvening, 100), candle(friday, 110), candle(nextSunday, 120)], 'W');
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ open: 100, close: 110, high: 111, low: 99 });
  });

  it('měsíc: poslední obchodní den měsíce a první den dalšího jsou dvě svíčky', () => {
    const lastOfOctober = at('2026-10-30T15:00:00Z');
    const firstOfNovember = at('2026-11-01T23:00:00Z'); // neděle 18:00 NY → obchodní den 2. 11.
    const bars = aggregateCandles([candle(at('2026-10-02T15:00:00Z'), 90), candle(lastOfOctober, 100), candle(firstOfNovember, 110)], 'M');
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ open: 90, close: 100 });
  });

  it('popisky vlastních timeframů v nabídce', () => {
    expect(customTimeframeOption('7m')).toMatchObject({ label: '7m', title: '7 minut', group: 'Vlastní' });
    expect(customTimeframeOption('3m')?.title).toBe('3 minuty');
    expect(customTimeframeOption('1h')?.title).toBe('1 hodina');
    expect(customTimeframeOption('2h')?.title).toBe('2 hodiny');
    expect(customTimeframeOption('W')).toBeNull();
  });
});

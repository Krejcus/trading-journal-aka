import { describe, expect, it } from 'vitest';
import { calculateHtfFairValueGaps, htfFairValueGapsWithFormingBars, htfFvgApplies, htfLastCandleClosed } from '../services/htfFairValueGaps';
import { aggregateCandles, timeframeBucketStart, updateFairValueGapAccumulator, type MarketCandle } from '../services/marketDataCalculations';

// 2026-08-03 14:00 UTC (pondělí, 10:00 NY) — začátek 5m svíčky.
const T0 = Date.parse('2026-08-03T14:00:00Z') / 1000;
const bar = (minute: number, open: number, high: number, low: number, close: number): MarketCandle =>
  ({ time: T0 + minute * 60, open, high, low, close, volume: 1 });
/** Pět 1m svíček jedné 5m svíčky v rozsahu low–high. */
const fiveMinutes = (start: number, low: number, high: number): MarketCandle[] =>
  Array.from({ length: 5 }, (_, index) => bar(start + index, low + 0.25, high, low, high - 0.25));

describe('HTF FVG', () => {
  it('applies only to a lower chart timeframe that nests into the higher one', () => {
    expect(htfFvgApplies('1m', '5m')).toBe(true);
    expect(htfFvgApplies('5m', '1h')).toBe(true);
    expect(htfFvgApplies('5m', '5m')).toBe(false);
    expect(htfFvgApplies('15m', '5m')).toBe(false);
    expect(htfFvgApplies('3m', '5m')).toBe(false);
  });

  it('finds a 5m gap on 1m candles only after the third 5m candle closes, drawn from the middle candle', () => {
    const candles = [
      ...fiveMinutes(0, 100, 101),
      ...fiveMinutes(5, 101, 104),
      ...fiveMinutes(10, 102, 105),
    ];
    // Třetí 5m svíčka ještě běží (poslední 1m svíčka 10:14 neuzavřená) → nic.
    expect(calculateHtfFairValueGaps(candles, '1m', '5m', false)).toEqual([]);
    // Bez poslední minuty není 5m svíčka celá ani v replayi.
    expect(calculateHtfFairValueGaps(candles.slice(0, -1), '1m', '5m', true)).toEqual([]);
    const [gap] = calculateHtfFairValueGaps(candles, '1m', '5m', true);
    expect(gap).toMatchObject({ direction: 'bullish', top: 102, bottom: 101, drawFrom: T0 + 5 * 60, startTime: T0 + 14 * 60, mitigated: false });
    // Stejné zóny jako 5m graf aplikace (zarovnání na session).
    const htf = aggregateCandles(candles, '5m');
    expect(htf.map(candle => candle.time)).toEqual([T0, T0 + 300, T0 + 600]);
    expect(htf[2].low).toBe(gap.top);
    expect(htf[0].high).toBe(gap.bottom);
  });

  it('fills on chart candles after confirmation: touch, grey steps, then ends on a full fill', () => {
    const base = [...fiveMinutes(0, 100, 101), ...fiveMinutes(5, 101, 104), ...fiveMinutes(10, 102, 105)];
    const touched = calculateHtfFairValueGaps([...base, bar(15, 103, 103.5, 101.5, 103)], '1m', '5m', true);
    expect(touched[0]).toMatchObject({ touched: true, mitigated: false });
    expect(touched[0].mitigationSteps).toEqual([{ time: T0 + 15 * 60, remainingTop: 101.5, remainingBottom: 101, filledTop: 102, filledBottom: 101.5 }]);
    const filled = calculateHtfFairValueGaps([...base, bar(15, 103, 103.5, 101.5, 103), bar(16, 102, 102.5, 100.75, 102)], '1m', '5m', true);
    expect(filled[0]).toMatchObject({ mitigated: true, endTime: T0 + 16 * 60 });
  });

  it('detects bearish gaps and ignores overlapping candles', () => {
    const bearish = calculateHtfFairValueGaps([
      ...fiveMinutes(0, 104, 105), ...fiveMinutes(5, 101, 104), ...fiveMinutes(10, 100, 103),
    ], '1m', '5m', true);
    expect(bearish).toEqual([expect.objectContaining({ direction: 'bearish', top: 104, bottom: 103 })]);
    expect(calculateHtfFairValueGaps([
      ...fiveMinutes(0, 100, 102), ...fiveMinutes(5, 101, 104), ...fiveMinutes(10, 101.5, 105),
    ], '1m', '5m', true)).toEqual([]);
  });

  it('buckets 1h and 4h by the CME session like the app charts', () => {
    // 4h svíčky od 18:00 NY (18, 22, 02, 06, 10, 14): 10:00 NY = 14:00 UTC (EDT) je začátek svíčky.
    expect(timeframeBucketStart(T0, '4h')).toBe(T0);
    expect(timeframeBucketStart(T0 + 59 * 60, '1h')).toBe(T0);
    const rising = Array.from({ length: 12 * 60 }, (_, minute) => bar(minute, 100 + minute / 60, 100.5 + minute / 60, 99.5 + minute / 60, 100 + minute / 60));
    const gaps = calculateHtfFairValueGaps(rising, '1m', '4h', true);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ direction: 'bullish', drawFrom: T0 + 4 * 3600, startTime: T0 + (12 * 60 - 1) * 60 });
  });

  it('finds the same zones as the FVG on the app 5m chart (detection), on jumpy synthetic 1m data', () => {
    const quarter = (value: number) => Math.round(value * 4) / 4;
    const price = (minute: number) => quarter(100 + Math.sin(minute / 8) * 3 + Math.sin(minute / 57) * 2 + 3 * Math.floor(minute / 45) * (Math.floor(minute / 270) % 2 ? -1 : 1));
    const minutes = Array.from({ length: 600 }, (_, index) => {
      const open = price(index), close = price(index + 1);
      return bar(index, open, Math.max(open, close) + 0.5 + (index % 4) * 0.25, Math.min(open, close) - 0.5 - ((index + 2) % 4) * 0.25, close);
    });
    const htf = calculateHtfFairValueGaps(minutes, '1m', '5m', true);
    const fiveMinuteChart = updateFairValueGapAccumulator(null, aggregateCandles(minutes, '5m')).gaps;
    expect(htf.length).toBeGreaterThan(3);
    expect(htf.map(gap => [gap.direction, gap.top, gap.bottom])).toEqual(fiveMinuteChart.map(gap => [gap.direction, gap.top, gap.bottom]));
  });

  it('treats a replayed chart candle above 1m as closed only with the cursor on its last minute', () => {
    const base = { chartTimeframe: '5m' as const, replayActive: true, nowSeconds: 0 };
    expect(htfLastCandleClosed({ ...base, lastTime: T0, replayCursorTime: T0 + 3 * 60 })).toBe(false);
    expect(htfLastCandleClosed({ ...base, lastTime: T0, replayCursorTime: T0 + 4 * 60 })).toBe(true);
    expect(htfLastCandleClosed({ ...base, chartTimeframe: '1m', lastTime: T0, replayCursorTime: T0 })).toBe(true);
    expect(htfLastCandleClosed({ ...base, replayActive: false, lastTime: T0, replayCursorTime: null, nowSeconds: T0 + 299 })).toBe(false);
    expect(htfLastCandleClosed({ ...base, replayActive: false, lastTime: T0, replayCursorTime: null, nowSeconds: T0 + 300 })).toBe(true);
    expect(htfLastCandleClosed({ ...base, lastTime: undefined, replayCursorTime: T0 })).toBe(false);
  });

  it('on a 5m replay chart with 1h HTF a zone waits for the whole third hour, not a partial 5m candle', () => {
    // Tři hodiny 1m dat: 3. hodina má low 102, ale v poslední minutě knot na 100.5 (zónu zruší).
    const minutes = Array.from({ length: 180 }, (_, minute) => {
      const hour = Math.floor(minute / 60);
      const [low, high] = hour === 0 ? [100, 101] : hour === 1 ? [101, 104] : [102, 105];
      return bar(minute, low + 0.25, high, minute === 179 ? 100.5 : low, high - 0.25);
    });
    const at = (cursorMinute: number) => {
      const revealed = minutes.slice(0, cursorMinute + 1);
      const chart = aggregateCandles(revealed, '5m');
      const closed = htfLastCandleClosed({ lastTime: chart.at(-1)!.time, chartTimeframe: '5m', replayActive: true, replayCursorTime: T0 + cursorMinute * 60, nowSeconds: 0 });
      return calculateHtfFairValueGaps(chart, '5m', '1h', closed);
    };
    expect(at(176)).toEqual([]);
    expect(at(178)).toEqual([]);
    // S posledním knotem je 3. hodina pod high 1. hodiny → žádná zóna, nic předčasného předtím.
    expect(at(179)).toEqual([]);
  });

  it('4h zones match the app 4h chart across the US DST change (1. 11. 2026)', () => {
    const quarter = (value: number) => Math.round(value * 4) / 4;
    const start = Date.parse('2026-10-29T22:00:00Z') / 1000;
    const minutes: MarketCandle[] = [];
    for (let index = 0; index < 7 * 24 * 60; index += 1) {
      const time = start + index * 60;
      const ny = new Date(time * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit' });
      if (/Sat|Sun 0|Sun 1[0-7]|Fri (1[7-9]|2)/.test(ny) || / 17$/.test(ny)) continue;
      const open = quarter(100 + Math.sin(index / 300) * 20 + 6 * Math.floor(index / 700));
      const close = quarter(100 + Math.sin((index + 1) / 300) * 20 + 6 * Math.floor((index + 1) / 700));
      minutes.push({ time, open, high: Math.max(open, close) + 0.5 + (index % 4) * 0.25, low: Math.min(open, close) - 0.5 - ((index + 2) % 4) * 0.25, close, volume: 1 });
    }
    const htf = calculateHtfFairValueGaps(minutes, '1m', '4h', true);
    const chart = aggregateCandles(minutes, '4h');
    const lastBucket = chart.at(-1)!.time;
    const fourHourChart = updateFairValueGapAccumulator(null, chart).gaps.filter(gap => gap.startTime < lastBucket);
    expect(fourHourChart.length).toBeGreaterThan(2);
    expect(htf.filter(gap => timeframeBucketStart(gap.startTime, '4h') < lastBucket).map(gap => [gap.direction, gap.top, gap.bottom]))
      .toEqual(fourHourChart.map(gap => [gap.direction, gap.top, gap.bottom]));
  });

  it('lets the forming chart candle touch and shrink an open zone, never end it', () => {
    const base = [...fiveMinutes(0, 100, 101), ...fiveMinutes(5, 101, 104), ...fiveMinutes(10, 102, 105)];
    const gaps = calculateHtfFairValueGaps(base, '1m', '5m', true);
    const live = htfFairValueGapsWithFormingBars(gaps, base.at(-1)!.time, [bar(15, 102, 102.5, 99, 100)]);
    expect(live[0]).toMatchObject({ touched: true, mitigated: false });
    expect(live[0].mitigationSteps.at(-1)).toMatchObject({ remainingTop: 101, remainingBottom: 101 });
    // Zdroj se nemění.
    expect(gaps[0].touched).toBe(false);
    expect(htfFairValueGapsWithFormingBars(gaps, base.at(-1)!.time, [])).toEqual(gaps);
  });
});

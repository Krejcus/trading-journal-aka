import { describe, expect, it } from 'vitest';
import { aggregateCandles, calculateIndicators, calculateMarketStructure, findEntryFairValueGap, findEntryStructureEvent, findFairValueGaps, marketDataWindowForEntry, resolveMarketSymbol, type MarketCandle } from '../services/marketData';

const candle = (time: number, open: number, high: number, low: number, close: number, volume = 1): MarketCandle =>
  ({ time, open, high, low, close, volume });

describe('marketData', () => {
  it('prioritises an MNQ equivalent of an imported NQ contract', () => {
    expect(resolveMarketSymbol('MNQ', 'NQU6')).toBe('MNQU6');
    expect(resolveMarketSymbol('MNQ', 'MNQ')).toBe('MNQ.v.0');
    expect(resolveMarketSymbol('NQ', 'MNQU6')).toBe('NQU6');
  });

  it('reuses one provider window and stops at the end of the Prague trade day', () => {
    const morning = marketDataWindowForEntry(Date.parse('2026-07-30T08:01:00Z'));
    const afternoon = marketDataWindowForEntry(Date.parse('2026-07-30T19:59:00Z'));
    expect(morning.start.toISOString()).toBe('2026-07-15T22:00:00.000Z');
    expect(morning.end.toISOString()).toBe('2026-07-30T22:00:00.000Z');
    expect(afternoon).toEqual(morning);
    expect(morning.end.getTime() - morning.start.getTime()).toBe(15 * 24 * 60 * 60 * 1000);
  });

  it('aggregates OHLCV without looking outside its bucket', () => {
    const source = [
      candle(0, 10, 12, 9, 11, 2),
      candle(60, 11, 13, 10, 12, 3),
      candle(300, 20, 21, 19, 20, 4),
    ];
    expect(aggregateCandles(source, '5m')).toEqual([
      candle(0, 10, 13, 9, 12, 5),
      candle(300, 20, 21, 19, 20, 4),
    ]);
  });

  it('aligns 4h and daily bars to the 18:00 New York CME session open', () => {
    const source = [
      candle(Date.parse('2026-07-30T22:00:00Z') / 1000, 10, 12, 9, 11, 2),
      candle(Date.parse('2026-07-30T23:59:00Z') / 1000, 11, 13, 10, 12, 3),
      candle(Date.parse('2026-07-31T02:00:00Z') / 1000, 20, 21, 19, 20, 4),
    ];
    expect(aggregateCandles(source, '4h').map(bar => bar.time)).toEqual([
      Date.parse('2026-07-30T22:00:00Z') / 1000,
      Date.parse('2026-07-31T02:00:00Z') / 1000,
    ]);
    expect(aggregateCandles(source, '1d')).toEqual([
      candle(Date.parse('2026-07-30T22:00:00Z') / 1000, 10, 21, 9, 20, 9),
    ]);
  });

  it('calculates progressive VWAP and session extremes', () => {
    const source = [
      candle(Date.parse('2026-07-27T22:00:00Z') / 1000, 100, 102, 99, 101, 10),
      candle(Date.parse('2026-07-27T22:01:00Z') / 1000, 101, 104, 100, 103, 10),
    ];
    const indicators = calculateIndicators(source);
    expect(indicators.vwap).toHaveLength(2);
    expect(indicators.sessionHigh.map(p => p.value)).toEqual([102, 104]);
    expect(indicators.sessionLow.map(p => p.value)).toEqual([99, 99]);
  });

  it('carries only completed prior-day and prior-week levels into a new CME session', () => {
    const source = [
      candle(Date.parse('2026-07-12T22:00:00Z') / 1000, 100, 105, 95, 102, 10), // prior Monday
      candle(Date.parse('2026-07-13T22:00:00Z') / 1000, 102, 110, 98, 108, 10),
      candle(Date.parse('2026-07-16T22:00:00Z') / 1000, 108, 112, 97, 101, 10), // prior Friday
      candle(Date.parse('2026-07-19T22:00:00Z') / 1000, 120, 123, 118, 122, 10), // current Monday
      candle(Date.parse('2026-07-19T22:01:00Z') / 1000, 122, 130, 119, 129, 10),
    ];
    const indicators = calculateIndicators(source);
    const currentMonday = source[3].time;
    expect(indicators.pdh.find(point => point.time === currentMonday)?.value).toBe(112);
    expect(indicators.pdl.find(point => point.time === currentMonday)?.value).toBe(97);
    expect(indicators.pwh.find(point => point.time === currentMonday)?.value).toBe(112);
    expect(indicators.pwl.find(point => point.time === currentMonday)?.value).toBe(95);
    // Progressive session high proves the first current-session point cannot see candle 5.
    expect(indicators.sessionHigh.slice(-2).map(point => point.value)).toEqual([123, 130]);
  });

  it('confirms a three-candle FVG only on the third candle and tracks mitigation', () => {
    const source = [
      candle(0, 100, 101, 99, 100),
      candle(60, 101, 104, 101, 103),
      candle(120, 104, 106, 103, 105),
      candle(180, 105, 105, 100, 101),
    ];
    const gaps = findFairValueGaps(source);
    expect(gaps[0]).toMatchObject({ direction: 'bullish', startTime: 120, bottom: 101, top: 103, mitigated: true, endTime: 180 });
    expect(findEntryFairValueGap(gaps, 180, 102.5, 'long')).toBe(gaps[0]);
    expect(findEntryFairValueGap(gaps, 180, 102.5, 'short')).toBeNull();
  });

  it('tracks Pine-style stepped partial FVG mitigation from candle wicks', () => {
    const source = [
      candle(0, 100, 101, 99, 100),
      candle(60, 101, 104, 101, 103),
      candle(120, 104, 106, 105, 105.5), // bullish FVG 101-105
      candle(180, 105, 106, 104, 105),   // fills 104-105
      candle(240, 104, 105, 103, 104),   // fills 103-104
      candle(300, 104, 105, 102, 103),
    ];

    const gap = findFairValueGaps(source)[0];
    expect(gap).toMatchObject({ touched: true, mitigated: false, endTime: 300 });
    expect(gap.mitigationSteps).toEqual([
      { time: 180, remainingTop: 104, remainingBottom: 101, filledTop: 105, filledBottom: 104 },
      { time: 240, remainingTop: 103, remainingBottom: 101, filledTop: 104, filledBottom: 103 },
      { time: 300, remainingTop: 102, remainingBottom: 101, filledTop: 103, filledBottom: 102 },
    ]);
  });

  it('tracks bearish partial FVG steps from the lower edge upward', () => {
    const source = [
      candle(0, 110, 111, 109, 110),
      candle(60, 108, 109, 106, 107),
      candle(120, 104, 105, 102, 103), // bearish FVG 105-109
      candle(180, 104, 106, 103, 105),
      candle(240, 106, 108, 105, 107),
    ];

    const gap = findFairValueGaps(source)[0];
    expect(gap).toMatchObject({ direction: 'bearish', touched: true, mitigated: false });
    expect(gap.mitigationSteps).toEqual([
      { time: 180, remainingTop: 109, remainingBottom: 106, filledTop: 106, filledBottom: 105 },
      { time: 240, remainingTop: 109, remainingBottom: 108, filledTop: 108, filledBottom: 106 },
    ]);
  });

  it('matches the 1m Pine CHoCH/BOS trend classification and pivot-to-break geometry', () => {
    const source = [
      candle(0, 10, 10, 8, 9),
      candle(60, 9, 12, 9, 11),       // pivot high 12
      candle(120, 11, 11, 9, 10),     // confirms pivot high
      candle(180, 10, 13, 10, 12.5),  // bullish CHoCH through 12
      candle(240, 12.5, 14, 12, 13),  // next pivot high 14
      candle(300, 13, 13.5, 11, 12),  // confirms pivot high
      candle(360, 12, 15, 12, 14.5),  // bullish continuation BOS through 14
      candle(420, 14.5, 15, 10, 11),  // pivot low 10
      candle(480, 11, 14, 11, 13),    // confirms pivot low
      candle(540, 13, 13, 9, 9.5),    // bearish CHoCH through 10
    ];

    const events = calculateMarketStructure(source);
    expect(events.map(event => ({
      type: event.type,
      direction: event.direction,
      pivotTime: event.pivotTime,
      breakTime: event.breakTime,
      price: event.price,
    }))).toEqual([
      { type: 'CHoCH', direction: 'bullish', pivotTime: 60, breakTime: 180, price: 12 },
      { type: 'BOS', direction: 'bullish', pivotTime: 240, breakTime: 360, price: 14 },
      { type: 'CHoCH', direction: 'bearish', pivotTime: 420, breakTime: 540, price: 10 },
    ]);
    expect(findEntryStructureEvent(events, 400, 'long', 'BOS')).toBe(events[1]);
    expect(findEntryStructureEvent(events, 400, 'short', 'CHoCH')).toBeNull();
  });
});

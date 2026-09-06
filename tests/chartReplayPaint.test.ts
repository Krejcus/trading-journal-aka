import { describe, expect, it } from 'vitest';
import { retainEqualNumbers, sharedRevealedCandles, uniqueStructureEvents } from '../services/chartReplayPaint';
import { aggregateCandles, updateFairValueGapAccumulator, type FairValueGapAccumulator, type MarketCandle, type MarketStructureEvent, type MarketTimeframe } from '../services/marketDataCalculations';
import { previousDayCloseAnchor, sessionBreakTimes, updateSessionBreakAccumulator, visibleHighLowAnchors } from '../services/chartSettingsApply';

const synthetic = (count: number): MarketCandle[] => {
  let seed = 81273;
  let price = 100;
  return Array.from({ length: count }, (_, index) => {
    seed = (seed * 16807) % 2147483647;
    const open = price;
    price += (seed % 19 - 9) / 4;
    return { time: Date.parse('2026-03-06T14:00:00Z') / 1000 + index * 60,
      open, close: price, high: Math.max(open, price) + .25, low: Math.min(open, price) - .25, volume: 10 };
  });
};
const trackReads = <T>(source: T[]) => {
  let reads = 0;
  return { input: new Proxy(source, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
    return Reflect.get(target, key, receiver);
  } }), reads: () => reads };
};

describe('replay paint work stays bounded by changed data', () => {
  it('shares only the revealed prefix between panels, supports rewind and a replaced source', () => {
    const source = synthetic(100);
    const revealed = sharedRevealedCandles(source, 30);
    expect(sharedRevealedCandles(source, 30)).toBe(revealed);
    expect(revealed).toEqual(source.slice(0, 30));
    expect(sharedRevealedCandles(source, 10)).toEqual(source.slice(0, 10));
    expect(revealed).toHaveLength(30);
    expect(sharedRevealedCandles([...source], 30)).not.toBe(revealed);
    expect(sharedRevealedCandles(source, source.length)).toBe(source);
  });

  it('deduplicates structure in first-seen order with the exact existing overlay key', () => {
    const event: MarketStructureEvent = { type: 'BOS', direction: 'bullish', pivotTime: 1, breakTime: 2, price: 3, labelPrice: 4 };
    const other = { ...event, price: 4 };
    const source = [event, { ...event, direction: 'bearish' as const }, other, event];
    expect(uniqueStructureEvents(source)).toEqual([event, other]);
    expect(uniqueStructureEvents(source)[0]).toBe(event);
    expect(retainEqualNumbers([], [])).toEqual([]);
    const offsets = [1, 2];
    expect(retainEqualNumbers(offsets, [1, 2])).toBe(offsets);
    expect(retainEqualNumbers(offsets, [1, 3])).not.toBe(offsets);
  });

  it('reads only visible bars plus a binary search for extremes, and logarithmic bars for PDC', () => {
    const candles = synthetic(14_000);
    const tracked = trackReads(candles);
    const range = { from: candles[13_700].time, to: candles[13_830].time };
    expect(visibleHighLowAnchors(tracked.input, range)).toEqual(visibleHighLowAnchors(candles.slice(13_700, 13_831), null));
    expect(tracked.reads()).toBeLessThan(160);
    const pdc = trackReads(candles);
    expect(previousDayCloseAnchor(pdc.input, 'Europe/Prague')).not.toBeNull();
    expect(pdc.reads()).toBeLessThan(20);
  });

  it('maintains calendar boundary parity through DST, append, same HTF time, prepend, rewind and timezone changes', () => {
    const candles = synthetic(7_000);
    let previous = updateSessionBreakAccumulator(null, candles.slice(500, 2000), 'America/New_York');
    for (const next of [candles.slice(500, 3000), candles.slice(500, 3000), candles.slice(0, 3000), candles.slice(0, 1000), candles]) {
      previous = updateSessionBreakAccumulator(previous, next, 'America/New_York');
      expect(previous.breaks).toEqual(sessionBreakTimes(next, 'America/New_York'));
    }
    expect(updateSessionBreakAccumulator(previous, candles, 'America/New_York')).toBe(previous);
    expect(updateSessionBreakAccumulator(previous, candles, 'Europe/Prague').breaks).toEqual(sessionBreakTimes(candles, 'Europe/Prague'));
  });
});

describe('FVG open-bar checkpoint', () => {
  it.each(['1m', '5m', '15m'] as MarketTimeframe[])('matches a full rebuild at every revealed horizon on %s without mutating earlier states', timeframe => {
    const source = synthetic(1_800);
    let previous: FairValueGapAccumulator | null = null;
    for (let count = 1_501; count <= 1_545; count += 1) {
      const candles = aggregateCandles(source.slice(0, count), timeframe);
      const before = previous ? JSON.stringify(previous.gaps) : null;
      const next = updateFairValueGapAccumulator(previous, candles);
      expect(next.gaps).toEqual(updateFairValueGapAccumulator(null, candles).gaps);
      if (previous) expect(JSON.stringify(previous.gaps)).toBe(before);
      previous = next;
    }
    // A large jump and a rewind retain exactly the same indicator semantics.
    for (const count of [1_650, 900, 1_755]) {
      const candles = aggregateCandles(source.slice(0, count), timeframe);
      previous = updateFairValueGapAccumulator(previous, candles);
      expect(previous.gaps).toEqual(updateFairValueGapAccumulator(null, candles).gaps);
    }
  });

  it('replaces an open tail without reading the closed history or retaining future mitigation', () => {
    const candles = synthetic(14_000);
    const previous = updateFairValueGapAccumulator(null, candles);
    const changed = [...candles];
    changed[changed.length - 1] = { ...changed.at(-1)!, high: 100_000, low: -100_000, close: -100_000 };
    const tracked = trackReads(changed);
    const next = updateFairValueGapAccumulator(previous, tracked.input);
    expect(tracked.reads()).toBeLessThan(12);
    expect(next.gaps).toEqual(updateFairValueGapAccumulator(null, changed).gaps);
    const restored = updateFairValueGapAccumulator(next, candles);
    expect(restored.gaps).toEqual(previous.gaps);
    expect(restored.tailCheckpoint).not.toHaveProperty('tailCheckpoint');
  });

  it('rebuilds when an append also changes the formerly open bar, and on a history prepend', () => {
    const candles = synthetic(100);
    const previous = updateFairValueGapAccumulator(null, candles.slice(20, 90));
    const changed = candles.slice(20, 95);
    changed[69] = { ...changed[69], low: -1000, close: -1000 };
    const next = updateFairValueGapAccumulator(previous, changed);
    expect(next.gaps).toEqual(updateFairValueGapAccumulator(null, changed).gaps);
    expect(updateFairValueGapAccumulator(next, candles).gaps).toEqual(updateFairValueGapAccumulator(null, candles).gaps);
  });
});

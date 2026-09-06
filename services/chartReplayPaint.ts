import type { MarketCandle, MarketStructureEvent } from './marketDataCalculations';

// Panels sharing one source and cursor can share its immutable revealed prefix.
// Keep only the latest prefix; old replay views must not accumulate in a cache.
const revealedPrefixes = new WeakMap<MarketCandle[], { count: number; candles: MarketCandle[] }>();
export const sharedRevealedCandles = (source: MarketCandle[], count: number): MarketCandle[] => {
  const safeCount = Math.max(0, Math.min(source.length, count));
  if (safeCount === source.length) return source;
  const previous = revealedPrefixes.get(source);
  if (previous?.count === safeCount) return previous.candles;
  const candles = source.slice(0, safeCount);
  revealedPrefixes.set(source, { count: safeCount, candles });
  return candles;
};

/** Same first-wins key and order as the overlay's former quadratic findIndex. */
export const uniqueStructureEvents = (events: MarketStructureEvent[]): MarketStructureEvent[] => {
  const seen = new Set<string>();
  return events.filter(event => {
    const key = JSON.stringify([event.pivotTime, event.breakTime, event.price, event.type]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const retainEqualNumbers = (previous: number[], next: number[]): number[] =>
  previous.length === next.length && previous.every((value, index) => value === next[index]) ? previous : next;

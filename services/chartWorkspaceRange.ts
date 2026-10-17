import type { MarketCandle } from './marketData';

export interface ChartLogicalRange {
  from: number;
  to: number;
}

/** Volné místo vpravo od poslední svíčky — stejné jako `rightOffset` grafu. */
const RIGHT_OFFSET_BARS = 6;

const firstIndexAtOrAfter = (candles: readonly MarketCandle[], unixSeconds: number): number => {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (candles[middle].time < unixSeconds) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * Logický rozsah pro rychlý rozsah ve spodním řádku („posledních 1H“).
 * Počítá se přes indexy, ne přes časy: časová osa má díry (pauzy, víkendy)
 * a `setVisibleRange` by hranici posunul na nejbližší existující bar po svém.
 */
export const logicalRangeForLastSeconds = (
  candles: readonly MarketCandle[],
  seconds: number | null,
): ChartLogicalRange | null => {
  if (candles.length === 0) return null;
  const lastIndex = candles.length - 1;
  const fromIndex = seconds === null || !Number.isFinite(seconds)
    ? 0
    : Math.min(lastIndex, firstIndexAtOrAfter(candles, candles[lastIndex].time - Math.max(0, seconds)));
  // Aspoň pár svíček, ať krátký rozsah na vyšším timeframu není jedna svíčka přes celý graf.
  const from = Math.min(fromIndex, lastIndex - 10);
  return { from, to: lastIndex + RIGHT_OFFSET_BARS };
};

/**
 * Rozsah se svíčkou nejbližší danému času uprostřed; šířka pohledu zůstává.
 * Čas mimo načtená data vrací null — graf má jen okno kolem obchodu.
 */
export const logicalRangeCenteredOn = (
  candles: readonly MarketCandle[],
  unixSeconds: number,
  currentSpan: number,
): ChartLogicalRange | null => {
  if (candles.length === 0 || !Number.isFinite(unixSeconds)) return null;
  const first = candles[0].time;
  const last = candles[candles.length - 1].time;
  if (unixSeconds < first || unixSeconds > last) return null;
  const after = Math.min(candles.length - 1, firstIndexAtOrAfter(candles, unixSeconds));
  const before = Math.max(0, after - 1);
  const index = Math.abs(candles[before].time - unixSeconds) <= Math.abs(candles[after].time - unixSeconds) ? before : after;
  const span = Number.isFinite(currentSpan) && currentSpan > 1 ? currentSpan : 120;
  return { from: index - span / 2, to: index + span / 2 };
};

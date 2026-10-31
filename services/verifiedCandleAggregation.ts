import { aggregateCandles, type MarketCandle, type MarketTimeframe } from './marketDataCalculations';

interface Entry { input: Float64Array; results: Map<MarketTimeframe, MarketCandle[]> }
const cache = new WeakMap<MarketCandle[], Entry>();
function sameInput(rows: MarketCandle[], input: Float64Array): boolean {
  if (input.length !== rows.length * 6) return false;
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i], j = i * 6;
    if (c.time !== input[j] || c.open !== input[j + 1] || c.high !== input[j + 2]
      || c.low !== input[j + 3] || c.close !== input[j + 4] || c.volume !== input[j + 5]) return false;
  }
  return true;
}
function snapshot(rows: MarketCandle[]): Float64Array {
  const input = new Float64Array(rows.length * 6);
  rows.forEach((c, i) => { const j = i * 6; input[j] = c.time; input[j + 1] = c.open; input[j + 2] = c.high; input[j + 3] = c.low; input[j + 4] = c.close; input[j + 5] = c.volume; });
  return input;
}
const copy = (rows: MarketCandle[]) => rows.map(c => ({ ...c }));

/** Reuse completed timeframe calculations only after checking every input
 * value. Copies isolate the private cache from mutable chart consumers. */
export function aggregateVerifiedCandles(rows: MarketCandle[], timeframe: MarketTimeframe): MarketCandle[] {
  if (timeframe === '1m') return aggregateCandles(rows, timeframe);
  let entry = cache.get(rows);
  if (!entry || !sameInput(rows, entry.input)) {
    entry = { input: snapshot(rows), results: new Map() };
    cache.set(rows, entry);
  }
  const found = entry.results.get(timeframe);
  if (found) return copy(found);
  const result = aggregateCandles(rows, timeframe);
  if (entry.results.size >= 12) entry.results.delete(entry.results.keys().next().value!);
  entry.results.set(timeframe, copy(result));
  return result;
}

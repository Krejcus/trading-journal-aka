import type { MarketCandle } from './marketDataCalculations';

export const stableBacktestJson = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableBacktestJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stableBacktestJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
type HashState = readonly [number, number];
const initial: HashState = [0x811c9dc5, 0x9e3779b9];
const feed = (state: HashState, text: string): HashState => {
  let [left, right] = state;
  for (let index = 0; index < text.length; index++) {
    left = Math.imul(left ^ text.charCodeAt(index), 0x01000193);
    right = Math.imul(right ^ text.charCodeAt(index), 0x85ebca6b);
  }
  return [left, right];
};
const finish = ([left, right]: HashState) => `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
export const backtestChangeHash = (value: unknown) => finish(feed(initial, stableBacktestJson(value)));

export interface BacktestAnalyticsSource {
  candles: readonly MarketCandle[];
  htfCandles?: readonly MarketCandle[];
  hash: string;
}
const upperBound = (bars: readonly MarketCandle[], horizon: number) => {
  let low = 0; let high = bars.length;
  while (low < high) { const mid = (low + high) >>> 1; if (bars[mid].time <= horizon) low = mid + 1; else high = mid; }
  return low;
};
const ordered = (bars: readonly MarketCandle[]) => bars.every((bar, index) => Number.isFinite(bar.time) && (!index || bars[index - 1].time <= bar.time));

/** Session-local cache. Inputs are immutable snapshots (the worker owns clones).
 * Keeps the exact v1 hash encoding; only revealed OHLCV is serialized. Replacing
 * either input array invalidates its prefix states, including same-time repairs.
 */
export const createBacktestAnalyticsSourceCache = (maxDatasets = 4, maxWindows = 128) => {
  type Dataset = { candles: readonly MarketCandle[]; htf?: readonly MarketCandle[]; ordered: boolean;
    states: HashState[]; htfText: string[]; windows: Map<string, BacktestAnalyticsSource>; materialized: Map<string, { candles: readonly MarketCandle[]; htfCandles?: readonly MarketCandle[] }> };
  let datasets: Dataset[] = [];
  const diagnostics = { candleSerializations: 0, sourceHashes: 0 };
  return {
    diagnostics,
    clear() { datasets = []; },
    get(candles: readonly MarketCandle[], htf: readonly MarketCandle[] | undefined, horizon: number): BacktestAnalyticsSource {
      let data = datasets.find(item => item.candles === candles && item.htf === htf);
      if (!data) {
        data = { candles, htf, ordered: ordered(candles) && (!htf || ordered(htf)), states: [feed(initial, '{"candles":[')], htfText: [], windows: new Map(), materialized: new Map() };
        datasets.push(data); if (datasets.length > Math.max(1, maxDatasets)) datasets.shift();
      }
      const count = data.ordered ? upperBound(candles, horizon) : -1;
      const hourlyCount = data.ordered && htf ? upperBound(htf, horizon) : 0;
      const key = data.ordered ? `${count}:${hourlyCount}` : `time:${horizon}`;
      const cached = data.windows.get(key);
      if (cached) { data.windows.delete(key); data.windows.set(key, cached); return cached; }
      const materialize = () => {
        const hit = data.materialized.get(key);
        if (hit) { data.materialized.delete(key); data.materialized.set(key, hit); return hit; }
        const value = { candles: data.ordered ? candles.slice(0, count) : candles.filter(bar => bar.time <= horizon),
          htfCandles: htf ? data.ordered ? htf.slice(0, hourlyCount) : htf.filter(bar => bar.time <= horizon) : undefined };
        data.materialized.set(key, value);
        // Idle hash checks do not retain one full candle prefix per closed trade.
        if (data.materialized.size > 8) data.materialized.delete(data.materialized.keys().next().value!);
        return value;
      };
      let hash: string;
      if (!data.ordered) {
        hash = backtestChangeHash(materialize());
      } else {
        while (data.states.length <= count) {
          const index = data.states.length - 1;
          data.states.push(feed(data.states[index], `${index ? ',' : ''}${stableBacktestJson(candles[index])}`));
          diagnostics.candleSerializations++;
        }
        while (data.htfText.length < hourlyCount) {
          data.htfText.push(stableBacktestJson(htf![data.htfText.length])); diagnostics.candleSerializations++;
        }
        const suffix = `],"htfCandles":${htf ? `[${data.htfText.slice(0, hourlyCount).join(',')}]` : 'null'}}`;
        hash = finish(feed(data.states[count], suffix));
      }
      const source: BacktestAnalyticsSource = { hash,
        get candles() { return materialize().candles; }, get htfCandles() { return materialize().htfCandles; } };
      diagnostics.sourceHashes++;
      data.windows.set(key, source);
      if (data.windows.size > Math.max(1, maxWindows)) data.windows.delete(data.windows.keys().next().value!);
      return source;
    },
  };
};

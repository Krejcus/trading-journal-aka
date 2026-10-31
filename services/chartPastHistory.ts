import type { MarketCandle, MarketCandleResponse, MarketDataSchema } from './marketDataCalculations';

export interface PastHistorySnapshot {
  candles: readonly MarketCandle[];
  startMs: number | null;
  endMs: number | null;
  loading: boolean;
  error: string | null;
  revision: number;
}
export type HistoryLoader = (request: { symbol: string; schema: MarketDataSchema; start: Date; end: Date }) => Promise<MarketCandleResponse>;

export function validateHistoryPage(page: MarketCandleResponse, symbol: string, schema: MarketDataSchema, startMs: number, endMs: number): MarketCandle[] {
  if (page.symbol !== symbol || page.schema !== schema) throw new Error('Historie patří jinému trhu nebo rozlišení.');
  if (!Number.isFinite(Date.parse(page.start)) || Date.parse(page.start) > startMs || Date.parse(page.end) < endMs || !Number.isFinite(Date.parse(page.end))) throw new Error('Zdroj nepotvrdil celé požadované období historie.');
  const byTime = new Map<number, MarketCandle>();
  for (const c of page.candles) {
    if (![c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
      || c.time * 1000 < startMs || c.time * 1000 >= endMs
      || c.time % (schema === 'ohlcv-1h' ? 3600 : 60) !== 0
      || Math.min(c.open, c.high, c.low, c.close) <= 0 || c.volume < 0
      || c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close)) continue;
    // A malformed row must not discard an otherwise authenticated page.
    // For duplicate timestamps retain the first valid observation.
    if (!byTime.has(c.time)) byTime.set(c.time, { ...c });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

const missingCoverage = (start: number, end: number, coverage: readonly (readonly [number, number])[]) => {
  const ranges: Array<[number, number]> = [];
  let cursor = start;
  for (const [coveredStart, coveredEnd] of coverage) {
    if (coveredEnd <= cursor) continue;
    if (coveredStart >= end) break;
    if (coveredStart > cursor) ranges.push([cursor, Math.min(coveredStart, end)]);
    cursor = Math.max(cursor, coveredEnd);
    if (cursor >= end) break;
  }
  if (cursor < end) ranges.push([cursor, end]);
  return ranges;
};

const addCoverage = (coverage: readonly (readonly [number, number])[], start: number, end: number): Array<[number, number]> => {
  const merged: Array<[number, number]> = [];
  for (const range of [...coverage, [start, end] as const].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (!last || range[0] > last[1]) merged.push([range[0], range[1]]);
    else last[1] = Math.max(last[1], range[1]);
  }
  return merged;
};

/** Shared immutable read model. No execution and no invented bars. */
export function createChartPastHistory(symbol: string, schema: MarketDataSchema, load: HistoryLoader) {
  let state: PastHistorySnapshot = { candles: [], startMs: null, endMs: null, loading: false, error: null, revision: 0 };
  let coverage: Array<[number, number]> = [];
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<PastHistorySnapshot>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const ensure = async (startMs: number, endMs: number): Promise<void> => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return;
    if (inFlight) { await inFlight; return ensure(startMs, endMs); }
    const ranges = missingCoverage(startMs, endMs, coverage);
    if (!ranges.length) return;
    publish({ loading: true, error: null });
    inFlight = (async () => {
      for (const [start, end] of ranges) {
        const page = await load({ symbol, schema, start: new Date(start), end: new Date(end) });
        const validCandles = validateHistoryPage(page, symbol, schema, start, end);
        const byTime = new Map(state.candles.map(c => [c.time, c]));
        validCandles.forEach(c => byTime.set(c.time, c));
        coverage = addCoverage(coverage, start, end);
        publish({
          candles: [...byTime.values()].sort((a, b) => a.time - b.time),
          startMs: coverage[0]?.[0] ?? null,
          endMs: coverage.at(-1)?.[1] ?? null,
          revision: state.revision + 1,
        });
      }
    })().catch(reason => {
      publish({ error: reason instanceof Error ? reason.message : 'Starší historii se nepodařilo načíst.' });
      throw reason;
    }).finally(() => { inFlight = null; publish({ loading: false }); });
    return inFlight;
  };
  return { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, ensure };
}

export const historyPageDays = (schema: MarketDataSchema, timeframe: string) => schema === 'ohlcv-1m' ? 14 : timeframe === 'M' ? 730 : ['1d', 'W'].includes(timeframe) ? 365 : 90;

import { completedHistoricalCandles, loadMarketCandles, MarketDataError, resolveMarketSymbol, type MarketCandle, type MarketCandleResponse, type MarketDataSchema } from './marketData';
import { backtestOlderHistoryRange } from './backtestReplayData';
import type { BacktestInstrument } from './backtestTypes';

const DAY_MS = 86_400_000;
const SEGMENT_MS = 3 * DAY_MS;
type Candles = Partial<Record<BacktestInstrument, MarketCandle[]>>;
type History = Partial<Record<BacktestInstrument, Partial<Record<MarketDataSchema, MarketCandle[]>>>>;
export interface BacktestCandleReceipt {
  root: BacktestInstrument;
  purpose: 'forward' | 'session-history' | 'context-history';
  schema: MarketDataSchema;
  symbol: string;
  startMs: number;
  endMs: number;
  response: Readonly<Pick<MarketCandleResponse, 'provider' | 'dataset' | 'schema' | 'symbol' | 'sourceSymbol' | 'start' | 'end'>> | null;
}
export interface BacktestCandleSnapshot {
  /** Successful requests, separate from observed normalized OHLCV bars. */
  provenance: readonly Readonly<BacktestCandleReceipt>[];
  candles: Candles;
  history: History;
  /** Successfully fetched contiguous forward coverage, even during a market closure. */
  loadedUntilMs: number;
}
const merge = (current: MarketCandle[] = [], incoming: MarketCandle[]) => {
  const byTime = new Map(current.map(candle => [candle.time, candle]));
  incoming.forEach(candle => byTime.set(candle.time, candle));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
};

/** Owns fetch coverage separately from replay progress. Failed requests never advance it. */
export function createBacktestCandleStore(
  run: { startAt: number; endAt: number; cursorAt: number | null; config: { instruments: BacktestInstrument[] } },
  load: typeof loadMarketCandles = loadMarketCandles,
) {
  let snapshot: BacktestCandleSnapshot = { candles: {}, history: {}, provenance: Object.freeze([]), loadedUntilMs: run.startAt };
  let initialized = false;
  let initialRequest: Promise<void> | undefined;
  let forwardChain = Promise.resolve();
  const sessionLoadedFrom: Partial<Record<BacktestInstrument, number>> = {};
  const historyLoadedFrom = new Map<string, number>();
  const olderRequests = new Map<string, Promise<void>>();
  const bounded = (candles: MarketCandle[], start: number, end: number) => candles.filter(c => c.time * 1000 >= start && c.time * 1000 < end);

  async function loadRange(params: Parameters<typeof loadMarketCandles>[0]) {
    try {
      const response = await load(params);
      const { provider, dataset, schema, symbol, sourceSymbol, start, end } = response;
      return { candles: response.candles, response: Object.freeze({ provider, dataset, schema, symbol, sourceSymbol, start, end }) };
    } catch (reason) {
      // The shared chart loader reports a successfully fetched empty market
      // window as no-data. It is valid coverage for replay (weekends/holidays).
      if (reason instanceof MarketDataError && reason.code === 'no-data') return { candles: [], response: null };
      throw reason;
    }
  }

  async function fetchForward(start: number, end: number) {
    const responses = await Promise.all(run.config.instruments.map(async root => ({
      root,
      incoming: await loadRange({ symbol: resolveMarketSymbol(root), start: new Date(start), end: new Date(end) }),
    })));
    const candles = { ...snapshot.candles };
    for (const { root, incoming } of responses) {
      candles[root] = merge(candles[root], bounded(incoming.candles, start, end));
      sessionLoadedFrom[root] = Math.min(sessionLoadedFrom[root] ?? start, start);
    }
    const receipts = responses.map(({ root, incoming }) => Object.freeze({ root, purpose: 'forward' as const,
      schema: 'ohlcv-1m' as const, symbol: resolveMarketSymbol(root), startMs: start, endMs: end, response: incoming.response }));
    snapshot = { ...snapshot, candles, loadedUntilMs: end, provenance: Object.freeze([...snapshot.provenance, ...receipts]) };
  }

  async function loadInitial() {
    if (initialized) return;
    if (!initialRequest) {
      const start = Math.max(run.startAt, (run.cursorAt ?? run.startAt) - 2 * DAY_MS);
      initialRequest = fetchForward(start, Math.min(run.endAt, start + SEGMENT_MS))
        .then(() => { initialized = true; })
        .finally(() => { initialRequest = undefined; });
    }
    await initialRequest;
  }

  async function ensureThrough(requestedEndMs: number) {
    if (!Number.isFinite(requestedEndMs)) throw new Error('Neplatný cíl načítání replaye.');
    await loadInitial();
    const end = Math.min(run.endAt, requestedEndMs);
    const job = forwardChain.catch(() => undefined).then(async () => {
      while (snapshot.loadedUntilMs < end) {
        const start = snapshot.loadedUntilMs;
        await fetchForward(start, Math.min(end, start + SEGMENT_MS));
      }
    });
    forwardChain = job;
    await job;
    return snapshot;
  }

  async function loadOlder(root: BacktestInstrument, schema: MarketDataSchema, beforeMs: number) {
    const key = `${root}:${schema}`;
    const pending = olderRequests.get(key);
    if (pending) return pending;
    const job = (async () => {
      await loadInitial();
      const range = backtestOlderHistoryRange({
        requestedBeforeMs: beforeMs, loadedFromMs: historyLoadedFrom.get(key),
        sessionStartMs: run.startAt, sessionLoadedFromMs: sessionLoadedFrom[root] ?? run.startAt, schema,
      });
      const incoming = await loadRange({
        symbol: resolveMarketSymbol(root), start: new Date(range.startMs), end: new Date(range.endMs),
        schema: range.kind === 'session' ? 'ohlcv-1m' : schema,
      });
      if (range.kind === 'session') {
        snapshot = { ...snapshot, candles: { ...snapshot.candles, [root]: merge(snapshot.candles[root], bounded(incoming.candles, range.startMs, range.endMs)) } };
        sessionLoadedFrom[root] = Math.min(sessionLoadedFrom[root] ?? range.startMs, range.startMs);
      } else {
        const safe = completedHistoricalCandles({ candles: incoming.candles, schema, endMs: range.endMs, replayStartMs: run.startAt });
        snapshot = { ...snapshot, history: { ...snapshot.history, [root]: { ...snapshot.history[root], [schema]: merge(snapshot.history[root]?.[schema], safe) } } };
      }
      const receipt = Object.freeze({ root, purpose: range.kind === 'session' ? 'session-history' as const : 'context-history' as const,
        schema: range.kind === 'session' ? 'ohlcv-1m' as const : schema, symbol: resolveMarketSymbol(root),
        startMs: range.startMs, endMs: range.endMs, response: incoming.response });
      snapshot = { ...snapshot, provenance: Object.freeze([...snapshot.provenance, receipt]) };
      historyLoadedFrom.set(key, range.startMs);
    })().finally(() => { olderRequests.delete(key); });
    olderRequests.set(key, job);
    return job;
  }

  return { getSnapshot: () => snapshot, loadInitial, ensureThrough, loadOlder };
}

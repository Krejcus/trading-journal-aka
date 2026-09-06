import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase', () => ({ supabase: {} }));
import { createBacktestCandleStore } from '../services/backtestCandleStore';
import { MarketDataError, type MarketCandle, type MarketCandleResponse, type loadMarketCandles } from '../services/marketData';
import { prepareBacktestReplayGoTo, prepareBacktestReplayStep } from '../services/backtestReplayData';
import { DEFAULT_REPLAY_GO_TO_SETTINGS } from '../services/replayGoTo';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const candle = (ms: number): MarketCandle => ({ time: ms / 1000, open: 100, high: 101, low: 99, close: 100, volume: 1 });
type Params = Parameters<typeof loadMarketCandles>[0];
const response = (params: Params, candles: MarketCandle[] = [candle(params.start.getTime())]): MarketCandleResponse => ({
  provider: 'databento', dataset: 'GLBX.MDP3', schema: params.schema ?? 'ohlcv-1m', symbol: params.symbol,
  start: params.start.toISOString(), end: params.end.toISOString(), candles,
});
const run = (overrides = {}) => ({ startAt: 0, endAt: 30 * DAY, cursorAt: null, config: { instruments: ['MNQ' as const, 'NQ' as const] }, ...overrides });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};

describe('backtest candle coverage store', () => {
  it('coalesces initialization and serializes overlapping forward coverage requests', async () => {
    const load = vi.fn(async (p: Params) => response(p));
    const store = createBacktestCandleStore(run(), load);
    await Promise.all([store.ensureThrough(7 * DAY), store.ensureThrough(9 * DAY)]);
    expect(store.getSnapshot().loadedUntilMs).toBe(9 * DAY);
    const windows = load.mock.calls.filter(([p]) => p.symbol === 'MNQ.v.0').map(([p]) => [p.start.getTime(), p.end.getTime()]);
    expect(windows).toEqual([[0, 3 * DAY], [3 * DAY, 6 * DAY], [6 * DAY, 7 * DAY], [7 * DAY, 9 * DAY]]);
  });

  it('does not commit partial cross-instrument responses and retries failed coverage', async () => {
    let fail = true;
    const load = vi.fn(async (p: Params) => {
      if (fail && p.start.getTime() === 3 * DAY && p.symbol === 'NQ.v.0') throw new Error('offline');
      return response(p);
    });
    const store = createBacktestCandleStore(run(), load);
    await expect(store.ensureThrough(6 * DAY)).rejects.toThrow('offline');
    expect(store.getSnapshot().loadedUntilMs).toBe(3 * DAY);
    expect(store.getSnapshot().candles.MNQ).toHaveLength(1);
    fail = false;
    await store.ensureThrough(6 * DAY);
    expect(store.getSnapshot().loadedUntilMs).toBe(6 * DAY);
    expect(store.getSnapshot().candles.MNQ).toHaveLength(2);
  });

  it('records successful empty market periods as coverage while preserving real errors', async () => {
    const load = vi.fn(async (p: Params) => {
      if (p.start.getTime() === 3 * DAY) throw new MarketDataError('Market closed', 'no-data');
      return response(p);
    });
    const store = createBacktestCandleStore(run(), load);
    await store.ensureThrough(9 * DAY);
    expect(store.getSnapshot().loadedUntilMs).toBe(9 * DAY);
    expect(store.getSnapshot().candles.MNQ!.map(c => c.time)).toEqual([0, 6 * DAY / 1000]);
    const unavailable = createBacktestCandleStore(run(), async () => { throw new MarketDataError('Partial provider response', 'provider-partial'); });
    await expect(unavailable.ensureThrough(DAY)).rejects.toMatchObject({ code: 'provider-partial' });
    expect(unavailable.getSnapshot().loadedUntilMs).toBe(0);
  });

  it('restores a resumed session prefix with minutes before fetching historical hourly context', async () => {
    const load = vi.fn(async (p: Params) => response(p));
    const store = createBacktestCandleStore(run({ cursorAt: 19 * DAY }), load);
    await store.loadInitial();
    expect(store.getSnapshot().candles.MNQ![0].time).toBe(17 * DAY / 1000);
    await store.loadOlder('MNQ', 'ohlcv-1h', 17 * DAY);
    await store.loadOlder('MNQ', 'ohlcv-1h', 10 * DAY);
    await store.loadOlder('MNQ', 'ohlcv-1h', 3 * DAY);
    expect(store.getSnapshot().candles.MNQ![0].time).toBe(0);
    const sessionLoads = load.mock.calls.slice(2).map(([p]) => ({ start: p.start.getTime(), end: p.end.getTime(), schema: p.schema }));
    expect(sessionLoads).toEqual([
      { start: 10 * DAY, end: 17 * DAY, schema: 'ohlcv-1m' },
      { start: 3 * DAY, end: 10 * DAY, schema: 'ohlcv-1m' },
      { start: 0, end: 3 * DAY, schema: 'ohlcv-1m' },
    ]);
    await store.loadOlder('MNQ', 'ohlcv-1h', 0);
    expect(load.mock.lastCall![0].schema).toBe('ohlcv-1h');
    expect(load.mock.lastCall![0].end.getTime()).toBe(0);
    expect(store.getSnapshot().loadedUntilMs).toBe(20 * DAY);
  });

  it('sorts, deduplicates, and bounds provider responses without admitting future historical hours', async () => {
    const load = vi.fn(async (p: Params) => response(p, p.schema === 'ohlcv-1h'
      ? [candle(-HOUR), candle(0), candle(HOUR)]
      : [candle(HOUR), candle(0), candle(HOUR), candle(50 * DAY)]));
    const store = createBacktestCandleStore(run(), load);
    await store.loadInitial();
    expect(store.getSnapshot().candles.MNQ!.map(c => c.time)).toEqual([0, HOUR / 1000]);
    await store.loadOlder('MNQ', 'ohlcv-1h', 0);
    expect(store.getSnapshot().history.MNQ!['ohlcv-1h']!.map(c => c.time)).toEqual([-HOUR / 1000]);
  });

  it('retains a late historical prepend when a forward load completes concurrently', async () => {
    const older = deferred<MarketCandleResponse>();
    let oldParams!: Params;
    const load = vi.fn(async (p: Params) => {
      if (p.start.getTime() < 0) { oldParams = p; return older.promise; }
      return response(p);
    });
    const store = createBacktestCandleStore(run(), load);
    await store.loadInitial();
    const pending = store.loadOlder('MNQ', 'ohlcv-1m', 0);
    await Promise.resolve();
    await store.ensureThrough(6 * DAY);
    older.resolve(response(oldParams, [candle(-HOUR)]));
    await pending;
    expect(store.getSnapshot().loadedUntilMs).toBe(6 * DAY);
    expect(store.getSnapshot().candles.MNQ).toHaveLength(2);
    expect(store.getSnapshot().history.MNQ!['ohlcv-1m']).toHaveLength(1);
  });

  it('provides all crossed bars before a Go To cursor can be committed', async () => {
    const load = vi.fn(async (p: Params) => response(p, Array.from({ length: (p.end.getTime() - p.start.getTime()) / HOUR }, (_, i) => candle(p.start.getTime() + i * HOUR))));
    const store = createBacktestCandleStore(run(), load);
    await store.loadInitial();
    const initial = store.getSnapshot();
    const result = await prepareBacktestReplayGoTo({ candles: initial.candles.MNQ!, loadedUntilMs: initial.loadedUntilMs,
      endMs: 30 * DAY, ensure: async end => { await store.ensureThrough(end); return store.getSnapshot().candles.MNQ!; },
    }, { kind: 'date', unixSeconds: 6 * DAY / 1000 }, { cursorTime: 0, timeZone: 'UTC', settings: DEFAULT_REPLAY_GO_TO_SETTINGS });
    expect(result.kind).toBe('ok');
    expect(store.getSnapshot().loadedUntilMs).toBe(6 * DAY);
    expect(store.getSnapshot().candles.MNQ).toHaveLength(144);
    expect(store.getSnapshot().candles.MNQ!.at(-1)!.time).toBe((6 * DAY - HOUR) / 1000);
  });

  it('advances a daily step across no-data chunks with the real loader error contract', async () => {
    const load = vi.fn(async (p: Params) => {
      if (p.start.getTime() === 3 * DAY) throw new MarketDataError('Closed', 'no-data');
      return response(p);
    });
    const store = createBacktestCandleStore(run(), load);
    await store.loadInitial();
    const initial = store.getSnapshot();
    const next = await prepareBacktestReplayStep({ candles: initial.candles.MNQ!, loadedUntilMs: initial.loadedUntilMs,
      endMs: 30 * DAY, ensure: async end => { await store.ensureThrough(end); return store.getSnapshot().candles.MNQ!; },
    }, 0, 1440);
    expect(next).toBe(6 * DAY / 1000);
  });
});

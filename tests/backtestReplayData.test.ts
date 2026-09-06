import { describe, expect, it, vi } from 'vitest';
import { backtestOlderHistoryRange, prepareBacktestReplayGoTo, prepareBacktestReplayStep, ReplayDataRequestCoordinator } from '../services/backtestReplayData';
import { DEFAULT_REPLAY_GO_TO_SETTINGS } from '../services/replayGoTo';
import type { MarketCandle } from '../services/marketData';
const bar = (time: number, high = 101): MarketCandle => ({ time, open: 100, high, low: 99, close: 100, volume: 1 });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const options = { cursorTime: 60, settings: DEFAULT_REPLAY_GO_TO_SETTINGS, timeZone: 'UTC' };

describe('backtest replay data preparation', () => {
  it('keeps Go To uncommitted until crossed candles arrive and uses the fresh source', async () => {
    const pending = deferred<MarketCandle[]>();
    const commit = vi.fn();
    const coordinator = new ReplayDataRequestCoordinator();
    const ensure = vi.fn(() => pending.promise);
    const done = coordinator.run('date', isCurrent => prepareBacktestReplayGoTo({
      candles: [bar(60), bar(120)], loadedUntilMs: 180_000, endMs: 600_000, ensure, isCurrent,
    }, { kind: 'date', unixSeconds: 300 }, options), commit, reason => { throw reason; });
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith(300_000);
    pending.resolve([bar(60), bar(120), bar(180), bar(240)]);
    await done;
    expect(commit).toHaveBeenCalledWith({ kind: 'ok', value: { cursorTime: 299, targetTime: 300 } });
    // target-1 reveals 180 and 240; the parent now has both before processing.
  });

  it('coalesces duplicate Go To requests into one load and one commit', async () => {
    const pending = deferred<number>();
    const task = vi.fn(() => pending.promise);
    const commit = vi.fn();
    const coordinator = new ReplayDataRequestCoordinator();
    const first = coordinator.run('same', task, commit, vi.fn());
    const second = coordinator.run('same', task, commit, vi.fn());
    expect(first).toBe(second);
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
    pending.resolve(42);
    await first;
    expect(commit).toHaveBeenCalledOnce();
  });

  it('ignores late older requests and their errors after a newer selection', async () => {
    const older = deferred<number>();
    const commit = vi.fn();
    const fail = vi.fn();
    const coordinator = new ReplayDataRequestCoordinator();
    const first = coordinator.run('old', () => older.promise, commit, fail);
    await Promise.resolve();
    await coordinator.run('new', async () => 2, commit, fail);
    older.reject(new Error('obsolete load failed'));
    await first;
    expect(commit).toHaveBeenCalledExactlyOnceWith(2);
    expect(fail).not.toHaveBeenCalled();
  });

  it('leaves the cursor unchanged on failure and permits retry of the same target', async () => {
    const coordinator = new ReplayDataRequestCoordinator();
    const commit = vi.fn();
    const fail = vi.fn();
    await coordinator.run('date', async () => { throw new Error('offline'); }, commit, fail);
    expect(commit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledOnce();
    expect(coordinator.pending).toBe(false);
    await coordinator.run('date', async () => 300, commit, fail);
    expect(commit).toHaveBeenCalledExactlyOnceWith(300);
  });

  it('loads a daily step with more than 240 bars still in the current segment', async () => {
    const source = Array.from({ length: 801 }, (_, i) => bar(i * 60));
    const ensure = vi.fn(async () => [...source, bar(86_400)]);
    const next = await prepareBacktestReplayStep({ candles: source, loadedUntilMs: 48_060_000, endMs: 400_000_000, ensure }, 0, 1440);
    expect(next).toBe(86_400);
    expect(ensure).toHaveBeenCalledOnce();
  });

  it('continues through empty weekend coverage to the next available bar', async () => {
    const day = 86_400_000;
    const ensure = vi.fn(async (end: number) => end <= 3 * day ? [bar(0)] : [bar(0), bar(4 * day / 1000)]);
    const next = await prepareBacktestReplayStep({ candles: [bar(0)], loadedUntilMs: 60_000, endMs: 7 * day, ensure }, 0, 1440);
    expect(next).toBe(4 * day / 1000);
    expect(ensure.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('lands on the last session bar when a daily step exceeds the end', async () => {
    const ensure = vi.fn(async () => [bar(60), bar(120), bar(180)]);
    const next = await prepareBacktestReplayStep({ candles: [bar(60)], loadedUntilMs: 120_000, endMs: 240_000, ensure }, 60, 1440);
    expect(next).toBe(180);
    expect(ensure).toHaveBeenCalledWith(240_000);
  });

  it('searches price beyond the loaded segment without revealing the search data', async () => {
    const source = [bar(60), bar(120)];
    const ensure = vi.fn(async () => [...source, bar(180, 105)]);
    const result = await prepareBacktestReplayGoTo({ candles: source, loadedUntilMs: 180_000, endMs: 600_000, ensure }, { kind: 'price', price: 104 }, options);
    expect(result).toEqual({ kind: 'ok', value: { cursorTime: 180, targetTime: 180 } });
    expect(source).toHaveLength(2);
  });

  it('uses source coverage rather than a rounded HTF label for the first context request', () => {
    const hour = 3_600_000;
    expect(backtestOlderHistoryRange({
      requestedBeforeMs: 18 * hour, sessionStartMs: 19 * hour,
      sessionLoadedFromMs: 19 * hour, schema: 'ohlcv-1h',
    }).endMs).toBe(19 * hour);
  });

  it('keeps consecutive historical ranges contiguous despite rounded HTF labels', () => {
    const hour = 3_600_000;
    expect(backtestOlderHistoryRange({
      requestedBeforeMs: -4 * hour, loadedFromMs: -2 * hour,
      sessionStartMs: 0, sessionLoadedFromMs: 0, schema: 'ohlcv-1h',
    }).endMs).toBe(-2 * hour);
  });

  it('fills the missing already-revealed prefix before loading pre-session context', () => {
    const day = 86_400_000;
    const base = { requestedBeforeMs: 17 * day, sessionStartMs: 0, sessionLoadedFromMs: 17 * day, schema: 'ohlcv-1m' as const };
    expect(backtestOlderHistoryRange(base)).toEqual({ startMs: 10 * day, endMs: 17 * day, kind: 'session' });
    expect(backtestOlderHistoryRange({ ...base, sessionLoadedFromMs: 10 * day })).toEqual({ startMs: 3 * day, endMs: 10 * day, kind: 'session' });
    expect(backtestOlderHistoryRange({ ...base, sessionLoadedFromMs: 3 * day })).toEqual({ startMs: 0, endMs: 3 * day, kind: 'session' });
    expect(backtestOlderHistoryRange({ ...base, requestedBeforeMs: 0, sessionLoadedFromMs: 0 })).toEqual({ startMs: -7 * day, endMs: 0, kind: 'context' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
import { createBacktestClosedTradeEmitter } from '../services/backtestClosedTradeEmission';
import type { BacktestClosedTradeIdentity } from '../services/backtestTradeOutbox';

const makeJob = (): BacktestClosedTradeIdentity => ({ tradeId: crypto.randomUUID(), runId: 'run', accountId: 'account', instrument: 'MNQ' });
const toTrade = (job: BacktestClosedTradeIdentity): Trade => ({ id: job.tradeId, backtestRunId: job.runId, accountId: job.accountId, instrument: job.instrument } as Trade);
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const setup = () => {
  const preflight = vi.fn(async (_ids: readonly BacktestClosedTradeIdentity[], _signal: AbortSignal) => ({ durableIds: new Set<string>() }));
  const mapTrade = vi.fn(async (job: BacktestClosedTradeIdentity, _signal: AbortSignal) => toTrade(job));
  const persist = vi.fn(async (_trade: Trade) => undefined);
  const yieldTask = vi.fn(async (_signal: AbortSignal) => undefined);
  return { ownerId: 'owner', runId: 'run', accountId: 'account', identity: (job: BacktestClosedTradeIdentity) => job,
    preflight, mapTrade, persist, yieldTask };
};

describe('bounded closed-trade recovery', () => {
  it('reopens hundreds of durable records without mapping or enqueueing one trade', async () => {
    const options = setup(); const jobs = Array.from({ length: 205 }, makeJob);
    options.preflight.mockImplementation(async ids => ({ durableIds: new Set(ids.map(item => item.tradeId)) }));
    const queue = createBacktestClosedTradeEmitter(options);
    expect((await queue.emit(jobs)).durableIds).toHaveLength(205);
    expect(options.preflight.mock.calls.map(call => call[0].length)).toEqual([100, 100, 5]);
    expect(options.mapTrade).not.toHaveBeenCalled(); expect(options.persist).not.toHaveBeenCalled();
    await queue.emit(jobs); expect(options.preflight).toHaveBeenCalledTimes(3);
  });

  it('maps only unknown records, once, and waits for each durable enqueue', async () => {
    const options = setup(); const jobs = [makeJob(), makeJob(), makeJob()]; const gate = deferred<void>();
    options.preflight.mockImplementation(async () => ({ durableIds: new Set([jobs[0].tradeId]) }));
    options.persist.mockImplementationOnce(async () => gate.promise);
    const queue = createBacktestClosedTradeEmitter(options);
    const first = queue.emit(jobs), second = queue.emit(jobs);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(options.persist).toHaveBeenCalledTimes(1));
    expect(options.mapTrade).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect((await first).durableIds).toHaveLength(3);
    expect(options.mapTrade).toHaveBeenCalledTimes(2);
    await queue.emit(jobs); expect(options.persist).toHaveBeenCalledTimes(2);
  });

  it('retains failed records for the next recovery attempt, without redoing successful ones', async () => {
    const options = setup(); const jobs = [makeJob(), makeJob()];
    options.persist.mockRejectedValueOnce(new Error('quota'));
    const queue = createBacktestClosedTradeEmitter(options);
    expect(await queue.emit(jobs)).toMatchObject({ failedIds: [jobs[0].tradeId], durableIds: [jobs[1].tradeId], error: 'quota' });
    expect(await queue.emit(jobs)).toMatchObject({ failedIds: [], durableIds: [jobs[0].tradeId], error: null });
    expect(options.persist).toHaveBeenCalledTimes(3);
  });

  it('never maps on a failed prerequisite or treats an unsolicited ID as an ACK', async () => {
    const options = setup(); const jobs = [makeJob(), makeJob()];
    options.preflight.mockRejectedValueOnce(new Error('IDB read failed'));
    const queue = createBacktestClosedTradeEmitter(options);
    expect((await queue.emit(jobs)).failedIds).toHaveLength(2);
    expect(options.mapTrade).not.toHaveBeenCalled();
    options.preflight.mockResolvedValueOnce({ durableIds: new Set(['foreign']) });
    expect((await queue.emit(jobs)).error).toContain('mimo dávku');
    expect(options.persist).not.toHaveBeenCalled();
    expect((await queue.emit(jobs)).durableIds).toHaveLength(2);
  });

  it('stops mapping on dispose or auth-generation change without publishing a late durable result', async () => {
    const options = setup(); const jobs = [makeJob(), makeJob()]; const gate = deferred<Trade>();
    options.mapTrade.mockImplementationOnce(async () => gate.promise);
    const queue = createBacktestClosedTradeEmitter(options);
    const result = queue.emit(jobs);
    await vi.waitFor(() => expect(options.mapTrade).toHaveBeenCalledTimes(1));
    queue.dispose(); gate.resolve(toTrade(jobs[0]));
    expect(await result).toMatchObject({ cancelled: true, durableIds: [] });
    expect(options.persist).not.toHaveBeenCalled();
    expect(options.mapTrade.mock.calls[0][1].aborted).toBe(true);

    let current = true; const other = setup();
    other.yieldTask.mockImplementationOnce(async () => { current = false; });
    const stale = createBacktestClosedTradeEmitter({ ...other, isCurrent: () => current });
    expect((await stale.emit(jobs)).cancelled).toBe(true);
    expect(other.mapTrade).not.toHaveBeenCalled();
  });

  it('prioritizes a newly closed trade before the rest of a recovery batch', async () => {
    const options = setup(); const jobs = [makeJob(), makeJob(), makeJob()]; const fresh = makeJob(); const gate = deferred<Trade>();
    options.mapTrade.mockImplementationOnce(async () => gate.promise);
    const queue = createBacktestClosedTradeEmitter(options);
    const result = queue.emit(jobs);
    await vi.waitFor(() => expect(options.mapTrade).toHaveBeenCalledTimes(1));
    expect(queue.emit([...jobs, fresh])).toBe(result);
    gate.resolve(toTrade(jobs[0])); await result;
    expect(options.mapTrade.mock.calls.map(call => call[0].tradeId)).toEqual([jobs[0], fresh, jobs[1], jobs[2]].map(job => job.tradeId));
  });

  it('keeps identity scope through preflight, worker results and repeated jobs', async () => {
    const options = setup(); const job = makeJob(); const queue = createBacktestClosedTradeEmitter(options);
    expect((await queue.emit([{ ...job, runId: 'foreign' }])).error).toContain('session');
    expect(options.preflight).not.toHaveBeenCalled();
    options.mapTrade.mockResolvedValueOnce({ ...toTrade(job), accountId: 'foreign' });
    expect((await queue.emit([job])).failedIds).toEqual([job.tradeId]);
    expect(options.persist).not.toHaveBeenCalled();
    expect((await queue.emit([{ ...job, instrument: 'NQ' }])).error).toContain('session');
  });

  it('uses an actual task boundary so microtask-only workers cannot monopolize input', async () => {
    vi.useFakeTimers();
    try {
      const options = setup(); const queue = createBacktestClosedTradeEmitter({ ...options, yieldTask: undefined });
      const result = queue.emit([makeJob(), makeJob()]);
      await Promise.resolve(); await Promise.resolve();
      expect(options.mapTrade).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect((await result).durableIds).toHaveLength(2);
      expect(options.mapTrade).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

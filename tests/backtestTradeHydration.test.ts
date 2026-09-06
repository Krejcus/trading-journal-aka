import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
import { createBacktestTradeHydrator } from '../services/backtestTradeHydration';

const identity = () => ({ tradeId: crypto.randomUUID(), runId: 'run', accountId: 'account', instrument: 'MNQ' });
const trade = (id: ReturnType<typeof identity>): Trade => ({ id: id.tradeId, backtestRunId: id.runId,
  accountId: id.accountId, instrument: id.instrument, notes: 'server review' } as Trade);
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const setup = () => ({ ownerId: 'owner', runId: 'run', accountId: 'account', isCurrent: () => true,
  hasTrade: vi.fn((_id: string) => false), load: vi.fn(async (_id: string, _signal?: AbortSignal): Promise<Trade | null> => null),
  onTrade: vi.fn((_trade: Trade) => undefined), onError: vi.fn((_message: string | null) => undefined) });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('independent backtest detail hydration', () => {
  it('retries a null and a rejected detail read after 5 seconds without another preflight or mapper', async () => {
    const item = identity(), options = setup();
    options.load.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(trade(item));
    const queue = createBacktestTradeHydrator(options); queue.enqueue([item]);
    await vi.advanceTimersByTimeAsync(1);
    expect(options.load).toHaveBeenCalledTimes(1); expect(queue.getPendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999); expect(options.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2); expect(options.load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(options.onTrade).toHaveBeenCalledExactlyOnceWith(trade(item));
    expect(queue.getPendingCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(options.onError.mock.calls.at(-1)).toEqual([null]); queue.dispose();
  });

  it('serializes separate enqueue batches and yields between each detail fetch', async () => {
    const first = identity(), second = identity(), third = identity(), options = setup();
    const gate = deferred<Trade | null>(); options.load.mockImplementationOnce(async () => gate.promise);
    options.load.mockResolvedValueOnce(trade(second)).mockResolvedValueOnce(trade(third));
    const queue = createBacktestTradeHydrator(options); queue.enqueue([first]);
    await vi.advanceTimersByTimeAsync(1); queue.enqueue([second, third]);
    await vi.advanceTimersByTimeAsync(1_000); expect(options.load).toHaveBeenCalledTimes(1);
    gate.resolve(trade(first)); await Promise.resolve(); await Promise.resolve();
    expect(options.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(options.load.mock.calls.map(call => call[0])).toEqual([first.tradeId, second.tradeId, third.tradeId]);
    expect(queue.getPendingCount()).toBe(0); queue.dispose();
  });

  it('same-ID reopen does not share a stale in-flight entry or let its late result affect the new instance', async () => {
    const item = identity(), oldOptions = setup(), nextOptions = setup(), oldGate = deferred<Trade | null>();
    oldOptions.load.mockImplementation(async () => oldGate.promise);
    nextOptions.load.mockResolvedValue(trade(item));
    const old = createBacktestTradeHydrator(oldOptions); old.enqueue([item]);
    await vi.advanceTimersByTimeAsync(1); old.dispose();
    const next = createBacktestTradeHydrator(nextOptions); next.enqueue([item]);
    await vi.advanceTimersByTimeAsync(1);
    oldGate.resolve({ ...trade(item), notes: 'stale' }); await Promise.resolve(); await Promise.resolve();
    expect(oldOptions.onTrade).not.toHaveBeenCalled();
    expect(nextOptions.onTrade).toHaveBeenCalledExactlyOnceWith(trade(item));
    expect(oldOptions.load.mock.calls[0][1]?.aborted).toBe(true);
    expect(next.getPendingCount()).toBe(0); next.dispose();
  });

  it('does not overwrite a newer UI review that arrived while the detail read was in flight', async () => {
    const item = identity(), options = setup(), gate = deferred<Trade | null>(); let present = false;
    options.hasTrade.mockImplementation(() => present); options.load.mockImplementation(async () => gate.promise);
    const queue = createBacktestTradeHydrator(options); queue.enqueue([item]); await vi.advanceTimersByTimeAsync(1);
    present = true; gate.resolve(trade(item)); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(options.onTrade).not.toHaveBeenCalled();
    queue.enqueue([item]); await vi.advanceTimersByTimeAsync(10_000);
    expect(options.load).toHaveBeenCalledTimes(1); queue.dispose();
  });

  it('keeps repeated null errors quiet and starts no timer when there is no pending work', async () => {
    const options = setup(), queue = createBacktestTradeHydrator(options);
    expect(vi.getTimerCount()).toBe(0); queue.enqueue([identity()]);
    await vi.advanceTimersByTimeAsync(15_010);
    expect(options.load.mock.calls.length).toBeGreaterThan(2); expect(options.onError).toHaveBeenCalledTimes(1);
    queue.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects over-limit and mixed scopes atomically, and never delivers mismatched server identities', async () => {
    const options = setup(), item = identity(), queue = createBacktestTradeHydrator({ ...options, maxPending: 2 });
    expect(() => queue.enqueue([identity(), identity(), identity()])).toThrow('limit 2'); expect(queue.getPendingCount()).toBe(0);
    expect(() => queue.enqueue([item, { ...identity(), accountId: 'other' }])).toThrow('účtu'); expect(queue.getPendingCount()).toBe(0);
    options.load.mockResolvedValue({ ...trade(item), instrument: 'NQ' }); queue.enqueue([item]); await vi.advanceTimersByTimeAsync(1);
    expect(options.onTrade).not.toHaveBeenCalled(); expect(queue.getPendingCount()).toBe(1);
    expect(options.onError).toHaveBeenCalledWith('Načtený obchod nepatří této replay session.'); queue.dispose();
  });

  it('cancels waiting retries and late results after an auth generation change or signal abort', async () => {
    const options = setup(), item = identity(), gate = deferred<Trade | null>(); let current = true;
    options.load.mockImplementation(async () => gate.promise);
    const queue = createBacktestTradeHydrator({ ...options, isCurrent: () => current });
    queue.enqueue([item]); await vi.advanceTimersByTimeAsync(1); current = false; gate.resolve(trade(item));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(options.onTrade).not.toHaveBeenCalled(); expect(queue.getPendingCount()).toBe(0);
    const controller = new AbortController(), waiting = createBacktestTradeHydrator({ ...setup(), signal: controller.signal });
    waiting.enqueue([identity()]); controller.abort(); await vi.advanceTimersByTimeAsync(10_000);
    expect(waiting.getPendingCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});

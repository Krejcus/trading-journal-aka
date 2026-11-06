import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResilientRealtimeSubscription } from '../lib/resilientRealtimeSubscription';

describe('display-only realtime subscription watchdog', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('keeps a subscribed channel and closes it exactly once on stop', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    let status: ((value: 'SUBSCRIBED') => void) | null = null;
    const subscription = createResilientRealtimeSubscription({
      open: onStatus => { status = onStatus as typeof status; return { close }; },
      watchdogMs: 100,
      reopenDelayMs: 10,
    });
    subscription.start();
    status?.('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(500);
    expect(close).not.toHaveBeenCalled();
    subscription.stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it('replaces a channel that never subscribes and ignores its stale callback', async () => {
    vi.useFakeTimers();
    const closes = [vi.fn(), vi.fn()];
    const statuses: Array<(value: 'SUBSCRIBED' | 'CHANNEL_ERROR') => void> = [];
    const open = vi.fn((onStatus: (value: 'SUBSCRIBED' | 'CHANNEL_ERROR') => void) => {
      statuses.push(onStatus);
      return { close: closes[statuses.length - 1] };
    });
    const subscription = createResilientRealtimeSubscription({ open, watchdogMs: 100, reopenDelayMs: 10 });
    subscription.start();
    await vi.advanceTimersByTimeAsync(110);
    expect(open).toHaveBeenCalledTimes(2);
    expect(closes[0]).toHaveBeenCalledOnce();
    statuses[0]('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(99);
    expect(closes[1]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11);
    expect(open).toHaveBeenCalledTimes(3);
    subscription.stop();
  });

  it('gives realtime-js a recovery window after an error, then reopens if it stays stuck', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    let status: ((value: 'SUBSCRIBED' | 'CHANNEL_ERROR') => void) | null = null;
    const open = vi.fn((onStatus: (value: 'SUBSCRIBED' | 'CHANNEL_ERROR') => void) => {
      status = onStatus;
      return { close };
    });
    const subscription = createResilientRealtimeSubscription({ open, watchdogMs: 100, reopenDelayMs: 10 });
    subscription.start();
    status?.('CHANNEL_ERROR');
    await vi.advanceTimersByTimeAsync(99);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11);
    expect(close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
    subscription.stop();
  });
});

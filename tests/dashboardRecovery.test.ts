import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboardRecovery } from '../services/dashboardRecovery';

afterEach(() => vi.useRealTimers());

function fixture(load = vi.fn().mockResolvedValue({ trades: [] })) {
  vi.useFakeTimers();
  const apply = vi.fn();
  const available = vi.fn(() => true);
  const onBusy = vi.fn();
  const onError = vi.fn();
  const recovery = createDashboardRecovery({ load, apply, available, onBusy, onError });
  return { load, apply, available, onBusy, onError, recovery };
}

describe('dashboard cloud recovery', () => {
  it('allows the complete multi-request recovery to finish past 20 seconds with its own bounded deadline', async () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const recovery = createDashboardRecovery({ timeoutMs: 60_000,
      available: () => true, onBusy: vi.fn(), onError: vi.fn(), apply,
      load: () => new Promise(resolve => setTimeout(() => resolve({ trades: [1] }), 30_000)),
    });
    const pending = recovery.retry();
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(apply).toHaveBeenCalledWith({ trades: [1] });
    recovery.stop();
  });
  it('retries transient failures with backoff and applies only successful data', async () => {
    const context = fixture(vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ trades: [1] }));
    context.recovery.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(context.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(context.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(context.apply).toHaveBeenCalledWith({ trades: [1] });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(context.load).toHaveBeenCalledTimes(2);
  });

  it('does not request while offline or hidden, but can retry on return', async () => {
    const context = fixture();
    context.available.mockReturnValue(false);
    context.recovery.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(context.load).not.toHaveBeenCalled();
    context.available.mockReturnValue(true);
    await context.recovery.retry();
    expect(context.apply).toHaveBeenCalledOnce();
  });

  it('coalesces simultaneous button, focus and reconnect retries', async () => {
    let resolve!: (value: object) => void;
    const context = fixture(vi.fn(() => new Promise(done => { resolve = done; })));
    const pending = context.recovery.retry();
    await context.recovery.retry();
    await context.recovery.retry();
    expect(context.load).toHaveBeenCalledOnce();
    resolve({ trades: [] });
    await pending;
    expect(context.apply).toHaveBeenCalledOnce();
  });

  it('aborts a hanging read and never applies its late response', async () => {
    let resolve!: (value: object) => void;
    const context = fixture(vi.fn(() => new Promise(done => { resolve = done; })));
    const pending = context.recovery.retry();
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(context.load.mock.calls[0][0].aborted).toBe(true);
    expect(context.onBusy).toHaveBeenLastCalledWith(false);
    resolve({ trades: ['stale'] });
    await Promise.resolve();
    expect(context.apply).not.toHaveBeenCalled();
    context.recovery.stop();
  });

  it('ignores old-session responses after cleanup', async () => {
    let resolve!: (value: object) => void;
    const context = fixture(vi.fn(() => new Promise(done => { resolve = done; })));
    const pending = context.recovery.retry();
    context.recovery.stop();
    expect(context.load.mock.calls[0][0].aborted).toBe(true);
    resolve({ trades: ['other-user'] });
    await pending;
    expect(context.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(context.load).toHaveBeenCalledOnce();
  });

  it('caps retry frequency during persistent outages', async () => {
    const context = fixture(vi.fn().mockRejectedValue(new Error('offline')));
    await context.recovery.retry();
    await vi.advanceTimersByTimeAsync(75_000);
    expect(context.load).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(context.load).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(context.load).toHaveBeenCalledTimes(6);
    context.recovery.stop();
  });
});

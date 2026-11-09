import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChartHistoryRefresh, historicalRefreshRetryDelay } from '../services/chartHistoryRefresh';

afterEach(() => vi.useRealTimers());
describe('historical refresh recovery', () => {
  it('recovers a transient failure without a reload, keeping the error until the real successful read', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValueOnce({ httpStatus: 502 }).mockResolvedValue(undefined);
    const onError = vi.fn();
    const refresh = createChartHistoryRefresh({ load, onError, isVisible: () => true });
    await refresh.refresh(); expect(onError).toHaveBeenCalledTimes(1);
    await refresh.refresh(); expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000); expect(load).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1); refresh.stop();
  });
  it('bounds retries and never retries payment, penalty or partial-data responses automatically', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue({ httpStatus: 502 });
    const refresh = createChartHistoryRefresh({ load, onError: () => undefined, isVisible: () => true });
    await refresh.refresh(); await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(4); refresh.stop();
    for (const code of ['provider-partial', 'provider-truncated', 'provider-payment', 'provider-rate-limit']) {
      expect(historicalRefreshRetryDelay({ code, httpStatus: 502 }, 0)).toBeNull();
    }
    expect(historicalRefreshRetryDelay({ httpStatus: 401 }, 0)).toBeNull();
    expect(historicalRefreshRetryDelay({ httpStatus: 429 }, 0)).toBeNull();
  });
  it('does not read in a hidden tab or after disposal and resumes on a visible refresh', async () => {
    vi.useFakeTimers(); let visible = true;
    const load = vi.fn().mockRejectedValueOnce({ httpStatus: 503 }).mockResolvedValue(undefined);
    const refresh = createChartHistoryRefresh({ load, onError: () => undefined, isVisible: () => visible });
    await refresh.refresh(); visible = false;
    await vi.advanceTimersByTimeAsync(5_000); expect(load).toHaveBeenCalledTimes(1);
    visible = true; await refresh.refresh(); expect(load).toHaveBeenCalledTimes(2);
    refresh.stop(); await refresh.refresh(); expect(load).toHaveBeenCalledTimes(2);
  });
  it('does not publish late errors or leave a retry after switching charts', async () => {
    vi.useFakeTimers(); let fail!: (reason: unknown) => void;
    const load = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const onError = vi.fn();
    const refresh = createChartHistoryRefresh({ load, onError, isVisible: () => true });
    const pending = refresh.refresh(); refresh.stop(); fail({ httpStatus: 503 }); await pending;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(onError).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledTimes(1);
  });
});

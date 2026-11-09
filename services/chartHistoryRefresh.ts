/** Bounded read-only recovery. Never retry provider payment/permission/partial
 * data errors or a pending store purchase through an alternative endpoint. */
export function historicalRefreshRetryDelay(reason: unknown, failures: number): number | null {
  const error = reason as { code?: string; httpStatus?: number } | null;
  if (!error || error.code === 'provider-partial' || error.code === 'provider-truncated'
    || error.code === 'provider-payment' || error.code === 'provider-rate-limit') return null;
  const transient = (error.httpStatus != null && error.httpStatus >= 500)
    || error.code === 'endpoint-unavailable' || error.code === 'store-pending-timeout';
  return transient ? [5_000, 15_000, 60_000][failures] ?? null : null;
}

export function createChartHistoryRefresh(options: {
  load: () => Promise<void>;
  onError: (reason: unknown) => void;
  isVisible: () => boolean;
}) {
  let disposed = false, inFlight = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const refresh = async (): Promise<void> => {
    if (disposed || inFlight || timer !== null || !options.isVisible()) return;
    inFlight = true;
    try {
      await options.load();
      failures = 0;
    } catch (reason) {
      if (disposed) return;
      options.onError(reason);
      const delay = historicalRefreshRetryDelay(reason, failures++);
      if (delay != null) timer = setTimeout(() => { timer = null; void refresh(); }, delay);
    } finally {
      inFlight = false;
    }
  };
  return {
    refresh,
    stop() { disposed = true; if (timer !== null) clearTimeout(timer); timer = null; },
  };
}

export interface DashboardRecoveryOptions<T> {
  load: (signal: AbortSignal) => Promise<T>;
  apply: (value: T) => void;
  available: () => boolean;
  onBusy: (busy: boolean) => void;
  onError: (error: unknown) => void;
  timeoutMs?: number;
}

export function createDashboardRecovery<T>(options: DashboardRecoveryOptions<T>) {
  let stopped = false;
  let busy = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const retry = async () => {
    if (stopped || busy || !options.available()) return;
    clearTimeout(timer);
    busy = true;
    options.onBusy(true);
    const request = new AbortController();
    controller = request;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        options.load(request.signal),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            request.abort();
            reject(new Error('dashboard-refresh-timeout'));
          }, options.timeoutMs ?? 20_000);
        }),
      ]);
      if (stopped || request.signal.aborted) return;
      options.onBusy(false);
      options.apply(value);
      stopped = true;
    } catch (error) {
      if (stopped) return;
      options.onError(error);
      timer = setTimeout(() => { void retry(); }, Math.min(5_000 * 2 ** failures++, 60_000));
    } finally {
      clearTimeout(deadline);
      busy = false;
      if (!stopped) options.onBusy(false);
    }
  };

  return {
    retry,
    start: () => { timer = setTimeout(() => { void retry(); }, 1_000); },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}

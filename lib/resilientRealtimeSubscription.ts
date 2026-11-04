/**
 * Malý watchdog pro display-only Supabase Realtime kanály.
 *
 * realtime-js se po běžném výpadku zpravidla připojí sám. V Safari ale může
 * kanál zůstat ve stavu connecting/disconnecting bez dalšího callbacku. Tento
 * wrapper po omezené době zahodí jen daný kanál a otevře nový. Nikdy nenese
 * rozhodovací stav ani neovlivňuje příkazy; bez něj zůstává polling fallback.
 */

export type ResilientRealtimeStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export interface ResilientRealtimeHandle {
  close(): unknown;
}

export interface ResilientRealtimeSubscription {
  start(): void;
  stop(): void;
}

export const REALTIME_SUBSCRIBE_WATCHDOG_MS = 12_000;
export const REALTIME_REOPEN_DELAY_MS = 1_000;

export function createResilientRealtimeSubscription(options: {
  open(onStatus: (status: ResilientRealtimeStatus) => void): ResilientRealtimeHandle;
  onStatus?: (status: ResilientRealtimeStatus) => void;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
  watchdogMs?: number;
  reopenDelayMs?: number;
}): ResilientRealtimeSubscription {
  const schedule = options.setTimeoutImpl ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancel = options.clearTimeoutImpl ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const watchdogMs = options.watchdogMs ?? REALTIME_SUBSCRIBE_WATCHDOG_MS;
  const reopenDelayMs = options.reopenDelayMs ?? REALTIME_REOPEN_DELAY_MS;
  let active = false;
  let joined = false;
  let generation = 0;
  let channel: ResilientRealtimeHandle | null = null;
  let watchdog: unknown = null;
  let reopen: unknown = null;

  const clear = (timer: unknown) => { if (timer !== null) cancel(timer); };
  const close = (target: ResilientRealtimeHandle | null) => {
    if (!target) return;
    try {
      const result = target.close();
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        void (result as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // Display-only kanál nesmí shodit LIVE.
    }
  };

  const scheduleOpen = () => {
    if (!active || reopen !== null) return;
    reopen = schedule(() => {
      reopen = null;
      open();
    }, reopenDelayMs);
  };

  const replace = () => {
    clear(watchdog);
    watchdog = null;
    joined = false;
    generation += 1;
    const stale = channel;
    channel = null;
    close(stale);
    scheduleOpen();
  };

  const armWatchdog = (owner: number) => {
    if (!active || watchdog !== null) return;
    watchdog = schedule(() => {
      watchdog = null;
      if (!active || owner !== generation || joined || !channel) return;
      replace();
    }, watchdogMs);
  };

  const open = () => {
    if (!active || channel) return;
    generation += 1;
    const owner = generation;
    joined = false;
    try {
      channel = options.open(status => {
        if (!active || owner !== generation) return;
        options.onStatus?.(status);
        if (status === 'SUBSCRIBED') {
          joined = true;
          clear(watchdog);
          watchdog = null;
          return;
        }
        joined = false;
        armWatchdog(owner);
      });
      armWatchdog(owner);
    } catch {
      channel = null;
      scheduleOpen();
    }
  };

  return {
    start() {
      if (active) return;
      active = true;
      open();
    },
    stop() {
      if (!active) return;
      active = false;
      generation += 1;
      joined = false;
      clear(watchdog);
      clear(reopen);
      watchdog = null;
      reopen = null;
      const stale = channel;
      channel = null;
      close(stale);
    },
  };
}

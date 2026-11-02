/**
 * Hlídač vlákna upozornění na cenu v hlavním vlákně workeru (2. 11. 2026, INV-WORKER-04,
 * INV-WATCH-01). Stejná pravidla jako kanál ceny: nikdy nevyhodí, na vlákno nikdy nečeká,
 * pád = restart s prodlevou, 3 pády za 10 min = jistič do restartu workeru. Vlákno dostane
 * jen klíč upozornění a dávky obchodů IBKR; jeho stav jde do statusu jen jako čísla.
 * Podle ničeho odsud se neobchoduje ani nerozhoduje o riziku.
 */

export interface PriceAlertWatchConfig { apiOrigin: string; deviceId: string; key: string }

export interface PriceAlertWatchBatch { contract: string; prev: number | null; min: number; max: number; last: number; at: number }

/** Stav pro status workeru: stáří v ms v okamžiku sestavení (web nezávisí na hodinách Macu). */
export interface PriceAlertWatchStatus {
  state: 'watching' | 'no-price' | 'no-sync' | 'off' | 'tripped';
  alerts: number;
  priceAgeMs: number | null;
  syncAgeMs: number | null;
}

export interface PriceAlertWorkerLike {
  on(event: 'message' | 'error' | 'exit', listener: (value: any) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  unref(): void;
}

export interface PriceAlertWatchSupervisor {
  update(config: PriceAlertWatchConfig | null): void;
  onBatch(batch: PriceAlertWatchBatch): void;
  stop(): void;
  status(): PriceAlertWatchStatus | null;
}

const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
const LIVENESS_TIMEOUT_MS = 15_000;
const LIVENESS_CHECK_MS = 5_000;
const SLEEP_GAP_MS = 30_000;
const WATCH_FRESH_MS = 5_000;
/** Vlákno posílá 1 zprávu/s; víc než tohle za 5 s = rozbité vlákno zahlcuje event loop pollu a brzd. */
const FLOOD_LIMIT = 100;
const FLOOD_WINDOW_MS = 5_000;
const STATES = new Set(['watching', 'no-price', 'no-sync', 'off']);

export function createPriceAlertWatchSupervisor(options: {
  createWorker: () => PriceAlertWorkerLike;
  log?: (line: string) => void;
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (timer: unknown) => void;
}): PriceAlertWatchSupervisor {
  const now = options.now ?? Date.now;
  const log = (line: string) => { try { options.log?.(line); } catch { /* log nesmí shodit worker */ } };
  const unrefd = <T>(timer: T) => { (timer as { unref?: () => void }).unref?.(); return timer; };
  const setTimer = options.setTimeoutImpl ?? ((callback, ms) => unrefd(setTimeout(callback, ms)));
  const clearTimer = options.clearTimeoutImpl ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const setTick = options.setIntervalImpl ?? ((callback, ms) => unrefd(setInterval(callback, ms)));
  const clearTick = options.clearIntervalImpl ?? (timer => clearInterval(timer as ReturnType<typeof setInterval>));

  let config: PriceAlertWatchConfig | null = null;
  let worker: PriceAlertWorkerLike | null = null;
  let stopped = false;
  let tripped = false;
  let crashes: number[] = [];
  let consecutiveRestarts = 0;
  let restartTimer: unknown = null;
  let lastAlive = now();
  let lastTick = now();
  let lastWake = -Infinity;
  let watch: { at: number; state: PriceAlertWatchStatus['state']; alerts: number; priceAt: number | null; syncAt: number | null } | null = null;
  const retired = new WeakSet<PriceAlertWorkerLike>();
  const terminate = (target: PriceAlertWorkerLike) => {
    retired.add(target);
    try { void target.terminate().catch(() => undefined); } catch { /* už ukončené */ }
  };
  const same = (a: PriceAlertWatchConfig | null, b: PriceAlertWatchConfig | null) => (
    a === b || (a != null && b != null && a.apiOrigin === b.apiOrigin && a.deviceId === b.deviceId && a.key === b.key)
  );

  const recordCrash = (reason: string) => {
    const at = now();
    if (at - lastWake >= SLEEP_GAP_MS) {
      crashes = [...crashes.filter(time => at - time < CRASH_WINDOW_MS), at];
      if (crashes.length >= CRASH_LIMIT) {
        tripped = true;
        log(`PRICE ALERTS jistič: ${crashes.length} pády za 10 min (${reason}) — hlídání vypnuto do restartu workeru`);
        return;
      }
    }
    log(`PRICE ALERTS vlákno skončilo (${reason}) — restart`);
    if (stopped || !config) return;
    const delay = Math.min(60_000, 2_000 * 2 ** consecutiveRestarts);
    consecutiveRestarts += 1;
    if (restartTimer !== null) clearTimer(restartTimer);
    restartTimer = setTimer(() => { restartTimer = null; ensure(); }, delay);
  };

  const ensure = () => {
    if (stopped || tripped || !config || worker) return;
    let created: PriceAlertWorkerLike;
    try {
      created = options.createWorker();
    } catch (error) {
      recordCrash(error instanceof Error ? error.name : 'create-failed');
      return;
    }
    worker = created;
    lastAlive = now();
    watch = null;
    try { created.unref(); } catch { /* volitelné */ }
    let ended = false;
    let floodWindowAt = now();
    let floodCount = 0;
    const end = (reason: string) => {
      if (ended || retired.has(created)) return;
      ended = true;
      if (worker === created) worker = null;
      if (!stopped && config && !tripped) recordCrash(reason);
    };
    created.on('message', message => { try {
      if (worker !== created) return;
      const at = now();
      if (at - floodWindowAt > FLOOD_WINDOW_MS) { floodWindowAt = at; floodCount = 0; }
      floodCount += 1;
      if (floodCount > FLOOD_LIMIT) {
        terminate(created);
        worker = null;
        ended = true;
        if (!stopped && config && !tripped) recordCrash('flood');
        return;
      }
      if (!message || typeof message !== 'object') return;
      const row = message as { type?: unknown; state?: unknown; alerts?: unknown; priceAt?: unknown; syncAt?: unknown };
      if (row.type !== 'watch' || typeof row.state !== 'string' || !STATES.has(row.state)) return;
      lastAlive = now();
      consecutiveRestarts = 0;
      const time = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, now()) : null);
      watch = {
        at: now(), state: row.state as PriceAlertWatchStatus['state'],
        alerts: Number.isSafeInteger(row.alerts) ? Math.max(0, Math.min(50, row.alerts as number)) : 0,
        priceAt: time(row.priceAt), syncAt: time(row.syncAt),
      };
    } catch { /* výjimka v posluchači by shodila proces kopírky */ } });
    created.on('error', error => { try { end(error instanceof Error ? error.name : 'error'); } catch { /* viz výše */ } });
    created.on('exit', code => { try { end(`exit ${Number(code)}`); } catch { /* viz výše */ } });
    try {
      created.postMessage({ type: 'config', ...config });
    } catch {
      end('post-failed');
      terminate(created);
    }
  };

  const liveness = setTick(() => {
    try {
      const at = now();
      if (at - lastTick > SLEEP_GAP_MS) {
        lastWake = at;
        lastAlive = at;
      }
      lastTick = at;
      if (worker && at - lastAlive > LIVENESS_TIMEOUT_MS && at - lastWake > LIVENESS_TIMEOUT_MS) {
        const stuck = worker;
        worker = null;
        terminate(stuck);
        recordCrash('no-alive');
      }
    } catch { /* hlídač nesmí shodit worker */ }
  }, LIVENESS_CHECK_MS);

  return {
    update(next) {
      try {
        if (stopped || same(config, next)) return;
        config = next ? { ...next } : null;
        if (!config) {
          if (restartTimer !== null) { clearTimer(restartTimer); restartTimer = null; }
          const running = worker;
          worker = null;
          watch = null;
          if (running) terminate(running);
          return;
        }
        if (worker) worker.postMessage({ type: 'config', ...config });
        // Vytvoření vlákna mimo volání z relay pollu (pár ms synchronní práce navíc v cyklu brzd).
        else if (restartTimer === null) restartTimer = setTimer(() => { restartTimer = null; ensure(); }, 0);
      } catch { /* hlídač nikdy nevyhodí do relay smyčky */ }
    },
    onBatch(batch) {
      try {
        if (!worker || stopped || tripped) return;
        worker.postMessage({ type: 'batch', ...batch });
      } catch { /* jen doplněk */ }
    },
    stop() {
      stopped = true;
      try {
        clearTick(liveness);
        if (restartTimer !== null) clearTimer(restartTimer);
        restartTimer = null;
        const running = worker;
        worker = null;
        if (running) terminate(running);
      } catch { /* best effort */ }
    },
    status() {
      try {
        if (tripped) return { state: 'tripped', alerts: 0, priceAgeMs: null, syncAgeMs: null };
        if (!config || !worker || !watch || now() - watch.at > WATCH_FRESH_MS) return null;
        const at = now();
        return { state: watch.state, alerts: watch.alerts,
          priceAgeMs: watch.priceAt == null ? null : Math.max(0, at - watch.priceAt),
          syncAgeMs: watch.syncAt == null ? null : Math.max(0, at - watch.syncAt) };
      } catch {
        return null;
      }
    },
  };
}

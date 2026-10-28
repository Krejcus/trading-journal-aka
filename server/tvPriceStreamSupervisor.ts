/**
 * Hlídač vlákna kanálu ceny z TradingView v hlavním vlákně workeru
 * (INV-WORKER-04). Vlákno je jen zobrazovací doplněk: jeho pád, zaseknutí
 * ani chyba nesmí ukončit proces kopírky ani zdržet relay poll a brzdy.
 *
 * - nikdy nevyhodí a na vlákno nikdy nečeká (`update`/`stop` jsou synchronní,
 *   ukončení vlákna doběhne na pozadí),
 * - pád = restart s prodlevou; 3 pády za 10 min = jistič vypne stream do
 *   restartu workeru (nikdy nerestartuje worker sám),
 * - pády a ticho do 60 s po probuzení Macu se do jističe nepočítají,
 * - zprávy z vlákna jsou jen `alive` a omezená diagnostika; podle nich se nic
 *   nespouští a téma ani klíč se nikdy nelogují.
 */

export interface TvPriceStreamConfig {
  enabled: boolean;
  url?: string;
  anonKey?: string;
  topic?: string;
  key?: string;
  /** Snímkový graf workeru — stream se k němu nikdy nepřipojí. */
  excludeTargetId?: string;
  excludeChartId?: string;
}

export interface TvStreamWorkerLike {
  on(event: 'message' | 'error' | 'exit', listener: (value: any) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  unref(): void;
}

export interface TvPriceStreamSupervisor {
  update(config: TvPriceStreamConfig): void;
  stop(): void;
  status(): { running: boolean; tripped: boolean; crashes: number };
}

/**
 * Konfigurace vlákna z `realtime` objektu poll odpovědi relaye. Bez tématu
 * nebo klíče (server nemá tajemství, starý web) = `enabled: false` —
 * serverový vypínač bez restartu workeru.
 */
export function tvPriceStreamConfigFromRealtime(
  realtime: unknown,
  exclude: { targetId?: string; chartId?: string } = {},
): TvPriceStreamConfig {
  const row = realtime && typeof realtime === 'object' ? realtime as Record<string, unknown> : {};
  const value = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 512 ? item : undefined;
  const url = value(row.url);
  const anonKey = value(row.anonKey);
  const topic = value(row.priceTopic);
  const key = value(row.priceKey);
  if (!url || !anonKey || !topic || !key) return { enabled: false };
  return { enabled: true, url, anonKey, topic, key, excludeTargetId: exclude.targetId, excludeChartId: exclude.chartId };
}

const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 3;
const WAKE_GRACE_MS = 60_000;
const SLEEP_GAP_MS = 30_000;
const LIVENESS_TIMEOUT_MS = 15_000;
const LIVENESS_CHECK_MS = 5_000;
const DIAG_LOG_INTERVAL_MS = 10 * 60_000;

const sameConfig = (left: TvPriceStreamConfig | null, right: TvPriceStreamConfig) => !!left
  && left.enabled === right.enabled && left.url === right.url && left.anonKey === right.anonKey
  && left.topic === right.topic && left.key === right.key
  && left.excludeTargetId === right.excludeTargetId && left.excludeChartId === right.excludeChartId;

export type TvPriceSourceName = 'tv' | 'ibkr';

/** Po pádu vlákna se zdrojem IBKR jede vlákno tak dlouho jen s TV (záloha nesmí padat s IBKR). */
export const IBKR_CRASH_FALLBACK_MS = 30 * 60_000;

export function createTvPriceStreamSupervisor(options: {
  /** Vlákno s daným zdrojem ceny (`workerData.priceSource`). */
  createWorker: (priceSource: TvPriceSourceName) => TvStreamWorkerLike;
  /** Požadovaný zdroj; výchozí `tv`. */
  priceSource?: TvPriceSourceName;
  log?: (line: string) => void;
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (timer: unknown) => void;
}): TvPriceStreamSupervisor {
  const now = options.now ?? Date.now;
  const log = (line: string) => { try { options.log?.(line); } catch { /* log nesmí shodit worker */ } };
  const unrefd = <T>(timer: T): T => { (timer as { unref?: () => void }).unref?.(); return timer; };
  const setTimer = options.setTimeoutImpl ?? ((callback, ms) => unrefd(setTimeout(callback, ms)));
  const clearTimer = options.clearTimeoutImpl ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const setTick = options.setIntervalImpl ?? ((callback, ms) => unrefd(setInterval(callback, ms)));
  const clearTick = options.clearIntervalImpl ?? (timer => clearInterval(timer as ReturnType<typeof setInterval>));

  let config: TvPriceStreamConfig | null = null;
  let worker: TvStreamWorkerLike | null = null;
  let tripped = false;
  let stopped = false;
  let crashes: number[] = [];
  let restartTimer: unknown = null;
  let lastAlive = now();
  let lastTick = now();
  let lastWake = -Infinity;
  let lastDiagLog = -Infinity;
  let consecutiveRestarts = 0;

  // Vlákna ukončená záměrně (vypnutí, stop, zaseknutí): jejich `exit` už
  // nesmí znovu počítat pád ani plánovat restart.
  const retired = new WeakSet<TvStreamWorkerLike>();
  const terminate = (target: TvStreamWorkerLike) => {
    retired.add(target);
    try {
      void target.terminate().catch(() => undefined);
    } catch { /* už ukončené */ }
  };

  const preferredSource: TvPriceSourceName = options.priceSource === 'ibkr' ? 'ibkr' : 'tv';
  let workerSource: TvPriceSourceName | null = null;
  let ibkrPausedUntil = -Infinity;

  const recordCrash = (reason: string) => {
    const at = now();
    if (workerSource === 'ibkr') {
      // Pád s IBKR (i po probuzení): další vlákna jen s TV, ať záloha nepadá s IBKR do jističe.
      ibkrPausedUntil = at + IBKR_CRASH_FALLBACK_MS;
      log('TV STREAM vlákno se zdrojem IBKR skončilo — 30 min jen TradingView');
    }
    if (at - lastWake < WAKE_GRACE_MS) {
      log(`TV STREAM vlákno skončilo po probuzení (${reason}) — do jističe se nepočítá`);
    } else {
      crashes = [...crashes.filter(time => at - time < CRASH_WINDOW_MS), at];
      if (crashes.length >= CRASH_LIMIT) {
        tripped = true;
        log(`TV STREAM jistič: ${crashes.length} pády za 10 min (${reason}) — stream vypnut do restartu workeru`);
        return;
      }
      log(`TV STREAM vlákno skončilo (${reason}) — restart`);
    }
    if (stopped || !config?.enabled) return;
    const delay = Math.min(60_000, 2_000 * 2 ** consecutiveRestarts);
    consecutiveRestarts += 1;
    if (restartTimer !== null) clearTimer(restartTimer);
    restartTimer = setTimer(() => { restartTimer = null; ensure(); }, delay);
  };

  const ensure = () => {
    if (stopped || tripped || !config?.enabled || worker) return;
    let created: TvStreamWorkerLike;
    const source: TvPriceSourceName = preferredSource === 'ibkr' && now() >= ibkrPausedUntil ? 'ibkr' : 'tv';
    workerSource = source;
    try {
      created = options.createWorker(source);
    } catch (error) {
      recordCrash(error instanceof Error ? error.name : 'create-failed');
      return;
    }
    worker = created;
    lastAlive = now();
    try { created.unref(); } catch { /* volitelné */ }
    let ended = false;
    const end = (reason: string) => {
      if (ended || retired.has(created)) return;
      ended = true;
      if (worker === created) worker = null;
      if (!stopped && config?.enabled && !tripped) recordCrash(reason);
    };
    created.on('message', message => { try {
      if (worker !== created || !message || typeof message !== 'object') return;
      const type = (message as { type?: unknown }).type;
      if (type === 'alive') {
        lastAlive = now();
        consecutiveRestarts = 0;
        return;
      }
      if (type === 'diag' && now() - lastDiagLog >= DIAG_LOG_INTERVAL_MS) {
        lastDiagLog = now();
        const diag = message as {
          state?: unknown; reads?: unknown; sends?: unknown; errors?: unknown;
          source?: unknown; ibkr?: unknown; ibkrCode?: unknown; ibkrTrades?: unknown;
        };
        const code = (value: unknown) => String(value ?? '-').replace(/[^a-z0-9-]/gi, '').slice(0, 16) || '-';
        // Jen čísla a krátké kódy — žádné téma, klíč, obsah zpráv ani text chyb Gateway.
        const ibkr = diag.source === undefined ? '' : ` zdroj=${code(diag.source)} ibkr=${code(diag.ibkr)} kód=${code(diag.ibkrCode)} obchody=${Number(diag.ibkrTrades) || 0}`;
        log(`TV STREAM stav=${String(diag.state).slice(0, 16)} reads=${Number(diag.reads) || 0} sends=${Number(diag.sends) || 0} errors=${Number(diag.errors) || 0}${ibkr}`);
      }
    } catch { /* výjimka v posluchači na hlavním vlákně by shodila proces kopírky */ } });
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
      } else if (worker && preferredSource === 'ibkr' && workerSource === 'tv' && at >= ibkrPausedUntil && !stopped && !tripped) {
        // Pauza IBKR po pádu skončila: zdravé vlákno s TV záměrně vyměnit (do jističe se nepočítá).
        const current = worker;
        worker = null;
        terminate(current);
        log('TV STREAM pauza IBKR skončila — vlákno znovu se zdrojem IBKR');
        ensure();
      }
    } catch { /* hlídač nesmí shodit worker */ }
  }, LIVENESS_CHECK_MS);

  return {
    update(next) {
      try {
        if (stopped || sameConfig(config, next)) return;
        config = { ...next };
        if (!next.enabled) {
          if (restartTimer !== null) { clearTimer(restartTimer); restartTimer = null; }
          const running = worker;
          worker = null;
          if (running) terminate(running);
          return;
        }
        if (worker) worker.postMessage({ type: 'config', ...next });
        // Čekající restart drží svou prodlevu; nová konfigurace se použije při něm.
        else if (restartTimer === null) ensure();
      } catch { /* zobrazovací doplněk nikdy nevyhodí do relay smyčky */ }
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
    status: () => ({ running: worker !== null, tripped, crashes: crashes.length }),
  };
}

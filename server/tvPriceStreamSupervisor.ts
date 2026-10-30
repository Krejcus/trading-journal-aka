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
 * - zprávy z vlákna jsou jen `alive`, omezená diagnostika a svíčky dne z IBKR
 *   (`bars`, jen čísla, ověřené a omezené velikostí i četností); podle nich se
 *   nic nespouští, svíčky jen čeká čtení grafu dne (`latestBars`) a téma ani klíč
 *   se nikdy nelogují.
 */

import { normalizeBarsContract, sanitizeTvBars, tvPriceFamily, tvSymbolRoot, TV_BARS_MAX, type TvBar, type TvBarsCapture } from '../lib/tradingViewBars';

/** Svíčky z vlákna starší než tohle se pro graf dne nepoužijí (vlákno posílá po 30 s). */
export const IBKR_BARS_FRESH_MS = 90_000;
/** Zprávy `bars` častější než tohle se zahodí. */
const BARS_MIN_INTERVAL_MS = 10_000;

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
  /**
   * Poslední svíčky dne z IBKR pro cenovou rodinu kořene (jen zobrazení: graf dne
   * a hodnocení). `null`, když vlákno neběží, kanál je vypnutý nebo čtení je starší
   * než 90 s. Synchronní, nikdy nevyhodí.
   */
  latestBars(root: string): TvBarsCapture | null;
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

/** Výpadek nebo návrat zdroje IBKR: `ibkr` = stav zdroje (`crash` = pád vlákna), `code` = kód Gateway. */
export interface PriceSourceAlert {
  state: 'down' | 'up';
  ibkr: string | null;
  code: number | null;
}

/** Po pádu vlákna se zdrojem IBKR jede vlákno tak dlouho jen s TV (záloha nesmí padat s IBKR). */
export const IBKR_CRASH_FALLBACK_MS = 30 * 60_000;

export function createTvPriceStreamSupervisor(options: {
  /** Vlákno s daným zdrojem ceny (`workerData.priceSource`). */
  createWorker: (priceSource: TvPriceSourceName) => TvStreamWorkerLike;
  /** Požadovaný zdroj; výchozí `tv`. */
  priceSource?: TvPriceSourceName;
  log?: (line: string) => void;
  /** Výpadek / návrat IBKR (jen stav a krátké kódy) — oznámení na Macu. Nikdy nesmí vyhodit ven. */
  onPriceSourceAlert?: (alert: PriceSourceAlert) => void;
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (timer: unknown) => void;
}): TvPriceStreamSupervisor {
  const now = options.now ?? Date.now;
  const log = (line: string) => { try { options.log?.(line); } catch { /* log nesmí shodit worker */ } };
  const alert = (value: PriceSourceAlert) => { try { options.onPriceSourceAlert?.(value); } catch { /* oznámení nesmí shodit worker */ } };
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
  let latest: { worker: TvStreamWorkerLike; receivedAt: number; capture: TvBarsCapture } | null = null;
  let lastBarsAt = -Infinity;

  /** Ověří zprávu `bars` z vlákna: typ a délka v O(1) dřív než cokoli dalšího. */
  const acceptBars = (from: TvStreamWorkerLike, message: Record<string, unknown>) => {
    const at = now();
    if (at - lastBarsAt < BARS_MIN_INTERVAL_MS) return;
    const flat = message.bars;
    if (!(flat instanceof Float64Array) || flat.length === 0 || flat.length % 6 !== 0 || flat.length > TV_BARS_MAX * 6) return;
    const root = tvSymbolRoot(message.root);
    const source = typeof message.source === 'string' && message.source.startsWith('IBKR:') ? message.source.slice(0, 32) : null;
    const contract = normalizeBarsContract(message.contract);
    const capturedAt = Number(message.at);
    if (!root || root !== message.root || !source || !contract || !Number.isFinite(capturedAt) || Math.abs(capturedAt - at) > 60_000) return;
    const rows: TvBar[] = [];
    for (let index = 0; index < flat.length; index += 6) {
      rows.push([flat[index], flat[index + 1], flat[index + 2], flat[index + 3], flat[index + 4], flat[index + 5]]);
    }
    const bars = sanitizeTvBars(rows, capturedAt);
    if (!bars.length) return;
    lastBarsAt = at;
    latest = { worker: from, receivedAt: at, capture: { root, at: Math.floor(capturedAt), source, contract, bars } };
  };

  let ibkrPausedUntil = -Infinity;

  const recordCrash = (reason: string) => {
    const at = now();
    if (workerSource === 'ibkr') {
      // Pád s IBKR (i po probuzení): další vlákna jen s TV, ať záloha nepadá s IBKR do jističe.
      ibkrPausedUntil = at + IBKR_CRASH_FALLBACK_MS;
      log('TV STREAM vlákno se zdrojem IBKR skončilo — 30 min jen TradingView');
      alert({ state: 'down', ibkr: 'crash', code: null });
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
      if (type === 'bars') {
        acceptBars(created, message as Record<string, unknown>);
        return;
      }
      if (type === 'price-source') {
        const row = message as { state?: unknown; ibkr?: unknown; code?: unknown };
        if (row.state !== 'down' && row.state !== 'up') return;
        const ibkr = typeof row.ibkr === 'string' ? row.ibkr.replace(/[^a-z-]/gi, '').slice(0, 16) || null : null;
        const code = Number.isSafeInteger(row.code) ? row.code as number : null;
        log(row.state === 'down'
          ? `TV STREAM IBKR nedostupné (ibkr=${ibkr ?? '-'} kód=${code ?? '-'}) — cena ze zálohy TradingView`
          : 'TV STREAM IBKR zpět — cena znovu z IBKR');
        alert({ state: row.state, ibkr, code });
        return;
      }
      if (type === 'diag' && now() - lastDiagLog >= DIAG_LOG_INTERVAL_MS) {
        lastDiagLog = now();
        const diag = message as {
          state?: unknown; reads?: unknown; sends?: unknown; errors?: unknown; skippedRateCap?: unknown;
          source?: unknown; ibkr?: unknown; ibkrCode?: unknown; ibkrTrades?: unknown;
        };
        const code = (value: unknown) => String(value ?? '-').replace(/[^a-z0-9-]/gi, '').slice(0, 16) || '-';
        // Jen čísla a krátké kódy — žádné téma, klíč, obsah zpráv ani text chyb Gateway.
        const ibkr = diag.source === undefined ? '' : ` zdroj=${code(diag.source)} ibkr=${code(diag.ibkr)} kód=${code(diag.ibkrCode)} obchody=${Number(diag.ibkrTrades) || 0}`;
        log(`TV STREAM stav=${String(diag.state).slice(0, 16)} reads=${Number(diag.reads) || 0} sends=${Number(diag.sends) || 0}`
          + ` rate-cap=${Number(diag.skippedRateCap) || 0} errors=${Number(diag.errors) || 0}${ibkr}`);
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
        // „Zpět“ ohlásí až nové vlákno po prvním platném čtení z IBKR (start je na TV).
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
    latestBars(root) {
      try {
        const current = latest;
        const wanted = tvSymbolRoot(root);
        if (!current || !wanted || stopped || tripped || !config?.enabled || worker === null || current.worker !== worker) return null;
        if (now() - current.receivedAt > IBKR_BARS_FRESH_MS) return null;
        if (tvPriceFamily(wanted) !== tvPriceFamily(current.capture.root)) return null;
        return { ...current.capture, root: wanted, bars: current.capture.bars.slice() };
      } catch {
        return null;
      }
    },
  };
}

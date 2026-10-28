import { pickTvBars, tvPriceFamily, tvSymbolRoot, TV_BARS_EXPRESSION, type TvBarsCapture } from '../lib/tradingViewBars';
import { evaluateTradingViewChartTargets, type TradingViewMarketPriceOptions } from './tradingViewMarketPrice';

/**
 * Worker: po výstupu z obchodu přečte 1m svíčky z grafu TradingView (read-only
 * CDP, stejný kanál jako snímky) a pošle je na server jako předběžný graf pro
 * hodnocení. Nikdy neblokuje copier: chyba = tichý skip s logem.
 */

export async function readTradingViewBars(
  root: string,
  options: TradingViewMarketPriceOptions = {},
): Promise<TvBarsCapture | null> {
  const at = (options.now ?? Date.now)();
  const readings = await evaluateTradingViewChartTargets(TV_BARS_EXPRESSION, { timeoutMs: 3_000, ...options });
  const picked = pickTvBars(readings.flatMap(reading => Array.isArray(reading) ? reading : []), root, at);
  return picked ? { root, at, ...picked } : null;
}

/** Hned po výstupu (uzavřená minuta výstupu) a po 20 min kvůli průběhu po obchodu. */
export const TV_BARS_CAPTURE_DELAYS_MS = [65_000, 20 * 60_000] as const;

export function scheduleTradingViewBarsCapture(options: {
  symbol: string;
  exitAt: number;
  upload: (capture: TvBarsCapture) => Promise<void>;
  read?: (root: string) => Promise<TvBarsCapture | null>;
  log?: (message: string) => void;
  delaysMs?: readonly number[];
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
}): () => void {
  const root = tvSymbolRoot(options.symbol);
  if (!root) return () => {};
  const read = options.read ?? (value => readTradingViewBars(value));
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const timers = (options.delaysMs ?? TV_BARS_CAPTURE_DELAYS_MS).map(delay => {
    const timer = (options.setTimeoutImpl ?? setTimeout)(() => {
      void (async () => {
        try {
          const capture = await read(root);
          if (!capture) { log(`TV BARS skip root=${root} reason=no-1m-chart`); return; }
          // Graf musí sahat až za výstup, jinak by chyběl konec obchodu.
          if (capture.bars[capture.bars.length - 1][0] * 1000 < options.exitAt - 60_000) {
            log(`TV BARS skip root=${root} reason=stale-chart`); return;
          }
          await options.upload(capture);
          log(`TV BARS uploaded root=${root} bars=${capture.bars.length} source=${capture.source}`);
        } catch (error) {
          log(`TV BARS failed root=${root} error=${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    }, Math.max(0, options.exitAt + delay - now()));
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });
  return () => { for (const timer of timers) clearTimeout(timer); };
}

/** Živé svíčky: jak často worker čte graf, když nic neobchoduje. */
export const TV_LIVE_BARS_INTERVAL_MS = 60_000;
/**
 * I beze změny grafu (přestávka, víkend) se čtení po této době pošle znovu,
 * aby klient poznal, že worker běží (klient hlásí „stojí“ po 5 min).
 */
export const TV_LIVE_BARS_KEEPALIVE_MS = 2 * 60_000;
/**
 * Sekunda minuty, ve které worker posílá svíčky dne (pilot). Soubor tak vždy
 * nese UZAVŘENOU předchozí minutu — jinak by klient při obnově dat přepsal
 * předposlední svíčku stavem z poloviny minuty (graf dne, 28. 10. 2026).
 */
export const TV_LIVE_BARS_PHASE_MS = 10_000;
/** Víc cenových rodin worker nečte — limit serveru je 4 zápisy/min. */
export const TV_LIVE_BARS_MAX_ROOTS = 2;

export interface TradingViewLiveBarsFeed {
  stop(): void;
}

/**
 * Worker: průběžně (výchozí 1×/min) čte 1m svíčky z grafu TradingView a
 * posílá je na server jako „živý“ graf pro přípravu a pohled dne. Stejné
 * read-only čtení jako po obchodu; jen zobrazení, nikdy nevstupuje do
 * copieru. Běhy se nepřekrývají, beze změny poslední svíčky se nic
 * neposílá a jakákoli chyba končí tichým skipem s logem při změně stavu.
 */
export function startTradingViewLiveBars(options: {
  roots: readonly string[];
  upload: (capture: TvBarsCapture) => Promise<void>;
  /** Bez spárovaného relaye se graf vůbec nečte (zbytečné CDP čtení). */
  ready?: () => boolean;
  read?: (root: string) => Promise<TvBarsCapture | null>;
  log?: (message: string) => void;
  intervalMs?: number;
  /** Čtení zarovnat na tuto ms po začátku minuty (`undefined` = hned a pak po intervalu). */
  phaseMs?: number;
  now?: () => number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): TradingViewLiveBarsFeed {
  // MNQ a NQ sdílí na serveru jeden soubor — čte se jen první kořen z rodiny.
  const byFamily = new Map<string, string>();
  for (const raw of options.roots) {
    const root = tvSymbolRoot(raw);
    if (root && !byFamily.has(tvPriceFamily(root))) byFamily.set(tvPriceFamily(root), root);
  }
  const roots = [...byFamily.values()].slice(0, TV_LIVE_BARS_MAX_ROOTS);
  const ready = options.ready ?? (() => true);
  const now = options.now ?? Date.now;
  const read = options.read ?? (root => readTradingViewBars(root));
  const log = options.log ?? (() => {});
  const intervalMs = Math.max(15_000, options.intervalMs ?? TV_LIVE_BARS_INTERVAL_MS);
  // Podpis posledního odeslaného čtení na kořen: čas, close a počet svíček.
  const sent = new Map<string, { signature: string; at: number }>();
  // Poslední zalogovaný stav na kořen, aby log nehlásil totéž každou minutu.
  const reported = new Map<string, string>();
  const report = (root: string, state: string, message: string) => {
    if (reported.get(root) === state) return;
    reported.set(root, state);
    log(message);
  };
  let inFlight = false;
  let stopped = false;
  const tick = async () => {
    if (inFlight || stopped || !ready()) return;
    inFlight = true;
    try {
      for (const root of roots) {
        if (stopped) return;
        try {
          const capture = await read(root);
          if (stopped) return;
          if (!capture) { report(root, 'no-chart', `TV LIVE skip root=${root} reason=no-1m-chart`); continue; }
          const last = capture.bars[capture.bars.length - 1];
          const signature = `${last[0]}:${last[4]}:${capture.bars.length}`;
          const previous = sent.get(root);
          if (previous?.signature === signature && now() - previous.at < TV_LIVE_BARS_KEEPALIVE_MS) continue;
          await options.upload(capture);
          sent.set(root, { signature, at: now() });
          report(root, 'ok', `TV LIVE uploading root=${root} bars=${capture.bars.length} source=${capture.source}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report(root, `error:${message}`, `TV LIVE failed root=${root} error=${message}`);
        }
      }
    } finally {
      inFlight = false;
    }
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let alignTimer: ReturnType<typeof setTimeout> | null = null;
  if (options.phaseMs === undefined) {
    timer = (options.setIntervalImpl ?? setInterval)(() => { void tick(); }, intervalMs);
    (timer as { unref?: () => void }).unref?.();
  } else {
    // Řetěz časovačů: každá příští prodleva se počítá znovu z hodin, aby se fáze
    // nerozjela zpožďováním ani po uspání Macu (setInterval by ji ztratil).
    const phase = Math.min(59_000, Math.max(0, options.phaseMs));
    const scheduleNext = () => {
      if (stopped) return;
      const raw = (60_000 + phase - (now() % 60_000)) % 60_000;
      // Časovač, který vystřelí o chlup dřív, nesmí naplánovat druhý běh hned za sebou.
      const delay = raw < 1_000 ? raw + 60_000 : raw;
      alignTimer = (options.setTimeoutImpl ?? setTimeout)(() => { alignTimer = null; void tick(); scheduleNext(); }, delay);
      (alignTimer as { unref?: () => void }).unref?.();
    };
    scheduleNext();
  }
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (alignTimer !== null) (options.clearTimeoutImpl ?? clearTimeout)(alignTimer);
      if (timer !== null) (options.clearIntervalImpl ?? clearInterval)(timer);
    },
  };
}

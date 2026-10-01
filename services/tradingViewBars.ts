import { pickTvBars, tvSymbolRoot, TV_BARS_EXPRESSION, type TvBarsCapture } from '../lib/tradingViewBars';
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

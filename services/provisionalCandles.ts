import type { Trade } from '../types';
import {
  mergeTvBarCaptures,
  parseTvBarsFileName,
  tvBarsFolder,
  tvPriceFamily,
  tvSymbolRoot,
  type TvBar,
} from '../lib/tradingViewBars';
import type { MarketCandleResponse } from './marketDataCalculations';
import { supabase } from './supabase';

/**
 * Předběžný graf hodnocení: 1m svíčky, které worker přečetl z TradingView po
 * výstupu z obchodu. Použije se jen dokud Databento historical data nemá
 * (~24 h); jinak vrací `null` a hodnocení ukáže „Graf dorazí zítra".
 */

const BUCKET = 'copier-snapshots';
// Krátká cache: druhé čtení workeru (20 min po výstupu) má dorazit bez reloadu.
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; request: Promise<MarketCandleResponse | null> }>();

/** Svíčky pokrývají obchod: před vstupem i minuta výstupu jsou v datech. */
export function coversTrade(bars: readonly TvBar[], entryMs: number, exitMs: number): boolean {
  if (!bars.length) return false;
  return bars[0][0] * 1000 <= entryMs && bars[bars.length - 1][0] * 1000 >= Math.floor(exitMs / 60_000) * 60_000;
}

export function provisionalResponse(bars: readonly TvBar[], symbol: string, source: string): MarketCandleResponse {
  return {
    provider: 'tradingview',
    dataset: 'tradingview',
    schema: 'ohlcv-1m',
    symbol,
    sourceSymbol: source,
    start: new Date(bars[0][0] * 1000).toISOString(),
    end: new Date((bars[bars.length - 1][0] + 60) * 1000).toISOString(),
    candles: bars.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume })),
  };
}

async function load(trade: Trade, { entryMs, exitMs }: ProvisionalTiming): Promise<MarketCandleResponse | null> {
  const root = tvSymbolRoot(trade.symbol || trade.instrument);
  if (!root) return null;
  const { data: auth } = await supabase.auth.getSession();
  const userId = auth.session?.user.id;
  if (!userId) return null;
  const family = tvPriceFamily(root);
  // Čtení vznikají po výstupu: den výstupu a případně následující (UTC půlnoc).
  const folders = [...new Set([exitMs, exitMs + 30 * 60_000].map(ms => tvBarsFolder(userId, ms)))];
  const files = (await Promise.all(folders.map(async folder => {
    const { data, error } = await supabase.storage.from(BUCKET).list(folder, { limit: 200 });
    if (error || !data) return [];
    return data.flatMap(item => {
      const parsed = parseTvBarsFileName(item.name);
      // Čtení před výstupem obchod nepokryje; čtení o hodně později nemá smysl stahovat.
      if (!parsed || tvPriceFamily(parsed.root) !== family) return [];
      if (parsed.at < exitMs || parsed.at > exitMs + 6 * 60 * 60_000) return [];
      return [{ path: `${folder}/${item.name}`, ...parsed }];
    });
  }))).flat().sort((a, b) => a.at - b.at).slice(0, 6);
  if (!files.length) return null;
  const captures = (await Promise.all(files.map(async file => {
    const { data, error } = await supabase.storage.from(BUCKET).download(file.path);
    if (error || !data) return null;
    try {
      const body = JSON.parse(await data.text()) as { at?: unknown; bars?: unknown; source?: unknown };
      return Array.isArray(body.bars) ? { at: file.at, bars: body.bars as TvBar[], source: String(body.source ?? '') } : null;
    } catch { return null; }
  }))).filter((capture): capture is { at: number; bars: TvBar[]; source: string } => capture != null);
  const bars = mergeTvBarCaptures(captures);
  if (!coversTrade(bars, entryMs, exitMs)) return null;
  return provisionalResponse(bars, root, captures[captures.length - 1]?.source ?? '');
}

/** Časy z `tradeChartTiming` (volající je už má). */
export interface ProvisionalTiming { entryMs: number; exitMs: number }

export function loadProvisionalCandles(trade: Trade, timing: ProvisionalTiming): Promise<MarketCandleResponse | null> {
  const key = `${trade.accountId}:${trade.id}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.request;
  const request = load(trade, timing).catch(() => null);
  const entry = { at: Date.now(), request };
  cache.set(key, entry);
  // Neúspěch (worker ještě nečetl) se může za chvíli změnit — necachovat.
  void request.then(result => { if (!result && cache.get(key) === entry) cache.delete(key); });
  return request;
}

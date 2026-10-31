import type { Trade } from '../types';
import {
  barsContractConflicts,
  mergeTvBarCaptures,
  parseTvBarsFileName,
  tvBarsFolder,
  tvPriceFamily,
  tvSymbolRoot,
  type TvBar,
} from '../lib/tradingViewBars';
import type { MarketCandleResponse } from './marketDataCalculations';
import { supabase } from './supabase';
import { inspectCandleSnapshot } from '../lib/candleSnapshotValidation';
import { regularNasdaqSession } from '../lib/chartDataQuality';

/**
 * Předběžný graf hodnocení: 1m svíčky, které worker přečetl z TradingView po
 * výstupu z obchodu. Použije se jen dokud Databento historical data nemá
 * (~24 h); jinak vrací `null` a hodnocení ukáže „Graf dorazí zítra".
 */

const BUCKET = 'copier-snapshots';
// Krátká cache: druhé čtení workeru (20 min po výstupu) má dorazit bez reloadu.
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; request: Promise<MarketCandleResponse | null> }>();

/** Both fill minutes and every minute of the regular session must be present. */
export function coversTrade(bars: readonly TvBar[], entryMs: number, exitMs: number): boolean {
  if (!bars.length || !Number.isFinite(entryMs) || !Number.isFinite(exitMs) || exitMs < entryMs) return false;
  const start = Math.floor(entryMs / 60_000) * 60;
  const end = Math.floor(exitMs / 60_000) * 60;
  let expected = start;
  let missingRegularMinutes = 0;
  for (const bar of bars) {
    if (bar[0] < start) continue;
    if (bar[0] > end) return false;
    // Fill minutes themselves always need evidence, even at a scheduled halt.
    if (expected === start && bar[0] !== start) return false;
    while (expected < bar[0]) {
      if (regularNasdaqSession(expected * 1000) && ++missingRegularMinutes > 1) return false;
      expected += 60;
    }
    if (bar[0] !== expected) return false;
    if (bar[0] === end) return true;
    expected += 60;
  }
  return false;
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
      const body: unknown = JSON.parse(await data.text());
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      // Legacy captures omit `at`; their authenticated storage filename supplies it.
      const parsed = inspectCandleSnapshot(JSON.stringify({ at: file.at, ...body }), root);
      if (!parsed.ok) return null;
      // Čtení jiného kontraktu než obchodu (týden rollu) do grafu hodnocení nepatří.
      const symbol = trade.symbol || trade.instrument || '';
      if (barsContractConflicts(parsed.validation.contract, symbol)) return null;
      return { at: parsed.at, bars: parsed.bars, source: parsed.source };
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

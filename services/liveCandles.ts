import { sanitizeTvBars, tvLiveBarsStoragePath, tvSymbolRoot, type TvBar } from '../lib/tradingViewBars';
import type { MarketCandle, MarketCandleResponse } from './marketDataCalculations';
import { provisionalResponse } from './provisionalCandles';
import { supabase } from './supabase';

/**
 * Živé 1m svíčky pro přípravu a pohled dne. Worker je 1×/min čte z grafu
 * TradingView (read-only CDP) a přepisuje jeden soubor v soukromém bucketu.
 * Databento historical má ~24 h zpoždění, takže dnešní noc a včerejší NY
 * jsou dostupné jen odsud. Jen zobrazení člověku na obrazovce — nikdy risk
 * brány, day lock, limity, kopírka ani jiná automatika (licence dat
 * TradingView je jen pro zobrazení; pravidlo v `lib/tradingViewBars.ts`).
 */

const BUCKET = 'copier-snapshots';

/**
 * Čtení starší než tohle znamená, že worker nebo TradingView neběží. Worker
 * i beze změny grafu posílá čtení nejpozději po 2 min, takže klidný trh
 * (přestávka, víkend) se za výpadek nevydává.
 */
export const LIVE_CANDLES_STALE_MS = 5 * 60_000;

export interface LiveCandles {
  response: MarketCandleResponse;
  /** Hodiny workeru v okamžiku čtení (epoch ms). */
  capturedAt: number;
  /** Čtení je starší než `LIVE_CANDLES_STALE_MS` — graf stojí. */
  stale: boolean;
}

/** Rozparsuje uložený soubor; vadný obsah = `null`, nikdy výjimka. */
export function parseLiveCandlesFile(text: string, root: string, now = Date.now()): LiveCandles | null {
  let body: { at?: unknown; bars?: unknown; source?: unknown };
  try { body = JSON.parse(text) as typeof body; } catch { return null; }
  const at = Number(body.at);
  if (!Number.isFinite(at) || at > now + 5 * 60_000) return null;
  const bars: TvBar[] = sanitizeTvBars(body.bars, at);
  if (!bars.length) return null;
  return {
    response: provisionalResponse(bars, root, typeof body.source === 'string' ? body.source : ''),
    capturedAt: at,
    stale: now - at > LIVE_CANDLES_STALE_MS,
  };
}

/** Poslední živé čtení pro kořen (MNQ i NQ sdílí jeden soubor). */
export async function loadLiveCandles(symbol: string, now = Date.now()): Promise<LiveCandles | null> {
  const root = tvSymbolRoot(symbol);
  if (!root) return null;
  const { data: auth } = await supabase.auth.getSession();
  const userId = auth.session?.user.id;
  if (!userId) return null;
  const { data, error } = await supabase.storage.from(BUCKET).download(tvLiveBarsStoragePath(userId, root));
  if (error || !data) return null;
  return parseLiveCandlesFile(await data.text(), root, now);
}

/**
 * Sešije historii (Databento) s živým čtením: historie platí, dokud ji
 * máme, živé svíčky doplní jen čas za její poslední svíčkou. Rozpracovaná
 * poslední minuta živého čtení tak nikdy nepřepíše dokončenou historickou.
 */
export function stitchLiveCandles(historical: readonly MarketCandle[], live: readonly MarketCandle[]): MarketCandle[] {
  const lastHistorical = historical.length ? historical[historical.length - 1].time : -Infinity;
  return [...historical, ...live.filter(candle => candle.time > lastHistorical)];
}

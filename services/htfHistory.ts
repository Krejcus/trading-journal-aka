import { marketDataSchemaForTimeframe, timeframeMinutes, type MarketCandle, type MarketTimeframe } from './marketDataCalculations';

/**
 * Hlubší historie pro vyšší timeframy v grafech deníku (fáze 5). Graf dne má
 * jen 14 dní 1m svíček; na timeframu skládaném z hodin (1h, 2h, 4h, D, W, M
 * a vlastní N h) se před ně přidají hodinové svíčky Databento. Poslední dny
 * dál jdou z 1m dat (a dnešek z IBKR) — hodinová historie končí přesně tam,
 * kde 1m data začínají. Jen zobrazení.
 */

const DAY_SEC = 24 * 60 * 60;
const HOUR_SEC = 60 * 60;

/** Kolik dní hodinové historie potřebuje timeframe; `0` = žádnou (skládá se z minut). */
export function htfHistoryDays(timeframe: MarketTimeframe): number {
  if (marketDataSchemaForTimeframe(timeframe) !== 'ohlcv-1h') return 0;
  if (timeframe === 'M') return 3 * 365;
  const minutes = timeframeMinutes(timeframe);
  if (!Number.isFinite(minutes)) return 0;
  return minutes >= 24 * 60 ? 2 * 365 : 120;
}

/** Nejdelší potřeba ze všech timeframů na obrazovce (jeden dotaz pro všechny panely). */
export const htfHistoryDaysFor = (timeframes: readonly MarketTimeframe[]): number =>
  timeframes.reduce((max, timeframe) => Math.max(max, htfHistoryDays(timeframe)), 0);

/**
 * Okno hodinové historie: od půlnoci UTC (stabilní klíč cache) do celé hodiny,
 * kde začínají 1m data. `null` = není co načíst.
 */
export function htfHistoryRange(firstRawTime: number | null | undefined, days: number): { startMs: number; endMs: number } | null {
  if (!days || firstRawTime == null || !Number.isFinite(firstRawTime)) return null;
  const endSec = Math.floor(firstRawTime / HOUR_SEC) * HOUR_SEC;
  const startSec = Math.floor((endSec - days * DAY_SEC) / DAY_SEC) * DAY_SEC;
  return endSec > startSec ? { startMs: startSec * 1_000, endMs: endSec * 1_000 } : null;
}

/**
 * 1m data grafu s hodinovou historií před nimi. Jen celé hodiny, které skončí
 * před první 1m svíčkou (žádná minuta se nezapočítá dvakrát). Pro timeframe
 * pod hodinu se historie nepřidává.
 */
export function withHtfHistory(raw: MarketCandle[], hourly: readonly MarketCandle[], timeframe: MarketTimeframe): MarketCandle[] {
  if (!hourly.length || !raw.length || !htfHistoryDays(timeframe)) return raw;
  const first = raw[0].time;
  const before = hourly.filter(candle => candle.time + HOUR_SEC <= first);
  return before.length ? [...before, ...raw] : raw;
}

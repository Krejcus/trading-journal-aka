import { marketDataSchemaForTimeframe, timeframeMinutes, type MarketCandle, type MarketTimeframe } from './marketDataCalculations';
import { aggregateVerifiedCandles } from './verifiedCandleAggregation';

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
 * Hodinová historie navazuje na 1m data jen když jde o stejný kontrakt.
 * Historie je kontinuální řada (`.v.0`), 1m data grafu dne můžou kolem rollu
 * patřit jinému kontraktu — skok mezi nimi (~roll spread) by v grafu vypadal
 * jako skutečný gap. Větší rozdíl než tohle (podíl ceny, ~60 b u NQ) =
 * historii nepřidat.
 */
export const HTF_HISTORY_MAX_JUMP_RATIO = 0.002;

const beforeCache = new WeakMap<readonly MarketCandle[], Map<string, MarketCandle[]>>();

/**
 * Hodiny, které skončí před první 1m svíčkou (žádná minuta dvakrát), nebo nic,
 * když na 1m data cenou nenavazují (jiný kontrakt). Výsledek je pro stejnou
 * historii a stejný začátek dat stejné pole (memo — přehrávání ho nepřepočítává).
 */
export function htfHistoryBefore(raw: readonly MarketCandle[], hourly: readonly MarketCandle[]): MarketCandle[] {
  if (!hourly.length || !raw.length) return [];
  const first = raw[0];
  const key = `${first.time}|${first.open}`;
  let byFirst = beforeCache.get(hourly);
  const cached = byFirst?.get(key);
  if (cached) return cached;
  const before = hourly.filter(candle => candle.time + HOUR_SEC <= first.time);
  const last = before[before.length - 1];
  const result = last && Math.abs(last.close - first.open) > Math.abs(first.open) * HTF_HISTORY_MAX_JUMP_RATIO ? [] : before;
  if (!byFirst) { byFirst = new Map(); beforeCache.set(hourly, byFirst); }
  if (byFirst.size > 8) byFirst.clear();
  byFirst.set(key, result);
  return result;
}

/**
 * 1m data grafu s hodinovou historií před nimi (pro rozpracovaný bar živé
 * svíčky a přehrávání). Pro timeframe pod hodinu beze změny.
 */
export function withHtfHistory(raw: MarketCandle[], hourly: readonly MarketCandle[], timeframe: MarketTimeframe): MarketCandle[] {
  if (!htfHistoryDays(timeframe)) return raw;
  const before = htfHistoryBefore(raw, hourly);
  return before.length ? [...before, ...raw] : raw;
}

/**
 * Svíčky timeframu z historie + 1m dat. Historie se agreguje jednou (memo), při
 * každém kroku přehrávání nebo obnově dat jen 1m část; svíčka na hranici (týden,
 * měsíc začatý v historii) se sloučí.
 */
export function aggregateWithHtfHistory(raw: MarketCandle[], hourly: readonly MarketCandle[], timeframe: MarketTimeframe): MarketCandle[] {
  const recent = aggregateVerifiedCandles(raw, timeframe);
  if (!htfHistoryDays(timeframe)) return recent;
  const before = htfHistoryBefore(raw, hourly);
  if (!before.length) return recent;
  const history = aggregateVerifiedCandles(before, timeframe);
  if (!history.length) return recent;
  if (!recent.length) return history;
  const tail = history[history.length - 1];
  const head = recent[0];
  if (tail.time !== head.time) return [...history, ...recent];
  const merged: MarketCandle = {
    ...head,
    open: tail.open,
    high: Math.max(tail.high, head.high),
    low: Math.min(tail.low, head.low),
    volume: (tail.volume ?? 0) + (head.volume ?? 0),
  };
  return [...history.slice(0, -1), merged, ...recent.slice(1)];
}

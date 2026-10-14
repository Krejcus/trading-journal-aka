import { pragueWallTime } from '../lib/dayJournal';
import {
  loadMarketCandles,
  loadTradeMarketCandles,
  marketDataWindowForEntry,
  resolveMarketSymbol,
  type MarketCandle,
  type MarketCandleResponse,
} from './marketData';
import { stitchLiveCandles } from './liveCandles';

/**
 * Svíčky pro graf dne: 14 dní kontextu (PDH/PDL, týdenní úrovně) až do
 * konce zvoleného dne, nikdy za něj. Databento historical má ~24 h
 * zpoždění a poslední den by šel přes placený fallback — historie proto
 * končí ~24 h 20 min před teď a zbytek (dnešek, včerejší NY) doplní živé čtení
 * z TradingView. Jen zobrazení; nic z toho nejde do copieru ani do P&L.
 */

/** Databento historical zveřejňuje ~24 h po trhu; rezerva, ať nejdeme do placeného fallbacku. */
export const HISTORICAL_LAG_MS = 24 * 60 * 60_000 + 20 * 60_000;
const MINUTE_MS = 60_000;
/** Hranice historie skáče po 15 min — stejný klíč dotazu (cache) a navazuje na živé čtení (27 h). */
const CAP_STEP_MS = 15 * MINUTE_MS;

const nextDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

export interface DayCandleWindow {
  /** Začátek kontextu (14 dní před dnem, pražská půlnoc). */
  start: Date;
  /** Konec historie — konec dne nebo now−25 h, co nastane dřív. `null` = historie nic nepokrývá. */
  historicalEnd: Date | null;
  /** Pražská půlnoc na začátku a konci dne (ms). */
  dayStart: number;
  dayEnd: number;
  /** Historie nepokryje celý den — zbytek musí dodat živé čtení. */
  needsLive: boolean;
}

export function dayCandleWindow(day: string, now = Date.now()): DayCandleWindow {
  const dayStart = pragueWallTime(day, '00:00');
  const dayEnd = pragueWallTime(nextDay(day), '00:00');
  const start = marketDataWindowForEntry(dayStart + 12 * 60 * MINUTE_MS).start;
  const cap = Math.floor((now - HISTORICAL_LAG_MS) / CAP_STEP_MS) * CAP_STEP_MS;
  const end = Math.min(dayEnd, cap);
  return {
    start,
    historicalEnd: end > start.getTime() ? new Date(end) : null,
    dayStart,
    dayEnd,
    needsLive: end < dayEnd,
  };
}

/** Ponechá jen svíčky před koncem dne (graf dne nikdy neukazuje budoucnost dne). */
export const candlesBefore = (candles: readonly MarketCandle[], endMs: number) => {
  const endSec = Math.floor(endMs / 1000);
  return candles.filter(candle => candle.time < endSec);
};

export interface DayCandleAnchor { symbol?: string; at: number; price: number }

export interface DayCandlesDeps {
  loadContinuous: (symbol: string, start: Date, end: Date) => Promise<MarketCandleResponse>;
  loadForTrade: (params: { root: 'MNQ' | 'NQ'; tradeSymbol?: string; start: Date; end: Date; entryMs: number; entryPrice: number }) => Promise<MarketCandleResponse>;
}

const defaultDeps: DayCandlesDeps = {
  loadContinuous: (symbol, start, end) => loadMarketCandles({ symbol, start, end }),
  loadForTrade: params => loadTradeMarketCandles(params),
};

/**
 * Historická část grafu dne. S obchody dne se kontrakt ověří cenou prvního
 * vstupu (rollover), jinak kontinuální řada. `null` = den je celý v živém okně.
 */
export async function loadDayHistoricalCandles(params: {
  day: string;
  root?: 'MNQ' | 'NQ';
  anchor?: DayCandleAnchor | null;
  now?: number;
  deps?: DayCandlesDeps;
}): Promise<{ window: DayCandleWindow; response: MarketCandleResponse | null }> {
  const root = params.root ?? 'MNQ';
  const deps = params.deps ?? defaultDeps;
  const window = dayCandleWindow(params.day, params.now);
  if (!window.historicalEnd) return { window, response: null };
  const anchor = params.anchor;
  const response = anchor && Number.isFinite(anchor.price) && anchor.at < window.historicalEnd.getTime()
    ? await deps.loadForTrade({ root, tradeSymbol: anchor.symbol, start: window.start, end: window.historicalEnd, entryMs: anchor.at, entryPrice: anchor.price })
    : await deps.loadContinuous(resolveMarketSymbol(root), window.start, window.historicalEnd);
  return { window, response: { ...response, candles: candlesBefore(response.candles, window.dayEnd) } };
}

/** Historie + živé svíčky, obojí oříznuté na konec dne. */
export function composeDayCandles(window: DayCandleWindow, historical: readonly MarketCandle[], live: readonly MarketCandle[] | null): MarketCandle[] {
  const base = candlesBefore(historical, window.dayEnd);
  if (!window.needsLive || !live?.length) return base;
  return stitchLiveCandles(base, candlesBefore(live, window.dayEnd));
}

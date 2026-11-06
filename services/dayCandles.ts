import { get as idbGet, set as idbSet } from 'idb-keyval';
import { chartMarketDay, pragueWallTime } from '../lib/dayJournal';
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

/**
 * Poslední historie grafu dne v zařízení. Nedokončený den se v denních kbelících
 * `marketData` neukládá, takže každé otevření čekalo ~4 s na Databento a pak graf
 * přestavělo (měřeno 6. 11.). Data z `market-candles` jsou starší než 24 h a už se
 * nemění, živé svíčky se sem nikdy neukládají (INV-UI-04).
 */
const DAY_TAIL_KEY = 'day-candles-tail-v1';

export interface DayCandlesTail {
  day: string;
  anchorKey: string;
  /** Hranice historie (ms), kterou uložené svíčky pokrývají. */
  capKey: number;
  symbol: string;
  candles: MarketCandle[];
}

/**
 * Starší historie jen do tohoto rozdílu hranic: živý soubor sahá 27 h zpět a hranice je
 * now−24 h 20 min, takže delší rozdíl by v řadě nechal díru, kterou logická osa skryje.
 */
export const DAY_TAIL_MAX_CAP_GAP_MS = 2 * 60 * 60_000;

/** Historii ze zařízení do grafu až se živým čtením: jinak by se graf otevřel na včerejšku a panel vzal ~24 h starou cenu. */
export function historyReadyForChart<T extends { fromDevice?: boolean }>(history: T | null, needsLive: boolean, liveLoading: boolean): T | null {
  return history?.fromDevice && needsLive && liveLoading ? null : history;
}

export async function readDayTail(day: string, anchorKey: string, capKey: number): Promise<DayCandlesTail | null> {
  try {
    const tail = await idbGet<DayCandlesTail>(DAY_TAIL_KEY);
    if (!tail || tail.day !== day || tail.anchorKey !== anchorKey) return null;
    if (!Number.isFinite(tail.capKey) || !Array.isArray(tail.candles) || !tail.candles.length) return null;
    if (tail.capKey > capKey || capKey - tail.capKey > DAY_TAIL_MAX_CAP_GAP_MS) return null;
    return tail;
  } catch {
    return null;
  }
}

/** Uloží jen odpověď, která hranici opravdu pokryla; jinak by ji další otevření vzalo za úplnou. */
export async function writeDayTail(tail: DayCandlesTail, coveredThrough: string | undefined): Promise<void> {
  if (!tail.capKey || !tail.candles.length || !(Date.parse(coveredThrough ?? '') >= tail.capKey)) return;
  try {
    await idbSet(DAY_TAIL_KEY, tail);
  } catch {
    // Plná nebo blokovaná cache nesmí graf rozbít.
  }
}

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
  // O víkendu je trh zavřený — graf dne ukazuje poslední obchodní den (pátek).
  const marketDay = chartMarketDay(day);
  const dayStart = pragueWallTime(marketDay, '00:00');
  const dayEnd = pragueWallTime(nextDay(marketDay), '00:00');
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

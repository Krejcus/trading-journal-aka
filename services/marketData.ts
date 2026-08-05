import { supabase } from './supabase';
import { get as idbGet, set as idbSet } from 'idb-keyval';

export type MarketTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketCandleResponse {
  provider: 'databento';
  dataset: 'GLBX.MDP3';
  symbol: string;
  sourceSymbol?: string;
  start: string;
  end: string;
  estimatedCostUsd?: number;
  candles: MarketCandle[];
}

export interface IndicatorPoint {
  time: number;
  value: number;
}

export interface MarketIndicators {
  vwap: IndicatorPoint[];
  upperDeviation: IndicatorPoint[];
  lowerDeviation: IndicatorPoint[];
  dayOpen: IndicatorPoint[];
  weekOpen: IndicatorPoint[];
  sessionHigh: IndicatorPoint[];
  sessionLow: IndicatorPoint[];
  pdh: IndicatorPoint[];
  pdl: IndicatorPoint[];
  pwh: IndicatorPoint[];
  pwl: IndicatorPoint[];
}

export interface FairValueGap {
  direction: 'bullish' | 'bearish';
  startTime: number;
  endTime: number;
  top: number;
  bottom: number;
  mitigated: boolean;
  touched: boolean;
  mitigationSteps: FairValueGapMitigationStep[];
}

export interface FairValueGapMitigationStep {
  time: number;
  remainingTop: number;
  remainingBottom: number;
  filledTop: number;
  filledBottom: number;
}

export interface MarketStructureEvent {
  type: 'CHoCH' | 'BOS';
  direction: 'bullish' | 'bearish';
  pivotTime: number;
  breakTime: number;
  price: number;
  labelPrice: number;
}

export function findEntryFairValueGap(
  gaps: FairValueGap[],
  entryTime: number,
  entryPrice: number,
  direction: 'long' | 'short',
  maxDistance = 1,
): FairValueGap | null {
  if (!Number.isFinite(entryTime) || !Number.isFinite(entryPrice)) return null;
  const expectedDirection = direction === 'long' ? 'bullish' : 'bearish';
  const candidates = gaps
    .filter(gap => gap.direction === expectedDirection && gap.startTime <= entryTime && gap.endTime >= entryTime)
    .map(gap => ({
      gap,
      distance: entryPrice < gap.bottom
        ? gap.bottom - entryPrice
        : entryPrice > gap.top
          ? entryPrice - gap.top
          : 0,
    }))
    .filter(candidate => candidate.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || b.gap.startTime - a.gap.startTime);
  return candidates[0]?.gap ?? null;
}

export function findEntryStructureEvent(
  events: MarketStructureEvent[],
  entryTime: number,
  direction: 'long' | 'short',
  desiredType?: 'CHoCH' | 'BOS' | null,
): MarketStructureEvent | null {
  const expectedDirection = direction === 'long' ? 'bullish' : 'bearish';
  const eligible = events
    .filter(event => event.direction === expectedDirection && event.breakTime <= entryTime)
    .sort((a, b) => b.breakTime - a.breakTime);
  if (!desiredType) return eligible[0] ?? null;
  return eligible.find(event => event.type === desiredType) ?? eligible[0] ?? null;
}

export const MARKET_TIMEFRAME_MINUTES: Record<MarketTimeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1_440,
};

const requestCache = new Map<string, Promise<MarketCandleResponse>>();
const MARKET_CACHE_VERSION = 'databento-glbx-ohlcv1m-v1';
const MARKET_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredMarketResponse {
  expiresAt: number;
  value: MarketCandleResponse;
}

export class MarketDataError extends Error {
  constructor(message: string, public readonly code = 'market-data-error') {
    super(message);
    this.name = 'MarketDataError';
  }
}

const finiteNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseFunctionError = async (error: any): Promise<MarketDataError> => {
  try {
    const response = error?.context;
    if (response instanceof Response) {
      const payload = await response.clone().json();
      if (payload?.error) return new MarketDataError(String(payload.message || payload.error), String(payload.error));
    }
  } catch {
    // Supabase can return a non-JSON gateway response. The generic message below is clearer.
  }
  const message = String(error?.message || '');
  if (/failed to send.*edge function|failed to fetch/i.test(message)) {
    return new MarketDataError('Datová funkce ještě není nasazená nebo není z lokálního prostředí dostupná.', 'endpoint-unavailable');
  }
  return new MarketDataError(message || 'Historická tržní data se nepodařilo načíst.');
};

export async function loadMarketCandles(params: {
  symbol: string;
  start: Date;
  end: Date;
}): Promise<MarketCandleResponse> {
  const start = params.start.toISOString();
  const end = params.end.toISOString();
  const cacheKey = `${params.symbol}|${start}|${end}`;
  const cached = requestCache.get(cacheKey);
  if (cached) return cached;

  const request = (async () => {
    const storageKey = `${MARKET_CACHE_VERSION}|${cacheKey}`;
    try {
      const stored = await idbGet<StoredMarketResponse>(storageKey);
      if (stored?.expiresAt > Date.now() && Array.isArray(stored.value?.candles) && stored.value.candles.length > 0) {
        return stored.value;
      }
    } catch {
      // IndexedDB can be unavailable in private mode. Network loading still works.
    }

    const { data, error } = await supabase.functions.invoke('market-candles', {
      body: { symbol: params.symbol, start, end },
    });
    if (error) throw await parseFunctionError(error);
    if (data?.error) throw new MarketDataError(String(data.message || data.error), String(data.error));

    const candles = Array.isArray(data?.candles)
      ? data.candles.map((row: any) => ({
          time: finiteNumber(row.time),
          open: finiteNumber(row.open),
          high: finiteNumber(row.high),
          low: finiteNumber(row.low),
          close: finiteNumber(row.close),
          volume: finiteNumber(row.volume) || 0,
        })).filter((row: any): row is MarketCandle =>
          row.time !== null && row.open !== null && row.high !== null && row.low !== null && row.close !== null,
        )
      : [];

    if (candles.length === 0) throw new MarketDataError('Pro zvolené okno nejsou dostupné žádné MNQ svíčky.', 'no-data');
    candles.sort((a: MarketCandle, b: MarketCandle) => a.time - b.time);
    const value = { ...data, candles } as MarketCandleResponse;
    try {
      await idbSet(storageKey, { expiresAt: Date.now() + MARKET_CACHE_TTL_MS, value } satisfies StoredMarketResponse);
    } catch {
      // A full/blocked browser cache must never make the chart itself fail.
    }
    return value;
  })();

  requestCache.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    requestCache.delete(cacheKey);
    throw error;
  }
}

export interface MarketDataWindow {
  start: Date;
  end: Date;
}

const pragueDateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

const pragueMidnightUtc = (year: number, month: number, day: number): Date => {
  const targetAsUtc = Date.UTC(year, month - 1, day);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      pragueDateParts.formatToParts(new Date(candidate)).map(part => [part.type, part.value]),
    );
    const representedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    candidate += targetAsUtc - representedAsUtc;
    const hourInPrague = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Prague', hour: '2-digit', hourCycle: 'h23',
    }).format(new Date(candidate)));
    candidate -= hourInPrague * 60 * 60 * 1000;
  }
  return new Date(candidate);
};

/**
 * All trades opened on the same Prague calendar date share one paid request.
 * Fourteen prior days cover previous CME context; forward data stops exactly
 * at the end of the trade's Prague day because intraday futures are not held
 * overnight in this workflow.
 */
export function marketDataWindowForEntry(entryMs: number): MarketDataWindow {
  const entryParts = Object.fromEntries(
    pragueDateParts.formatToParts(new Date(entryMs)).map(part => [part.type, part.value]),
  );
  const year = Number(entryParts.year);
  const month = Number(entryParts.month);
  const day = Number(entryParts.day);
  const priorDate = new Date(Date.UTC(year, month - 1, day - 14));
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    start: pragueMidnightUtc(priorDate.getUTCFullYear(), priorDate.getUTCMonth() + 1, priorDate.getUTCDate()),
    end: pragueMidnightUtc(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate()),
  };
}

export function resolveMarketSymbol(root: 'MNQ' | 'NQ', tradeSymbol?: string): string {
  const normalized = String(tradeSymbol || '').trim().toUpperCase();
  const contract = normalized.match(/^(MNQ|NQ)([HMUZ]\d{1,2})$/);
  if (contract) return `${root}${contract[2]}`;
  return `${root}.v.0`;
}

export function aggregateCandles(candles: MarketCandle[], timeframe: MarketTimeframe): MarketCandle[] {
  const minutes = MARKET_TIMEFRAME_MINUTES[timeframe];
  if (minutes === 1) return candles.slice();
  const result: MarketCandle[] = [];

  for (const candle of candles) {
    const time = cmeBucketStart(candle.time, minutes);
    const current = result[result.length - 1];
    if (!current || current.time !== time) {
      result.push({ ...candle, time });
      continue;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }
  return result;
}

const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

/** Align intraday and daily bars to the CME equity-index session opening at 18:00 New York. */
function cmeBucketStart(unixSeconds: number, minutes: number): number {
  const parts = Object.fromEntries(nyParts.formatToParts(new Date(unixSeconds * 1000)).map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const minutesSinceSessionOpen = ((hour - 18 + 24) % 24) * 60 + minute;
  const secondsIntoBucket = (minutesSinceSessionOpen % minutes) * 60 + second;
  return unixSeconds - secondsIntoBucket;
}

const tradingDayKey = (unixSeconds: number): string => {
  const parts = Object.fromEntries(nyParts.formatToParts(new Date(unixSeconds * 1000)).map(p => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const shifted = new Date(Date.UTC(year, month - 1, day + (hour >= 18 ? 1 : 0)));
  return shifted.toISOString().slice(0, 10);
};

const weekKey = (dayKey: string): string => {
  const date = new Date(`${dayKey}T00:00:00Z`);
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return date.toISOString().slice(0, 10);
};

type PeriodStats = { open: number; high: number; low: number };

const point = (time: number, value: number | undefined): IndicatorPoint | null =>
  value === undefined || !Number.isFinite(value) ? null : { time, value };

export function calculateIndicators(candles: MarketCandle[]): MarketIndicators {
  const output: MarketIndicators = {
    vwap: [], upperDeviation: [], lowerDeviation: [], dayOpen: [], weekOpen: [],
    sessionHigh: [], sessionLow: [], pdh: [], pdl: [], pwh: [], pwl: [],
  };
  const completedDays = new Map<string, PeriodStats>();
  const completedWeeks = new Map<string, PeriodStats>();
  let currentDay = '';
  let currentWeek = '';
  let dayStats: PeriodStats | null = null;
  let weekStats: PeriodStats | null = null;
  let previousDay: PeriodStats | undefined;
  let previousWeek: PeriodStats | undefined;
  let weightedPrice = 0;
  let weightedPriceSquared = 0;
  let volume = 0;

  for (const candle of candles) {
    const day = tradingDayKey(candle.time);
    const week = weekKey(day);
    if (day !== currentDay) {
      if (dayStats && currentDay) completedDays.set(currentDay, dayStats);
      previousDay = completedDays.get(Array.from(completedDays.keys()).at(-1) || '');
      currentDay = day;
      dayStats = { open: candle.open, high: candle.high, low: candle.low };
      weightedPrice = 0;
      weightedPriceSquared = 0;
      volume = 0;
    }
    if (week !== currentWeek) {
      if (weekStats && currentWeek) completedWeeks.set(currentWeek, weekStats);
      previousWeek = completedWeeks.get(Array.from(completedWeeks.keys()).at(-1) || '');
      currentWeek = week;
      weekStats = { open: candle.open, high: candle.high, low: candle.low };
    }

    dayStats!.high = Math.max(dayStats!.high, candle.high);
    dayStats!.low = Math.min(dayStats!.low, candle.low);
    weekStats!.high = Math.max(weekStats!.high, candle.high);
    weekStats!.low = Math.min(weekStats!.low, candle.low);

    const typical = (candle.high + candle.low + candle.close) / 3;
    const barVolume = Math.max(0, candle.volume);
    weightedPrice += typical * barVolume;
    weightedPriceSquared += typical * typical * barVolume;
    volume += barVolume;
    const vwap = volume > 0 ? weightedPrice / volume : typical;
    const variance = volume > 0 ? Math.max(0, weightedPriceSquared / volume - vwap * vwap) : 0;
    const deviation = Math.sqrt(variance);

    output.vwap.push({ time: candle.time, value: vwap });
    output.upperDeviation.push({ time: candle.time, value: vwap + deviation });
    output.lowerDeviation.push({ time: candle.time, value: vwap - deviation });
    output.dayOpen.push({ time: candle.time, value: dayStats!.open });
    output.weekOpen.push({ time: candle.time, value: weekStats!.open });
    output.sessionHigh.push({ time: candle.time, value: dayStats!.high });
    output.sessionLow.push({ time: candle.time, value: dayStats!.low });
    const priorPoints: Array<[keyof MarketIndicators, IndicatorPoint | null]> = [
      ['pdh', point(candle.time, previousDay?.high)],
      ['pdl', point(candle.time, previousDay?.low)],
      ['pwh', point(candle.time, previousWeek?.high)],
      ['pwl', point(candle.time, previousWeek?.low)],
    ];
    for (const [key, value] of priorPoints) if (value) output[key].push(value);
  }
  return output;
}

export function findFairValueGaps(candles: MarketCandle[]): FairValueGap[] {
  const gaps: FairValueGap[] = [];
  const active: Array<{ gap: FairValueGap; top: number; bottom: number }> = [];

  for (let i = 0; i < candles.length; i++) {
    const candidate = candles[i];

    // Advance every still-open gap once with the new candle. This is
    // equivalent to scanning every gap's future candles, but remains fast
    // enough to run on every replay step.
    for (let activeIndex = active.length - 1; activeIndex >= 0; activeIndex -= 1) {
      const state = active[activeIndex];
      const { gap } = state;
      gap.endTime = candidate.time;
      const wickTouch = candidate.high >= state.bottom && candidate.low <= state.top;
      if (wickTouch) gap.touched = true;

      const nextTop = gap.direction === 'bullish' ? Math.min(state.top, candidate.low) : state.top;
      const nextBottom = gap.direction === 'bearish' ? Math.max(state.bottom, candidate.high) : state.bottom;
      const fullyFilled = gap.direction === 'bullish' ? nextTop <= gap.bottom : nextBottom >= gap.top;
      const closeInvalidated = gap.direction === 'bullish' ? candidate.close < gap.bottom : candidate.close > gap.top;
      if (fullyFilled || closeInvalidated) {
        gap.mitigated = true;
        active.splice(activeIndex, 1);
        continue;
      }

      const partiallyFilled = nextTop < state.top || nextBottom > state.bottom;
      if (!partiallyFilled) continue;
      gap.mitigationSteps.push({
        time: candidate.time,
        remainingTop: nextTop,
        remainingBottom: nextBottom,
        filledTop: gap.direction === 'bullish' ? state.top : nextBottom,
        filledBottom: gap.direction === 'bullish' ? nextTop : state.bottom,
      });
      state.top = nextTop;
      state.bottom = nextBottom;
    }

    if (i < 2) continue;
    const first = candles[i - 2];
    const confirmation = candidate;
    let gap: FairValueGap | null = null;
    if (confirmation.low > first.high) {
      gap = {
        direction: 'bullish', startTime: confirmation.time, endTime: candles.at(-1)!.time,
        top: confirmation.low, bottom: first.high, mitigated: false, touched: false, mitigationSteps: [],
      };
    } else if (confirmation.high < first.low) {
      gap = {
        direction: 'bearish', startTime: confirmation.time, endTime: candles.at(-1)!.time,
        top: first.low, bottom: confirmation.high, mitigated: false, touched: false, mitigationSteps: [],
      };
    }
    if (!gap) continue;
    gaps.push(gap);
    active.push({ gap, top: gap.top, bottom: gap.bottom });
  }
  return gaps;
}

/**
 * Historical equivalent of tradingview/alphatrade-bos-choch-cz.pine defaults:
 * pivot 1/1, close confirmation, first break against/without trend = CHoCH,
 * subsequent break in the same direction = BOS.
 */
export function calculateMarketStructure(candles: MarketCandle[]): MarketStructureEvent[] {
  const events: MarketStructureEvent[] = [];
  if (candles.length < 3) return events;

  let lastPivotHigh: { time: number; price: number } | null = null;
  let lastPivotLow: { time: number; price: number } | null = null;
  let trend: 'bullish' | 'bearish' | null = null;
  let previousAtr: number | null = null;
  const trueRanges: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    const trueRange = previous
      ? Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close))
      : current.high - current.low;
    trueRanges.push(trueRange);
    if (i === 13) {
      previousAtr = trueRanges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
    } else if (i > 13 && previousAtr !== null) {
      previousAtr = ((previousAtr * 13) + trueRange) / 14;
    }

    if (i < 2) continue;
    const candidate = candles[i - 1];
    const left = candles[i - 2];
    if (candidate.high > left.high && candidate.high > current.high) {
      lastPivotHigh = { time: candidate.time, price: candidate.high };
    }
    if (candidate.low < left.low && candidate.low < current.low) {
      lastPivotLow = { time: candidate.time, price: candidate.low };
    }

    const offset = previousAtr && previousAtr > 0
      ? previousAtr * 0.08
      : Math.max((current.high - current.low) * 0.1, 0.25 * 5);

    if (lastPivotHigh && current.close > lastPivotHigh.price) {
      events.push({
        type: trend === 'bullish' ? 'BOS' : 'CHoCH',
        direction: 'bullish',
        pivotTime: lastPivotHigh.time,
        breakTime: current.time,
        price: lastPivotHigh.price,
        labelPrice: lastPivotHigh.price + offset,
      });
      trend = 'bullish';
      lastPivotHigh = null;
    }

    if (lastPivotLow && current.close < lastPivotLow.price) {
      events.push({
        type: trend === 'bearish' ? 'BOS' : 'CHoCH',
        direction: 'bearish',
        pivotTime: lastPivotLow.time,
        breakTime: current.time,
        price: lastPivotLow.price,
        labelPrice: lastPivotLow.price + offset,
      });
      trend = 'bearish';
      lastPivotLow = null;
    }
  }

  return events;
}

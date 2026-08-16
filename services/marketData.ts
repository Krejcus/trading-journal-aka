import { supabase } from './supabase';
import { get as idbGet, getMany as idbGetMany, setMany as idbSetMany } from 'idb-keyval';

export type MarketTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export type MarketDataSchema = 'ohlcv-1m' | 'ohlcv-1h';

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
  schema: MarketDataSchema;
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
  /** Chraneny protilehly pivot znamy v okamziku zlomu. */
  protectedPrice?: number | null;
  protectedTime?: number | null;
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
const MARKET_CACHE_VERSION = 'databento-glbx-ohlcv-v2';
const MARKET_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredMarketResponse {
  expiresAt: number;
  value: MarketCandleResponse;
}

/**
 * Svíčky se skladují po UTC dnech, ne po oknech požadavků.
 *
 * Původní cache měla klíč `schema|symbol|start|end` — přesné hranice okna.
 * Hranice segmentů se ale odvíjejí od pozice kurzoru při otevření session,
 * takže otevření jindy znamenalo jiné hranice, cache miss a nový PLACENÝ
 * Databento request na data, která už na disku ležela pod jiným klíčem.
 * Denní kbelík je deterministický: požadavek se poskládá z hotových dnů
 * a od Databenta se dotáhnou jen ty chybějící.
 */
const DAY_BUCKET_VERSION = 'databento-glbx-day-v1';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Margin od „teď": den se cachuje, až když je bezpečně uzavřený u poskytovatele. */
const DAY_COMPLETE_MARGIN_MS = 60 * 60 * 1000;
/** Limity Databento oken na jeden request: ~16 dní pro 1m, ~370 dní pro 1h. */
const FETCH_CHUNK_DAYS: Record<MarketDataSchema, number> = { 'ohlcv-1m': 14, 'ohlcv-1h': 300 };

interface StoredDayBucket {
  expiresAt: number;
  /** Prázdné pole je platný obsah — soboty a svátky se jinak stahovaly pořád dokola. */
  candles: MarketCandle[];
}

const dayBucketKey = (schema: MarketDataSchema, symbol: string, dayStartMs: number): string =>
  `${DAY_BUCKET_VERSION}|${schema}|${symbol}|${new Date(dayStartMs).toISOString().slice(0, 10)}`;

/** UTC dny (začátky v ms) pokrývající [startMs, endMs). */
const dayStartsIn = (startMs: number, endMs: number): number[] => {
  const days: number[] = [];
  for (let day = Math.floor(startMs / DAY_MS) * DAY_MS; day < endMs; day += DAY_MS) days.push(day);
  return days;
};

/** Souvislé běhy chybějících dnů → co nejméně requestů. */
const contiguousRanges = (dayStarts: number[]): Array<{ startMs: number; endMs: number }> => {
  const ranges: Array<{ startMs: number; endMs: number }> = [];
  for (const day of dayStarts) {
    const last = ranges[ranges.length - 1];
    if (last && last.endMs === day) last.endMs = day + DAY_MS;
    else ranges.push({ startMs: day, endMs: day + DAY_MS });
  }
  return ranges;
};

const splitRange = (range: { startMs: number; endMs: number }, chunkMs: number): Array<{ startMs: number; endMs: number }> => {
  const chunks: Array<{ startMs: number; endMs: number }> = [];
  for (let start = range.startMs; start < range.endMs; start += chunkMs) {
    chunks.push({ startMs: start, endMs: Math.min(range.endMs, start + chunkMs) });
  }
  return chunks;
};

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

const parseCandleRows = (rows: unknown): MarketCandle[] => {
  if (!Array.isArray(rows)) return [];
  return rows.map((row: any) => ({
    time: finiteNumber(row.time),
    open: finiteNumber(row.open),
    high: finiteNumber(row.high),
    low: finiteNumber(row.low),
    close: finiteNumber(row.close),
    volume: finiteNumber(row.volume) || 0,
  })).filter((row: any): row is MarketCandle =>
    row.time !== null && row.open !== null && row.high !== null && row.low !== null && row.close !== null,
  );
};

/** Jeden síťový request. `no-data` je tady legitimní odpověď (víkend, svátek). */
const fetchCandleRange = async (
  symbol: string,
  schema: MarketDataSchema,
  startMs: number,
  endMs: number,
): Promise<{ candles: MarketCandle[]; estimatedCostUsd: number; sourceSymbol?: string }> => {
  const { data, error } = await supabase.functions.invoke('market-candles', {
    body: { symbol, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), schema },
  });
  if (error) throw await parseFunctionError(error);
  if (data?.error) {
    if (String(data.error) === 'no-data') return { candles: [], estimatedCostUsd: 0 };
    throw new MarketDataError(String(data.message || data.error), String(data.error));
  }
  const candles = parseCandleRows(data?.candles);
  candles.sort((a, b) => a.time - b.time);
  return {
    candles,
    estimatedCostUsd: finiteNumber(data?.estimatedCostUsd) ?? 0,
    sourceSymbol: typeof data?.sourceSymbol === 'string' ? data.sourceSymbol : undefined,
  };
};

/** Rozřeže stažené svíčky do denních kbelíků; neuzavřené dny se necachují. */
const storeDayBuckets = async (
  schema: MarketDataSchema,
  symbol: string,
  candles: MarketCandle[],
  coveredStartMs: number,
  coveredEndMs: number,
): Promise<void> => {
  const now = Date.now();
  const entries: Array<[string, StoredDayBucket]> = [];
  for (const day of dayStartsIn(coveredStartMs, coveredEndMs)) {
    if (day < coveredStartMs || day + DAY_MS > coveredEndMs) continue;
    if (day + DAY_MS > now - DAY_COMPLETE_MARGIN_MS) continue;
    const startSec = day / 1000;
    const endSec = (day + DAY_MS) / 1000;
    entries.push([
      dayBucketKey(schema, symbol, day),
      { expiresAt: now + MARKET_CACHE_TTL_MS, candles: candles.filter(c => c.time >= startSec && c.time < endSec) },
    ]);
  }
  if (!entries.length) return;
  try {
    await idbSetMany(entries);
  } catch {
    // A full/blocked browser cache must never make the chart itself fail.
  }
};

export async function loadMarketCandles(params: {
  symbol: string;
  start: Date;
  end: Date;
  schema?: MarketDataSchema;
}): Promise<MarketCandleResponse> {
  const schema = params.schema ?? 'ohlcv-1m';
  const startMs = params.start.getTime();
  const endMs = params.end.getTime();
  const startIso = params.start.toISOString();
  const endIso = params.end.toISOString();
  const cacheKey = `${schema}|${params.symbol}|${startIso}|${endIso}`;
  const cached = requestCache.get(cacheKey);
  if (cached) return cached;

  const request = (async (): Promise<MarketCandleResponse> => {
    // Starší okenní cache poslouží jako bezplatná migrace: přesná shoda okna se
    // vrátí rovnou a po cestě se rozřeže do denních kbelíků, ať příště poslouží
    // i požadavkům s jinými hranicemi.
    try {
      const legacy = await idbGet<StoredMarketResponse>(`${MARKET_CACHE_VERSION}|${cacheKey}`);
      if (legacy?.expiresAt > Date.now() && Array.isArray(legacy.value?.candles) && legacy.value.candles.length > 0) {
        void storeDayBuckets(schema, params.symbol, legacy.value.candles, startMs, endMs);
        return legacy.value;
      }
    } catch {
      // IndexedDB can be unavailable in private mode. Network loading still works.
    }

    const days = dayStartsIn(startMs, endMs);
    const buckets = new Map<number, MarketCandle[]>();
    try {
      const stored = await idbGetMany<StoredDayBucket>(days.map(day => dayBucketKey(schema, params.symbol, day)));
      stored.forEach((bucket, index) => {
        if (bucket && bucket.expiresAt > Date.now() && Array.isArray(bucket.candles)) {
          buckets.set(days[index], bucket.candles);
        }
      });
    } catch {
      // Bez IndexedDB prostě stáhneme všechno ze sítě.
    }

    let estimatedCostUsd = 0;
    let sourceSymbol: string | undefined;
    const missing = days.filter(day => !buckets.has(day));
    if (missing.length) {
      const chunks = contiguousRanges(missing)
        .flatMap(range => splitRange(range, FETCH_CHUNK_DAYS[schema] * DAY_MS));
      const results = await Promise.all(chunks.map(chunk =>
        fetchCandleRange(params.symbol, schema, chunk.startMs, chunk.endMs)));
      const now = Date.now();
      const toStore: Array<[string, StoredDayBucket]> = [];
      results.forEach((result, index) => {
        estimatedCostUsd += result.estimatedCostUsd;
        sourceSymbol ??= result.sourceSymbol;
        const chunk = chunks[index];
        for (let day = chunk.startMs; day < chunk.endMs; day += DAY_MS) {
          const startSec = day / 1000;
          const endSec = (day + DAY_MS) / 1000;
          const dayCandles = result.candles.filter(c => c.time >= startSec && c.time < endSec);
          buckets.set(day, dayCandles);
          if (day + DAY_MS <= now - DAY_COMPLETE_MARGIN_MS) {
            toStore.push([
              dayBucketKey(schema, params.symbol, day),
              { expiresAt: now + MARKET_CACHE_TTL_MS, candles: dayCandles },
            ]);
          }
        }
      });
      try {
        if (toStore.length) await idbSetMany(toStore);
      } catch {
        // A full/blocked browser cache must never make the chart itself fail.
      }
    }

    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);
    const candles = days
      .flatMap(day => buckets.get(day) ?? [])
      .filter(candle => candle.time >= startSec && candle.time < endSec)
      .sort((a, b) => a.time - b.time);
    if (candles.length === 0) throw new MarketDataError('Pro zvolené okno nejsou dostupné žádné MNQ svíčky.', 'no-data');
    return {
      provider: 'databento',
      dataset: 'GLBX.MDP3',
      schema,
      symbol: params.symbol,
      sourceSymbol,
      start: startIso,
      end: endIso,
      estimatedCostUsd: estimatedCostUsd > 0 ? estimatedCostUsd : undefined,
      candles,
    };
  })();

  requestCache.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    requestCache.delete(cacheKey);
    throw error;
  }
}

export const marketDataSchemaForTimeframe = (timeframe: MarketTimeframe): MarketDataSchema =>
  MARKET_TIMEFRAME_MINUTES[timeframe] >= 60 ? 'ohlcv-1h' : 'ohlcv-1m';

export function completedHistoricalCandles(params: {
  candles: MarketCandle[];
  schema: MarketDataSchema;
  endMs: number;
  replayStartMs: number;
}): MarketCandle[] {
  const candleDurationSeconds = params.schema === 'ohlcv-1h' ? 60 * 60 : 60;
  const boundarySeconds = Math.floor(Math.min(params.endMs, params.replayStartMs) / 1_000);
  return params.candles.filter(candle => candle.time + candleDurationSeconds <= boundarySeconds);
}

/**
 * Combines completed 1h context from before the replay boundary with candles
 * derived from revealed 1m data after it. Provider HTF bars at or after the
 * boundary are deliberately discarded so replay can never see a completed
 * future hour/day.
 */
export function composeReplayTimeframeCandles(params: {
  historicalHourly: MarketCandle[];
  revealedMinute: MarketCandle[];
  timeframe: Extract<MarketTimeframe, '1h' | '4h' | '1d'>;
  replayStartSeconds: number;
}): MarketCandle[] {
  const completedHistoricalHours = params.historicalHourly.filter(
    candle => candle.time + 60 * 60 <= params.replayStartSeconds,
  );
  const revealedReplayMinutes = params.revealedMinute.filter(
    candle => candle.time >= params.replayStartSeconds,
  );
  return aggregateCandles(
    [...completedHistoricalHours, ...revealedReplayMinutes]
      .sort((left, right) => left.time - right.time),
    params.timeframe,
  );
}

/**
 * Builds a replay chart from two deliberately separate timelines:
 * - historical 1m candles before the session start are view-only context;
 * - session candles are included only after the replay has revealed them.
 *
 * Keeping the boundary here prevents analytical history from becoming
 * tradable data or leaking future session candles into indicators.
 */
export function composeReplayAnalysisCandles(params: {
  historicalMinute: MarketCandle[];
  revealedMinute: MarketCandle[];
  timeframe: MarketTimeframe;
  replayStartSeconds: number;
}): MarketCandle[] {
  const historical = params.historicalMinute.filter(candle => candle.time < params.replayStartSeconds);
  const revealed = params.revealedMinute.filter(candle => candle.time >= params.replayStartSeconds);
  return aggregateCandles(
    [...historical, ...revealed],
    params.timeframe,
  );
}

export interface ReplayAnalysisAccumulator {
  historicalMinute: MarketCandle[];
  sessionMinute: MarketCandle[];
  timeframe: MarketTimeframe;
  replayStartSeconds: number;
  revealedCount: number;
  candles: MarketCandle[];
}

const appendAggregatedCandle = (
  target: MarketCandle[],
  candle: MarketCandle,
  timeframe: MarketTimeframe,
) => {
  const minutes = MARKET_TIMEFRAME_MINUTES[timeframe];
  if (minutes === 1) {
    target.push({ ...candle });
    return;
  }
  const time = cmeBucketStart(candle.time, minutes);
  const current = target[target.length - 1];
  if (!current || current.time !== time) {
    target.push({ ...candle, time });
    return;
  }
  // Replace the open HTF bucket instead of mutating it. The replay
  // accumulator keeps the previous array alive long enough for React and the
  // chart updater to compare it with the next one.
  target[target.length - 1] = {
    ...current,
    high: Math.max(current.high, candle.high),
    low: Math.min(current.low, candle.low),
    close: candle.close,
    volume: current.volume + candle.volume,
  };
};

/**
 * Incrementally advances the replay analysis series. A normal one-candle step
 * only aggregates the newly revealed source candle instead of rebuilding and
 * sorting weeks of minute history. Backward seeks and source prepends rebuild
 * once, which keeps deterministic replay semantics.
 */
export function updateReplayAnalysisAccumulator(
  previous: ReplayAnalysisAccumulator | null,
  params: {
    historicalMinute: MarketCandle[];
    sessionMinute: MarketCandle[];
    timeframe: MarketTimeframe;
    replayStartSeconds: number;
    revealedCount: number;
  },
): ReplayAnalysisAccumulator {
  const revealedCount = Math.max(0, Math.min(params.sessionMinute.length, params.revealedCount));
  const canAppend = previous !== null
    && previous.historicalMinute === params.historicalMinute
    && previous.sessionMinute === params.sessionMinute
    && previous.timeframe === params.timeframe
    && previous.replayStartSeconds === params.replayStartSeconds
    && revealedCount >= previous.revealedCount;

  if (canAppend && revealedCount === previous.revealedCount) return previous;

  const previousHistoryFirst = previous?.historicalMinute[0]?.time;
  const prependedHistoryBoundary = previousHistoryFirst === undefined
    ? -1
    : params.historicalMinute.findIndex(candle => candle.time >= previousHistoryFirst);
  const canPrependHistory = previous !== null
    && previous.sessionMinute === params.sessionMinute
    && previous.timeframe === params.timeframe
    && previous.replayStartSeconds === params.replayStartSeconds
    && revealedCount === previous.revealedCount
    && prependedHistoryBoundary > 0
    && params.historicalMinute.length - prependedHistoryBoundary === previous.historicalMinute.length
    && previous.historicalMinute.every((candle, index) => (
      params.historicalMinute[prependedHistoryBoundary + index]?.time === candle.time
    ));

  if (canPrependHistory) {
    // Lazy history arrives strictly before the already analysed source. Do not
    // rebuild every revealed 1m bar merely because another context segment was
    // prepended. Aggregate only the new prefix and retain all existing candle
    // objects. The shared boundary bucket is merged for HTF timeframes.
    const prefix: MarketCandle[] = [];
    for (let index = 0; index < prependedHistoryBoundary; index += 1) {
      const candle = params.historicalMinute[index];
      if (candle.time < params.replayStartSeconds) appendAggregatedCandle(prefix, candle, params.timeframe);
    }
    const previousCandles = previous.candles;
    const prefixLast = prefix.at(-1);
    const previousFirst = previousCandles[0];
    if (prefixLast && previousFirst && prefixLast.time === previousFirst.time) {
      prefix[prefix.length - 1] = {
        ...prefixLast,
        high: Math.max(prefixLast.high, previousFirst.high),
        low: Math.min(prefixLast.low, previousFirst.low),
        close: previousFirst.close,
        volume: prefixLast.volume + previousFirst.volume,
      };
      return {
        ...previous,
        historicalMinute: params.historicalMinute,
        candles: [...prefix, ...previousCandles.slice(1)],
      };
    }
    return {
      ...previous,
      historicalMinute: params.historicalMinute,
      candles: [...prefix, ...previousCandles],
    };
  }

  if (canAppend) {
    // A replay step must not clone weeks of OHLC objects. The existing bars
    // are immutable; only a newly appended bar (or the current HTF bucket)
    // receives a fresh object in appendAggregatedCandle.
    const candles = previous.candles.slice();
    for (let index = previous.revealedCount; index < revealedCount; index += 1) {
      const candle = params.sessionMinute[index];
      if (candle.time >= params.replayStartSeconds) appendAggregatedCandle(candles, candle, params.timeframe);
    }
    return { ...previous, revealedCount, candles };
  }

  const candles: MarketCandle[] = [];
  params.historicalMinute.forEach(candle => {
    if (candle.time < params.replayStartSeconds) appendAggregatedCandle(candles, candle, params.timeframe);
  });
  for (let index = 0; index < revealedCount; index += 1) {
    const candle = params.sessionMinute[index];
    if (candle.time >= params.replayStartSeconds) appendAggregatedCandle(candles, candle, params.timeframe);
  }
  return { ...params, revealedCount, candles };
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
  return updateFairValueGapAccumulator(null, candles).gaps;
}

export interface FairValueGapAccumulator {
  firstTime: number | null;
  lastTime: number | null;
  lastSignature: string;
  candleCount: number;
  gaps: FairValueGap[];
  active: Array<{ gapIndex: number; top: number; bottom: number }>;
}

const candleSignature = (candle: MarketCandle | undefined) => candle
  ? `${candle.time}:${candle.open}:${candle.high}:${candle.low}:${candle.close}:${candle.volume}`
  : '';

const appendFairValueGapCandle = (
  state: FairValueGapAccumulator,
  candles: MarketCandle[],
  index: number,
) => {
  const candidate = candles[index];
  for (let activeIndex = state.active.length - 1; activeIndex >= 0; activeIndex -= 1) {
    const active = state.active[activeIndex];
    const gap = state.gaps[active.gapIndex];
    gap.endTime = candidate.time;
    const wickTouch = candidate.high >= active.bottom && candidate.low <= active.top;
    if (wickTouch) gap.touched = true;
    const nextTop = gap.direction === 'bullish' ? Math.min(active.top, candidate.low) : active.top;
    const nextBottom = gap.direction === 'bearish' ? Math.max(active.bottom, candidate.high) : active.bottom;
    const fullyFilled = gap.direction === 'bullish' ? nextTop <= gap.bottom : nextBottom >= gap.top;
    const closeInvalidated = gap.direction === 'bullish' ? candidate.close < gap.bottom : candidate.close > gap.top;
    if (fullyFilled || closeInvalidated) {
      gap.mitigated = true;
      state.active.splice(activeIndex, 1);
      continue;
    }
    if (nextTop === active.top && nextBottom === active.bottom) continue;
    gap.mitigationSteps.push({
      time: candidate.time,
      remainingTop: nextTop,
      remainingBottom: nextBottom,
      filledTop: gap.direction === 'bullish' ? active.top : nextBottom,
      filledBottom: gap.direction === 'bullish' ? nextTop : active.bottom,
    });
    active.top = nextTop;
    active.bottom = nextBottom;
  }

  if (index < 2) return;
  const first = candles[index - 2];
  let gap: FairValueGap | null = null;
  if (candidate.low > first.high) {
    gap = {
      direction: 'bullish', startTime: candidate.time, endTime: candidate.time,
      top: candidate.low, bottom: first.high, mitigated: false, touched: false, mitigationSteps: [],
    };
  } else if (candidate.high < first.low) {
    gap = {
      direction: 'bearish', startTime: candidate.time, endTime: candidate.time,
      top: first.low, bottom: candidate.high, mitigated: false, touched: false, mitigationSteps: [],
    };
  }
  if (!gap) return;
  state.gaps.push(gap);
  state.active.push({ gapIndex: state.gaps.length - 1, top: gap.top, bottom: gap.bottom });
};

const buildFairValueGapAccumulator = (candles: MarketCandle[]): FairValueGapAccumulator => {
  const lastTime = candles.at(-1)?.time ?? null;
  const state: FairValueGapAccumulator = {
    firstTime: candles[0]?.time ?? null,
    lastTime,
    lastSignature: candleSignature(candles.at(-1)),
    candleCount: 0,
    gaps: [],
    active: [],
  };
  for (let index = 0; index < candles.length; index += 1) {
    appendFairValueGapCandle(state, candles, index);
  }
  state.candleCount = candles.length;
  return state;
};

/**
 * Incremental replay variant. The common append-only path only evaluates the
 * newly revealed candles and currently open gaps. Back-seeks, window shifts,
 * or an in-place update of the latest HTF candle rebuild deterministically.
 */
export function updateFairValueGapAccumulator(
  previous: FairValueGapAccumulator | null,
  candles: MarketCandle[],
): FairValueGapAccumulator {
  const firstTime = candles[0]?.time ?? null;
  const lastTime = candles.at(-1)?.time ?? null;
  const lastSignature = candleSignature(candles.at(-1));
  const canAppend = previous
    && previous.firstTime === firstTime
    && candles.length > previous.candleCount
    && previous.lastTime === candles[previous.candleCount - 1]?.time;
  if (previous
    && previous.firstTime === firstTime
    && previous.candleCount === candles.length
    && previous.lastSignature === lastSignature) return previous;

  if (!canAppend) return buildFairValueGapAccumulator(candles);

  const state: FairValueGapAccumulator = {
    firstTime,
    lastTime,
    lastSignature,
    candleCount: previous.candleCount,
    gaps: previous.gaps.map(gap => ({ ...gap, mitigationSteps: gap.mitigationSteps.slice() })),
    active: previous.active.map(active => ({ ...active })),
  };
  for (let index = previous.candleCount; index < candles.length; index += 1) {
    appendFairValueGapCandle(state, candles, index);
  }
  state.candleCount = candles.length;
  state.lastTime = lastTime;
  state.lastSignature = lastSignature;
  return state;
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
        protectedPrice: lastPivotLow?.price ?? null,
        protectedTime: lastPivotLow?.time ?? null,
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
        protectedPrice: lastPivotHigh?.price ?? null,
        protectedTime: lastPivotHigh?.time ?? null,
      });
      trend = 'bearish';
      lastPivotLow = null;
    }
  }

  return events;
}

export interface MarketStructureAccumulator {
  firstTime: number | null;
  lastTime: number | null;
  lastSignature: string;
  candleCount: number;
  events: MarketStructureEvent[];
  lastPivotHigh: { time: number; price: number } | null;
  lastPivotLow: { time: number; price: number } | null;
  trend: 'bullish' | 'bearish' | null;
  previousAtr: number | null;
  initialTrueRanges: number[];
}

const appendMarketStructureCandle = (
  state: MarketStructureAccumulator,
  candles: MarketCandle[],
  index: number,
) => {
  const current = candles[index];
  const previous = candles[index - 1];
  const trueRange = previous
    ? Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close))
    : current.high - current.low;
  if (index <= 13) state.initialTrueRanges.push(trueRange);
  if (index === 13) {
    state.previousAtr = state.initialTrueRanges.reduce((sum, value) => sum + value, 0) / 14;
  } else if (index > 13 && state.previousAtr !== null) {
    state.previousAtr = ((state.previousAtr * 13) + trueRange) / 14;
  }
  if (index < 2) return;

  const candidate = candles[index - 1];
  const left = candles[index - 2];
  if (candidate.high > left.high && candidate.high > current.high) {
    state.lastPivotHigh = { time: candidate.time, price: candidate.high };
  }
  if (candidate.low < left.low && candidate.low < current.low) {
    state.lastPivotLow = { time: candidate.time, price: candidate.low };
  }
  const offset = state.previousAtr && state.previousAtr > 0
    ? state.previousAtr * 0.08
    : Math.max((current.high - current.low) * 0.1, 0.25 * 5);
  if (state.lastPivotHigh && current.close > state.lastPivotHigh.price) {
    state.events.push({
      type: state.trend === 'bullish' ? 'BOS' : 'CHoCH', direction: 'bullish',
      pivotTime: state.lastPivotHigh.time, breakTime: current.time,
      price: state.lastPivotHigh.price, labelPrice: state.lastPivotHigh.price + offset,
      protectedPrice: state.lastPivotLow?.price ?? null,
      protectedTime: state.lastPivotLow?.time ?? null,
    });
    state.trend = 'bullish';
    state.lastPivotHigh = null;
  }
  if (state.lastPivotLow && current.close < state.lastPivotLow.price) {
    state.events.push({
      type: state.trend === 'bearish' ? 'BOS' : 'CHoCH', direction: 'bearish',
      pivotTime: state.lastPivotLow.time, breakTime: current.time,
      price: state.lastPivotLow.price, labelPrice: state.lastPivotLow.price + offset,
      protectedPrice: state.lastPivotHigh?.price ?? null,
      protectedTime: state.lastPivotHigh?.time ?? null,
    });
    state.trend = 'bearish';
    state.lastPivotLow = null;
  }
};

export function updateMarketStructureAccumulator(
  previous: MarketStructureAccumulator | null,
  candles: MarketCandle[],
): MarketStructureAccumulator {
  const firstTime = candles[0]?.time ?? null;
  const lastTime = candles.at(-1)?.time ?? null;
  const lastSignature = candleSignature(candles.at(-1));
  const canAppend = previous
    && previous.firstTime === firstTime
    && candles.length > previous.candleCount
    && previous.lastTime === candles[previous.candleCount - 1]?.time;
  if (previous
    && previous.firstTime === firstTime
    && previous.candleCount === candles.length
    && previous.lastSignature === lastSignature) return previous;

  const state: MarketStructureAccumulator = canAppend ? {
    ...previous,
    firstTime,
    lastTime,
    lastSignature,
    events: [...previous.events],
    initialTrueRanges: [...previous.initialTrueRanges],
  } : {
    firstTime,
    lastTime,
    lastSignature,
    candleCount: 0,
    events: [],
    lastPivotHigh: null,
    lastPivotLow: null,
    trend: null,
    previousAtr: null,
    initialTrueRanges: [],
  };
  const start = canAppend ? previous.candleCount : 0;
  for (let index = start; index < candles.length; index += 1) {
    appendMarketStructureCandle(state, candles, index);
  }
  state.candleCount = candles.length;
  state.lastTime = lastTime;
  state.lastSignature = lastSignature;
  return state;
}

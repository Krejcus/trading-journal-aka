import { supabase } from './supabase';
import { get as idbGet, getMany as idbGetMany, setMany as idbSetMany } from 'idb-keyval';

import type { MarketCandle, MarketCandleResponse, MarketDataSchema } from './marketDataCalculations';
export * from './marketDataCalculations';

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

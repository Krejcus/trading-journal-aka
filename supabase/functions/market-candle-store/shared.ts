import {
  isAllowedSchema,
  isAllowedSymbol,
  normalizeMarketSymbol,
  validateRequestedRange,
  type DatabentoOhlcvSchema,
  type ParsedMarketCandle,
} from '../market-candles/shared.ts';

export type CandleStoreSchema = DatabentoOhlcvSchema;
export type CandleStoreCandle = ParsedMarketCandle;
export interface CandleStorePeriod { startMs: number; endMs: number; key: string }
export interface CandleStoreRequest {
  symbol: string;
  schema: CandleStoreSchema;
  startMs: number;
  endMs: number;
  periods: CandleStorePeriod[];
  cacheablePeriods: CandleStorePeriod[];
  transientPeriods: CandleStorePeriod[];
}

const DAY_MS = 86_400_000;
export const COMPLETE_MARGIN_MS = 25 * 60 * 60 * 1000;
export const CANDLE_STORE_BUCKET = 'market-candles-private';
export const CANDLE_STORE_VERSION = 1;

const monthStart = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};
const nextMonth = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
};

/** 1m uses complete UTC days; 1h uses complete UTC months to keep 370-day reads small. */
export function periodsForWindow(schema: CandleStoreSchema, startMs: number, endMs: number): CandleStorePeriod[] {
  const periods: CandleStorePeriod[] = [];
  if (schema === 'ohlcv-1m') {
    for (let at = Math.floor(startMs / DAY_MS) * DAY_MS; at < endMs; at += DAY_MS) {
      periods.push({ startMs: at, endMs: at + DAY_MS, key: new Date(at).toISOString().slice(0, 10) });
    }
  } else {
    for (let at = monthStart(startMs); at < endMs; at = nextMonth(at)) {
      periods.push({ startMs: at, endMs: nextMonth(at), key: new Date(at).toISOString().slice(0, 7) });
    }
  }
  return periods;
}

export function parseStoreRequest(value: unknown, nowMs = Date.now()): CandleStoreRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-request');
  const payload = value as Record<string, unknown>;
  const symbol = normalizeMarketSymbol(typeof payload.symbol === 'string' ? payload.symbol : '');
  const schema = payload.schema ?? 'ohlcv-1m';
  const startMs = typeof payload.start === 'string' ? Date.parse(payload.start) : Number.NaN;
  const endMs = typeof payload.end === 'string' ? Date.parse(payload.end) : Number.NaN;
  if (!isAllowedSymbol(symbol) || !isAllowedSchema(String(schema)) || !validateRequestedRange(startMs, endMs, schema as CandleStoreSchema)) {
    throw new Error('invalid-request');
  }
  const periods = periodsForWindow(schema as CandleStoreSchema, startMs, endMs);
  // The provider will silently truncate an end after its 24h cutoff. Never
  // return a misleadingly complete range. The 25h margin is only for storage.
  if (endMs > nowMs - 24 * 60 * 60 * 1000) throw new Error('data-not-yet-historical');
  const cacheablePeriods = periods.filter(period => period.endMs <= nowMs - COMPLETE_MARGIN_MS);
  const transientPeriods = periods.filter(period => period.endMs > nowMs - COMPLETE_MARGIN_MS);
  return { symbol, schema: schema as CandleStoreSchema, startMs, endMs, periods, cacheablePeriods, transientPeriods };
}

export function groupAdjacentPeriods(periods: CandleStorePeriod[], maxDays: number): CandleStorePeriod[][] {
  const groups: CandleStorePeriod[][] = [];
  for (const period of periods) {
    const last = groups.at(-1);
    if (last && last.at(-1)!.endMs === period.startMs && period.endMs - last[0].startMs <= maxDays * DAY_MS) {
      last.push(period);
    } else {
      groups.push([period]);
    }
  }
  return groups;
}

export function validateProviderCandles(candles: unknown, startMs: number, endMs: number): CandleStoreCandle[] {
  if (!Array.isArray(candles) || candles.length > 25_000) throw new Error('invalid-provider-candles');
  let previous = -Infinity;
  for (const value of candles) {
    if (!value || typeof value !== 'object') throw new Error('invalid-provider-candles');
    const row = value as Record<string, unknown>;
    if (!['time', 'open', 'high', 'low', 'close', 'volume'].every(key => typeof row[key] === 'number' && Number.isFinite(row[key]))) {
      throw new Error('invalid-provider-candles');
    }
    const time = row.time as number;
    if (!Number.isInteger(time) || time <= previous || time * 1000 < startMs || time * 1000 >= endMs
      || (row.high as number) < Math.max(row.open as number, row.close as number, row.low as number)
      || (row.low as number) > Math.min(row.open as number, row.close as number, row.high as number)
      || (row.volume as number) < 0) throw new Error('invalid-provider-candles');
    previous = time;
  }
  return candles as CandleStoreCandle[];
}

export function slicePeriod(candles: CandleStoreCandle[], period: CandleStorePeriod): CandleStoreCandle[] {
  return candles.filter(candle => candle.time * 1000 >= period.startMs && candle.time * 1000 < period.endMs);
}

export function mergeWindow(periods: Array<{ period: CandleStorePeriod; candles: CandleStoreCandle[] }>, startMs: number, endMs: number): CandleStoreCandle[] {
  const byTime = new Map<number, CandleStoreCandle>();
  for (const item of periods) {
    for (const candle of item.candles) {
      if (candle.time * 1000 >= startMs && candle.time * 1000 < endMs) byTime.set(candle.time, candle);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export interface StoredCandlePeriod {
  version: number;
  schema: CandleStoreSchema;
  symbol: string;
  start: string;
  end: string;
  sourceSymbol?: string;
  candles: CandleStoreCandle[];
}

export function validateStoredPeriod(value: unknown, request: CandleStoreRequest, period: CandleStorePeriod, expectedCount: number): StoredCandlePeriod {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('corrupt-stored-period');
  const item = value as StoredCandlePeriod;
  if (item.version !== CANDLE_STORE_VERSION || item.schema !== request.schema || item.symbol !== request.symbol
    || item.start !== new Date(period.startMs).toISOString() || item.end !== new Date(period.endMs).toISOString()
    || !Array.isArray(item.candles) || item.candles.length !== expectedCount) throw new Error('corrupt-stored-period');
  try { validateProviderCandles(item.candles, period.startMs, period.endMs); }
  catch { throw new Error('corrupt-stored-period'); }
  return item;
}

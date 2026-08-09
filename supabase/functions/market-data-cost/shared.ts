import { parseEstimatedCost } from '../market-candles/shared.ts';

export const BACKFILL_DATASET = 'GLBX.MDP3';
export const BACKFILL_SCHEMA = 'ohlcv-1m';
export const BACKFILL_SYMBOLS = Object.freeze(['MNQ.v.0', 'NQ.v.0'] as const);

const MAX_BACKFILL_RANGE_MS = 6 * 366 * 24 * 60 * 60 * 1000;

export interface BackfillCostRange {
  start: string;
  end: string;
}

export const parseAllowedUserIds = (raw: string | undefined): ReadonlySet<string> =>
  new Set((raw ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean));

export const isAllowedCostUser = (userId: string, rawAllowedUserIds: string | undefined): boolean =>
  userId.length > 0 && parseAllowedUserIds(rawAllowedUserIds).has(userId);

export const validateBackfillCostRange = (start: unknown, end: unknown): BackfillCostRange | null => {
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs || endMs - startMs > MAX_BACKFILL_RANGE_MS) return null;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
};

export const buildBackfillCostParams = (symbol: typeof BACKFILL_SYMBOLS[number], range: BackfillCostRange): URLSearchParams =>
  new URLSearchParams({
    dataset: BACKFILL_DATASET,
    symbols: symbol,
    schema: BACKFILL_SCHEMA,
    stype_in: 'continuous',
    start: range.start,
    end: range.end,
  });

export const parseBackfillCost = (raw: string): number => {
  const parsed = parseEstimatedCost(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
};

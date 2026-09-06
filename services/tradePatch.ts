import type { Trade } from '../types';

export const tradeValuesEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => tradeValuesEqual(value, b[index]));
  }
  const left = Object.keys(a).filter(key => (a as Record<string, unknown>)[key] !== undefined);
  const right = Object.keys(b).filter(key => (b as Record<string, unknown>)[key] !== undefined);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) && tradeValuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

const identity = new Set(['id', 'accountId', 'backtestRunId', 'recordedAt', 'createdAt']);
/** A full editor snapshot is not a patch: never resend unrelated unchanged fields. */
export const changedTradeFields = (before: Partial<Trade>, proposed: Partial<Trade>): Partial<Trade> => Object.fromEntries(
  Object.entries(proposed).filter(([key, value]) => !identity.has(key) && value !== undefined
    && !tradeValuesEqual((before as Record<string, unknown>)[key], value)),
);

/** Revert only this failed optimistic write; preserve later edits/realtime fields. */
export const rollbackTradePatch = (current: Trade, before: Trade, patch: Partial<Trade>): Trade => {
  const result = { ...current } as Trade & Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (!tradeValuesEqual(result[key], value)) continue;
    if (Object.hasOwn(before, key)) result[key] = (before as unknown as Record<string, unknown>)[key];
    else delete result[key];
  }
  return result;
};

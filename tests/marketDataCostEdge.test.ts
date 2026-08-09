import { describe, expect, it } from 'vitest';
import {
  BACKFILL_SYMBOLS,
  buildBackfillCostParams,
  isAllowedCostUser,
  parseBackfillCost,
  validateBackfillCostRange,
} from '../supabase/functions/market-data-cost/shared';

describe('market-data-cost Edge Function helpers', () => {
  it('authorizes only exact user IDs from the configured allowlist', () => {
    const allowlist = 'user-a, user-b';
    expect(isAllowedCostUser('user-a', allowlist)).toBe(true);
    expect(isAllowedCostUser('user-b', allowlist)).toBe(true);
    expect(isAllowedCostUser('user', allowlist)).toBe(false);
    expect(isAllowedCostUser('user-a', '')).toBe(false);
  });

  it('accepts a bounded historical range and canonicalizes it to UTC', () => {
    expect(validateBackfillCostRange('2021-08-07', '2026-08-07')).toEqual({
      start: '2021-08-07T00:00:00.000Z',
      end: '2026-08-07T00:00:00.000Z',
    });
    expect(validateBackfillCostRange('2026-08-07', '2021-08-07')).toBeNull();
    expect(validateBackfillCostRange('2010-01-01', '2026-08-07')).toBeNull();
  });

  it('quotes only the fixed MNQ/NQ continuous 1m backfill without a data limit', () => {
    const range = validateBackfillCostRange('2021-08-07', '2026-08-07');
    expect(range).not.toBeNull();
    expect(BACKFILL_SYMBOLS).toEqual(['MNQ.v.0', 'NQ.v.0']);
    const params = buildBackfillCostParams('MNQ.v.0', range!);
    expect(params.get('dataset')).toBe('GLBX.MDP3');
    expect(params.get('schema')).toBe('ohlcv-1m');
    expect(params.get('stype_in')).toBe('continuous');
    expect(params.has('limit')).toBe(false);
  });

  it('fails closed on negative or malformed provider prices', () => {
    expect(parseBackfillCost('1.25')).toBe(1.25);
    expect(parseBackfillCost('{"cost_usd":2.75}')).toBe(2.75);
    expect(parseBackfillCost('-1')).toBeNaN();
    expect(parseBackfillCost('invalid')).toBeNaN();
  });
});

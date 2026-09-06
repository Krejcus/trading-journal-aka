import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupBacktestTradeIdentities } from '../services/backtestTradeIdentityLookup';

const h = vi.hoisted(() => ({ owner: 'owner', rows: [] as unknown, error: null as unknown,
  operations: [] as unknown[][], afterRead: undefined as (() => void) | undefined }));
vi.mock('../services/storageService', () => ({ getUserId: async () => h.owner }));
vi.mock('../services/supabase', () => ({ supabase: { from: (table: string) => {
  h.operations.push(['from', table]);
  const query = {
    select: (value: string) => { h.operations.push(['select', value]); return query; },
    eq: (key: string, value: string) => { h.operations.push(['eq', key, value]); return query; },
    in: (key: string, value: string[]) => { h.operations.push(['in', key, value]); return query; },
    abortSignal: (signal: AbortSignal) => { h.operations.push(['signal', signal]); return query; },
    then: (resolve: (result: unknown) => unknown) => { h.afterRead?.(); return Promise.resolve(resolve({ data: h.rows, error: h.error })); },
  };
  return query;
} } }));
const identity = () => ({ tradeId: crypto.randomUUID(), runId: 'run', accountId: 'account', instrument: 'MNQ' });
const row = (item: ReturnType<typeof identity>) => ({ id: item.tradeId, user_id: 'owner', account_id: item.accountId,
  instrument: item.instrument, backtest_run_id: item.runId, backtestRunId: null });
beforeEach(() => { h.owner = 'owner'; h.rows = []; h.error = null; h.operations = []; h.afterRead = undefined; });

describe('minimal authoritative backtest identity lookup', () => {
  it('projects only requested owner identities and verifies the account without hiding collisions', async () => {
    const item = identity(); const controller = new AbortController();
    h.rows = [{ ...row(item), notes: 'must not escape', data: { excursion: 'must not escape' } }];
    expect(await lookupBacktestTradeIdentities([item], 'owner', controller.signal)).toEqual([item]);
    expect(h.operations).toEqual([
      ['from', 'trades'], ['select', 'id,user_id,account_id,instrument,backtest_run_id,backtestRunId:data->>backtestRunId'],
      ['eq', 'user_id', 'owner'], ['in', 'id', [item.tradeId]], ['signal', controller.signal],
    ]);
  });

  it('uses the canonical root run ID and the exact legacy JSON fallback when root is absent', async () => {
    const root = identity(), legacy = identity();
    h.rows = [{ ...row(root), backtestRunId: 'stale-json-run' }, { ...row(legacy), backtest_run_id: null, backtestRunId: legacy.runId }];
    expect(await lookupBacktestTradeIdentities([root, legacy], 'owner')).toEqual([root, legacy]);
  });

  it('does not return a foreign, duplicate or missing-identity row as an existing trade', async () => {
    const item = identity();
    for (const wrong of [{ ...row(item), user_id: 'other' }, { ...row(item), account_id: 'other' },
      { ...row(item), backtest_run_id: 'other' }, { ...row(item), instrument: 'NQ' }, row(identity()),
      { ...row(item), backtest_run_id: null }]) {
      h.rows = [wrong]; await expect(lookupBacktestTradeIdentities([item], 'owner')).rejects.toThrow('identit');
    }
    h.rows = [row(item), row(item)];
    await expect(lookupBacktestTradeIdentities([item], 'owner')).rejects.toThrow('identit');
  });

  it('fails on malformed/error responses, while an actual empty result means no confirmed IDs', async () => {
    const item = identity();
    h.rows = null; await expect(lookupBacktestTradeIdentities([item], 'owner')).rejects.toThrow('nepotvrdil');
    h.rows = []; expect(await lookupBacktestTradeIdentities([item], 'owner')).toEqual([]);
    h.error = new Error('offline'); await expect(lookupBacktestTradeIdentities([item], 'owner')).rejects.toThrow('offline');
  });

  it('checks auth and cancellation before and after the request, including a same-owner generation change', async () => {
    const item = identity(); const controller = new AbortController(); controller.abort();
    await expect(lookupBacktestTradeIdentities([item], 'owner', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.operations).toEqual([]);
    h.afterRead = () => { h.owner = 'other'; };
    await expect(lookupBacktestTradeIdentities([item], 'owner')).rejects.toThrow('uživatel se změnil');
    h.owner = 'owner'; let current = true; h.afterRead = () => { current = false; };
    await expect(lookupBacktestTradeIdentities([item], 'owner', undefined, () => current)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects oversized or mixed scopes before querying', async () => {
    const item = identity();
    await expect(lookupBacktestTradeIdentities(Array.from({ length: 101 }, identity), 'owner')).rejects.toThrow('100');
    await expect(lookupBacktestTradeIdentities([item, { ...identity(), runId: 'other' }], 'owner')).rejects.toThrow('session');
    await expect(lookupBacktestTradeIdentities([item, item], 'owner')).rejects.toThrow('duplicitní');
    expect(h.operations).toEqual([]);
  });
});

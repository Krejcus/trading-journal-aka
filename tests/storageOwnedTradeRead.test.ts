import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { stripTradeNoteHistory } from '../services/tradeNotePrivacy';

// Run the actual bounded method, avoiding unrelated service startup effects.
const source = readFileSync(new URL('../services/storageService.ts', import.meta.url), 'utf8');
const start = source.indexOf('  async getTradesWithDataByAccounts(');
const end = source.indexOf('  async getBacktestSessions(', start);
const js = ts.transpile(`let authStateVersion = 0; const service = {${source.slice(start, end)}};`, { target: ts.ScriptTarget.ES2022 });
const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: String(i).padStart(6, '0'), user_id: 'owner', account_id: 'account', instrument: 'MNQ', pnl: i, direction: 'Long', date: '2026-01-01', timestamp: i, data: { tags: ['own'], setupType: 'Breakout', counterfactual: { scenario: 'keep' }, custom: { deeply: ['preserved'] } } }));
function fixture(count = 1) {
  const state = { owner: 'owner' as string | null, items: rows(count), cap: 1000, failAt: -1, nullAt: -1, repeat: false, sessionRead: undefined as undefined | (() => Promise<string | null>), onRead: undefined as undefined | (() => void) };
  const calls: Array<{ table: string; filters: Array<[string, unknown]>; order?: [string, unknown]; range?: [number, number]; signal?: AbortSignal }> = [];
  const hydrate = vi.fn(async (trades: any[], _owner: string) => trades.map(t => ({ ...t, notes: 'private owner note', noteHistory: { version: 1, revision: 0, revisions: [] } })));
  const db = { from(table: string) {
    const call: typeof calls[number] = { table, filters: [] }; calls.push(call);
    return {
      select() { return this; }, eq(k: string, v: unknown) { call.filters.push([k, v]); return this; },
      in(k: string, v: unknown) { call.filters.push([k, v]); return this; }, order(k: string, v: unknown) { call.order = [k, v]; return this; },
      range(lo: number, hi: number) { call.range = [lo, hi]; return this; }, abortSignal(signal: AbortSignal) { call.signal = signal; return this; },
      then(resolve: any, reject: any) {
        const offset = call.range?.[0] ?? 0;
        state.onRead?.();
        const result = offset === state.failAt ? { data: null, error: { message: 'page failed' } }
          : offset === state.nullAt ? { data: null, error: null }
          : { data: state.items.slice(state.repeat ? 0 : offset, (state.repeat ? 0 : offset) + Math.min(state.cap, (call.range?.[1] ?? 999) - offset + 1)), error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  } };
  const runtime = new Function('supabase', 'getUserId', 'stripTradeNoteHistory', 'hydratePrivateTradeNotes', `${js}; return { read: service.getTradesWithDataByAccounts, bump: () => { authStateVersion += 1; } };`)(db, () => state.sessionRead ? state.sessionRead() : Promise.resolve(state.owner), stripTradeNoteHistory, hydrate);
  return { ...runtime, state, calls, hydrate };
}
const strict = { strict: true as const, expectedOwnerId: 'owner' };

describe('complete owner trade read', () => {
  it('reads beyond server caps through the final empty page and keeps rich fields + private hydration', async () => {
    const f = fixture(1205); f.state.cap = 500; const progress = vi.fn();
    Object.assign(f.state.items[1204], { drawings: [{ id: 'chart-mark' }], backtest_run_id: 'run-id', signal: 'root-signal', share_notes: false });
    const result = await f.read(['account', 'account'], 'owner', { ...strict, onProgress: progress });
    expect(result).toHaveLength(1205);
    expect(result[1204]).toMatchObject({ id: '001204', custom: { deeply: ['preserved'] }, setupType: 'Breakout', notes: 'private owner note', noteHistory: { version: 1 }, drawings: [{ id: 'chart-mark' }], backtestRunId: 'run-id', signal: 'root-signal', shareNotes: false });
    expect(f.calls.map((c: any) => c.range)).toEqual([[0,999],[500,1499],[1000,1999],[1205,2204]]);
    expect(f.calls.every((c: any) => JSON.stringify(c.filters) === JSON.stringify([['user_id','owner'],['account_id',['account']]]) && c.order[0] === 'id' && c.order[1].ascending)).toBe(true);
    expect(progress.mock.calls.flat()).toEqual([500,1000,1205]);
    expect(f.hydrate).toHaveBeenCalledTimes(1);
  });
  it('never returns a partial prefix on a failed later page, and compatibility mode retains [] on DB error', async () => {
    const f = fixture(1001); f.state.failAt = 1000;
    await expect(f.read(['account'], undefined, strict)).rejects.toThrow('page failed');
    expect(f.hydrate).not.toHaveBeenCalled();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await f.read(['account'])).toEqual([]); log.mockRestore();
  });
  it('distinguishes confirmed empty rows from missing response and rejects repeated pages', async () => {
    const empty = fixture(0); expect(await empty.read(['account'], undefined, strict)).toEqual([]);
    const invalid = fixture(); invalid.state.nullAt = 0;
    await expect(invalid.read(['account'], undefined, strict)).rejects.toThrow('nepotvrdil');
    const repeated = fixture(); repeated.state.repeat = true;
    await expect(repeated.read(['account'], undefined, strict)).rejects.toThrow('stránkování');
  });
  it('rejects no owner, wrong expected owner or foreign target before querying and permits empty selection', async () => {
    const f = fixture();
    await expect(f.read(['account'], 'other', strict)).rejects.toThrow('přihlášený účet');
    await expect(f.read(['account'], undefined, { strict: true, expectedOwnerId: 'other' })).rejects.toThrow('přihlášený účet');
    expect(await f.read([], undefined, strict)).toEqual([]);
    f.state.owner = null;
    await expect(f.read(['account'], undefined, { strict: true })).rejects.toThrow('přihlášený účet');
    expect(f.calls).toEqual([]);
  });
  it('rejects a returned row outside the explicitly requested owner or accounts', async () => {
    const f = fixture(); f.state.items[0].user_id = 'other';
    await expect(f.read(['account'], undefined, strict)).rejects.toThrow('mimo požadovaný účet');
    f.state.items[0].user_id = 'owner'; f.state.items[0].account_id = 'other-account';
    await expect(f.read(['account'], undefined, strict)).rejects.toThrow('mimo požadovaný účet');
    expect(f.hydrate).not.toHaveBeenCalled();
  });
  it('captures the auth generation before the initial await, including A→B→A', async () => {
    const f = fixture();
    f.state.sessionRead = async () => { f.bump(); f.state.sessionRead = undefined; return 'owner'; };
    await expect(f.read(['account'], undefined, strict)).rejects.toThrow('Účet');
    expect(f.calls).toEqual([]);
  });
  it('rejects an owner switch during any page and after private note hydration', async () => {
    const f = fixture(); f.state.onRead = () => { f.bump(); };
    await expect(f.read(['account'], undefined, strict)).rejects.toThrow('Účet');
    expect(f.hydrate).not.toHaveBeenCalled();
    const late = fixture(); late.hydrate.mockImplementation(async trades => { late.bump(); return trades; });
    await expect(late.read(['account'], undefined, strict)).rejects.toThrow('Účet');
  });
  it('passes cancellation into the query and discards cancellation before hydration/after hydration', async () => {
    const before = fixture(); const aborted = new AbortController(); aborted.abort();
    await expect(before.read(['account'], undefined, { ...strict, signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(before.calls).toEqual([]);
    const f = fixture(1001); const controller = new AbortController();
    await expect(f.read(['account'], undefined, { ...strict, signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toHaveLength(1); expect(f.calls[0].signal).toBe(controller.signal); expect(f.hydrate).not.toHaveBeenCalled();
    const late = fixture(); const lateController = new AbortController(); late.hydrate.mockImplementation(async trades => { lateController.abort(); return trades; });
    await expect(late.read(['account'], undefined, { ...strict, signal: lateController.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

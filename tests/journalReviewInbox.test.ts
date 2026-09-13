import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { readJournalInbox, readJournalRetainedReview } from '../services/journalReviewInbox';
import type { Trade } from '../types';

const owner = '11111111-1111-4111-8111-111111111111';
const account = '22222222-2222-4222-8222-222222222222';
const id = (index: number) => `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
function fixture(rows: unknown) {
  const calls: URL[] = [];
  let current = true;
  let fail = false;
  const client = createClient('http://127.0.0.1:9998', 'fictional', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async input => {
      calls.push(new URL(String(input)));
      return new Response(JSON.stringify(fail ? { message: 'unavailable' } : rows), { status: fail ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  return { client, calls, stillOwner: () => current, logout: () => { current = false; }, fail: () => { fail = true; } };
}
describe('owner review archive', () => {
  it('uses a bounded owner/account page and does not return financial or private history values', async () => {
    const f = fixture(Array.from({ length: 26 }, (_, i) => ({ id: id(i), account_id: account,
      instrument: 'MNQ', source: 'copier', pnlEstimated: true, pnl: 500, executionHistory: { private: true } })));
    const page = await readJournalInbox(f.client, owner, 'retained', f.stillOwner, { accountIds: [account], after: id(0) });
    expect(page.rows).toHaveLength(25); expect(page.next).toBe(id(24));
    expect(page.rows[0]).not.toHaveProperty('pnl'); expect(page.rows[0]).not.toHaveProperty('executionHistory');
    const query = f.calls[0].searchParams;
    expect(query.get('user_id')).toBe(`eq.${owner}`); expect(query.get('account_id')).toBe(`in.(${account})`);
    expect(query.get('id')).toBe(`gt.${id(0)}`); expect(query.get('order')).toBe('id.asc'); expect(query.get('limit')).toBe('26');
    expect(query.get('select')).not.toContain('screenshots'); expect(query.get('select')).not.toContain('data,');
  });
  it('distinguishes pending from retained and skips already adopted legacy estimates', async () => {
    const p = fixture([{ trade_id: id(1), journal_account_id: null, external_account_id: 10, trade_created: false, status: 'pending' }]);
    expect((await readJournalInbox(p.client, owner, 'pending', p.stillOwner)).rows[0]).toMatchObject({ state: 'pending', hasReview: false, externalAccountId: 10 });
    expect(p.calls[0].searchParams.get('status')).toBe('in.(pending,invalidated)');
    const adopted = fixture([{ id: id(1), source: 'copier', pnlEstimated: true, copierTradeId: `journal:${id(1)}` },
      { id: id(2), journalSupersededBy: id(1) }]);
    expect((await readJournalInbox(adopted.client, owner, 'retained', adopted.stillOwner)).rows).toMatchObject([{ id: id(2), state: 'superseded' }]);
  });
  it('refuses invalid scopes, logout, aborted reads and unavailable archives', async () => {
    const f = fixture([]);
    await expect(readJournalInbox(f.client, owner, 'retained', f.stillOwner, { after: 'bad' })).rejects.toThrow('invalid-scope');
    expect(f.calls).toHaveLength(0);
    expect(await readJournalInbox(f.client, owner, 'pending', f.stillOwner, { accountIds: [] })).toEqual({ rows: [], next: null });
    expect(f.calls).toHaveLength(0);
    f.logout(); await expect(readJournalInbox(f.client, owner, 'pending', f.stillOwner)).rejects.toThrow('session-changed');
    const unavailable = fixture([]); unavailable.fail();
    await expect(readJournalInbox(unavailable.client, owner, 'pending', unavailable.stillOwner)).rejects.toThrow('unavailable');
    const abort = new AbortController(); abort.abort();
    await expect(readJournalInbox(f.client, owner, 'pending', () => true, { signal: abort.signal })).rejects.toThrow('session-changed');
  });
  it('reads original review by owner and ID while omitting old P&L, even after private note hydration', async () => {
    const f = fixture({ id: id(1), drawings: [{}], data: { pnl: 999, notes: 'old', screenshot: 'https://example.test/a.png',
      screenshots: ['https://example.test/a.png', 'javascript:unsafe'], executionHistory: { private: true } } });
    const hydrate = vi.fn(async (trades: Trade[]) => trades.map(trade => ({ ...trade, notes: 'retained private review' })));
    const review = await readJournalRetainedReview(f.client, owner, id(1), f.stillOwner, hydrate);
    expect(review).toEqual({ id: id(1), screenshots: ['https://example.test/a.png'], notes: [{ label: 'Poznámky', text: 'retained private review' }], drawingCount: 1 });
    expect(f.calls[0].searchParams.get('user_id')).toBe(`eq.${owner}`);
    expect(f.calls[0].searchParams.get('id')).toBe(`eq.${id(1)}`);
    await expect(readJournalRetainedReview(f.client, owner, id(1), f.stillOwner, async trades => { f.logout(); return trades; })).rejects.toThrow('session-changed');
  });
});

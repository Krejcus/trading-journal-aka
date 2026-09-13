import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '../types';
import { readOwnedJournalDetails, mergeJournalDetailSelection } from '../services/journalTradeDetail';
import { aggregateHistoryTrades } from '../lib/tradeHistoryPresentation';
import { journalAccountsFixture } from './fixtures/journalAccounts';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import { journalPositionWrite } from '../lib/journalTradeFacts';

function fixture(count = 12) {
  const raw = journalAccountsFixture();
  const positions = projectJournalAccounts(raw.events, raw.accounts).ready.map(journalPositionWrite);
  const roots = Array.from({ length: count }, (_, index) => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    user_id: 'owner', account_id: positions[index % 12].journalAccountId, pnl: 999,
    data: { copierTradeId: 'journal:position', notes: 'saved', screenshot: 'own-image' } }));
  const records = roots.map((row, index) => ({ trade_id: row.id, journal_account_id: row.account_id, status: 'confirmed',
    facts: positions[index % 12].facts, history: positions[index % 12].history,
    connection_id: raw.events[0].connectionId, external_account_id: positions[index % 12].externalAccountId, revision: 80 }));
  const state = { roots, records, current: true, head: { connection_id: raw.events[0].connectionId, revision: 80, completed_revision: 80, generation: 1 },
    onRead: undefined as undefined | ((table: string) => void) };
  const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const client = { from(table: string) {
    const call = { table, filters: {} as Record<string, unknown> }; calls.push(call);
    const q = { select: () => q, eq: (k: string, v: unknown) => { call.filters[k] = v; return q; },
      in: (k: string, v: unknown) => { call.filters[k] = v; return q; }, order: () => q, limit: () => q, gt: () => q, returns: () => q,
      abortSignal: async () => {
        state.onRead?.(table);
        const ids = (call.filters.id ?? call.filters.trade_id) as string[];
        return { error: null, data: table.endsWith('_heads') ? [structuredClone(state.head)] : table === 'trades'
          ? state.roots.filter(row => ids.includes(row.id)) : table === 'journal_trade_snapshots' ? []
            : state.records.filter(row => ids.includes(row.trade_id)) };
      } }; return q;
  } } as unknown as SupabaseClient;
  const ids = roots.map(row => row.id);
  const read = (hydrate: (rows: Trade[]) => Promise<Trade[]> = async rows => rows, signal?: AbortSignal) =>
    readOwnedJournalDetails(client, ids, 'owner', () => state.current, hydrate, signal);
  return { state, calls, read, ids, client };
}

describe('consistent complete journal detail', () => {
  it('reads the exact 12-account selection with actual fact/history hydration and one root query', async () => {
    const f = fixture(); const rows = await f.read();
    expect(rows.map(row => row.pnl)).toEqual(Array.from({ length: 12 }, (_, i) => 19 * (i + 1)));
    expect(rows.map(row => row.executionHistory?.accountId)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(f.calls.filter(call => call.table === 'trades')).toHaveLength(1);
    expect(f.calls.every(call => call.filters.user_id === 'owner')).toBe(true);
    expect(f.calls.filter(call => call.table === 'trades')[0].filters.id).toEqual(f.ids);
  });
  it('fences the root-to-facts gap and changes while private notes load', async () => {
    const f = fixture(); f.state.onRead = table => { if (table === 'trades') f.state.head.generation++; };
    await expect(f.read()).rejects.toThrow('changed-during-read');
    const g = fixture(); await expect(g.read(async rows => { g.state.head.generation++; return rows; })).rejects.toThrow('changed-during-read');
  });
  it('rejects incomplete, duplicate, foreign, retired and invalidated members instead of publishing a partial sum', async () => {
    const missing = fixture(); missing.state.roots.pop(); await expect(missing.read()).rejects.toThrow('detail-incomplete');
    const dup = fixture(); dup.state.roots[1] = dup.state.roots[0]; await expect(dup.read()).rejects.toThrow('detail-incomplete');
    const foreign = fixture(); foreign.state.roots[0].user_id = 'other'; await expect(foreign.read()).rejects.toThrow('detail-incomplete');
    const legacy = fixture(); legacy.state.roots[0].data.copierTradeId = 'copier-old'; await expect(legacy.read()).rejects.toThrow('detail-incomplete');
    const invalid = fixture(); invalid.state.records[0].status = 'invalidated'; await expect(invalid.read()).rejects.toThrow('detail-incomplete');
  });
  it('batches 101 requested realizations and rejects cancellation/session changes', async () => {
    const f = fixture(101); expect(await f.read()).toHaveLength(101);
    expect(f.calls.filter(call => call.table === 'trades').map(call => (call.filters.id as string[]).length)).toEqual([100, 1]);
    const g = fixture(); g.state.onRead = () => { g.state.current = false; }; await expect(g.read()).rejects.toThrow('session-changed');
    const h = fixture(); const controller = new AbortController();
    await expect(h.read(async rows => { controller.abort(); return rows; }, controller.signal)).rejects.toThrow('session-changed');
  });
  it('rejects empty, duplicate and malformed selections before queries', async () => {
    const f = fixture();
    for (const ids of [[], [f.ids[0], f.ids[0]], ['combined_group']]) await expect(readOwnedJournalDetails(f.client, ids, 'owner', () => true, async rows => rows)).rejects.toThrow('selection-invalid');
    expect(f.calls).toEqual([]);
  });
});

describe('one snapshot for summary, individual prices and chart', () => {
  it('rebuilds a filtered sum and all member facts while preserving current private review', async () => {
    const f = fixture(); const fresh = (await f.read()).map(row => ({ ...row, groupId: 'group' }));
    const old = fresh.slice(2, 5).map(row => ({ ...row, pnl: 999, entryPrice: 123, notes: 'edited while loading', riskAmount: 999 }));
    const selected = aggregateHistoryTrades(old)[0];
    const result = mergeJournalDetailSelection(selected, old, fresh.slice(2, 5).reverse());
    expect(result.trade.pnl).toBe(19 * (3 + 4 + 5));
    expect(result.members.map(row => row.entryPrice)).toEqual(fresh.slice(2, 5).map(row => row.entryPrice));
    expect(result.members.every(row => row.notes === 'edited while loading' && row.riskAmount === undefined)).toBe(true);
    expect(result.members[0].executionHistory).toBe(fresh[2].executionHistory);
    expect(result.trade.combinedTradeIds).toEqual(old.map(row => row.id));
    expect(old[0].pnl).toBe(999);
  });
  it('rejects account/group reassignment or missing selection without borrowing another row', async () => {
    const f = fixture(); const fresh = (await f.read()).map(row => ({ ...row, groupId: 'group' }));
    const combined = aggregateHistoryTrades(fresh)[0];
    for (const rows of [fresh.slice(1), [fresh[0], ...fresh.slice(0, -1)],
      [{ ...fresh[0], accountId: 'other' }, ...fresh.slice(1)], [{ ...fresh[0], groupId: 'other' }, ...fresh.slice(1)]]) {
      expect(() => mergeJournalDetailSelection(combined, fresh, rows)).toThrow('detail-incomplete');
    }
  });
  it('keeps an individual account alone and loads missing media/review from its fresh row', async () => {
    const f = fixture(); const fresh = (await f.read())[1];
    const old = { ...fresh, pnl: 999, screenshot: 'old-cached-image', screenshots: [], drawings: [], notes: undefined };
    fresh.drawings = [{ id: 'fresh-drawing' }] as Trade['drawings'];
    expect(mergeJournalDetailSelection(old, [old], [fresh])).toMatchObject({ trade: { pnl: 38, screenshot: 'own-image', drawings: [{ id: 'fresh-drawing' }], notes: 'saved' } });
  });
});

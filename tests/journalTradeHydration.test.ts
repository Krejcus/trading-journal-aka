import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '../types';
import { hydrateOwnedJournalTrades, stripPrivateJournalHistory } from '../services/journalTradeHydration';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import { journalPositionWrite } from '../lib/journalTradeFacts';
import { journalAccountsFixture } from './fixtures/journalAccounts';
import { publicTradeNotes } from '../services/tradeNotePrivacy';

function fixture(count = 12) {
  const raw = journalAccountsFixture();
  const positions = projectJournalAccounts(raw.events, raw.accounts).ready.map(journalPositionWrite);
  const trades = Array.from({ length: count }, (_, i) => ({ id: `trade-${i}`, accountId: positions[i % 12].journalAccountId,
    copierTradeId: `journal:trade-${i}`, pnl: 999, notes: `review ${i}` } as Trade));
  const records = trades.map((trade, i) => ({ trade_id: String(trade.id), journal_account_id: trade.accountId,
    status: 'confirmed', facts: positions[i % 12].facts, history: positions[i % 12].history,
    connection_id: raw.events[0].connectionId, external_account_id: positions[i % 12].externalAccountId, revision: 80 }));
  const head = { connection_id: raw.events[0].connectionId, revision: 80, completed_revision: 80, generation: 1 };
  const state = { heads: [head], records, onRead: undefined as undefined | ((table: string, count: number) => void), error: null as null | string };
  const calls: { table: string; filters: [string, unknown][]; selected: string }[] = [];
  const client = { from: vi.fn((table: string) => {
    const call = { table, filters: [] as [string, unknown][], selected: '' }; calls.push(call);
    const q = {
      select: (value: string) => { call.selected = value; return q; },
      eq: (key: string, value: unknown) => { call.filters.push([key, value]); return q; },
      in: (key: string, value: unknown) => { call.filters.push([key, value]); return q; },
      gt: () => q, order: () => q, limit: () => q, returns: () => q,
      abortSignal: async (_signal: AbortSignal) => {
        state.onRead?.(table, calls.length);
        if (state.error) return { data: null, error: { code: state.error } };
        const ids = call.filters.find(([key]) => key === 'trade_id')?.[1] as string[] | undefined;
        return { data: table === 'journal_trade_snapshots' ? [] : table.endsWith('_heads') ? structuredClone(state.heads)
          : state.records.filter(row => ids?.includes(row.trade_id)).map(row => call.selected.endsWith(',history') ? row : { ...row, history: undefined }), error: null };
      },
    };
    return q;
  }) };
  const read = (options = {}, stillOwner: () => boolean = () => true, target = 'owner') =>
    hydrateOwnedJournalTrades(client as unknown as SupabaseClient, trades, 'owner', target, stillOwner, options);
  return { state, client, calls, read, trades };
}

describe('shared owner journal facts reader', () => {
  it('hydrates 12 own results without downloading heavy history for the list', async () => {
    const f = fixture(); const result = await f.read();
    expect(result.map(row => row.pnl)).toEqual(Array.from({ length: 12 }, (_, i) => 19 * (i + 1)));
    expect(result[0]).toMatchObject({ notes: 'review 0', entryTime: 1001, timestamp: 2001 });
    expect(result.every(row => row.executionHistory === undefined)).toBe(true);
    expect(f.calls.every(call => call.filters.some(([key, value]) => key === 'user_id' && value === 'owner'))).toBe(true);
  });
  it('excludes pending and invalidated positions from confirmed financial collections', async () => {
    const f = fixture(); f.state.records[0].status = 'pending'; f.state.records[1].status = 'invalidated';
    expect((await f.read()).map(row => row.id)).toEqual(f.trades.slice(2).map(row => row.id));
  });
  it('fetches the selected owner history in detail and rejects a different account history', async () => {
    const f = fixture(1); const result = await f.read({ detail: true });
    expect(result[0].executionHistory?.accountId).toBe(1);
    f.state.records[0].history = { ...f.state.records[0].history, accountId: 2 };
    await expect(f.read({ detail: true })).rejects.toThrow('history-incomplete');
  });
  it('bounds URL batches and rejects an intervening same-revision reprojection', async () => {
    const f = fixture(101); expect(await f.read()).toHaveLength(101);
    expect(f.calls.filter(call => call.table.endsWith('_positions')).map(call => (call.filters.find(([key]) => key === 'trade_id')![1] as string[]).length)).toEqual([100, 1]);
    const race = fixture(101);
    race.state.onRead = (_table, count) => { if (count === 3) race.state.heads[0].generation++; };
    await expect(race.read()).rejects.toThrow('changed-during-read');
  });
  it('never publishes a partial batch, missing record, unavailable table or mismatched revision', async () => {
    const missing = fixture(); missing.state.records.pop(); await expect(missing.read()).rejects.toThrow('facts-incomplete');
    const absent = fixture(); absent.state.error = '42P01'; await expect(absent.read()).rejects.toThrow('facts-unavailable');
    const failed = fixture(101); failed.state.onRead = (_table, count) => { if (count === 3) failed.state.error = 'network'; };
    await expect(failed.read()).rejects.toThrow('facts-unavailable');
    const incomplete = fixture(); incomplete.state.heads[0].completed_revision = 79;
    await expect(incomplete.read()).rejects.toThrow('facts-incomplete');
    const stale = fixture(); stale.state.records[0].revision = 79;
    await expect(stale.read()).rejects.toThrow('facts-incomplete');
    const bad = fixture(); bad.state.records[0].facts = { ...bad.state.records[0].facts, pnl: null };
    await expect(bad.read()).rejects.toThrow('facts-incomplete');
  });
  it('fences logout and cancellation even after data has arrived', async () => {
    const f = fixture(); let current = true; f.state.onRead = () => { current = false; };
    await expect(f.read({}, () => current)).rejects.toThrow('session-changed');
    const g = fixture(); const abort = new AbortController(); g.state.onRead = () => abort.abort();
    await expect(g.read({ signal: abort.signal })).rejects.toThrow('read-aborted');
  });
  it('never queries private evidence for social reads or ordinary manual trades', async () => {
    const f = fixture(); expect(await f.read({}, () => true, 'other')).toEqual([]); expect(f.client.from).not.toHaveBeenCalled();
    const manual = { ...f.trades[0], copierTradeId: undefined };
    expect(await hydrateOwnedJournalTrades(f.client as unknown as SupabaseClient, [manual], 'owner', 'owner', () => true)).toEqual([manual]);
    expect(f.client.from).not.toHaveBeenCalled();
  });
  it('strips private execution history recursively from saves and public sharing', () => {
    const value = { copierSnapshotLoadError: true, notes: 'shareable', executionHistory: { accountId: 1 }, data: { executionHistory: { accountId: 1 } } };
    expect(stripPrivateJournalHistory(value)).toEqual({ notes: 'shareable', data: {} });
    expect(publicTradeNotes(value, true)).toEqual({ notes: 'shareable', data: {} });
    expect(value.executionHistory.accountId).toBe(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Trade } from '../types';
import { hydrateOwnedJournalTrades, stripPrivateJournalHistory } from '../services/journalTradeHydration';
import { publicTradeNotes } from '../services/tradeNotePrivacy';

// Obchody z Tradovate importu jsou zmrazené (23. 11. 2026): čísla jsou přímo
// v trades, soukromá historie fillů v trade_execution_history.
const history = (accountId: number) => ({ accountId, fills: [{ id: `fill-${accountId}` }], protection: [], gaps: [] });

function fixture(count = 12) {
  const trades = Array.from({ length: count }, (_, i) => ({ id: `trade-${i}`, accountId: `account-${i % 12}`,
    copierTradeId: `journal:trade-${i}`, pnl: 19 * (i + 1), notes: `review ${i}`,
    executionHistory: { accountId: 99 } } as unknown as Trade));
  const records = trades.map((trade, i) => ({ trade_id: String(trade.id), history: history(i + 1) as unknown }));
  const state = { records, onRead: undefined as undefined | ((table: string, count: number) => void), error: null as null | string };
  const calls: { table: string; filters: [string, unknown][]; selected: string }[] = [];
  const client = { from: vi.fn((table: string) => {
    const call = { table, filters: [] as [string, unknown][], selected: '' }; calls.push(call);
    const q = {
      select: (value: string) => { call.selected = value; return q; },
      eq: (key: string, value: unknown) => { call.filters.push([key, value]); return q; },
      in: (key: string, value: unknown) => { call.filters.push([key, value]); return q; },
      returns: () => q,
      abortSignal: async (_signal: AbortSignal) => {
        state.onRead?.(table, calls.length);
        if (state.error) return { data: null, error: { code: state.error } };
        const ids = call.filters.find(([key]) => key === 'trade_id')?.[1] as string[] | undefined;
        return { data: state.records.filter(row => ids?.includes(row.trade_id)), error: null };
      },
    };
    return q;
  }) };
  const read = (options = {}, stillOwner: () => boolean = () => true, target = 'owner') =>
    hydrateOwnedJournalTrades(client as unknown as SupabaseClient, trades, 'owner', target, stillOwner, options);
  return { state, client, calls, read, trades };
}

describe('frozen journal trades reader', () => {
  it('returns stored facts for the list without any query and strips stale private history', async () => {
    const f = fixture(); const result = await f.read();
    expect(result.map(row => row.pnl)).toEqual(Array.from({ length: 12 }, (_, i) => 19 * (i + 1)));
    expect(result.every(row => row.executionHistory === undefined)).toBe(true);
    expect(f.client.from).not.toHaveBeenCalled();
  });
  it('attaches owner-only history in detail from trade_execution_history', async () => {
    const f = fixture(3); const result = await f.read({ detail: true });
    expect(result.map(row => row.executionHistory?.accountId)).toEqual([1, 2, 3]);
    expect(f.calls.map(call => call.table)).toEqual(['trade_execution_history']);
    expect(f.calls[0].filters).toContainEqual(['user_id', 'owner']);
  });
  it('bounds URL batches to 100 trades', async () => {
    const f = fixture(101); expect(await f.read({ detail: true })).toHaveLength(101);
    expect(f.calls.map(call => (call.filters.find(([key]) => key === 'trade_id')![1] as string[]).length)).toEqual([100, 1]);
  });
  it('never returns a detail with missing, duplicate, malformed or unavailable history', async () => {
    const missing = fixture(); missing.state.records.pop(); await expect(missing.read({ detail: true })).rejects.toThrow('history-incomplete');
    const dup = fixture(); dup.state.records.push(dup.state.records[0]); await expect(dup.read({ detail: true })).rejects.toThrow('history-incomplete');
    const bad = fixture(); bad.state.records[0].history = { accountId: 1 }; await expect(bad.read({ detail: true })).rejects.toThrow('history-incomplete');
    const absent = fixture(); absent.state.error = '42P01'; await expect(absent.read({ detail: true })).rejects.toThrow('history-unavailable');
  });
  it('fences logout and cancellation even after data has arrived', async () => {
    const f = fixture(); let current = true; f.state.onRead = () => { current = false; };
    await expect(f.read({ detail: true }, () => current)).rejects.toThrow('session-changed');
    const g = fixture(); const abort = new AbortController(); g.state.onRead = () => abort.abort();
    await expect(g.read({ detail: true, signal: abort.signal })).rejects.toThrow('read-aborted');
  });
  it('hides imported trades from social reads and never queries for them or for manual trades', async () => {
    const f = fixture(); expect(await f.read({ detail: true }, () => true, 'other')).toEqual([]); expect(f.client.from).not.toHaveBeenCalled();
    const manual = { ...f.trades[0], copierTradeId: undefined, executionHistory: undefined };
    expect(await hydrateOwnedJournalTrades(f.client as unknown as SupabaseClient, [manual], 'owner', 'owner', () => true, { detail: true })).toEqual([manual]);
    expect(f.client.from).not.toHaveBeenCalled();
  });
  it('strips private execution history recursively from saves and public sharing', () => {
    const value = { copierSnapshotLoadError: true, notes: 'shareable', executionHistory: { accountId: 1 }, data: { executionHistory: { accountId: 1 } } };
    expect(stripPrivateJournalHistory(value)).toEqual({ notes: 'shareable', data: {} });
    expect(publicTradeNotes(value, true)).toEqual({ notes: 'shareable', data: {} });
    expect(value.executionHistory.accountId).toBe(1);
  });
});

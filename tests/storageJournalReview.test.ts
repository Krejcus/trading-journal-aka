import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { journalReviewPatch } from '../lib/journalReviewPatch';
import { stripTradeNoteHistory } from '../services/tradeNotePrivacy';
import { stripPrivateJournalHistory } from '../services/journalTradeHydration';

// Execute the actual service method with an isolated transport and cache.
const source = readFileSync(new URL('../services/storageService.ts', import.meta.url), 'utf8');
const start = source.indexOf('  async updateTrade(tradeId:');
const end = source.indexOf('  async saveTrades(', start);
const js = ts.transpile(`let authStateVersion=0; const service={${source.slice(start,end)}};`, { target: ts.ScriptTarget.ES2022 });
function harness() {
  const state = { owner: 'owner', confirmed: true, fail: false, updates: [] as any[],
    row: { id: 'trade', user_id: 'owner', data: { copierTradeId: 'journal:1', source: 'copier', notes: 'old', entryPrice: 100, privateShape: { keep: true } } },
    cache: [{ id: 'trade', pnl: 37, entryPrice: 100, notes: 'old', copierTradeId: 'journal:1' }], filters: [] as any[], changeOwner: false };
  const db = { from() { return {
    select() { return this; }, eq(key: string, value: unknown) { state.filters.push([key,value]); return this; },
    async single() { if (state.changeOwner) state.owner = 'other'; return { data: state.row, error: null }; },
    update(value: any) { state.updates.push(value); return this; },
    async maybeSingle() { return { data: state.confirmed ? { id: 'trade' } : null, error: state.fail ? new Error('refused') : null }; },
  }; } };
  const service = new Function('supabase','getUserId','journalReviewPatch','stripTradeNoteHistory','stripPrivateJournalHistory','get','set',`${js}; return service;`)(
    db, async () => state.owner, journalReviewPatch, stripTradeNoteHistory, stripPrivateJournalHistory,
    async () => state.cache, async (_key: string, value: typeof state.cache) => { state.cache = value; });
  return { state, update: service.updateTrade.bind(service) };
}

describe('journal review persistence boundary', () => {
  it('uses persisted identity and excludes financial/provenance fields from DB and cache patches', async () => {
    const { state, update } = harness();
    await update('trade', { pnl: 999, entryPrice: 1, source: 'manual', copierTradeId: '', notes: 'new',
      executionHistory: { secret: true } });
    expect(state.updates).toEqual([{ data: { ...state.row.data, notes: 'new' } }]);
    expect(state.cache[0]).toMatchObject({ pnl: 37, entryPrice: 100, notes: 'new', copierTradeId: 'journal:1' });
    expect(state.filters.filter(([key]) => key === 'user_id')).toEqual([['user_id','owner'],['user_id','owner']]);
  });
  it('does not write or replace cache when there are no permitted fields', async () => {
    const { state, update } = harness();
    await update('trade', { pnl: 999, stopLoss: 1 });
    expect(state.updates).toEqual([]); expect(state.cache[0].notes).toBe('old');
  });
  it('does not claim success without a confirmed row or after the session changes', async () => {
    const first = harness(); first.state.confirmed = false;
    await expect(first.update('trade', { notes: 'new' })).rejects.toThrow('potvrzeno');
    expect(first.state.cache[0].notes).toBe('old');
    const second = harness(); second.state.changeOwner = true;
    await expect(second.update('trade', { notes: 'new' })).rejects.toThrow('Účet');
    expect(second.state.updates).toEqual([]);
  });
});

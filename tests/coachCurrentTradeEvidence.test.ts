import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
import { buildTradeNoteHistoryPatch } from '../services/tradeNoteHistory';

const h = vi.hoisted(() => ({ results: [] as any[], queryAvailable: true }));
vi.mock('../services/supabase', () => ({ supabase: {
  supabaseUrl: 'https://mock.invalid',
  auth: { getSession: async () => ({ data: { session: h.queryAvailable ? { access_token: 'mock-only' } : null } }) },
  rpc: async () => ({ data: h.results, error: null }),
} }));
import { executeTool } from '../services/coachTools';
import { buildTradeWindow, formatTradesForAI } from '../services/aiService';

const trade = (partial: Partial<Trade> = {}): Trade => ({
  id: 't-current', accountId: 'backtest', instrument: 'MNQ', date: '2025-01-01',
  timestamp: 1, pnl: 100, direction: 'Long', signal: 'Replay', runUp: 100,
  drawdown: 0, duration: '1m', durationMinutes: 1, ...partial,
});
const ctx = (trades: Trade[]) => ({ trades, accounts: [], preps: [], reviews: [], scope: 'backtest' as const });
beforeEach(() => {
  h.results = []; h.queryAvailable = true;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ embedding: [0.1] }) })));
});
afterEach(() => vi.unstubAllGlobals());

describe('Coach reads current review evidence', () => {
  it('replaces a matched stale embedding with full newly saved notes and current tags', async () => {
    const item = trade({ notes: 'x'.repeat(1800) + ' Dodatečně: revenge po stopce.', tags: ['Moje pravidlo'], htfConfluence: ['u mé rezistence'], autoConfluence: { htf: [], ltf: [] } });
    h.results = [{ source_type: 'trade', source_id: item.id, content: 'OLD generated note', metadata: { tags: ['removed'] }, similarity: 0.9 }];
    const result: any = await executeTool('search_history', { query: 'revenge' }, ctx([item]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0].content).toContain(item.notes);
    expect(result.results[0].content).not.toContain('OLD');
    expect(result.results[0].metadata.tags).toEqual(['Moje pravidlo']);
    expect(result.results[0].metadata.autoConfluence).toEqual({ htf: [], ltf: [] });
  });

  it('rehydrates semantic-only matches when there is no lexical token overlap', async () => {
    const item = trade({ notes: 'Nedodržel jsem limit počtu vstupů.' });
    h.results = [{ source_type: 'trade', source_id: item.id, content: 'OLD', similarity: 0.9 }];
    const result: any = await executeTool('search_history', { query: 'overtrading' }, ctx([item]));
    expect(result.retrieval.lexicalCandidates).toBe(0);
    expect(result.results[0].content).toContain(item.notes);
  });

  it('finds the added note without embeddings or any external request', async () => {
    h.queryAvailable = false;
    const item = trade({ notes: 'Doplňuji netrpělivost po stop lossu' });
    const result: any = await executeTool('search_history', { query: 'netrpelivost' }, ctx([item]));
    expect(result.results[0].content).toContain(item.notes);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still finds newly added notes when semantic transport throws', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('mock offline'));
    const item = trade({ notes: 'Dodatečné revenge review' });
    const result: any = await executeTool('search_history', { query: 'revenge' }, ctx([item]));
    expect(result.results[0].content).toContain(item.notes);
    expect(result.retrieval.mode).toBe('lexical-fallback');
  });

  it('keeps similar trade results inside the selected world and returns current notes', async () => {
    const item = trade({ notes: 'current reviewed note', tags: ['My tag'] });
    h.results = [
      { source_type: 'trade', source_id: 'live-outside-scope', content: 'LIVE SECRET', similarity: 0.99 },
      { source_type: 'trade', source_id: item.id, content: 'OLD', similarity: 0.9 },
    ];
    const result: any = await executeTool('find_similar_trades', { description: 'similar setup' }, ctx([item]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0].source_id).toBe(item.id);
    expect(result.results[0].content).toContain(item.notes);
  });

  it('includes full notes and both manual and indicator tags in recent context and the prompt', async () => {
    const item = trade({ notes: 'x'.repeat(1800) + 'TAIL NOTE', tags: ['Custom'], htfConfluence: ['u PDH'], ltfConfluence: ['nad VWAP'] });
    const result: any = await executeTool('get_recent_context', {}, ctx([item]));
    expect(result.recentTrades[0]).toMatchObject({ notes: item.notes, tags: item.tags, htfConfluence: item.htfConfluence, ltfConfluence: item.ltfConfluence });
    expect(formatTradesForAI([item])).toContain(item.notes);
    expect(formatTradesForAI([item])).toContain('Tagy:Custom');
  });

  it('reads owner-hydrated phase history in prompts, recent context and lexical search with hindsight labels', async () => {
    h.queryAvailable = false;
    const noteHistory = buildTradeNoteHistoryPatch({ before: 'Doplněná netrpělivost', during: '', after: '' }, undefined,
      { marketTime: 240, maxRevealedMarketTime: 240, entryMarketTime: 120, exitMarketTime: 180, closedTradeReview: true },
      { operationId: 'coach-note', clientCapturedAt: 1000 }).history;
    const item = trade({ noteHistory });
    const recent: any = await executeTool('get_recent_context', {}, ctx([item]));
    expect(recent.recentTrades[0].noteHistory.revisions[0]).toMatchObject({ retrospective: true, retrospectiveReason: 'closed-trade-review' });
    const search: any = await executeTool('search_history', { query: 'netrpelivost' }, ctx([item]));
    expect(search.results[0].content).toContain('Doplněná netrpělivost');
    expect(formatTradesForAI([item])).toContain('closed-trade-review');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('makes the 500-trade prompt cutoff explicit instead of claiming all history is included', () => {
    const all = Array.from({ length: 503 }, (_, index) => trade({ id: `t-${index}`, date: new Date(Date.UTC(2024, 0, index + 1)).toISOString() }));
    const result = buildTradeWindow(all, { allTime: true });
    expect(result.windowCount).toBe(500);
    expect(result.olderCount).toBe(3);
    expect(result.rollupText).toContain('3 starších');
    expect(result.rollupText).toContain('search_history');
  });
});

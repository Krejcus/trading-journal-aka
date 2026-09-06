import { describe, expect, it, vi } from 'vitest';
import { hydrateOwnedTradeNoteHistories, publicTradeNotes, stripTradeNoteHistory } from '../services/tradeNotePrivacy';
import { buildTradeNoteHistoryPatch } from '../services/tradeNoteHistory';
import { PRIVATE_BACKTEST_REVIEW_RPC, requestBacktestReviewPatch } from '../services/backtestReviewPersistence';
import { persistBacktestTradeReview } from '../services/backtestTradeReview';
import { formatTradeNoteHistoryForAI, tradeNoteAiEvidence } from '../services/tradeNoteAiContext';
const history = buildTradeNoteHistoryPatch({ before: 'before plan', during: '', after: '' }, undefined,
  { marketTime: 60, maxRevealedMarketTime: 60, entryMarketTime: 120, exitMarketTime: 180, closedTradeReview: false },
  { operationId: 'op1', clientCapturedAt: 1000 }).history;
const snapshot = { ownerId: 'owner-a', authVersion: 1, data: {} };
const privateClient = (result: unknown) => {
  const query = { select: vi.fn(() => query), eq: vi.fn(() => query), in: vi.fn(async () => result) };
  const from = vi.fn(() => query);
  return { from, query };
};

describe('private note cloud boundary', () => {
  it('strips private history at every legacy nesting depth without mutating the input', () => {
    const trade = { id: 't', noteHistory: history, notes: 'shared', data: { noteHistory: history, notes: 'nested', list: [{ noteHistory: history, keep: true }] } };
    const clean = stripTradeNoteHistory(trade);
    expect(JSON.stringify(clean)).not.toContain('noteHistory');
    expect(clean.notes).toBe('shared'); expect(trade.noteHistory).toEqual(history);
    expect(publicTradeNotes(trade, false)).toEqual({ id: 't', data: { list: [{ keep: true }] } });
    expect(publicTradeNotes({ ...trade, sessionPreNotes: 'before', sessionPostNotes: 'after' }, false)).not.toHaveProperty('sessionPreNotes');
    expect(publicTradeNotes(trade, true).notes).toBe('shared');
    expect(JSON.stringify(publicTradeNotes(trade, true))).not.toContain('noteHistory');
  });
  it('uses the versioned private RPC and sends the original expected ledger only', async () => {
    const rpc = vi.fn(async () => ({ data: { id: 't', data: { noteHistory: history }, privateNotes: { version: 1, storage: 'owner-table' } }, error: null }));
    expect(await requestBacktestReviewPatch({ rpc }, 't', snapshot, { noteHistory: history })).toEqual({ noteHistory: history });
    expect(rpc).toHaveBeenCalledWith(PRIVATE_BACKTEST_REVIEW_RPC, expect.objectContaining({ p_updates: { noteHistory: history }, p_expected: {} }));
  });
  it('fails before screenshot upload or save when private capability is missing', async () => {
    const rpc = vi.fn(async () => ({ error: { code: 'PGRST202' }, data: null }));
    const uploadScreenshot = vi.fn(); const updateBacktestTradeReview = vi.fn();
    const api = { prepareBacktestTradeReview: async (id: string, updates: any) => ({ ...snapshot, data: await requestBacktestReviewPatch({ rpc }, id, snapshot, {}, undefined, Object.hasOwn(updates, 'noteHistory')) }), uploadScreenshot, updateBacktestTradeReview };
    await expect(persistBacktestTradeReview(api, 't', { noteHistory: history }, 'data:image/png;base64,x')).rejects.toThrow('není aktivované');
    expect(rpc).toHaveBeenCalledTimes(1); expect(rpc).toHaveBeenCalledWith(PRIVATE_BACKTEST_REVIEW_RPC, expect.any(Object));
    expect(uploadScreenshot).not.toHaveBeenCalled(); expect(updateBacktestTradeReview).not.toHaveBeenCalled();
  });
  it('rejects malformed history before an RPC and requires a private storage acknowledgement', async () => {
    const rpc = vi.fn(async () => ({ data: { id: 't', data: { noteHistory: history } }, error: null }));
    await expect(requestBacktestReviewPatch({ rpc }, 't', snapshot, { noteHistory: { ...history, revision: 9 } })).rejects.toThrow('formát');
    expect(rpc).not.toHaveBeenCalled();
    await expect(requestBacktestReviewPatch({ rpc }, 't', snapshot, { noteHistory: history })).rejects.toThrow('nepotvrdil soukromé');
  });
  it('does not trust history from the old public blob snapshot', async () => {
    const rpc = vi.fn(async () => ({ data: { id: 't', data: { notes: 'legacy', noteHistory: history } }, error: null }));
    expect(await requestBacktestReviewPatch({ rpc }, 't', snapshot, {})).toEqual({ notes: 'legacy' });
  });
});

describe('owner private history hydration', () => {
  it('hydrates owner rows from the owner-only table and filters both user and ids', async () => {
    const client = privateClient({ data: [{ trade_id: 't', history }], error: null });
    expect(await hydrateOwnedTradeNoteHistories(client, [{ id: 't' }], 'a', 'a', () => true)).toEqual([{ id: 't', noteHistory: history }]);
    expect(client.from).toHaveBeenCalledWith('backtest_trade_note_histories');
    expect(client.query.eq).toHaveBeenCalledWith('user_id', 'a'); expect(client.query.in).toHaveBeenCalledWith('trade_id', ['t']);
  });
  it('never queries private table for another owner or returns their cached/nested history', async () => {
    const client = privateClient({ data: [], error: null });
    expect(await hydrateOwnedTradeNoteHistories(client, [{ id: 't', noteHistory: history, data: { noteHistory: history } }], 'a', 'b', () => true)).toEqual([{ id: 't', data: {} }]);
    expect(client.from).not.toHaveBeenCalled();
  });
  it('rejects a response arriving after account switch', async () => {
    const client = privateClient({ data: [{ trade_id: 't', history }], error: null });
    let count = 0;
    await expect(hydrateOwnedTradeNoteHistories(client, [{ id: 't' }], 'a', 'a', () => ++count === 1)).rejects.toThrow('Účet');
  });
  it('allows old servers without the feature but surfaces a real private-read failure', async () => {
    expect(await hydrateOwnedTradeNoteHistories(privateClient({ error: { code: 'PGRST205' } }), [{ id: 't' }], 'a', 'a', () => true)).toEqual([{ id: 't' }]);
    await expect(hydrateOwnedTradeNoteHistories(privateClient({ error: { code: '500' } }), [{ id: 't' }], 'a', 'a', () => true)).rejects.toThrow('nepodařilo načíst');
  });
});

describe('AI note evidence', () => {
  it('preserves provenance, current heads, corrections and retrospective limitations', () => {
    const later = buildTradeNoteHistoryPatch({ before: 'reviewed plan', during: '', after: 'afterthought' }, history,
      { marketTime: 240, maxRevealedMarketTime: 240, entryMarketTime: 120, exitMarketTime: 180, closedTradeReview: true },
      { operationId: 'op2', clientCapturedAt: 2000 }).history;
    const evidence = tradeNoteAiEvidence(later)!;
    expect(evidence).toMatchObject({ revision: 3, currentHeadIds: { before: 'op2:before', after: 'op2:after' }, omittedRevisionCount: 0 });
    expect(formatTradeNoteHistoryForAI(later)).toContain('closed-trade-review');
    expect(formatTradeNoteHistoryForAI(later)).toContain('not server-attested');
    expect(formatTradeNoteHistoryForAI(later)).toContain('"current":false');
    expect(formatTradeNoteHistoryForAI(undefined)).toBe('');
  });
});

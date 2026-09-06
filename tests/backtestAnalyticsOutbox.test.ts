import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
import type { BacktestAnalyticsRefreshCandidate } from '../services/backtestAnalyticsRefresh';
const h = vi.hoisted(() => ({ owner: 'alice' as string | null, local: new Map<string, unknown>() }));
vi.mock('idb-keyval', () => ({
  get: async (key: string) => structuredClone(h.local.get(key)),
  update: async (key: string, fn: (previous: unknown) => unknown) => { h.local.set(key, structuredClone(fn(structuredClone(h.local.get(key))))); },
}));
vi.mock('../services/storageService', () => ({ getUserId: async () => h.owner }));
import { enqueueBacktestAnalytics, flushBacktestAnalytics, getPendingBacktestAnalytics } from '../services/backtestAnalyticsOutbox';
const trade = { id: 'trade-a', accountId: 'account-a', backtestRunId: 'run-a', notes: 'Manual note', tags: ['My setup'], ltfConfluence: ['Manual level', 'Old auto'], autoConfluence: { ltf: ['Old auto'], htf: [] } } as Trade;
const candidate = (hash = 'hash-a', horizon = 100): BacktestAnalyticsRefreshCandidate => ({
  tradeId: String(trade.id), runId: 'run-a', instrument: 'MNQ',
  recalculated: { ...trade, notes: 'Generated stale note', tags: [], ltfConfluence: ['New auto'], autoConfluence: { ltf: ['New auto'], htf: [] }, executionPathComplete: true },
  updates: {}, stamp: { version: 1, schemaVersion: 8, sourceHash: hash, horizonTime: horizon, lastCandleTime: horizon, complete: true },
});
const storage = () => ({
  prepareBacktestTradeReview: vi.fn(async () => ({ ownerId: 'alice', authVersion: 1, data: structuredClone(trade) })),
  updateBacktestTradeReview: vi.fn(async (_id: string, updates: Partial<Trade>) => updates),
});
beforeEach(() => { h.owner = 'alice'; h.local.clear(); });
describe('progressive analytics durable queue', () => {
  it('rebases against fresh review without overwriting notes or manually owned tags', async () => {
    const api = storage(); await enqueueBacktestAnalytics([candidate()], 'alice');
    const result = await flushBacktestAnalytics(api);
    expect(result.pendingCount).toBe(0);
    const patch = api.updateBacktestTradeReview.mock.calls[0][1];
    expect(patch).not.toHaveProperty('notes'); expect(patch).not.toHaveProperty('tags');
    expect(patch.ltfConfluence).toEqual(['Manual level', 'New auto']);
    expect(patch.backtestAnalyticsRefresh?.horizonTime).toBe(100);
  });
  it('retains work after failed preflight, offline commit or same-field conflict', async () => {
    const api = storage(); await enqueueBacktestAnalytics([candidate()], 'alice');
    api.prepareBacktestTradeReview.mockRejectedValueOnce(new Error('missing RPC'));
    expect((await flushBacktestAnalytics(api)).error).toContain('missing RPC');
    expect(api.updateBacktestTradeReview).not.toHaveBeenCalled();
    api.updateBacktestTradeReview.mockRejectedValueOnce(new Error('conflict'));
    expect((await flushBacktestAnalytics(api)).pendingCount).toBe(1);
    expect((await flushBacktestAnalytics(api)).pendingCount).toBe(0);
  });
  it('does not lose a newer horizon when an older request returns', async () => {
    const api = storage(); await enqueueBacktestAnalytics([candidate()], 'alice');
    api.updateBacktestTradeReview.mockImplementationOnce(async (_id, updates) => {
      await enqueueBacktestAnalytics([candidate('hash-b', 200)], 'alice'); return updates;
    });
    const first = await flushBacktestAnalytics(api);
    expect(first.pendingCount).toBe(1);
    expect((await getPendingBacktestAnalytics('alice'))[0].stamp.horizonTime).toBe(200);
    expect((await flushBacktestAnalytics(api)).pendingCount).toBe(0);
  });
  it('preserves account ownership across pending async calls', async () => {
    const api = storage(); await enqueueBacktestAnalytics([candidate()], 'alice');
    api.prepareBacktestTradeReview.mockImplementationOnce(async () => { h.owner = 'bob'; return { ownerId: 'alice', authVersion: 1, data: trade }; });
    await flushBacktestAnalytics(api);
    expect(api.updateBacktestTradeReview).not.toHaveBeenCalled();
    expect(await getPendingBacktestAnalytics('bob')).toEqual([]);
    h.owner = 'alice'; expect(await getPendingBacktestAnalytics('alice')).toHaveLength(1);
  });
  it('refuses mismatched run/account identity without dropping pending data', async () => {
    const api = storage(); await enqueueBacktestAnalytics([candidate()], 'alice');
    api.prepareBacktestTradeReview.mockResolvedValueOnce({ ownerId: 'alice', authVersion: 1, data: { ...trade, accountId: 'other' } });
    expect((await flushBacktestAnalytics(api)).pendingCount).toBe(1);
    expect(api.updateBacktestTradeReview).not.toHaveBeenCalled();
  });
  it('never downgrades a newer queued or server horizon', async () => {
    const api = storage(); await enqueueBacktestAnalytics([candidate('new', 200), candidate('old', 100)], 'alice');
    expect((await getPendingBacktestAnalytics('alice'))[0].stamp.horizonTime).toBe(200);
    api.prepareBacktestTradeReview.mockResolvedValueOnce({ ownerId: 'alice', authVersion: 1, data: { ...trade, backtestAnalyticsRefresh: candidate('newest', 300).stamp } });
    const result = await flushBacktestAnalytics(api);
    expect(result.pendingCount).toBe(0); expect(result.confirmed).toEqual([]);
    expect(api.updateBacktestTradeReview).not.toHaveBeenCalled();
  });
  it('rejects competing same-horizon data corrections without causal ancestry', async () => {
    const api = storage(); await enqueueBacktestAnalytics([candidate('source-a')], 'alice');
    api.prepareBacktestTradeReview.mockResolvedValueOnce({ ownerId: 'alice', authVersion: 1, data: { ...trade, backtestAnalyticsRefresh: candidate('source-b').stamp } });
    expect((await flushBacktestAnalytics(api)).error).toContain('jinou verzi dat');
    expect(api.updateBacktestTradeReview).not.toHaveBeenCalled();
  });
  it('coalesces concurrent flushes and rejects malformed enqueue', async () => {
    const api = storage(); await enqueueBacktestAnalytics([candidate()], 'alice');
    await Promise.all([flushBacktestAnalytics(api), flushBacktestAnalytics(api)]);
    expect(api.updateBacktestTradeReview).toHaveBeenCalledTimes(1);
    await expect(enqueueBacktestAnalytics([{ ...candidate(), runId: 'wrong' }], 'alice')).rejects.toThrow('identita');
  });
});

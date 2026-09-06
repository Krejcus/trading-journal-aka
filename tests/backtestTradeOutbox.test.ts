import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
const h = vi.hoisted(() => ({ userId: 'user-a' as string | null, local: new Map<string, any>(), failLocal: false }));
vi.mock('idb-keyval', () => ({
  get: async (key: string) => structuredClone(h.local.get(key)),
  update: async (key: string, fn: (previous: any) => any) => {
    if (h.failLocal) throw new Error('IndexedDB quota exceeded');
    h.local.set(key, structuredClone(fn(structuredClone(h.local.get(key)))));
  },
}));
vi.mock('../services/storageService', () => ({ getUserId: async () => h.userId }));

import {
  BacktestTradeOutboxError, enqueueBacktestTrade, flushBacktestTradeOutbox,
  getPendingBacktestTrades, reconcileBacktestClosedTrades,
  resolveBacktestClosedTradeDurability, getPendingBacktestTradeCount, BacktestTradeIdentityError,
  type BacktestTradeOutboxStorage,
} from '../services/backtestTradeOutbox';

const trade = (id: string = crypto.randomUUID(), notes = 'generated'): Trade => ({
  id, accountId: 'account-a', backtestRunId: 'run-a', instrument: 'MNQ', direction: 'Long',
  pnl: 100, date: '2026-01-01T10:00:00.000Z', entryDate: '2026-01-01T09:00:00.000Z',
  source: 'backtest-replay', notes,
} as Trade);
const storage = (): BacktestTradeOutboxStorage => ({
  findExistingIds: vi.fn(async () => []),
  saveTrades: vi.fn(async items => items),
});

describe('identity-only closed trade preflight', () => {
  const key = 'alphatrade:backtest-trade-outbox:user-a:v1';
  const identity = (item: Trade) => ({ tradeId: String(item.id), runId: item.backtestRunId!, accountId: item.accountId, instrument: item.instrument });
  const request = (items: Trade[]) => ({ ownerId: 'user-a', runId: 'run-a', accountId: 'account-a', identities: items.map(identity) });

  it('finds durable pending and acknowledged IDs without server reads or replacing their snapshot', async () => {
    const queued = trade(), acknowledged = trade();
    await enqueueBacktestTrade(acknowledged);
    await flushBacktestTradeOutbox(storage());
    const count = await enqueueBacktestTrade(queued);
    expect(count).toEqual({ pendingCount: 1, durability: 'pending' });
    expect(await getPendingBacktestTradeCount('user-a')).toBe(1);
    const lookup = vi.fn(async () => []);
    const result = await resolveBacktestClosedTradeDurability(request([queued, acknowledged]), lookup);
    expect([...result.durableIds].sort()).toEqual([queued.id, acknowledged.id].sort());
    expect(lookup).not.toHaveBeenCalled();
    expect(await getPendingBacktestTrades()).toEqual([queued]);
    expect(h.local.get(key).acknowledged[acknowledged.id]).toMatchObject(identity(acknowledged));
  });

  it('keeps legacy owner UUID receipts after a deliberate journal deletion', async () => {
    const item = trade();
    h.local.set(key, { pending: {}, acknowledged: { [item.id]: 1 } });
    const lookup = vi.fn(async () => []);
    const result = await resolveBacktestClosedTradeDurability(request([item]), lookup);
    expect(result.durableIds.has(String(item.id))).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(h.local.get(key).acknowledged[item.id]).toBe(1);
  });

  it('checks unknown identities in batches and persists authoritative receipts before returning', async () => {
    const items = Array.from({ length: 205 }, () => trade());
    const calls: number[] = [];
    const result = await resolveBacktestClosedTradeDurability(request(items), async (ids, owner) => {
      expect(owner).toBe('user-a'); calls.push(ids.length); return ids;
    });
    expect(calls).toEqual([100, 100, 5]);
    expect(result.durableIds.size).toBe(205);
    expect(Object.keys(h.local.get(key).acknowledged)).toHaveLength(205);
    expect(await getPendingBacktestTrades()).toEqual([]);
    expect(await enqueueBacktestTrade(items[0])).toEqual({ pendingCount: 0, durability: 'acknowledged' });
  });

  it('does not treat lookup failure, missing or partial server results as a receipt', async () => {
    const items = [trade(), trade()];
    const partial = await resolveBacktestClosedTradeDurability(request(items), async () => [identity(items[0])]);
    expect([...partial.durableIds]).toEqual([items[0].id]);
    const offline = await resolveBacktestClosedTradeDurability(request(items), async () => { throw new Error('offline'); });
    expect([...offline.durableIds]).toEqual([items[0].id]);
    expect(offline.lookupError).toBe('offline');
    await enqueueBacktestTrade(items[1]);
    expect(await getPendingBacktestTrades()).toEqual([items[1]]);
  });

  it('rejects wrong run/account/instrument identities and unsolicited server IDs without writing receipts', async () => {
    const item = trade();
    for (const wrong of [{ ...identity(item), runId: 'other-run' }, { ...identity(item), accountId: 'other-account' },
      { ...identity(item), instrument: 'NQ' }, identity(trade())]) {
      await expect(resolveBacktestClosedTradeDurability(request([item]), async () => [wrong])).rejects.toThrow('identit');
      expect(h.local.get(key)).toBeUndefined();
    }
    await expect(resolveBacktestClosedTradeDurability({ ...request([item]), accountId: 'other' })).rejects.toThrow('účtu');
  });

  it('does not downgrade an authoritative identity conflict to an offline fallback', async () => {
    const item = trade();
    await expect(resolveBacktestClosedTradeDurability(request([item]), async () => {
      throw new BacktestTradeIdentityError('identity collision');
    })).rejects.toThrow('identity collision');
    expect(h.local.get(key)).toBeUndefined();
  });

  it('refuses a raced local identity collision even if the server lookup succeeded', async () => {
    const item = trade();
    await expect(resolveBacktestClosedTradeDurability(request([item]), async ids => {
      await enqueueBacktestTrade({ ...item, accountId: 'other-account' }); return ids;
    })).rejects.toThrow('účtu');
    expect(h.local.get(key).acknowledged).toEqual({});
    expect((await getPendingBacktestTrades())[0].accountId).toBe('other-account');
  });

  it('never returns a cloud receipt when its IndexedDB write fails', async () => {
    const item = trade(); h.failLocal = true;
    await expect(resolveBacktestClosedTradeDurability(request([item]), async ids => ids)).rejects.toThrow('quota');
    expect(h.local.get(key)).toBeUndefined();
  });

  it('cancels stale generations, including A -> B -> A, before receipts become durable', async () => {
    const item = trade(); let generation = 1;
    await expect(resolveBacktestClosedTradeDurability({ ...request([item]), isCurrent: () => generation === 1 }, async ids => {
      generation = 3; return ids;
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.local.get(key)).toBeUndefined();
    await expect(resolveBacktestClosedTradeDurability(request([item]), async ids => { h.userId = 'user-b'; return ids; })).rejects.toThrow('uživatel se změnil');
    expect(h.local.get(key)).toBeUndefined();
  });

  it('rejects aborted and malformed local reads instead of silently assuming an empty queue', async () => {
    const item = trade(); const controller = new AbortController(); controller.abort();
    await expect(resolveBacktestClosedTradeDurability({ ...request([item]), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    h.local.set(key, { pending: null, acknowledged: {} });
    await expect(resolveBacktestClosedTradeDurability(request([item]))).rejects.toThrow('nelze přečíst');
    expect(h.local.get(key).pending).toBeNull();
  });
});
beforeEach(() => { h.userId = 'user-a'; h.local.clear(); h.failLocal = false; });

describe('durable closed-trade outbox', () => {
  it('queues the full immutable trade and coalesces duplicate enqueue attempts', async () => {
    const item = trade();
    await Promise.all([enqueueBacktestTrade(item), enqueueBacktestTrade({ ...item, notes: 'stale overwrite' })]);
    item.notes = 'later mutation';
    expect(await getPendingBacktestTrades()).toEqual([{ ...item, notes: 'generated' }]);
  });

  it('does not acknowledge a local storage failure or accept unstable IDs', async () => {
    h.failLocal = true;
    await expect(enqueueBacktestTrade(trade())).rejects.toThrow('quota');
    h.failLocal = false;
    await expect(enqueueBacktestTrade(trade('temporary-id'))).rejects.toThrow('stabilní ID');
    expect(await getPendingBacktestTrades()).toEqual([]);
  });

  it('keeps failed writes durable for retry and acknowledges only successful persistence', async () => {
    const item = trade(); await enqueueBacktestTrade(item);
    const api = storage(); api.saveTrades = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([item]);
    await expect(flushBacktestTradeOutbox(api)).rejects.toThrow('offline');
    expect(await getPendingBacktestTrades()).toEqual([item]);
    expect(await flushBacktestTradeOutbox(api)).toEqual({ savedTrades: [item], acknowledgedIds: [item.id], pendingCount: 0 });
    expect(await getPendingBacktestTrades()).toEqual([]);
    expect(api.saveTrades).toHaveBeenCalledTimes(2);
  });

  it('treats an empty server return as failure rather than dropping the trade', async () => {
    const item = trade(); await enqueueBacktestTrade(item);
    const api = storage(); api.saveTrades = vi.fn(async () => []);
    const result = await flushBacktestTradeOutbox(api).catch(error => error as BacktestTradeOutboxError);
    expect(result).toBeInstanceOf(BacktestTradeOutboxError);
    expect((result as BacktestTradeOutboxError).result.pendingCount).toBe(1);
    expect(await getPendingBacktestTrades()).toEqual([item]);
  });

  it('acknowledges only returned IDs after a partial save', async () => {
    const first = trade(), second = trade();
    await enqueueBacktestTrade(first); await enqueueBacktestTrade(second);
    const api = storage(); api.saveTrades = vi.fn(async () => [first]);
    const error = await flushBacktestTradeOutbox(api).catch(error => error as BacktestTradeOutboxError);
    expect((error as BacktestTradeOutboxError).result).toEqual({ savedTrades: [first], acknowledgedIds: [first.id], pendingCount: 1 });
    expect(await getPendingBacktestTrades()).toEqual([second]);
  });

  it('checks server IDs before retry so uncertain success cannot overwrite a later review', async () => {
    const item = trade(); await enqueueBacktestTrade(item);
    const api = storage(); let serverHasTrade = false;
    api.findExistingIds = vi.fn(async () => serverHasTrade ? [String(item.id)] : []);
    api.saveTrades = vi.fn(async () => { serverHasTrade = true; throw new Error('response lost'); });
    await expect(flushBacktestTradeOutbox(api)).rejects.toThrow('response lost');
    // The server row can now contain user edits made in another tab.
    const retried = await flushBacktestTradeOutbox(api);
    expect(retried).toEqual({ savedTrades: [], acknowledgedIds: [item.id], pendingCount: 0 });
    expect(api.saveTrades).toHaveBeenCalledTimes(1);
  });

  it('does not write when the existence lookup failed', async () => {
    const item = trade(); await enqueueBacktestTrade(item);
    const api = storage(); api.findExistingIds = vi.fn(async () => { throw new Error('read offline'); });
    await expect(flushBacktestTradeOutbox(api)).rejects.toThrow('read offline');
    expect(api.saveTrades).not.toHaveBeenCalled();
    expect(await getPendingBacktestTrades()).toEqual([item]);
  });

  it('acknowledges an insert-only conflict only after a second server lookup', async () => {
    const item = trade(); await enqueueBacktestTrade(item);
    const api = storage();
    api.findExistingIds = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([String(item.id)]);
    api.saveTrades = vi.fn(async () => []);
    expect(await flushBacktestTradeOutbox(api)).toEqual({ savedTrades: [], acknowledgedIds: [item.id], pendingCount: 0 });
    expect(api.findExistingIds).toHaveBeenCalledTimes(2);
  });

  it('reconciles missed closes after reload and does not resurrect acknowledged deletions', async () => {
    const missed = trade(), persisted = trade();
    await reconcileBacktestClosedTrades([missed, persisted], new Set([String(persisted.id)]), 'user-a');
    expect(await getPendingBacktestTrades()).toEqual([missed]);
    await flushBacktestTradeOutbox(storage());
    // Confirmed IDs may disappear because the user deliberately deleted a trade.
    await reconcileBacktestClosedTrades([missed, persisted], new Set(), 'user-a');
    expect(await getPendingBacktestTrades()).toEqual([]);
  });

  it('coalesces concurrent retry triggers without duplicate persistence', async () => {
    const item = trade(); await enqueueBacktestTrade(item);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const api = storage(); api.findExistingIds = vi.fn(async () => { await gate; return []; });
    const first = flushBacktestTradeOutbox(api), second = flushBacktestTradeOutbox(api);
    await Promise.resolve(); release();
    expect(await first).toEqual(await second);
    expect(api.saveTrades).toHaveBeenCalledTimes(1);
  });

  it('preserves a newly enqueued trade while an older batch is being acknowledged', async () => {
    const first = trade(), second = trade(); await enqueueBacktestTrade(first);
    const api = storage(); api.saveTrades = vi.fn(async items => { await enqueueBacktestTrade(second); return items; });
    expect((await flushBacktestTradeOutbox(api)).pendingCount).toBe(1);
    expect(await getPendingBacktestTrades()).toEqual([second]);
  });

  it('isolates both pending data and receipts across user switches', async () => {
    const item = trade(); await enqueueBacktestTrade(item, 'user-a');
    h.userId = 'user-b';
    expect(await getPendingBacktestTrades()).toEqual([]);
    await expect(enqueueBacktestTrade(trade(), 'user-a')).rejects.toThrow('uživatel se změnil');
    const api = storage(); await flushBacktestTradeOutbox(api); expect(api.saveTrades).not.toHaveBeenCalled();
    h.userId = 'user-a'; expect(await getPendingBacktestTrades()).toEqual([item]);
    h.userId = null; expect(await getPendingBacktestTrades()).toEqual([]);
  });

  it('aborts before writing when auth changes during existence lookup', async () => {
    const item = trade(); await enqueueBacktestTrade(item);
    const api = storage(); api.findExistingIds = vi.fn(async () => { h.userId = 'user-b'; return []; });
    await expect(flushBacktestTradeOutbox(api)).rejects.toThrow('uživatel se změnil');
    expect(api.saveTrades).not.toHaveBeenCalled();
    h.userId = 'user-a'; expect(await getPendingBacktestTrades()).toEqual([item]);
  });

  it('keeps the original owner pending after auth changes during an uncertain write', async () => {
    const item = trade(); await enqueueBacktestTrade(item);
    const api = storage(); api.saveTrades = vi.fn(async items => { h.userId = 'user-b'; return items; });
    await expect(flushBacktestTradeOutbox(api)).rejects.toThrow('uživatel se změnil');
    expect(await getPendingBacktestTrades()).toEqual([]);
    h.userId = 'user-a'; expect(await getPendingBacktestTrades()).toEqual([item]);
  });
});

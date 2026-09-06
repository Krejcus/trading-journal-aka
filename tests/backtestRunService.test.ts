import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  userId: 'user-a' as string | null,
  local: new Map<string, any>(),
  rows: new Map<string, Map<string, any>>(),
  calls: [] as Array<{ table: string; op: string; payload?: any }>,
  errors: new Map<string, any>(),
  commitThenFail: false,
  authReadCount: 0, switchAuthOnRead: null as number | null,
}));

vi.mock('idb-keyval', () => ({
  get: async (key: string) => structuredClone(h.local.get(key)),
  set: async (key: string, value: unknown) => { h.local.set(key, structuredClone(value)); },
  del: async (key: string) => { h.local.delete(key); },
  update: async (key: string, fn: (previous: any) => any) => {
    // One indivisible read-modify-write, matching idb-keyval's transaction.
    h.local.set(key, structuredClone(fn(structuredClone(h.local.get(key)))));
  },
}));
vi.mock('../services/storageService', () => ({ getUserId: async () => {
  h.authReadCount += 1;
  if (h.authReadCount === h.switchAuthOnRead) h.userId = 'user-b';
  return h.userId;
} }));
vi.mock('../services/supabase', () => ({ supabase: { from: (table: string) => {
  const q = {
    op: 'select', payload: undefined as any, filters: [] as Array<[string, any]>,
    select() { return this; }, order() { return this; },
    eq(key: string, value: any) { this.filters.push([key, value]); return this; },
    in(key: string, values: any[]) { this.filters.push([key, values]); return this; },
    insert(payload: any) { this.op = 'insert'; this.payload = payload; return this; },
    update(payload: any) { this.op = 'update'; this.payload = payload; return this; },
    upsert(payload: any) { this.op = 'upsert'; this.payload = payload; return this; },
    delete() { this.op = 'delete'; return this; },
    execute(single = false) {
      h.calls.push({ table, op: this.op, payload: structuredClone(this.payload) });
      const error = h.errors.get(`${table}:${this.op}`);
      if (error) return { data: null, error };
      const rows = h.rows.get(table) ?? new Map();
      h.rows.set(table, rows);
      let data = [...rows.values()].filter(row => row.user_id === h.userId && this.filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
      if (this.op === 'insert') {
        if (rows.has(this.payload.id)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        rows.set(this.payload.id, structuredClone(this.payload)); data = [this.payload];
      }
      if (this.op === 'update') {
        data = data.map(row => { rows.set(row.id, structuredClone(this.payload)); return this.payload; });
        if (h.commitThenFail) { h.commitThenFail = false; return { data: null, error: { code: '08006', message: 'response lost after commit' } }; }
      }
      if (this.op === 'upsert') {
        data = Array.isArray(this.payload) ? this.payload : [this.payload];
        data.forEach(row => rows.set(row.id, structuredClone(row)));
      }
      if (this.op === 'delete') data.forEach(row => rows.delete(row.id));
      return { data: structuredClone(single ? data[0] ?? null : data), error: null };
    },
    single() { return Promise.resolve(this.execute(true)); },
    maybeSingle() { return Promise.resolve(this.execute(true)); },
    then(resolve: any, reject: any) { return Promise.resolve(this.execute()).then(resolve, reject); },
  };
  return q;
} } }));

import {
  BacktestRunConflictError, BacktestRunSyncError, createBacktestLedgerCursor, createBacktestRun,
  getBacktestCloudRevision, listBacktestRunConflictCopies, listBacktestRuns,
  loadBacktestRunFromCloud, saveBacktestRunLocal, syncBacktestRunToCloud, withBacktestCloudRevision,
} from '../services/backtestRunService';
import { cancelBacktestOrder, createBacktestOrder, enqueueBacktestOrder } from '../services/backtestEngine';

const input = { accountId: 'account-a', name: 'Research A', initialCapital: 10000, startAt: Date.UTC(2026, 0, 1), endAt: Date.UTC(2026, 0, 2) };
const table = (name = 'backtest_runs') => h.rows.get(name)!;
const localKey = (id: string, user = 'user-a') => `alphatrade:backtest-run:${user}:${id}:v2`;
const error = { code: '08006', message: 'network unavailable' };

beforeEach(() => {
  h.userId = 'user-a'; h.local.clear(); h.rows.clear(); h.calls = []; h.errors.clear(); h.commitThenFail = false;
  h.authReadCount = 0; h.switchAuthOnRead = null;
});

describe('owned local backtest storage', () => {
  it('retains every ID during parallel hydration and subsequent offline reads', async () => {
    await createBacktestRun(input); await createBacktestRun(input); await createBacktestRun(input);
    h.local.clear();
    expect(await listBacktestRuns()).toHaveLength(3);
    h.errors.set('backtest_runs:select', error);
    expect(await listBacktestRuns()).toHaveLength(3);
    expect(h.local.get('alphatrade:backtest-runs:user-a:index:v2')).toHaveLength(3);
  });

  it('never exposes another user or signed-out user to cached runs', async () => {
    const run = await createBacktestRun(input);
    h.userId = 'user-b'; expect(await listBacktestRuns()).toEqual([]);
    await expect(saveBacktestRunLocal(run, { name: 'stolen' })).rejects.toThrow('nepatří');
    h.userId = null; expect(await listBacktestRuns()).toEqual([]);
    expect(h.local.get(localKey(run.id)).name).toBe(input.name);
  });

  it('migrates legacy blobs only after cloud/account ownership proof and preserves originals', async () => {
    const run = await createBacktestRun(input);
    const legacy = { ...run }; delete (legacy as any).persistence;
    const unknown = { ...legacy, id: 'foreign', accountId: 'account-b' };
    const ownedOffline = { ...legacy, id: 'offline-owned', accountId: 'account-a' };
    h.local.clear();
    h.local.set('alphatrade:backtest-runs:index:v1', [run.id, unknown.id, ownedOffline.id]);
    for (const item of [legacy, unknown, ownedOffline]) h.local.set(`alphatrade:backtest-run:${item.id}:v1`, item);
    h.rows.set('accounts', new Map([['account-a', { id: 'account-a', user_id: 'user-a' }]]));
    const restored = await listBacktestRuns();
    expect(restored.map(item => item.id).sort()).toEqual([run.id, ownedOffline.id].sort());
    expect(h.local.has('alphatrade:backtest-run:foreign:v1')).toBe(true);
    expect(h.local.has(`alphatrade:backtest-run:${run.id}:v1`)).toBe(true);
    // Missing legacy cloud rows may have been deliberately deleted. Never
    // invent a new cloud row from this unknown baseline.
    const offline = restored.find(item => item.id === ownedOffline.id)!;
    await expect(syncBacktestRunToCloud(offline, getBacktestCloudRevision(offline))).rejects.toBeInstanceOf(BacktestRunConflictError);
    expect(table().has(ownedOffline.id)).toBe(false);
  });

  it('keeps unverified legacy data hidden and untouched when ownership reads fail', async () => {
    const run = await createBacktestRun(input); h.local.clear(); table().clear();
    h.local.set('alphatrade:backtest-runs:index:v1', [run.id]);
    h.local.set(`alphatrade:backtest-run:${run.id}:v1`, run);
    h.errors.set('accounts:select', error);
    expect(await listBacktestRuns()).toEqual([]);
    expect(h.local.get(`alphatrade:backtest-run:${run.id}:v1`)).toEqual(run);
  });

  it('does not return user A cloud results after a mid-request switch to B', async () => {
    await createBacktestRun(input);
    h.authReadCount = 0; h.switchAuthOnRead = 2;
    expect(await listBacktestRuns()).toEqual([]);
    expect(h.userId).toBe('user-b');
  });
});

describe('cloud checkpoint conflict and recovery', () => {
  it('keeps the last confirmed cloud baseline separate from local revisions', async () => {
    const run = await createBacktestRun(input);
    const next = await saveBacktestRunLocal(run, { name: 'local edit' });
    expect(next.revision).toBe(1); expect(getBacktestCloudRevision(next)).toBe(0);
    const saved = await syncBacktestRunToCloud(next, getBacktestCloudRevision(next));
    expect(getBacktestCloudRevision(saved)).toBe(1);
  });

  it('never overwrites a divergent cloud revision, even after listing sessions', async () => {
    const run = await createBacktestRun(input);
    const next = await saveBacktestRunLocal(run, { name: 'my unsynced branch' });
    table().set(run.id, { ...table().get(run.id), revision: 10, name: 'other tab' });
    const listed = (await listBacktestRuns())[0];
    expect(listed.name).toBe(next.name);
    await expect(syncBacktestRunToCloud(listed, getBacktestCloudRevision(listed))).rejects.toBeInstanceOf(BacktestRunConflictError);
    expect(table().get(run.id).revision).toBe(10);
    expect(table().get(run.id).name).toBe('other tab');
    expect(h.local.get(localKey(run.id)).name).toBe(next.name);
    expect(h.calls.filter(call => call.table === 'backtest_runs' && call.op === 'upsert')).toHaveLength(0);
  });

  it('does not resurrect a previously synced row that was deleted remotely', async () => {
    const run = await createBacktestRun(input); table().delete(run.id);
    const next = await saveBacktestRunLocal(run, { name: 'local' });
    await expect(syncBacktestRunToCloud(next, 0)).rejects.toBeInstanceOf(BacktestRunConflictError);
    expect(table().has(run.id)).toBe(false);
    expect(h.local.has(localKey(run.id))).toBe(true);
  });

  it('archives the full local branch before explicit remote reload, with user-scoped export', async () => {
    const run = await createBacktestRun(input);
    const local = await saveBacktestRunLocal(run, { name: 'my local' });
    table().set(run.id, { ...table().get(run.id), name: 'cloud', revision: 4 });
    const remote = await loadBacktestRunFromCloud(run.id);
    expect(remote.name).toBe('cloud'); expect(getBacktestCloudRevision(remote)).toBe(4);
    const copies = await listBacktestRunConflictCopies(run.id);
    expect(copies).toHaveLength(1); expect(copies[0].run).toEqual(local);
    h.userId = 'user-b'; expect(await listBacktestRunConflictCopies()).toEqual([]);
  });

  it('does not return or install a conflict resolution after switching users mid-request', async () => {
    const run = await createBacktestRun(input);
    const local = await saveBacktestRunLocal(run, { name: 'my local' });
    table().set(run.id, { ...table().get(run.id), name: 'cloud', revision: 4 });
    h.authReadCount = 0; h.switchAuthOnRead = 2;
    await expect(loadBacktestRunFromCloud(run.id)).rejects.toThrow('nepatří');
    expect(h.local.get(localKey(run.id))).toEqual(local);
    expect(await listBacktestRunConflictCopies()).toEqual([]);
    h.switchAuthOnRead = null; h.userId = 'user-a';
    expect((await listBacktestRunConflictCopies())[0].run).toEqual(local);
  });

  it('surfaces a network failure and allows a later retry', async () => {
    const run = await createBacktestRun(input);
    const next = await saveBacktestRunLocal(run, { name: 'edited' });
    h.errors.set('backtest_runs:update', error);
    await expect(syncBacktestRunToCloud(next, 0)).rejects.toThrow('network unavailable');
    expect(table().get(run.id).revision).toBe(0);
    h.errors.clear();
    expect((await syncBacktestRunToCloud(next, 0)).revision).toBe(1);
  });

  it('does not permanently disable sync after missing-table or validation errors', async () => {
    const run = await createBacktestRun(input);
    const next = await saveBacktestRunLocal(run, { name: 'edited' });
    h.errors.set('backtest_runs:update', { code: '42P01', message: 'backtest_runs does not exist' });
    await expect(syncBacktestRunToCloud(next, 0)).rejects.toThrow('does not exist');
    h.errors.clear(); expect((await syncBacktestRunToCloud(next, 0)).revision).toBe(1);
    await expect(createBacktestRun({ ...input, name: 'x'.repeat(121) })).rejects.toThrow('1–120');
  });

  it('retains a failed new run locally and retries only with insert', async () => {
    h.errors.set('backtest_runs:insert', error);
    await expect(createBacktestRun(input)).rejects.toThrow('network unavailable');
    h.errors.clear(); const run = (await listBacktestRuns())[0];
    expect(getBacktestCloudRevision(run)).toBeNull();
    expect((await syncBacktestRunToCloud(run, null)).id).toBe(run.id);
    expect(table().has(run.id)).toBe(true);
  });

  it('reconciles an uncertain update only if the remote payload is identical', async () => {
    const run = await createBacktestRun(input);
    const next = await saveBacktestRunLocal(run, { name: 'edited' });
    h.commitThenFail = true;
    const saved = await syncBacktestRunToCloud(next, 0);
    expect(saved.revision).toBe(1);
    expect(getBacktestCloudRevision(saved)).toBe(1);
  });

  it('rejects an old-user run before any cloud write after switching accounts', async () => {
    const run = await createBacktestRun(input); h.userId = 'user-b'; h.calls = [];
    await expect(syncBacktestRunToCloud(run, 0)).rejects.toThrow('nepatří');
    expect(h.calls).toEqual([]);
  });
});

describe('incremental financial ledger', () => {
  it('syncs an order edit on the same replay timestamp', async () => {
    const run = await createBacktestRun(input);
    const order = createBacktestOrder({ runId: run.id, instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1, limitPrice: 99, now: 1000 });
    const opened = await saveBacktestRunLocal(run, { runtimeState: enqueueBacktestOrder(run.runtimeState, order) });
    const cursor = createBacktestLedgerCursor();
    const saved = await syncBacktestRunToCloud(opened, 0, cursor);
    const cancelled = await saveBacktestRunLocal(saved, { runtimeState: cancelBacktestOrder(saved.runtimeState, order.id, 1000) });
    await syncBacktestRunToCloud(cancelled, 1, cursor);
    expect(table('backtest_orders').get(order.id).status).toBe('cancelled');
    expect(cancelled.runtimeState.orders[0].updatedAt).toBe(order.updatedAt);
  });

  it('retries ledger failure after the run snapshot committed without overwriting a newer branch', async () => {
    const run = await createBacktestRun(input);
    const order = createBacktestOrder({ runId: run.id, instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1, limitPrice: 99, now: 1000 });
    const next = await saveBacktestRunLocal(run, { runtimeState: enqueueBacktestOrder(run.runtimeState, order) });
    const cursor = createBacktestLedgerCursor();
    h.errors.set('backtest_orders:upsert', error);
    await expect(syncBacktestRunToCloud(next, 0, cursor)).rejects.toThrow('network unavailable');
    expect(table().get(run.id).revision).toBe(1); expect(cursor.orderStamps.size).toBe(0);
    h.errors.clear();
    expect((await syncBacktestRunToCloud(next, 0, cursor)).revision).toBe(1);
    expect(table('backtest_orders').get(order.id).status).toBe('pending');
    table().set(run.id, { ...table().get(run.id), name: 'different snapshot', revision: 2 });
    await expect(syncBacktestRunToCloud(next, 0, cursor)).rejects.toBeInstanceOf(BacktestRunConflictError);
    expect(table().get(run.id).revision).toBe(2);
  });

  it('carries a committed snapshot baseline through ledger failure and subsequent local edits', async () => {
    const run = await createBacktestRun(input);
    const order = createBacktestOrder({ runId: run.id, instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1, limitPrice: 99, now: 1000 });
    const next = await saveBacktestRunLocal(run, { runtimeState: enqueueBacktestOrder(run.runtimeState, order) });
    h.errors.set('backtest_orders:upsert', error);
    const failed = await syncBacktestRunToCloud(next, 0).catch(reason => reason as BacktestRunSyncError);
    expect(failed).toBeInstanceOf(BacktestRunSyncError);
    const confirmed = (failed as BacktestRunSyncError).confirmedRun;
    expect(getBacktestCloudRevision(confirmed)).toBe(1);
    const edited = await saveBacktestRunLocal(withBacktestCloudRevision(next, confirmed.revision), { name: 'edit during ledger failure' });
    expect(edited.revision).toBe(2); expect(getBacktestCloudRevision(edited)).toBe(1);
    h.errors.clear();
    const restored = (await listBacktestRuns())[0];
    expect(getBacktestCloudRevision(restored)).toBe(1);
    expect((await syncBacktestRunToCloud(restored, getBacktestCloudRevision(restored))).revision).toBe(2);
  });
});

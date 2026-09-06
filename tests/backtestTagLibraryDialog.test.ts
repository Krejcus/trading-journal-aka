import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Account, Trade } from '../types';
vi.mock('../services/supabase', () => ({ supabase: { auth: { onAuthStateChange: vi.fn() } } }));
vi.mock('../services/storageService', () => ({ getUserId: vi.fn(), storageService: { getTradesWithDataByAccounts: vi.fn() } }));
vi.mock('../services/backtestTagLibraryPersistence', async importOriginal => ({ ...await importOriginal<typeof import('../services/backtestTagLibraryPersistence')>(), loadBacktestTagLibrary: vi.fn(), commitBacktestTagLibrary: vi.fn() }));
import BacktestTagLibraryDialog, { backtestTagAccountIds, BacktestTagLibraryLoadStatus, createBacktestTagDialogController, type BacktestTagDialogDependencies } from '../components/BacktestTagLibraryDialog';
import BacktestTagManager, { assertBacktestTagDraftCurrent, captureBacktestTagCommitAttempt } from '../components/BacktestTagManager';
import { BacktestTagPersistenceError, createBacktestTagLibraryPersistence } from '../services/backtestTagLibraryPersistence';
import { createBacktestTagLibrary, prepareBacktestTagLibraryChange, previewBacktestTagMerge } from '../services/backtestTagLibrary';

const ownerId = 'owner-a';
const empty = createBacktestTagLibrary(ownerId);
const source = prepareBacktestTagLibraryChange(empty, { type: 'create', tag: { id: 'source', label: 'Old', category: 'setup' } }, { ownerId, expectedRevision: 0, operationId: 'source' }).library;
const library = prepareBacktestTagLibraryChange(source, { type: 'create', tag: { id: 'target', label: 'New', category: 'context' } }, { ownerId, expectedRevision: 1, operationId: 'target' }).library;
const trades = [{ id: 'trade', accountId: 'backtest', backtestRunId: 'run', tags: ['Old'], notes: 'Preserve review', autoConfluence: { htf: ['Auto'], ltf: [] } } as Trade];
const makePlan = () => previewBacktestTagMerge(library, trades, { ownerId, expectedRevision: 2, operationId: 'merge-operation', sourceId: 'source', targetId: 'target', scope: { tradeIds: ['trade'], fields: ['tags'] } });
const receipt = () => { const plan = makePlan(); return { library: plan.library, operationId: plan.operationId, alreadyApplied: false, tradePatches: [{ tradeId: 'trade', updates: { tags: ['New'] } }] }; };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  let currentOwner: string | null = ownerId;
  let ownerListener: ((id: string | null) => void) | undefined;
  const deps = {
    getOwnerId: vi.fn(async () => currentOwner),
    onLibraryChanged: vi.fn(),
    onLibraryError: vi.fn(),
    subscribeOwner: vi.fn((listener: (id: string | null) => void) => { ownerListener = listener; return () => { ownerListener = undefined; }; }),
    loadLibrary: vi.fn(async () => structuredClone(library)),
    loadTrades: vi.fn<BacktestTagDialogDependencies['loadTrades']>(async () => structuredClone(trades)),
    commitPlan: vi.fn<BacktestTagDialogDependencies['commitPlan']>(async () => receipt()),
  };
  return { deps, controller: createBacktestTagDialogController(ownerId, deps), switchOwner: (id: string | null) => { currentOwner = id; ownerListener?.(id); } };
}

describe('owner-bound tag dialog loading and refresh', () => {
  it('selects explicit backtest accounts including archived history, never Live or Paper', () => {
    const accounts = [{ id: 'live', type: 'Live' }, { id: 'paper', type: 'Paper' }, { id: 'z', type: 'Backtest', status: 'Archived' }, { id: 'a', type: 'Backtest' }, { id: 'a', type: 'Backtest' }] as Account[];
    expect(backtestTagAccountIds(accounts)).toEqual(['a', 'z']);
  });

  it('loads each prerequisite separately with an owner-bound strict request and keeps full rows', async () => {
    const { deps, controller } = fixture();
    const waiting = deferred<typeof library>();
    deps.loadLibrary.mockReturnValueOnce(waiting.promise);
    const load = controller.start(['backtest']);
    await tick(); await tick();
    expect(controller.getSnapshot()).toMatchObject({ libraryLoading: true, tradesLoading: false, trades });
    expect(deps.loadTrades).toHaveBeenCalledWith(['backtest'], ownerId, expect.objectContaining({ strict: true, expectedOwnerId: ownerId, signal: expect.any(AbortSignal), onProgress: expect.any(Function) }));
    waiting.resolve(library); await load;
    expect(controller.getSnapshot()).toMatchObject({ library, trades, libraryLoading: false, tradesLoading: false, loadedRows: 1 });
  });

  it('never treats a rejected catalog or trade read as an empty successful prerequisite', async () => {
    const { deps, controller } = fixture();
    deps.loadLibrary.mockRejectedValueOnce(new Error('RPC unavailable'));
    deps.loadTrades.mockRejectedValueOnce(new Error('page 2 failed'));
    await controller.start(['backtest']);
    expect(controller.getSnapshot()).toMatchObject({ libraryError: 'RPC unavailable', tradesError: 'page 2 failed' });
    expect(controller.getSnapshot().library).toBeUndefined();
    expect(controller.getSnapshot().trades).toBeUndefined();
    await expect(controller.commit(makePlan())).rejects.toThrow(/Nejdřív/);
    expect(deps.commitPlan).not.toHaveBeenCalled();
  });

  it('keeps confirmed data and the same preview on refresh failure, then rejects a stale preview after successful refresh', async () => {
    const { deps, controller } = fixture();
    await controller.start(['backtest']);
    const capturedTrades = controller.getSnapshot().trades;
    const plan = makePlan(), savedPlan = structuredClone(plan);
    deps.loadTrades.mockRejectedValueOnce(new Error('offline'));
    await controller.refresh();
    expect(controller.getSnapshot().trades).toBe(capturedTrades);
    await expect(controller.commit(plan)).rejects.toThrow(/Nejdřív/);
    deps.loadTrades.mockResolvedValueOnce([{ ...trades[0], tags: ['Changed elsewhere'] }]);
    await controller.refresh();
    await expect(controller.commit(plan)).rejects.toThrow();
    expect(plan).toEqual(savedPlan);
    expect(deps.commitPlan).not.toHaveBeenCalled();
  });

  it('supports authoritative empty account scopes without an unscoped trade query', async () => {
    const { deps, controller } = fixture();
    await controller.start([]);
    expect(controller.getSnapshot().trades).toEqual([]);
    expect(deps.loadLibrary).toHaveBeenCalledTimes(1);
    expect(deps.loadTrades).not.toHaveBeenCalled();
  });

  it('aborts old reads and discards their data and progress after refresh/unmount, and can restart in StrictMode', async () => {
    const { deps, controller } = fixture();
    const waiting = deferred<Trade[]>();
    deps.loadTrades.mockReturnValueOnce(waiting.promise);
    const first = controller.start(['backtest']); await tick();
    const options = deps.loadTrades.mock.calls[0][2];
    options.onProgress(1000);
    expect(controller.getSnapshot().loadedRows).toBe(1000);
    controller.stop();
    expect(options.signal.aborted).toBe(true);
    await controller.start(['backtest']);
    options.onProgress(9999); waiting.resolve([{ ...trades[0], tags: ['STALE'] }]); await first;
    expect(controller.getSnapshot()).toMatchObject({ loadedRows: 1, trades });
    controller.stop();
    await expect(controller.commit(makePlan())).rejects.toThrow(/Nejdřív/);
  });

  it('discards responses through owner A→B→A even when the original RPC later succeeds', async () => {
    const { deps, controller, switchOwner } = fixture();
    const waiting = deferred<Trade[]>(); deps.loadTrades.mockReturnValueOnce(waiting.promise);
    const first = controller.start(['backtest']); await tick();
    switchOwner('owner-b'); switchOwner(ownerId);
    waiting.resolve(trades); await first;
    expect(controller.getSnapshot()).toMatchObject({ blocked: true, trades: undefined, library: undefined });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ blocked: false, trades });
  });

  it('rejects wrong-account or duplicate rows instead of silently filtering an incomplete load', async () => {
    for (const bad of [[{ ...trades[0], accountId: 'live' }], [...trades, ...trades]]) {
      const { deps, controller } = fixture(); deps.loadTrades.mockResolvedValueOnce(bad);
      await controller.start(['backtest']);
      expect(controller.getSnapshot().trades).toBeUndefined();
      expect(controller.getSnapshot().tradesError).toMatch(/identitu/);
    }
  });
});

describe('tag dialog atomic commit boundary', () => {

  it('allows catalog-only changes with all legacy rows excluded, reports every ID and never invents a run', async () => {
    const { deps, controller } = fixture();
    const legacy = [{ ...trades[0], id: 0, backtestRunId: undefined }, { ...trades[0], id: 'legacy-two', backtestRunId: '' }] as Trade[];
    deps.loadTrades.mockResolvedValueOnce(legacy);
    await controller.start(['backtest']);
    const snapshot = controller.getSnapshot();
    expect(snapshot).toMatchObject({ trades: [], loadedRows: 2, tradesError: undefined });
    expect(snapshot.excludedTrades.map(row => row.tradeId)).toEqual(['0', 'legacy-two']);
    const plan = prepareBacktestTagLibraryChange(library, { type: 'archive', id: 'source' }, { ownerId, expectedRevision: library.revision, operationId: 'catalog-legacy' });
    deps.commitPlan.mockResolvedValueOnce({ library: plan.library, operationId: plan.operationId, alreadyApplied: false, tradePatches: [] });
    await expect(controller.commit(plan)).resolves.toEqual([]);
    expect(deps.commitPlan.mock.calls[0][0].scope.tradeIds).toEqual([]);
    expect(legacy[0].backtestRunId).toBeUndefined();
    const html = renderToStaticMarkup(React.createElement(BacktestTagLibraryLoadStatus, { state: snapshot, onRefresh: vi.fn() }));
    expect(html).toContain('2 načtených · 0 způsobilých · 2 vyloučených');
    expect(html).toContain('<strong>0</strong>'); expect(html).toContain('legacy-two'); expect(html).toContain('Chybí propojení');
  });

  it('limits historical merge to explicit eligible rows and retains the visible exclusions on refresh failure', async () => {
    const { deps, controller } = fixture();
    const legacy = { ...trades[0], id: 'legacy', backtestRunId: undefined };
    deps.loadTrades.mockResolvedValueOnce([...trades, legacy]); await controller.start(['backtest']);
    expect(controller.getSnapshot().trades).toEqual(trades);
    expect(controller.getSnapshot().excludedTrades.map(row => row.tradeId)).toEqual(['legacy']);
    const plan = makePlan();
    deps.loadTrades.mockRejectedValueOnce(new Error('page failure')); await controller.refresh();
    expect(controller.getSnapshot().excludedTrades.map(row => row.tradeId)).toEqual(['legacy']);
    await expect(controller.commit(plan)).rejects.toThrow(/Nejdřív/);
    deps.loadTrades.mockResolvedValueOnce([...trades, legacy]); await controller.refresh();
    const forged = structuredClone(plan); forged.scope.tradeIds.push('legacy');
    await expect(controller.commit(forged)).rejects.toThrow();
    expect(deps.commitPlan).not.toHaveBeenCalled();
    await controller.commit(plan);
    expect(deps.commitPlan.mock.calls[0][0].scope.tradeIds).toEqual(['trade']);
  });

  it('publishes only confirmed owner libraries, reports refresh errors without an empty fallback, and publishes ACK while mounted but closed', async () => {
    const { deps, controller } = fixture(); await controller.start(['backtest']);
    expect(deps.onLibraryChanged).toHaveBeenLastCalledWith(library);
    const confirmed = controller.getSnapshot().library;
    deps.loadLibrary.mockRejectedValueOnce(new Error('catalog offline')); await controller.refresh();
    expect(deps.onLibraryChanged).toHaveBeenCalledTimes(1);
    expect(deps.onLibraryError).toHaveBeenLastCalledWith('catalog offline');
    expect(controller.getSnapshot().library).toBe(confirmed);
    await controller.refresh();
    const pending = deferred<ReturnType<typeof receipt>>(); deps.commitPlan.mockReturnValueOnce(pending.promise);
    const publish = vi.fn(), commit = controller.commit(makePlan(), publish);
    await vi.waitFor(() => expect(deps.commitPlan).toHaveBeenCalledTimes(1));
    controller.pause(); pending.resolve(receipt()); await commit;
    expect(deps.onLibraryChanged).toHaveBeenLastCalledWith(receipt().library);
    expect(publish).toHaveBeenCalledWith(receipt().tradePatches);
    await expect(controller.commit(makePlan())).rejects.toThrow(/Nejdřív/);
    await controller.start(['backtest']);
    expect(controller.getSnapshot().committing).toBe(false);
  });

  it('never publishes a delayed catalog or ACK to another owner, even if the dialog closed while waiting', async () => {
    const { deps, controller, switchOwner } = fixture();
    const waiting = deferred<typeof library>(); deps.loadLibrary.mockReturnValueOnce(waiting.promise);
    const loading = controller.start(['backtest']); await tick(); switchOwner('other'); waiting.resolve(library); await loading;
    expect(deps.onLibraryChanged).not.toHaveBeenCalled(); expect(deps.onLibraryError).not.toHaveBeenCalled();
    expect(controller.getSnapshot().excludedTrades).toEqual([]);
    switchOwner(ownerId); await controller.refresh(); deps.onLibraryChanged.mockClear();
    const pending = deferred<ReturnType<typeof receipt>>(); deps.commitPlan.mockReturnValueOnce(pending.promise);
    const commit = controller.commit(makePlan()); await vi.waitFor(() => expect(deps.commitPlan).toHaveBeenCalledTimes(1));
    controller.pause(); switchOwner('other'); pending.resolve(receipt());
    await expect(commit).rejects.toThrow(/Uživatel/);
    expect(deps.onLibraryChanged).not.toHaveBeenCalled();
  });

  it('retries the identical operation after an uncertain error and merges only authoritative tag patches', async () => {
    const { deps, controller } = fixture(); await controller.start(['backtest']);
    deps.commitPlan.mockRejectedValueOnce(new Error('connection lost after write'));
    const plan = makePlan();
    await expect(controller.commit(plan)).rejects.toThrow(/connection lost/);
    expect(controller.getSnapshot().trades).toEqual(trades);
    const current = receipt(); current.alreadyApplied = true; current.tradePatches[0].updates.tags = ['Later reviewed']; current.library.revision++;
    deps.commitPlan.mockResolvedValueOnce(current);
    expect(await controller.commit(plan)).toEqual(current.tradePatches);
    expect(deps.commitPlan.mock.calls[0][0]).toEqual(deps.commitPlan.mock.calls[1][0]);
    expect(deps.commitPlan.mock.calls[0][0]).not.toBe(plan);
    expect(controller.getSnapshot().trades?.[0]).toMatchObject({ tags: ['Later reviewed'], notes: 'Preserve review', autoConfluence: trades[0].autoConfluence });
    expect(plan.tradePatches[0].updates.tags).toEqual(['New']);
  });


  it('retries the same uncertain operation after refresh sees a later revision, without overwriting that newer truth', async () => {
    const { deps, controller } = fixture(); await controller.start(['backtest']);
    const plan = makePlan(); deps.commitPlan.mockRejectedValueOnce(new Error('lost response'));
    await expect(controller.commit(plan)).rejects.toThrow('lost response');
    const current = receipt(); current.library.revision++; current.alreadyApplied = true;
    current.tradePatches[0].updates.tags = ['Later reviewed'];
    deps.loadLibrary.mockResolvedValueOnce(current.library);
    deps.loadTrades.mockResolvedValueOnce([{ ...trades[0], tags: ['Later reviewed'], notes: 'Also reviewed later' }]);
    await controller.refresh();
    deps.commitPlan.mockResolvedValueOnce(current);
    await expect(controller.commit(plan)).resolves.toEqual(current.tradePatches);
    expect(controller.getSnapshot().trades?.[0]).toMatchObject({ tags: ['Later reviewed'], notes: 'Also reviewed later' });
    expect(deps.commitPlan.mock.calls[1][0]).toEqual(plan);
  });

  it('never grants the retry exception for an altered plan or an explicitly rolled-back 40001', async () => {
    for (const definite of [false, true]) {
      const { deps, controller } = fixture(); await controller.start(['backtest']);
      const plan = makePlan();
      deps.commitPlan.mockRejectedValueOnce(definite ? new BacktestTagPersistenceError('conflict: nothing applied', '40001') : new Error('lost response'));
      await expect(controller.commit(plan)).rejects.toThrow();
      deps.loadLibrary.mockResolvedValueOnce({ ...plan.library, revision: plan.library.revision + 1 });
      await controller.refresh();
      const retry = structuredClone(plan);
      if (!definite) retry.library.tags[1].label = 'Changed request';
      await expect(controller.commit(retry)).rejects.toThrow();
      expect(deps.commitPlan).toHaveBeenCalledTimes(1);
    }
  });

  it('preserves a real transport rollback classification and canonical deep-cloned retry fingerprints', async () => {
    const persistence = createBacktestTagLibraryPersistence({ getOwnerId: async () => ownerId, getAuthVersion: () => 0, rpc: async () => ({ data: null, error: { code: '40001', message: 'conflict' } }) });
    await expect(persistence.commit(makePlan())).rejects.toMatchObject({ code: '40001', definitelyNotApplied: true });
    const plan = makePlan(), same = Object.fromEntries(Object.entries(plan).reverse()) as typeof plan;
    const before = await captureBacktestTagCommitAttempt(plan), reordered = await captureBacktestTagCommitAttempt(same);
    expect(before.hash).toHaveLength(64); expect(reordered.hash).toBe(before.hash);
    plan.library.tags[1].label = 'New draft';
    expect(before.plan.library.tags[1].label).toBe('New');
    expect((await captureBacktestTagCommitAttempt(plan)).hash).not.toBe(before.hash);
  });

  it('does not publish a successful commit after an owner change or unmount', async () => {
    for (const mode of ['owner', 'unmount']) {
      const { deps, controller, switchOwner } = fixture(); await controller.start(['backtest']);
      const pending = deferred<ReturnType<typeof receipt>>(); deps.commitPlan.mockReturnValueOnce(pending.promise);
      const publish = vi.fn();
      const committing = controller.commit(makePlan(), publish);
      await vi.waitFor(() => expect(deps.commitPlan).toHaveBeenCalledTimes(1));
      if (mode === 'owner') switchOwner('other'); else controller.stop();
      pending.resolve(receipt());
      await expect(committing).rejects.toThrow(/Uživatel nebo rozsah/);
      expect(publish).not.toHaveBeenCalled();
      expect(controller.getSnapshot().trades?.[0].tags).not.toEqual(['New']);
      await controller.start(['backtest']);
      expect(controller.getSnapshot().committing).toBe(false);
    }
  });
});

describe('tag dialog render contract', () => {
  it('keeps the edit-time tag baseline across refresh and refuses to overwrite concurrently changed aliases or category', () => {
    const original = structuredClone(library.tags[0]);
    const unrelated = structuredClone(library); unrelated.revision++; unrelated.tags[1].label = 'Unrelated change';
    expect(() => assertBacktestTagDraftCurrent(original, unrelated)).not.toThrow();
    for (const edit of [{ aliases: ['New alias from another tab'] }, { category: 'context' as const }, { status: 'archived' as const }]) {
      const refreshed = structuredClone(library); Object.assign(refreshed.tags[0], edit);
      expect(() => assertBacktestTagDraftCurrent(original, refreshed)).toThrow(/Rozepsané hodnoty zůstaly/);
    }
    expect(original).toEqual(library.tags[0]);
    expect(() => assertBacktestTagDraftCurrent(original, { ...library, tags: [library.tags[1]] })).toThrow();
  });
  it('does not render an invented empty catalog or run I/O during initial render', () => {
    const html = renderToStaticMarkup(React.createElement(BacktestTagLibraryDialog, { ownerId, accounts: [], open: true, isDark: true, onClose: vi.fn(), onCommitted: vi.fn() }));
    expect(html).toContain('role="dialog"'); expect(html).toContain('Načítám katalog');
    expect(html).not.toContain('Nový tag'); expect(html).not.toContain('Katalog ·');
  });

  it('places errors, progress, and refresh controls inside the existing manager focus boundary', async () => {
    const { deps, controller } = fixture(); await controller.start(['backtest']);
    deps.loadTrades.mockRejectedValueOnce(new Error('page failed'));
    await controller.refresh();
    const headerContent = React.createElement(BacktestTagLibraryLoadStatus, { state: controller.getSnapshot(), onRefresh: vi.fn() });
    const html = renderToStaticMarkup(React.createElement(BacktestTagManager, { library, trades, ownerId, onCommit: vi.fn(), headerContent }));
    expect(html.match(/role="dialog"/g)).toHaveLength(1);
    expect(html).toContain('page failed'); expect(html).toContain('Obnovit katalog a obchody');
    expect(html.indexOf('aria-labelledby="backtest-tag-manager-title"')).toBeLessThan(html.indexOf('Obnovit katalog'));
    expect(html).toContain('Obnovení zachová rozepsanou úpravu i náhled');
    expect(html).not.toContain('Načteno 0 backtest');
  });
});

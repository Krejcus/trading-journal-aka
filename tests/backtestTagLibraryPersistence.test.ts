import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
vi.mock('../services/supabase', () => ({ supabase: { rpc: vi.fn(), auth: { onAuthStateChange: vi.fn() } } }));
vi.mock('../services/storageService', () => ({ getUserId: vi.fn() }));
import { createBacktestTagLibrary, prepareBacktestTagLibraryChange, previewBacktestTagMerge } from '../services/backtestTagLibrary';
import { BACKTEST_TAG_LIBRARY_COMMIT_RPC, BACKTEST_TAG_LIBRARY_READ_RPC, BACKTEST_TAG_LIBRARY_UNAVAILABLE, backtestTagCommitRpcArgs, createBacktestTagLibraryPersistence } from '../services/backtestTagLibraryPersistence';

const owner = 'owner-a';
const empty = createBacktestTagLibrary(owner);
const library = prepareBacktestTagLibraryChange(empty, { type: 'create', tag: { id: 'first', label: 'Old', category: 'setup' } }, { ownerId: owner, expectedRevision: 0, operationId: 'first' }).library;
const second = prepareBacktestTagLibraryChange(library, { type: 'create', tag: { id: 'second', label: 'New', category: 'context' } }, { ownerId: owner, expectedRevision: 1, operationId: 'second' }).library;
const trades = ['a', 'b'].map(id => ({ id, accountId: 'account', backtestRunId: 'run', tags: ['Old'], notes: 'Must not send' } as Trade));
const plan = () => previewBacktestTagMerge(second, trades, { ownerId: owner, expectedRevision: 2, operationId: 'merge', sourceId: 'first', targetId: 'second', scope: { tradeIds: ['a', 'b'], fields: ['tags'] } });
const receipt = () => { const p = plan(); return { library: p.library, operationId: p.operationId, alreadyApplied: false, tradePatches: p.tradePatches.map(({ tradeId, updates }) => ({ tradeId, updates })) }; };
let authOwner: string | null; let authVersion: number;
const rpc = vi.fn();
const persistence = () => createBacktestTagLibraryPersistence({ rpc, getOwnerId: async () => authOwner, getAuthVersion: () => authVersion });
beforeEach(() => { authOwner = owner; authVersion = 1; rpc.mockReset(); });

describe('owner-scoped tag library transport', () => {
  it('requires an authoritative successful read instead of treating unavailable data as an empty catalog', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } });
    await expect(persistence().load(owner)).rejects.toThrow(BACKTEST_TAG_LIBRARY_UNAVAILABLE);
    expect(rpc).toHaveBeenCalledWith(BACKTEST_TAG_LIBRARY_READ_RPC);
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(persistence().load(owner)).rejects.toThrow(/Načtení katalogu/);
    rpc.mockResolvedValueOnce({ data: empty, error: null });
    expect(await persistence().load(owner)).toEqual(empty);
  });

  it('captures ownership before RPC and rejects delayed responses across auth changes, including switch-back', async () => {
    let resolve!: (value: unknown) => void;
    rpc.mockReturnValue(new Promise(done => { resolve = done; }));
    const read = persistence().load(owner);
    await Promise.resolve(); await Promise.resolve();
    authOwner = 'owner-b'; authVersion++; authOwner = owner; authVersion++;
    resolve({ data: library, error: null });
    await expect(read).rejects.toThrow(/Uživatel se během/);
  });

  it('sends a single RPC transaction containing only the explicit tag scope in its body', async () => {
    rpc.mockResolvedValue({ data: receipt(), error: null });
    const result = await persistence().commit(plan());
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe(BACKTEST_TAG_LIBRARY_COMMIT_RPC);
    const body = rpc.mock.calls[0][1];
    expect(body.p_scope).toEqual({ tradeIds: ['a', 'b'], fields: ['tags'] });
    expect(JSON.stringify(body)).not.toContain('Must not send');
    expect(JSON.stringify(body)).not.toContain('noteHistory');
    expect(body.p_owner_id).toBe(owner);
    expect(result.tradePatches.map(item => item.tradeId)).toEqual(['a', 'b']);
  });

  it('retries an uncertain operation with exactly the original body and accepts fresh later truth only with a receipt', async () => {
    rpc.mockRejectedValueOnce(new Error('Connection closed after commit'));
    const p = plan(), service = persistence();
    await expect(service.commit(p)).rejects.toThrow(/Connection closed/);
    const firstBody = structuredClone(rpc.mock.calls[0][1]);
    const later = receipt(); later.alreadyApplied = true; later.library.revision++;
    later.tradePatches[0].updates.tags = ['Changed later'];
    rpc.mockResolvedValueOnce({ data: later, error: null });
    const result = await service.commit(p);
    expect(rpc.mock.calls[1][1]).toEqual(firstBody);
    expect(result.tradePatches[0].updates.tags).toEqual(['Changed later']);
    expect(p.tradePatches[0].updates.tags).toEqual(['New']);
  });

  it('rejects success after account switch and never returns another owner’s result', async () => {
    rpc.mockImplementationOnce(async () => { authOwner = 'other'; authVersion++; return { data: receipt(), error: null }; });
    await expect(persistence().commit(plan())).rejects.toThrow(/Uživatel se během/);
    rpc.mockClear(); authOwner = 'other';
    await expect(persistence().commit(plan())).rejects.toThrow(/Uživatel se během/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['PGRST202', '42883', '40001', '42501'])('surfaces %s without fallback or a partial series of trade writes', async code => {
    rpc.mockResolvedValue({ data: null, error: { code, message: 'Denied' } });
    await expect(persistence().commit(plan())).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete, foreign or out-of-scope confirmations', async () => {
    const incomplete = receipt(); incomplete.tradePatches.pop();
    const wrongId = receipt(); wrongId.tradePatches[0].tradeId = 'foreign';
    const extraField = receipt(); extraField.tradePatches[0].updates.notes = 'private text';
    const unexpectedValue = receipt(); unexpectedValue.tradePatches[0].updates.tags = ['Wrong'];
    for (const value of [incomplete, wrongId, extraField, unexpectedValue, { ...receipt(), operationId: 'wrong' }]) {
      rpc.mockResolvedValueOnce({ data: value, error: null });
      await expect(persistence().commit(plan())).rejects.toThrow();
    }
  });

  it('rejects private fields smuggled into a plan before any request and preserves the source plan', () => {
    const invalid = plan(); invalid.tradePatches[0].updates.notes = 'Secret';
    const original = JSON.stringify(invalid);
    expect(() => backtestTagCommitRpcArgs(invalid)).toThrow(/nepovolené pole/);
    expect(JSON.stringify(invalid)).toBe(original);
    const captured = plan(); captured.scopeSnapshots[0].expected.notes = 'Secret';
    expect(() => backtestTagCommitRpcArgs(captured)).toThrow(/mimo rozsah/);
  });

  it('bounds the transaction size and explicit row count without truncating', () => {
    const tooMany = plan(); tooMany.scope.tradeIds = Array.from({ length: 501 }, (_, i) => String(i));
    expect(() => backtestTagCommitRpcArgs(tooMany)).toThrow(/500/);
    const huge = plan(); huge.scopeSnapshots[0].expected.tags = ['č'.repeat(1_100_000)];
    huge.tradePatches[0].expected = structuredClone(huge.scopeSnapshots[0].expected);
    expect(() => backtestTagCommitRpcArgs(huge)).toThrow(/2 MiB/);
    expect(huge.scopeSnapshots[0].expected.tags?.[0].length).toBe(1_100_000);
  });
});

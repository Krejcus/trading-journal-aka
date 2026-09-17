import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../server/journalIncrementalInput', () => ({ prepareJournalInput: mocks.read }));
import { importJournalPositions } from '../server/journalPositionImport';

const scope = { ownerId: '11111111-1111-4111-8111-111111111111',
  connectionId: '33333333-3333-4333-8333-333333333333', environment: 'demo' as const };
const receipt = { accepted: true, unchanged: true, through: 73, confirmed: 12, pending: 0, unassigned: 0 };
const rpc = vi.fn();
const from = vi.fn(() => { throw new Error('unexpected-table-read'); });
const db = { rpc, from } as unknown as SupabaseClient;
const byName = (answers: Record<string, unknown>) => rpc.mockImplementation(async (name: string) => (
  { data: name in answers ? answers[name] : name === 'claim_journal_import_lease' ? true : null, error: null }));
beforeEach(() => { vi.clearAllMocks(); rpc.mockResolvedValue({ data: receipt, error: null });
  mocks.read.mockRejectedValue(new Error('full-import-required')); });

describe('server import checkpoint trust boundary', () => {
  it('returns a verified unchanged snapshot without any evidence read or write', async () => {
    expect(await importJournalPositions(db, scope)).toEqual(receipt);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('read_journal_import_checkpoint', {
      p_user_id: scope.ownerId, p_connection_id: scope.connectionId,
    });
    expect(mocks.read).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
  });
  it('continues the full import when the database has no matching checkpoint', async () => {
    byName({ read_journal_import_checkpoint: null });
    await expect(importJournalPositions(db, scope)).rejects.toThrow('full-import-required');
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(db, scope);
  });
  it('claims one import lease per connection and releases it even after a failed import', async () => {
    byName({ read_journal_import_checkpoint: null });
    await expect(importJournalPositions(db, scope)).rejects.toThrow('full-import-required');
    const claim = rpc.mock.calls.find(([name]) => name === 'claim_journal_import_lease');
    const release = rpc.mock.calls.find(([name]) => name === 'release_journal_import_lease');
    expect(claim?.[1]).toMatchObject({ p_user_id: scope.ownerId, p_connection_id: scope.connectionId, p_ttl_ms: 120_000 });
    expect(release?.[1]).toEqual({ p_user_id: scope.ownerId, p_connection_id: scope.connectionId, p_holder: (claim?.[1] as { p_holder: string }).p_holder });
    expect(rpc.mock.calls.map(([name]) => name).indexOf('release_journal_import_lease'))
      .toBeGreaterThan(rpc.mock.calls.map(([name]) => name).indexOf('claim_journal_import_lease'));
  });
  it('answers processing without reading evidence while another importer holds the lease', async () => {
    byName({ read_journal_import_checkpoint: null, claim_journal_import_lease: false });
    expect(await importJournalPositions(db, scope)).toEqual({ accepted: false, processing: true, through: 0, targetThrough: 0, confirmed: 0, pending: 0, unassigned: 0 });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain('release_journal_import_lease');
  });
  it('fails closed when the lease cannot be claimed at all', async () => {
    rpc.mockImplementation(async (name: string) => name === 'claim_journal_import_lease'
      ? { data: null, error: { message: 'connection pool exhausted' } } : { data: null, error: null });
    await expect(importJournalPositions(db, scope)).rejects.toThrow('journal-lease-unavailable');
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('accepts a stored empty snapshot and pending counts without fabricating confirmed trades', async () => {
    for (const next of [{ ...receipt, through: 0, confirmed: 0 }, { ...receipt, confirmed: 0, pending: 12, unassigned: 1 }]) {
      rpc.mockResolvedValue({ data: next, error: null });
      expect(await importJournalPositions(db, scope)).toEqual(next);
    }
  });
  it.each([
    false, [], 'ok', {}, { ...receipt, accepted: false }, { ...receipt, unchanged: false },
    { ...receipt, through: '73' }, { ...receipt, through: 0 }, { ...receipt, confirmed: -1 },
    { ...receipt, pending: 1.5 }, { ...receipt, unassigned: Number.MAX_SAFE_INTEGER + 1 },
    { ...receipt, confirmed: undefined },
  ])('rejects malformed checkpoint %j before any table reads', async value => {
    rpc.mockResolvedValue({ data: value, error: null });
    await expect(importJournalPositions(db, scope)).rejects.toThrow('journal-checkpoint-invalid');
    expect(mocks.read).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
  });
  it.each([
    ['journal-connection-not-found', 'journal-connection-not-found'],
    ['database unavailable', 'journal-checkpoint-read-failed'],
  ])('fails closed on checkpoint RPC error %s', async (message, code) => {
    rpc.mockResolvedValue({ data: receipt, error: { message } });
    await expect(importJournalPositions(db, scope)).rejects.toThrow(code);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('rejects an invalid selector or environment before accessing the database', async () => {
    await expect(importJournalPositions(db, { ...scope, connectionId: 'bad' })).rejects.toThrow('invalid-journal-cursor');
    await expect(importJournalPositions(db, { ...scope, environment: 'live' })).rejects.toThrow('invalid-journal-environment');
    expect(rpc).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { prepareJournalInput } from '../server/journalIncrementalInput';
import { journalAccountsFixture } from './fixtures/journalAccounts';

const event = journalAccountsFixture().events[0];
const scope = { ownerId: '11111111-1111-4111-8111-111111111111', connectionId: event.connectionId, environment: 'demo' as const };
const entity = { key: 'contract:1', latest: event, orderedThrough: event };
const context = { version: 1, generation: 1, after: 0, through: 1, ready: false, watermark: null,
  hasMore: false, next: 1, rows: [{ cursor: 1, event }], entities: [] };
const ready = { ...context, generation: 2, after: 1, ready: true, rows: [], watermark: event };
const ack = { accepted: true, generation: 2, through: 1, targetThrough: 1 };
const snapshot = { generation: 2, through: 1, rows: [{ key: 'e:contract:1', entity, event: null }] };
function client(responses: unknown[]) {
  const rpc = vi.fn(async () => {
    if (!responses.length) throw new Error('unexpected-rpc');
    const next = responses.shift();
    return next instanceof Error ? { error: next, data: null } : { data: next, error: null };
  });
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}
describe('durable projection input protocol', () => {
  it('commits one bounded batch and resumes in a new call without rereading raw input', async () => {
    const c = client([context, ack]);
    expect(await prepareJournalInput(c.db, scope, { maxPages: 1 })).toEqual({ ready: false, through: 1, targetThrough: 1 });
    expect(c.rpc.mock.calls).toHaveLength(2);
    expect(c.rpc).toHaveBeenLastCalledWith('commit_journal_input_batch', expect.objectContaining({ p_after: 0, p_next: 1, p_updates: [entity] }));
    const resumed = client([ready, snapshot, { ...snapshot, rows: [] }]);
    expect(await prepareJournalInput(resumed.db, scope)).toEqual({ ready: true, through: 1, targetThrough: 1, events: [event] });
    expect(resumed.rpc).toHaveBeenLastCalledWith('read_journal_input_snapshot', expect.objectContaining({ p_after: 'e:contract:1' }));
  });
  it('does not turn a lost CAS or transport failure into a completed projection', async () => {
    const stale = client([context, { accepted: false, stale: true }]);
    expect(await prepareJournalInput(stale.db, scope)).toEqual({ ready: false, through: 0, targetThrough: 1 });
    const failed = client([context, new Error('offline')]);
    await expect(prepareJournalInput(failed.db, scope)).rejects.toThrow('input-unavailable');
  });
  it('requires exact durable cursor and generation acknowledgement', async () => {
    for (const bad of [{ ...ack, through: 0 }, { ...ack, generation: 1 }, { ...ack, targetThrough: 2 }, { accepted: true }]) {
      await expect(prepareJournalInput(client([context, bad]).db, scope)).rejects.toThrow('commit-not-confirmed');
    }
  });
  it('rejects invalid source context before committing any input', async () => {
    for (const bad of [{ ...context, after: undefined }, { ...context, after: -1 }, { ...context, version: 2 },
      { ...context, ready: true }, { ...context, entities: [{ ...entity, key: 'contract:2' }] },
      { ...context, rows: [{ cursor: 1, event: { ...event, connectionId: scope.ownerId } }] }]) {
      const c = client([bad]);
      await expect(prepareJournalInput(c.db, scope)).rejects.toThrow();
      expect(c.rpc).toHaveBeenCalledTimes(1);
    }
  });
  it('checks the final empty snapshot page and rejects concurrent generation changes', async () => {
    const c = client([ready, snapshot, new Error('journal-input-changed')]);
    await expect(prepareJournalInput(c.db, scope)).rejects.toThrow('input-changed');
    expect(c.rpc).toHaveBeenCalledTimes(3);
  });
  it('rejects duplicate snapshot keys and mismatched entity identity', async () => {
    await expect(prepareJournalInput(client([ready, snapshot, snapshot]).db, scope)).rejects.toThrow('snapshot-invalid');
    const bad = { ...snapshot, rows: [{ ...snapshot.rows[0], entity: { ...entity, key: 'contract:2' } }] };
    await expect(prepareJournalInput(client([ready, bad]).db, scope)).rejects.toThrow('entity-invalid');
  });
  it('replays only the late entity through this batch cursor', async () => {
    const later = { ...event, id: 'a'.repeat(64), sequence: 2, receivedAt: 200, entity: { id: 1, name: 'MNQU6' } };
    const insertion = { ...event, id: 'b'.repeat(64), sequence: 3, receivedAt: 100, entity: { id: 1, name: 'MNQH6' } };
    const lateContext = { ...context, after: 2, through: 3, next: 3, rows: [{ cursor: 3, event: insertion }],
      entities: [{ ...entity, latest: later, orderedThrough: later }] };
    const history = { after: 0, through: 3, next: 3, hasMore: false,
      rows: [event, later, insertion].map((item, index) => ({ cursor: index + 1, event: item })) };
    const c = client([lateContext, history, { ...ack, through: 3, targetThrough: 3 }]);
    await prepareJournalInput(c.db, scope, { maxPages: 1 });
    expect(c.rpc).toHaveBeenNthCalledWith(2, 'read_journal_input_entity_history', expect.objectContaining({ p_key: 'contract:1', p_after: 0, p_through: 3 }));
    expect(c.rpc).toHaveBeenLastCalledWith('commit_journal_input_batch', expect.objectContaining({ p_updates: [{ ...entity, latest: later, orderedThrough: later }] }));
  });
});

import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { JOURNAL_BACKFILL_TYPES } from '../lib/journalBackfillPlan';
import { decodeJournalSourceStatus, journalSourceConnections, readJournalSourceStatus } from '../services/journalSourceStatus';
import type { Account } from '../types';

const owner = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const at = Date.parse('2026-09-10T13:30:00Z');
const metadata = { kind: 'observed', startedAt: at - 500, completedAt: at, scope: 'available-list', scanned: 12, recorded: 2, contended: 0 };
const response = (ids: readonly string[]) => ({ connections: ids.map(connectionId => ({ connectionId, environment: 'demo',
  sources: JOURNAL_BACKFILL_TYPES.map(type => ({ type, recordedAt: new Date(at).toISOString(), metadata: { ...metadata } })) })) });
const clientFor = (read: (ids: string[], signal?: AbortSignal) => unknown | Promise<unknown>) => {
 const client = createClient('http://127.0.0.1:9915', 'fictional', {
  auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url, init) => {
    expect(String(url)).toContain('/rpc/read_journal_source_status');
    return Response.json(await read(JSON.parse(String(init?.body)).p_connection_ids, init?.signal ?? undefined));
  } },
 });
 return async (ids: readonly string[], signal: AbortSignal) => {
   const { data, error } = await client.rpc('read_journal_source_status', { p_connection_ids: ids }).abortSignal(signal);
   if (error) throw error;
   return data;
 };
};
describe('owner history source availability', () => {
  it('shares one connection across 12 accounts and deduplicates archived references', () => {
    const accounts = Array.from({ length: 12 }, (_, i) => ({ id: String(i), oauth: { provider: 'tradovate', connectionId: id(1) } } as Account));
    expect(journalSourceConnections([...accounts, accounts[0]], [id(1), id(2)])).toEqual([
      { connectionId: id(1), accountCount: 12 }, { connectionId: id(2), accountCount: 0 },
    ]);
  });
  it('keeps failures, missing metadata, empty lists and legacy scope distinct', () => {
    const data = response([id(1)]);
    const sources = data.connections[0].sources as Array<Record<string, unknown>>;
    sources[0].metadata = { ...metadata, kind: 'unavailable', scanned: null, recorded: null, contended: null };
    sources[1].metadata = null; sources[1].recordedAt = null;
    sources[2].metadata = { ...metadata, scope: null, scanned: 0, recorded: 0 };
    const decoded = decodeJournalSourceStatus(data, [id(1)], at).at(0)!.sources;
    expect(decoded[0].metadata?.kind).toBe('unavailable');
    expect(decoded[1].metadata).toBeNull();
    expect(decoded[2].metadata).toMatchObject({ scope: null, scanned: 0 });
  });
  it('rejects missing, duplicate and foreign connection/source rows', () => {
    for (const mutate of [
      (data: ReturnType<typeof response>) => { data.connections.pop(); },
      (data: ReturnType<typeof response>) => { data.connections[0].connectionId = id(2); },
      (data: ReturnType<typeof response>) => { data.connections[0].sources.pop(); },
      (data: ReturnType<typeof response>) => { data.connections[0].sources[0] = data.connections[0].sources[1]; },
    ]) { const data = response([id(1)]); mutate(data); expect(() => decodeJournalSourceStatus(data, [id(1)], at)).toThrow(); }
  });
  it('rejects impossible counts, timestamps and incomplete bounded scope', () => {
    for (const patch of [{ recorded: 13 }, { scanned: '12' }, { startedAt: at + 1 }, { completedAt: at + 2000 }, { scope: 'all-history' }, { scope: 'known-parents', requested: 101, remaining: 0 }, { scope: 'known-parents' }]) {
      const data = response([id(1)]); Object.assign(data.connections[0].sources[0].metadata, patch);
      expect(() => decodeJournalSourceStatus(data, [id(1)], at)).toThrow();
    }
    const future = response([id(1)]); future.connections[0].sources[0].recordedAt = new Date(at + 300_001).toISOString();
    expect(() => decodeJournalSourceStatus(future, [id(1)], at)).toThrow();
  });
  it('reads 26 connections in bounded batches without returning a partial response', async () => {
    const batches: number[] = [];
    const client = clientFor(ids => { batches.push(ids.length); return response(ids); });
    const ids = Array.from({ length: 26 }, (_, i) => id(i));
    expect(await readJournalSourceStatus(client, owner, ids, () => true)).toHaveLength(26);
    expect(batches).toEqual([25, 1]);
    const incomplete = clientFor(ids => response(ids.length === 1 ? [] : ids));
    await expect(readJournalSourceStatus(incomplete, owner, ids, () => true)).rejects.toThrow();
  });
  it('discards responses when the owner changes or reading is cancelled', async () => {
    let same = true;
    const changed = clientFor(ids => { same = false; return response(ids); });
    await expect(readJournalSourceStatus(changed, owner, [id(1)], () => same)).rejects.toThrow('session-changed');
    const abort = new AbortController();
    const cancelled = clientFor(ids => { abort.abort(); return response(ids); });
    await expect(readJournalSourceStatus(cancelled, owner, [id(1)], () => true, abort.signal)).rejects.toThrow('session-changed');
  });
  it('rejects invalid scope before any request and preserves an empty selection', async () => {
    let calls = 0; const client = clientFor(ids => { calls++; return response(ids); });
    for (const ids of [[id(1), id(1)], ['invalid'], Array.from({ length: 251 }, (_, i) => id(i))]) {
      await expect(readJournalSourceStatus(client, owner, ids, () => true)).rejects.toThrow('invalid-scope');
    }
    expect(await readJournalSourceStatus(client, owner, [], () => true)).toEqual([]);
    expect(calls).toBe(0);
  });
});

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileJournalEvidenceStore } from '../server/fileJournalEvidenceStore';
import { APPROVED_JOURNAL_ORIGIN, createJournalBatchUploader, journalUploadUrl, startJournalEvidenceUpload } from '../server/journalEvidenceUpload';
import { storeJournalBatch, validateJournalBatch } from '../server/tradovateJournalStore';
import { journalObservation, type JournalEvidence } from '../lib/tradovateJournalEvidence';

const device = { id: 'device', userId: 'owner', connectionId: 'connection', publicKey: '', deviceName: 'Test' };
const observation = journalObservation('fill', { id: 1, orderId: 2, accountId: 3, contractId: 4, action: 'Buy', qty: 1, price: 20_000 }, 'stream', 'Created', 1000)!;
const seal = (overrides: Partial<JournalEvidence> = {}): JournalEvidence => {
  const payload = { ...observation, connectionId: device.connectionId, environment: 'demo' as const,
    sessionId: 'e1082cbd-906c-43b7-bf21-5c6c6493cab1', sequence: 1, ...overrides };
  return { ...payload, id: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
};
const ack = (events: readonly JournalEvidence[]) => new Response(JSON.stringify({ accepted: true, ids: events.map(event => event.id) }));
const authorizationHeader = async () => 'Device fictional-test-authorization';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('journal transport with exact durable acknowledgement', () => {
  it('only permits the approved origin and refuses redirects', async () => {
    for (const origin of ['http://alphatrade-mentor-15.vercel.app', 'https://example.com',
      `${APPROVED_JOURNAL_ORIGIN}.example.com`, `${APPROVED_JOURNAL_ORIGIN}/other`, `${APPROVED_JOURNAL_ORIGIN}?other=1`,
      'https://name:password@alphatrade-mentor-15.vercel.app']) {
      expect(() => journalUploadUrl(origin)).toThrow();
    }
    const events = [seal()];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: await authorizationHeader() });
      expect(JSON.parse(String(init?.body))).toEqual({ events });
      expect(String(init?.body)).not.toContain('fictional-test-authorization');
      return ack(events);
    });
    await createJournalBatchUploader({ apiOrigin: APPROVED_JOURNAL_ORIGIN, authorizationHeader, fetchImpl })(events);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${APPROVED_JOURNAL_ORIGIN}/api/tradovate/oauth/copier-journal`);
  });

  it('rejects partial, duplicate, foreign, null and unsuccessful acknowledgements', async () => {
    const events = [seal(), seal({ sequence: 2 })];
    for (const body of [null, {}, { accepted: false, ids: events.map(row => row.id) },
      { accepted: true, ids: [events[0].id] }, { accepted: true, ids: [events[0].id, events[0].id] },
      { accepted: true, ids: [events[0].id, 'foreign'] }]) {
      const upload = createJournalBatchUploader({ apiOrigin: APPROVED_JOURNAL_ORIGIN, authorizationHeader,
        fetchImpl: async () => new Response(JSON.stringify(body)) });
      await expect(upload(events)).rejects.toThrow('journal-upload-incomplete-ack');
    }
    await expect(createJournalBatchUploader({ apiOrigin: APPROVED_JOURNAL_ORIGIN, authorizationHeader,
      fetchImpl: async () => new Response('private diagnostic must not enter logs', { status: 503 }) })(events))
      .rejects.toThrow('journal-upload-http-503');
  });

  it('checks scope, integrity and the field allowlist before any database write', async () => {
    const rpc = vi.fn();
    const db = { rpc } as unknown as SupabaseClient;
    for (const event of [seal({ connectionId: 'someone-else' }), seal({ environment: 'live' }),
      { ...seal(), sequence: 2 }, seal({ entity: { ...observation.entity, accessToken: 'must-not-store' } })]) {
      await expect(storeJournalBatch(db, device, [event])).rejects.toThrow('invalid-journal-');
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(validateJournalBatch([seal()], device.connectionId, 'demo')).toHaveLength(1);
  });

  it('replays a lost response after restart with identical ids and owner-scoped deduplication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'journal-transport-')); roots.push(root);
    const options = { path: join(root, 'events.jsonl'), connectionId: device.connectionId, environment: 'demo' as const };
    const rows = new Map<string, unknown>();
    const db = { rpc: async (name: string, input: { p_user_id: string; p_connection_id: string; p_device_id: string; p_events: JournalEvidence[] }) => {
      expect(name).toBe('append_tradovate_journal_evidence');
      expect(input).toMatchObject({ p_user_id: device.userId, p_connection_id: device.connectionId, p_device_id: device.id });
      for (const event of input.p_events) rows.set(`${input.p_user_id}:${input.p_connection_id}:${event.id}`, event);
      return { error: null, data: { accepted: true, ids: input.p_events.map(event => event.id) } };
    } } as unknown as SupabaseClient;
    let loseResponse = true;
    const batches: JournalEvidence[][] = [];
    const upload = createJournalBatchUploader({ apiOrigin: APPROVED_JOURNAL_ORIGIN, authorizationHeader,
      fetchImpl: async (_url, init) => {
        const { events } = JSON.parse(String(init?.body)); batches.push(events);
        const result = await storeJournalBatch(db, device, events);
        if (loseResponse) { loseResponse = false; throw new Error('simulated-lost-response'); }
        return new Response(JSON.stringify(result));
      } });
    const first = await createFileJournalEvidenceStore(options);
    await first.record(observation);
    await expect(first.flush(upload)).rejects.toThrow('simulated-lost-response'); await first.close();
    const second = await createFileJournalEvidenceStore(options);
    expect(second.health().pending).toBeNull();
    await second.flush(upload); await second.close();
    const third = await createFileJournalEvidenceStore(options);
    await third.flush(async () => { throw new Error('acknowledged-evidence-must-not-replay'); }); await third.close();
    expect(batches).toHaveLength(2); expect(batches[0]).toEqual(batches[1]); expect(rows.size).toBe(1);
  });

  it('does not acknowledge a failed database insert', async () => {
    const db = { rpc: async () => ({ error: { message: 'test failure' } }) } as unknown as SupabaseClient;
    await expect(storeJournalBatch(db, device, [seal()])).rejects.toThrow('journal-evidence-write-failed');
  });

  it('aborts stuck authorization or fetch on shutdown without waiting for the network', async () => {
    for (const phase of ['authorization', 'fetch']) {
      let entered!: () => void;
      const entry = new Promise<void>(resolve => { entered = resolve; });
      const never = () => { entered(); return new Promise<never>(() => undefined); };
      const uploader = startJournalEvidenceUpload({ apiOrigin: APPROVED_JOURNAL_ORIGIN,
        authorizationHeader: phase === 'authorization' ? never : authorizationHeader,
        fetchImpl: phase === 'fetch' ? never : async () => ack([seal()]),
        flush: callback => callback([seal()]) });
      await entry;
      await uploader.close();
    }
  });

  it('backs off unavailable endpoints and stops all scheduled retries when closed', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    const onError = vi.fn();
    const uploader = startJournalEvidenceUpload({ apiOrigin: APPROVED_JOURNAL_ORIGIN, authorizationHeader,
      fetchImpl, onError, pollMs: 100, flush: callback => callback([seal()]) });
    await vi.advanceTimersByTimeAsync(0); expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199); expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    await uploader.close(); await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

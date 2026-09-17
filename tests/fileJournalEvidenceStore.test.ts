import { positionSnapshotObservations, journalSnapshotAnchors } from '../lib/journalPositionSnapshot';
import { journalObservation } from '../lib/tradovateJournalEvidence';
import { validateJournalBatch } from '../server/tradovateJournalStore';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileJournalEvidenceStore } from '../server/fileJournalEvidenceStore';
import type { JournalEvidence, JournalObservation } from '../lib/tradovateJournalEvidence';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'alphatrade-evidence-test-')); roots.push(root);
  return { path: join(root, 'events.jsonl'), connectionId: 'connection-1', environment: 'demo' as const };
};
const observation: JournalObservation = { entityType: 'fill', entity: { id: 1, qty: 2, price: 100 }, receivedAt: 1234, source: 'stream', eventType: 'Created' };
describe('durable journal evidence', () => {
  it('retries identical ids after a lost ACK and resumes the durable cursor after restart', async () => {
    const options = await setup();
    const store = await createFileJournalEvidenceStore(options);
    store.record(observation);
    let first: JournalEvidence[] = [];
    await expect(store.flush(async events => { first = events; throw new Error('lost-ack'); })).rejects.toThrow('lost-ack');
    await store.close();
    const restarted = await createFileJournalEvidenceStore(options);
    await restarted.flush(async events => { expect(events).toEqual(first); });
    await restarted.close();
    const third = await createFileJournalEvidenceStore(options);
    await third.flush(async () => { throw new Error('must-not-upload-acknowledged-events'); });
    await third.close();
    expect((await readFile(options.path, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('returns to recording once a later upload is acknowledged', async () => {
    const options = await setup();
    const store = await createFileJournalEvidenceStore(options);
    store.record(observation);
    await expect(store.flush(async () => { throw new Error('The operation was aborted due to timeout'); })).rejects.toThrow('timeout');
    expect(store.health()).toMatchObject({ state: 'degraded', error: 'The operation was aborted due to timeout' });
    await store.flush(async () => undefined);
    expect(store.health()).toMatchObject({ state: 'recording', error: null });
    await store.close();
  });
  it('uses bounded batches and keeps events appended during an upload', async () => {
    const options = await setup();
    const store = await createFileJournalEvidenceStore(options);
    for (let index = 0; index < 150; index++) store.record({ ...observation, receivedAt: index });
    await store.flush(async events => { expect(events).toHaveLength(100); store.record(observation); });
    await store.flush(async events => { expect(events).toHaveLength(51); });
    await store.close();
  });
  it('reports a torn append rather than accepting a corrupt history as complete', async () => {
    const options = await setup();
    await writeFile(options.path, '{"partial":');
    await expect(createFileJournalEvidenceStore(options)).rejects.toThrow('truncated-tail');
  });
  it('round-trips snapshot completion witnesses through durable encoding and API integrity validation', async () => {
    const options = { ...await setup(), connectionId: '33333333-3333-4333-8333-333333333333' };
    const store = await createFileJournalEvidenceStore(options);
    for (const row of positionSnapshotObservations('initial', [{ id: 1 }], [], 100, 200)) {
      await store.record(journalObservation(row.entityType, row.entity, row.source, row.eventType, row.receivedAt)!);
    }
    await store.flush(async rows => {
      const valid = validateJournalBatch(rows, options.connectionId, 'demo');
      expect(journalSnapshotAnchors(valid, [{ accountId: 1, contractId: 7 }], [])).toEqual([{ accountId: 1, contractId: 7, at: 200, net: 0 }]);
    });
    await store.close();
  });

  it('persists a burst in a few durable batches instead of one datasync per row', async () => {
    const options = await setup();
    const store = await createFileJournalEvidenceStore(options);
    const receipts: Promise<boolean>[] = [];
    for (let index = 0; index < 500; index++) receipts.push(store.record({ ...observation, entity: { id: index }, receivedAt: index }));
    expect(await Promise.all(receipts)).toEqual(new Array(500).fill(true));
    const health = store.health();
    expect(health.batches).toBeLessThan(10);
    expect(health.queued).toBe(0);
    expect(health.dropped).toBe(0);
    expect(typeof health.lastWriteMs).toBe('number');
    expect(health.lastPersistedAt).toBe(499);
    await store.close();
    expect((await readFile(options.path, 'utf8')).trim().split('\n')).toHaveLength(500);
  });

  it('records an unchanged REST snapshot once and every change or stream witness always', async () => {
    const options = await setup();
    const store = await createFileJournalEvidenceStore(options);
    const command: JournalObservation = { entityType: 'command', entity: { id: 7, commandStatus: 'Pending' }, receivedAt: 1, source: 'snapshot', eventType: 'Observed' };
    expect(await store.record(command)).toBe(true);
    expect(await store.record({ ...command, receivedAt: 2 })).toBe(true);
    expect(await store.record({ ...command, receivedAt: 3, entity: { id: 7, commandStatus: 'Done' } })).toBe(true);
    expect(await store.record({ ...command, receivedAt: 4, entity: { id: 7, commandStatus: 'Done' } })).toBe(true);
    const position: JournalObservation = { entityType: 'position', entity: { id: 9, netPos: 2 }, receivedAt: 5, source: 'stream', eventType: 'Updated' };
    expect(await store.record(position)).toBe(true);
    expect(await store.record({ ...position, receivedAt: 6 })).toBe(true);
    const witness: JournalObservation = { entityType: 'positionsnapshot', entity: { id: 'a:1:2', netPos: 0 }, receivedAt: 7, source: 'snapshot', eventType: 'Observed' };
    expect(await store.record(witness)).toBe(true);
    expect(await store.record({ ...witness, receivedAt: 8 })).toBe(true);
    expect(store.health().deduplicated).toBe(2);
    await store.close();
    const lines = (await readFile(options.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JournalEvidence);
    expect(lines.map(line => `${line.entityType}@${line.receivedAt}`)).toEqual([
      'command@1', 'command@3', 'position@5', 'position@6', 'positionsnapshot@7', 'positionsnapshot@8',
    ]);
  });

  it('drops command history first and opens a recording gap only for position-critical loss', async () => {
    const options = await setup();
    const errors: string[] = [];
    const store = await createFileJournalEvidenceStore({ ...options, maxQueued: 2, onError: error => errors.push(error.message) });
    const fill = (id: number, receivedAt: number): JournalObservation => ({ ...observation, entity: { id }, receivedAt });
    const command = (id: number, receivedAt: number): JournalObservation => ({ ...observation, entityType: 'command', entity: { id }, receivedAt });
    const receipts = [store.record(fill(1, 10))]; // in flight
    receipts.push(store.record(command(2, 11)), store.record(command(3, 12))); // queued (soft limit reached)
    const droppedCommand = store.record(command(4, 13));
    for (let index = 0; index < 6; index++) receipts.push(store.record(fill(10 + index, 20 + index))); // critical keeps queueing to the hard limit
    const droppedFill = store.record(fill(99, 30));
    expect(await droppedCommand).toBe(false);
    expect(await droppedFill).toBe(false);
    expect(await Promise.all(receipts)).toEqual(new Array(9).fill(true));
    const health = store.health();
    expect(health).toMatchObject({ state: 'degraded', dropped: 1, droppedLowPriority: 1, lastGapAt: 30, lastGapReason: 'queue-full', queued: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('journal-queue-full-history-incomplete');
    await store.close();
    const lines = (await readFile(options.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JournalEvidence);
    const markers = lines.filter(line => line.entityType === 'connection');
    expect(markers).toHaveLength(1);
    expect(markers[0].entity).toEqual({ state: 'recording-gap', reason: 'queue-full' });
    expect(markers[0].receivedAt).toBe(30);
    expect(lines).toHaveLength(10);
  });

  it('never marks a gap when only command history was lost', async () => {
    const options = await setup();
    const store = await createFileJournalEvidenceStore({ ...options, maxQueued: 1 });
    const first = store.record(observation);
    const queued = store.record({ ...observation, entityType: 'command' as const, entity: { id: 2 }, receivedAt: 2 });
    const dropped = store.record({ ...observation, entityType: 'commandreport' as const, entity: { id: 3 }, receivedAt: 3 });
    expect(await Promise.all([first, queued, dropped])).toEqual([true, true, false]);
    expect(store.health()).toMatchObject({ state: 'degraded', dropped: 0, droppedLowPriority: 1, lastGapAt: null });
    await store.close();
    const lines = (await readFile(options.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JournalEvidence);
    expect(lines.map(line => line.entityType)).toEqual(['fill', 'command']);
  });
});

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

});

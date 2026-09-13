import { describe, expect, it, vi } from 'vitest';
import { createJournalAccountingBackfill, readJournalResponseText } from '../lib/journalAccountingBackfill';
import { journalObservation, projectJournalEvidence, type JournalEvidence } from '../lib/tradovateJournalEvidence';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import { journalAccountsFixture } from './fixtures/journalAccounts';

describe('bounded accounting backfill', () => {
  it('recovers own net PnL for twelve accounts from late fee and pair lists', () => {
    const fixture = journalAccountsFixture(undefined, 12, true);
    const rows = fixture.events.filter(row => !['fillfee', 'fillpair'].includes(row.entityType));
    expect(projectJournalAccounts(rows, fixture.accounts).ready).toHaveLength(0);
    const cache = createJournalAccountingBackfill();
    for (const type of ['fillfee', 'fillpair'] as const) {
      const data = fixture.events.filter(row => row.entityType === type).map(row => row.entity);
      const result = cache.select(type, data, cache.begin(), 4000);
      for (const observation of result.observations) {
        cache.remember(observation);
        const sequence = rows.length + 1000;
        rows.push({ ...fixture.events[0], ...observation, sequence, id: sequence.toString(16).padStart(64, '0') });
      }
      expect(cache.select(type, data, cache.begin(), 5000).observations).toEqual([]);
    }
    const projected = projectJournalAccounts(rows, fixture.accounts);
    expect(projected.ready.map(row => row.history.netPnl)).toEqual(Array.from({ length: 12 }, (_, i) => (i + 1) * 19));
  });

  it('retains late corrections and fences an older REST result by stream revision, not milliseconds', () => {
    const cache = createJournalAccountingBackfill();
    cache.remember(journalObservation('fillfee', { id: 1, commission: 2 }, 'stream', 'Created', 10)!);
    const start = cache.begin();
    cache.remember(journalObservation('fillfee', { id: 1, commission: 3 }, 'stream', 'Updated', 10)!);
    expect(cache.select('fillfee', [{ id: 1, commission: 2 }], start, 10)).toMatchObject({ observations: [], contended: 1 });
    expect(cache.select('fillfee', [{ id: 1, commission: 4 }], cache.begin(), 20).observations[0].entity.commission).toBe(4);
  });

  it('does not resurrect deleted fees and treats their net PnL as unknown', () => {
    const cache = createJournalAccountingBackfill();
    const fixture = journalAccountsFixture(undefined, 1);
    const original = fixture.events.find(row => row.entityType === 'fillfee')!;
    const deleted: JournalEvidence = { ...original, entity: { id: original.entity.id }, eventType: 'Deleted', receivedAt: 9000, id: 'deleted' };
    cache.remember(deleted);
    expect(cache.select('fillfee', [original.entity], cache.begin(), 10_000).observations).toEqual([]);
    expect(projectJournalEvidence([...fixture.events, deleted]).fills[0].fees).toBeNull();
  });

  it('does not treat absence, empty fees or metadata as zero fees or repaired coverage', () => {
    const fixture = journalAccountsFixture(undefined, 1);
    const missing = fixture.events.filter(row => row.entityType !== 'fillfee');
    const cache = createJournalAccountingBackfill();
    expect(cache.select('fillfee', [], cache.begin(), 10).observations).toEqual([]);
    const extras = [journalObservation('fillfee', { id: 10 }, 'snapshot', 'Backfill', 4000)!,
      journalObservation('connection', { state: 'disconnected' }, 'transport', 'Observed', 3500)!,
      journalObservation('journalbackfill', { id: 'read', kind: 'observed', scanned: 0 }, 'snapshot', 'Observed', 4000)!];
    const rows = [...missing, ...extras.map((row, index) => ({ ...fixture.events[0], ...row, id: `extra-${index}`, sequence: 900 + index }))];
    expect(projectJournalEvidence(rows)).toMatchObject({ gaps: [{ from: 3500, to: null }], issues: [] });
    expect(projectJournalEvidence(rows).fills.every(row => row.fees === null)).toBe(true);
  });

  it('validates the complete bounded list and never retains private response fields', () => {
    const cache = createJournalAccountingBackfill();
    for (const data of [null, {}, [{ id: 1 }, {}], [{ id: 1 }, { id: 1 }], Array.from({ length: 10_001 }, (_, i) => ({ id: i + 1 }))]) {
      expect(() => cache.select('fillfee', data, cache.begin(), 10)).toThrow('invalid-list');
    }
    expect(cache.select('fillfee', [{ id: 1, commission: 2, token: 'private' }], cache.begin(), 10).observations[0].entity)
      .toEqual({ id: 1, commission: 2 });
  });

  it('fences an overflowing cache and records evidence again after observer reset', () => {
    const cache = createJournalAccountingBackfill(1);
    const start = cache.begin();
    for (const id of [1, 2]) cache.remember(journalObservation('fillfee', { id, commission: 2 }, 'stream', 'Updated', 10)!);
    expect(cache.select('fillfee', [{ id: 1, commission: 1 }], start, 20).contended).toBe(1);
    cache.reset();
    expect(cache.select('fillfee', [{ id: 2, commission: 2 }], cache.begin(), 30).observations).toHaveLength(1);
  });

  it('bounds chunked bodies before parsing and decodes split multibyte text', async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8)); }, cancel: cancelled });
    await expect(readJournalResponseText(new Response(stream), 10)).rejects.toThrow('response-too-large');
    expect(cancelled).toHaveBeenCalledTimes(1);
    await expect(readJournalResponseText(new Response('too big', { headers: { 'content-length': '100' } }), 10)).rejects.toThrow('response-too-large');
    const encoded = new TextEncoder().encode('Příliš');
    const split = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    expect(await readJournalResponseText(new Response(split), 100)).toBe('Příliš');
  });
});

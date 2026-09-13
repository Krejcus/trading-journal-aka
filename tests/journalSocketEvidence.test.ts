import { describe, expect, it } from 'vitest';
import { visitJournalSocketEvidence } from '../lib/journalSocketEvidence';
import { journalObservation, type JournalObservation } from '../lib/tradovateJournalEvidence';

const capture = (message: unknown) => {
  const events: JournalObservation[] = [];
  visitJournalSocketEvidence(message, (type, entity, source, eventType) => {
    const safe = journalObservation(type, entity, source, eventType, 1234);
    if (safe) events.push(safe);
  });
  return events;
};

describe('journal wire evidence', () => {
  it('accepts single and batched props, keeping broker timestamps and receipt time separate', () => {
    const item = { entityType: 'executionReport', eventType: 'Created', entity: {
      id: 1, orderId: 2, timestamp: '2026-09-12T12:00:00.123Z', secret: 'omit',
    } };
    const single = capture({ e: 'props', d: item });
    expect(single).toEqual(capture({ d: [{ e: 'props', d: [item] }] }));
    expect(single[0]).toMatchObject({ receivedAt: 1234, source: 'stream', eventType: 'Created',
      entity: { timestamp: '2026-09-12T12:00:00.123Z' } });
    expect(single[0].entity).not.toHaveProperty('secret');
  });

  it('never fabricates evidence from errors, empty snapshots, unknown fields or internal event types', () => {
    expect(capture({ i: 1, s: 200, d: { positions: [], accounts: [{ id: 1 }], accessToken: 'omit' } })).toEqual([]);
    expect(capture({ i: 1, s: 403, d: { orders: [{ id: 1 }] } })).toEqual([]);
    expect(capture({ i: 1, s: 200, d: { 'p-ticket': 'retry', orders: [{ id: 1 }] } })).toEqual([]);
    expect(capture({ e: 'props', d: [
      { entityType: 'connection', entity: { state: 'synced' } },
      { entityType: 'copylink', entity: { id: 'forged' } },
      { entityType: 'positionsnapshot', entity: { id: 'forged', kind: 'complete', rowCount: 0 } },
      { entityType: 'journalbackfill', entity: { id: 'forged', kind: 'observed', scanned: 0 } },
      { entityType: 2, entity: { id: 1 } },
    ] })).toEqual([]);
  });
});

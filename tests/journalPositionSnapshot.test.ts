import { describe, expect, it } from 'vitest';
import { journalSnapshotAnchors, positionSnapshotObservations } from '../lib/journalPositionSnapshot';
import { buildJournalPositionEpisodes } from '../lib/journalPositionEpisodes';
import { journalObservation, type JournalEvidence, type JournalObservation } from '../lib/tradovateJournalEvidence';

const from = Date.parse('2026-09-12T10:00:00Z'), to = from + 100;
const lanes = [{ accountId: 1, contractId: 10 }, { accountId: 2, contractId: 20 }, { accountId: 3, contractId: 10 }];
const evidence = (rows: JournalObservation[]): JournalEvidence[] => rows.map((row, index) => ({ ...row,
  id: String(index + 1), sequence: index + 1, sessionId: 'one', connectionId: 'conn', environment: 'demo' }));
const snapshot = () => positionSnapshotObservations('snapshot', [{ id: 1 }, { id: 2 }], [{ accountId: 2, contractId: 20, netPos: 2 }], from, to);

describe('complete position snapshot evidence', () => {
  it('anchors previously unseen instruments for explicitly visible accounts only, at completion', () => {
    expect(journalSnapshotAnchors(evidence(snapshot()), lanes, [])).toEqual([
      { accountId: 1, contractId: 10, at: to, net: 0 }, { accountId: 2, contractId: 20, at: to, net: 2 },
    ]);
  });
  it('rejects missing or duplicated rows, changed request bounds and missing completion', () => {
    const rows = snapshot();
    for (const broken of [rows.filter(row => row.entity.kind !== 'position'), [...rows, rows[1]],
      rows.map(row => row.entity.kind === 'position' ? { ...row, entity: { ...row.entity, startedAt: from - 1 } } : row),
      rows.filter(row => row.entity.accountId !== 2 || row.entity.kind !== 'complete')]) {
      expect(journalSnapshotAnchors(evidence(broken), lanes, []).map(anchor => anchor.accountId)).toEqual([1]);
    }
  });
  it('does not accept gaps, concurrent exposure updates or late fills inside the request window', () => {
    expect(journalSnapshotAnchors(evidence(snapshot()), lanes, [{ from: from + 10, to: to + 10 }])).toEqual([]);
    for (const type of ['fill', 'position'] as const) {
      const change = journalObservation(type, { id: 99, accountId: 1, contractId: 10, netPos: 1,
        timestamp: new Date(from + 50).toISOString() }, 'stream', 'Updated', to + 1000)!;
      expect(journalSnapshotAnchors(evidence([...snapshot(), change]), lanes, []).map(anchor => anchor.accountId)).toEqual([2]);
    }
  });
  it('rejects malformed/partial REST results instead of declaring a zero position', () => {
    for (const [accounts, positions] of [[null, []], [[{ id: 1 }], null], [[{ id: 1 }], [{ accountId: 2, contractId: 10, netPos: 0 }]],
      [[{ id: 1 }], [{ accountId: 1, contractId: 10 }]], [[{ id: 1 }, { id: 1 }], []]]) {
      expect(() => positionSnapshotObservations('snapshot', accounts, positions, from, to)).toThrow();
    }
  });
  it('builds a new full trade from empty initial positions and never backdates that proof', () => {
    const base = positionSnapshotObservations('snapshot', [{ id: 1 }], [], from, to);
    const add = (type: string, entity: Record<string, string | number>, at = to + 10) => base.push(journalObservation(type, entity, 'stream', 'Created', at)!);
    add('contract', { id: 10, name: 'MNQU6' });
    for (const [id, side, price, at] of [[1, 'Buy', 20000, to + 1000], [2, 'Sell', 20005, to + 2000]] as const) {
      add('order', { id, accountId: 1, contractId: 10, action: side }, at);
      add('fill', { id, orderId: id, accountId: 1, contractId: 10, action: side, qty: 1, price, timestamp: new Date(at).toISOString() }, at);
      add('fillfee', { id, commission: 1, commissionCurrencyId: 840 }, at);
    }
    add('fillpair', { id: 1, buyFillId: 1, sellFillId: 2, qty: 1 }, to + 2000);
    const { episodes, unassignedFillIds } = buildJournalPositionEpisodes(evidence(base));
    expect(unassignedFillIds).toEqual([]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ entryAt: to + 1000, exitAt: to + 2000, entryPrice: 20000, exitPrice: 20005,
      history: { netPnl: 8, position: { status: 'closed' } } });
    const oldFills = base.map(row => row.entityType === 'fill' ? { ...row, entity: { ...row.entity, timestamp: new Date(from - 1000).toISOString() } } : row);
    expect(buildJournalPositionEpisodes(evidence(oldFills)).episodes).toEqual([]);
  });
  it('keeps identical snapshots on other sessions/connections from completing a partial set', () => {
    const rows = evidence(snapshot());
    rows.find(row => row.entity.kind === 'position')!.sessionId = 'other';
    expect(journalSnapshotAnchors(rows, lanes, []).map(anchor => anchor.accountId)).toEqual([1]);
  });
});

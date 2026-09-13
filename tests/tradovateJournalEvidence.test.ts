import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { journalObservation, projectJournalEvidence, type JournalEvidence, type JournalEntityType } from '../lib/tradovateJournalEvidence';
import { validateJournalBatch } from '../server/tradovateJournalStore';

let sequence = 0;
const event = (entityType: JournalEntityType, entity: Record<string, string | number | boolean>, receivedAt = 1_000): JournalEvidence => {
  const payload = { ...journalObservation(entityType, entity, 'stream', 'Updated', receivedAt)!,
    connectionId: 'connection-1', environment: 'demo' as const,
    sessionId: '11111111-1111-4111-8111-111111111111', sequence: ++sequence };
  return { ...payload, id: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
};
const order = event('order', { id: 10, accountId: 1, contractId: 5, action: 'Sell', ordStatus: 'Working' });
const change = (id: number, price: number, at: number, outcome = 'Replaced') => [
  event('orderversion', { id, orderId: 10, orderType: 'Stop', orderQty: 2, stopPrice: price }),
  event('command', { id, orderId: 10, commandType: 'Modify', timestamp: new Date(at - 50).toISOString() }),
  event('executionreport', { id: id + 100, commandId: id, orderId: 10, execType: outcome, timestamp: new Date(at).toISOString() }),
];
describe('journal broker evidence', () => {
  it('keeps every confirmed intraminute change, ignores delivery order and replay duplicates', () => {
    const rows = [order, ...change(20, 100, 12_123), ...change(21, 101, 12_456), ...change(22, 102, 48_789)];
    const projection = projectJournalEvidence([...rows].reverse().concat(rows));
    expect(projection.protection.map(item => [item.at, item.price, item.status])).toEqual([
      [12_123, 100, 'confirmed'], [12_456, 101, 'confirmed'], [48_789, 102, 'confirmed'],
    ]);
  });
  it('does not confuse rejected or unconfirmed versions with active protection', () => {
    const projection = projectJournalEvidence([order, ...change(20, 100, 12_123), ...change(21, 101, 15_234, 'Rejected'),
      event('orderversion', { id: 22, orderId: 10, stopPrice: 102, orderType: 'Stop', orderQty: 2 })]);
    expect(projection.protection.filter(item => item.status === 'confirmed').map(item => item.price)).toEqual([100]);
    expect(projection.protection.find(item => item.price === 101)?.status).toBe('rejected');
    expect(projection.protection.find(item => item.price === 102)?.status).toBe('pending');
  });
  it('requires the command-to-order identity even if a report has a matching number', () => {
    const rows = change(20, 100, 12_123);
    rows[1] = event('command', { id: 20, orderId: 999, commandType: 'Modify' });
    expect(projectJournalEvidence([order, ...rows]).protection[0].status).toBe('pending');
  });
  it('preserves own fills and own fees across 12 accounts without multiplier arithmetic', () => {
    const rows = Array.from({ length: 12 }, (_, index) => [
      event('order', { id: index + 1, accountId: index + 100, action: 'Buy' }),
      event('fill', { id: index + 50, orderId: index + 1, contractId: 5, qty: index + 1, price: 100 + index / 4, timestamp: new Date(10_123 + index * 37).toISOString() }),
      event('fillfee', { id: index + 50, commission: index + 0.5, commissionCurrencyId: 840 }),
    ]).flat();
    const fills = projectJournalEvidence(rows).fills;
    expect(fills).toHaveLength(12);
    expect(fills[11]).toMatchObject({ accountId: 111, at: 10_530, price: 102.75, quantity: 12, fees: 11.5 });
  });
  it('never treats missing fees, currencies or invalidated fills as confirmed net PnL', () => {
    const fill = event('fill', { id: 50, orderId: 10, contractId: 5, qty: 2, price: 100 });
    expect(projectJournalEvidence([order, fill]).fills[0].fees).toBeNull();
    const fee = event('fillfee', { id: 50, commission: 2, commissionCurrencyId: 840, exchangeFee: 1, exchangeCurrencyId: 978 });
    expect(projectJournalEvidence([order, fill, fee]).fills[0].fees).toBeNull();
    expect(projectJournalEvidence([order, fill, event('fill', { ...fill.entity, active: false } as Record<string, string | number | boolean>, 2_000)]).fills).toEqual([]);
  });
  it('marks gaps independently of successful snapshots and uses received-time labels for unknown times', () => {
    const rows = [event('connection', { state: 'starting' }, 100), event('connection', { state: 'synced' }, 200),
      event('connection', { state: 'disconnected' }, 300), event('connection', { state: 'disconnected' }, 400)];
    expect(projectJournalEvidence(rows).gaps).toEqual([{ from: 100, to: 200 }, { from: 300, to: null }]);
    expect(projectJournalEvidence([order, event('fill', { id: 50, orderId: 10, contractId: 5, qty: 2, price: 100 }, 321)]).fills[0]).toMatchObject({ at: 321, timeSource: 'received' });
  });
  it('rejects cross-connection/environment evidence and strips fields outside the explicit allowlist', () => {
    expect(() => projectJournalEvidence([order, { ...order, id: 'other', connectionId: 'other' }])).toThrow('mixed-connections');
    expect(journalObservation('account', { accessToken: 'secret' }, 'snapshot', 'Observed', 1)).toBeNull();
    expect(journalObservation('fill', { id: 1, accessToken: 'secret', nested: {} }, 'stream', 'Updated', 1)?.entity).toEqual({ id: 1 });
    expect(() => validateJournalBatch([order], 'other', 'demo')).toThrow('invalid-journal-connection');
    expect(() => validateJournalBatch([{ ...order, environment: 'live' }], 'connection-1', 'demo')).toThrow('invalid-journal-connection');
    expect(validateJournalBatch([order], 'connection-1', 'demo')).toEqual([order]);
  });
});

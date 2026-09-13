import { positionSnapshotObservations } from '../../lib/journalPositionSnapshot';
import type { Account } from '../../types';
import { journalObservation, type JournalEntityType, type JournalEvidence } from '../../lib/tradovateJournalEvidence';

/** Fictional raw broker observations: twelve independent executions, distinct
 * times, quantities and fees. Tests exercise the same projection as import. */
export function journalAccountsFixture(connectionId = '33333333-3333-4333-8333-333333333333', count = 12, initialSnapshot = false) {
  const events: JournalEvidence[] = [];
  const accounts: Pick<Account, 'id' | 'oauth'>[] = [];
  const add = (type: JournalEntityType, entity: Record<string, number | string | boolean | null>, at: number, source: 'stream' | 'snapshot' = 'stream') => {
    const sequence = events.length + 1;
    events.push({ ...journalObservation(type, entity, source, 'Created', at)!, connectionId, environment: 'demo',
      sequence, id: sequence.toString(16).padStart(64, '0'), sessionId: '55555555-5555-4555-8555-555555555555' });
  };
  add('contract', { id: 1, name: 'MNQU6' }, 0);
  if (initialSnapshot) {
    for (const row of positionSnapshotObservations('initial', Array.from({ length: count }, (_, index) => ({ id: index + 1 })), [], 0, 100)) {
      add(row.entityType, row.entity, row.receivedAt, 'snapshot');
    }
  }
  for (let id = 1; id <= count; id++) {
    accounts.push({ id: `ce4990b0-0c8c-40e0-a790-${String(id).padStart(12, '0')}`,
      oauth: { provider: 'tradovate', environment: 'demo', connectionId, externalAccountId: String(id), firm: null } });
    if (!initialSnapshot) add('position', { id, accountId: id, contractId: 1, netPos: 0 }, 0);
    for (const [fillId, action, price, at] of [[id * 10, 'Buy', 20_000 + id, 1000 + id], [id * 10 + 1, 'Sell', 20_010 + id, 2000 + id]] as const) {
      add('fill', { id: fillId, orderId: fillId, accountId: id, contractId: 1, action, price, qty: id, timestamp: new Date(at).toISOString() }, at);
      add('fillfee', { id: fillId, commission: id * 0.5, commissionCurrencyId: 840 }, at);
    }
    add('fillpair', { id, buyFillId: id * 10, sellFillId: id * 10 + 1, qty: id, active: true }, 3000);
  }
  return { events, accounts };
}

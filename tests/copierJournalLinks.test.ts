import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '../services/copierStore';
import { copierJournalLinks } from '../services/copierJournalLinks';

describe('historical copier ownership', () => {
  it('uses the observed owner of each historical leader order after leader changes', () => {
    const snapshot = emptySnapshot();
    snapshot.links = [['100', []], ['200', []], ['300', []]];
    const owners = new Map([
      ['100', { connectionId: 'old-connection', accountId: 1 }],
      ['200', { connectionId: 'new-connection', accountId: 2 }],
    ]);
    const links = copierJournalLinks(snapshot, id => owners.get(id) ?? null, 123);
    expect(links.map(link => link.entity)).toMatchObject([
      { leaderConnectionId: 'old-connection', leaderAccountId: 1, accountId: 1, orderId: '100' },
      { leaderConnectionId: 'new-connection', leaderAccountId: 2, accountId: 2, orderId: '200' },
    ]);
    expect(links).toHaveLength(2);
  });
  it('does not create a copy for an order with unknown or ambiguous ownership', () => {
    const snapshot = emptySnapshot();
    snapshot.links = [['100', []]];
    expect(copierJournalLinks(snapshot, () => null, 123)).toEqual([]);
  });
});

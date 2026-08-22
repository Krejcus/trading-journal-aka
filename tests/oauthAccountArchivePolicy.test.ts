import { describe, expect, it } from 'vitest';
import { accountRemovalDecision } from '../lib/oauthAccountArchivePolicy';
import type { Account } from '../types';

const oauthAccount: Account = {
  id: '0f0f0f0f-1111-4111-8111-222222222222',
  name: 'Tradeify hlavní',
  initialBalance: 50_000,
  type: 'Funded',
  status: 'Active',
  currency: 'USD',
  createdAt: 1,
  oauth: {
    provider: 'tradovate',
    environment: 'demo',
    externalAccountId: '62364058',
    connectionId: 'connection-1',
    firm: 'Tradeify',
  },
};

describe('OAuth account archive policy', () => {
  it('nahradí mazání OAuth účtu archivací a zachová jeho ID', () => {
    const decision = accountRemovalDecision([oauthAccount], oauthAccount, 1234);
    expect(decision.kind).toBe('archive');
    if (decision.kind !== 'archive') throw new Error('expected archive');
    expect(decision.accounts).toEqual([{ ...oauthAccount, status: 'Inactive', isArchived: true, archivedAt: 1234 }]);
  });

  it('běžný účet ponechá ve stávajícím delete flow', () => {
    const regular = { ...oauthAccount, id: 'regular', oauth: undefined };
    expect(accountRemovalDecision([regular], regular)).toEqual({ kind: 'delete', id: 'regular' });
  });
});

import { describe, expect, it } from 'vitest';
import type { Account } from '../types';
import { funeralAccountScope, planMultiAccountFuneral, type FailureData } from '../lib/accountFuneralPlan';

const account = (id: string, firm = 'Tradeify'): Account => ({
  id, name: id, initialBalance: 50_000, type: 'Funded', phase: 'Funded', status: 'Active', currency: 'USD', createdAt: 1,
  firmOverride: firm,
  oauth: { provider: 'tradovate', environment: 'demo', connectionId: `connection-${firm}`, externalAccountId: id, firm },
});

describe('multi-account funeral plan', () => {
  it('buries only checked accounts, shares the incident and preserves per-account stats', () => {
    const failureData: FailureData = {
      reason: 'Porušení max drawdownu', whatHappened: 'Kopírovaný obchod protnul floor.', amountLost: 0,
      daysOfConsistency: 0, progressPct: 0, keyLesson: 'Po breach vše ručně ověřit.', failureDate: '2026-08-22',
      successorByAccountId: { a: 'successor', c: 'successor-lucid' },
    };
    const result = planMultiAccountFuneral({
      accounts: [account('a'), account('b'), account('c', 'Lucid'), account('successor'), account('successor-lucid', 'Lucid')],
      selectedAccountIds: ['a', 'c'], failureData,
      statsByAccountId: {
        a: { amountLost: 2_000, progressPct: 70, daysConsistency: 8 },
        c: { amountLost: 1_500, progressPct: 30, daysConsistency: 4 },
      },
      archivedAt: 123, funeralGroupId: 'funeral-1',
    });
    expect(result.find(item => item.id === 'a')).toMatchObject({ status: 'Inactive', result: 'Failed', failureAmountLost: 2_000, failureGroupId: 'funeral-1', successorOfAccountId: 'successor' });
    expect(result.find(item => item.id === 'c')).toMatchObject({ status: 'Inactive', result: 'Failed', failureAmountLost: 1_500, failureWhatHappened: failureData.whatHappened, successorOfAccountId: 'successor-lucid' });
    expect(result.find(item => item.id === 'b')).toEqual(account('b'));
    expect(result.find(item => item.id === 'successor')).toEqual(account('successor'));
  });

  it('offers active OAuth accounts across firms and preselects breach plus opener', () => {
    const inactive = { ...account('inactive', 'Lucid'), status: 'Inactive' as const };
    const manual = { ...account('manual'), oauth: undefined };
    const scope = funeralAccountScope({
      accounts: [account('tradeify'), account('lucid', 'Lucid'), account('safe', 'Lucid'), inactive, manual],
      openedAccountId: 'tradeify',
      breachedAccountIds: ['lucid'],
    });
    expect(scope.accounts.map(item => item.id)).toEqual(['tradeify', 'lucid', 'safe']);
    expect(scope.groups.map(group => [group.firm, group.accounts.map(item => item.id)]))
      .toEqual([['LUCID', ['lucid', 'safe']], ['TRADEIFY', ['tradeify']]]);
    expect(new Set(scope.selectedAccountIds)).toEqual(new Set(['tradeify', 'lucid']));
  });
});

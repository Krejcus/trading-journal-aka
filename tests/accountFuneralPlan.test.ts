import { describe, expect, it } from 'vitest';
import type { Account } from '../types';
import { planMultiAccountFuneral, type FailureData } from '../lib/accountFuneralPlan';

const account = (id: string): Account => ({
  id, name: id, initialBalance: 50_000, type: 'Funded', phase: 'Funded', status: 'Active', currency: 'USD', createdAt: 1,
});

describe('multi-account funeral plan', () => {
  it('buries only checked accounts, shares the incident and preserves per-account stats', () => {
    const failureData: FailureData = {
      reason: 'Porušení max drawdownu', whatHappened: 'Kopírovaný obchod protnul floor.', amountLost: 0,
      daysOfConsistency: 0, progressPct: 0, keyLesson: 'Po breach vše ručně ověřit.', failureDate: '2026-08-22',
      successorOfAccountId: 'successor',
    };
    const result = planMultiAccountFuneral({
      accounts: [account('a'), account('b'), account('c'), account('successor')],
      selectedAccountIds: ['a', 'c'], failureData,
      statsByAccountId: {
        a: { amountLost: 2_000, progressPct: 70, daysConsistency: 8 },
        c: { amountLost: 1_500, progressPct: 30, daysConsistency: 4 },
      },
      archivedAt: 123, funeralGroupId: 'funeral-1',
    });
    expect(result.find(item => item.id === 'a')).toMatchObject({ status: 'Inactive', result: 'Failed', failureAmountLost: 2_000, failureGroupId: 'funeral-1', successorOfAccountId: 'successor' });
    expect(result.find(item => item.id === 'c')).toMatchObject({ status: 'Inactive', result: 'Failed', failureAmountLost: 1_500, failureWhatHappened: failureData.whatHappened });
    expect(result.find(item => item.id === 'b')).toEqual(account('b'));
    expect(result.find(item => item.id === 'successor')).toEqual(account('successor'));
  });
});

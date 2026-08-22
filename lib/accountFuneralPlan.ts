import type { Account } from '../types';

export interface FailureData {
  reason: string;
  whatHappened: string;
  amountLost: number;
  daysOfConsistency: number;
  progressPct: number;
  keyLesson: string;
  failureDate: string;
  selectedAccountIds?: string[];
  successorOfAccountId?: string;
}

export interface FuneralAccountStats {
  amountLost: number;
  progressPct: number;
  daysConsistency: number;
}

export function planMultiAccountFuneral({
  accounts,
  selectedAccountIds,
  failureData,
  statsByAccountId,
  archivedAt,
  funeralGroupId,
}: {
  accounts: readonly Account[];
  selectedAccountIds: readonly string[];
  failureData: FailureData;
  statsByAccountId: Readonly<Record<string, FuneralAccountStats>>;
  archivedAt: number;
  funeralGroupId: string;
}): Account[] {
  const selected = new Set(selectedAccountIds);
  return accounts.map(account => {
    if (!selected.has(account.id) || account.status !== 'Active' || account.type === 'Backtest') return account;
    const stats = statsByAccountId[account.id];
    return {
      ...account,
      status: 'Inactive',
      isArchived: true,
      archivedAt,
      result: 'Failed',
      failureDate: failureData.failureDate,
      failureReason: failureData.reason,
      failureWhatHappened: failureData.whatHappened,
      failureAmountLost: stats?.amountLost ?? failureData.amountLost,
      failureProgressPct: stats?.progressPct ?? failureData.progressPct,
      failureDaysOfConsistency: stats?.daysConsistency ?? failureData.daysOfConsistency,
      failureKeyLesson: failureData.keyLesson,
      failureGroupId: funeralGroupId,
      ...(failureData.successorOfAccountId ? { successorOfAccountId: failureData.successorOfAccountId } : {}),
    };
  });
}

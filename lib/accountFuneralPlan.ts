import type { Account } from '../types';
import { firmOf } from '../utils/accountFirm';

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
  successorByAccountId?: Record<string, string>;
}

export interface FuneralAccountStats {
  amountLost: number;
  progressPct: number;
  daysConsistency: number;
}

export interface FuneralAccountGroup {
  firm: string;
  accounts: Account[];
}

/** Všechny aktivní OAuth účty napříč firmami + případný ruční účet, odkud se dialog otevřel. */
export function funeralAccountScope({
  accounts,
  openedAccountId,
  breachedAccountIds = [],
  preferredAccountIds = [],
}: {
  accounts: readonly Account[];
  openedAccountId: string;
  breachedAccountIds?: readonly string[];
  preferredAccountIds?: readonly string[];
}): { accounts: Account[]; groups: FuneralAccountGroup[]; selectedAccountIds: string[] } {
  const available = accounts.filter(account => account.status === 'Active' && account.type !== 'Backtest'
    && (account.oauth != null || account.id === openedAccountId));
  const availableIds = new Set(available.map(account => account.id));
  const selected = new Set([openedAccountId, ...breachedAccountIds, ...preferredAccountIds]
    .filter(accountId => availableIds.has(accountId)));
  const byFirm = new Map<string, Account[]>();
  for (const account of available) {
    const firm = firmOf(account);
    byFirm.set(firm, [...(byFirm.get(firm) ?? []), account]);
  }
  return {
    accounts: available,
    groups: [...byFirm.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'cs'))
      .map(([firm, firmAccounts]) => ({ firm, accounts: firmAccounts })),
    selectedAccountIds: [...selected],
  };
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
      ...((failureData.successorByAccountId?.[account.id] || failureData.successorOfAccountId)
        ? { successorOfAccountId: failureData.successorByAccountId?.[account.id] || failureData.successorOfAccountId }
        : {}),
    };
  });
}

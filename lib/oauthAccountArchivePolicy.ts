import type { Account } from '../types';

export type AccountRemovalDecision =
  | { kind: 'archive'; accounts: Account[] }
  | { kind: 'delete'; id: string };

export const accountRemovalDecision = (
  accounts: readonly Account[],
  account: Account,
  now = Date.now(),
): AccountRemovalDecision => {
  if (!account.oauth) return { kind: 'delete', id: account.id };
  return {
    kind: 'archive',
    accounts: accounts.map(item => item.id === account.id ? {
      ...item,
      status: 'Inactive',
      isArchived: true,
      archivedAt: now,
    } : item),
  };
};

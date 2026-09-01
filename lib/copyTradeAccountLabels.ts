import type { TradovateAccountProfile } from './tradovateAccountProfileTypes';
import type { LiveAccount, LiveGroup } from '../services/tradecopiaLiveService';

export type CopyTradeAccountRole = 'leader' | 'follower';

export interface CopyTradeAccountLabelSources {
  accountsById: ReadonlyMap<number, LiveAccount>;
  profilesById: ReadonlyMap<number, TradovateAccountProfile>;
  sourceGroupsById: ReadonlyMap<string, LiveGroup>;
}

export interface CopyTradeAccountLabelInput extends CopyTradeAccountLabelSources {
  accountId: number;
  groupId?: string | null;
  role?: CopyTradeAccountRole;
}

const sourceGroupForAccount = (
  sourceGroupsById: ReadonlyMap<string, LiveGroup>,
  accountId: number,
  groupId?: string | null,
): LiveGroup | undefined => {
  const exact = groupId ? sourceGroupsById.get(groupId) : undefined;
  if (exact) return exact;
  return [...sourceGroupsById.values()].find(group => (
    group.leaderAccountId === accountId
    || group.followers.some(follower => follower.accountId === accountId)
  ));
};

/**
 * Jediná UI kaskáda názvu copier účtu:
 * LIVE snapshot -> profil displayName -> profil accountName -> uložená source
 * group -> bezpečný fallback s ID. Neprovádí žádné párování ani změnu dat.
 */
export function copyTradeAccountName({
  accountId,
  groupId,
  role,
  accountsById,
  profilesById,
  sourceGroupsById,
}: CopyTradeAccountLabelInput): string {
  const account = accountsById.get(accountId);
  const profile = profilesById.get(accountId);
  const source = sourceGroupForAccount(sourceGroupsById, accountId, groupId);
  const sourceName = role === 'leader' || (role == null && source?.leaderAccountId === accountId)
    ? source?.leaderName
    : source?.followers.find(follower => follower.accountId === accountId)?.accountName;
  return account?.name
    || profile?.displayName
    || profile?.accountName
    || sourceName
    || `Účet ${accountId}`;
}

/** Formát pro blokery/toasty; neznámý název už sám obsahuje jednoznačné ID. */
export function copyTradeAccountLabel(input: CopyTradeAccountLabelInput): string {
  const name = copyTradeAccountName(input);
  return name === `Účet ${input.accountId}` ? name : `${name} (ID ${input.accountId})`;
}

export function createCopyTradeAccountLabelResolver(sources: CopyTradeAccountLabelSources) {
  return (accountId: number, groupId?: string | null, role?: CopyTradeAccountRole) => copyTradeAccountLabel({
    ...sources,
    accountId,
    groupId,
    role,
  });
}

/**
 * Konzervativní UI-only překlad známých account ID v textu staršího workeru.
 * Původní Error, relay payload, audit ani log se nemění.
 */
export function formatKnownCopyTradeAccountIds(
  message: string,
  accountIds: Iterable<number>,
  label: (accountId: number) => string,
): string {
  const ids = [...new Set(accountIds)]
    .filter(accountId => Number.isSafeInteger(accountId) && accountId > 0)
    .sort((left, right) => String(right).length - String(left).length || left - right);
  let rendered = message;
  for (const accountId of ids) {
    const token = String(accountId);
    const pattern = new RegExp(`\\b${token}\\b`, 'g');
    rendered = rendered.replace(pattern, (match, offset: number, whole: string) => {
      if (whole.slice(Math.max(0, offset - 3), offset) === 'ID ') return match;
      const resolved = label(accountId);
      // Bez známého názvu už původní prefix „Účet “ tvoří správný fallback.
      if (resolved === `Účet ${accountId}`
        && whole.slice(Math.max(0, offset - 5), offset).toLocaleLowerCase('cs-CZ') === 'účet ') {
        return match;
      }
      return resolved;
    });
  }
  return rendered;
}

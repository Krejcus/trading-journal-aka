import { describe, expect, it } from 'vitest';
import {
  copyTradeAccountLabel,
  copyTradeAccountName,
  formatKnownCopyTradeAccountIds,
} from '../lib/copyTradeAccountLabels';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { LiveAccount, LiveGroup } from '../services/tradecopiaLiveService';

const account = (id: number, name: string) => ({ id, name } as LiveAccount);
const profile = (displayName?: string, accountName?: string) => ({
  displayName,
  accountName,
} as TradovateAccountProfile);
const source = (accountId: number, accountName: string) => ({
  id: 'main',
  leaderAccountId: 10,
  leaderName: 'Source leader',
  followers: [{ accountId, accountName }],
} as LiveGroup);

const resolve = (
  accountId: number,
  accountsById: ReadonlyMap<number, LiveAccount>,
  profilesById: ReadonlyMap<number, TradovateAccountProfile>,
  sourceGroupsById: ReadonlyMap<string, LiveGroup>,
) => copyTradeAccountName({
  accountId,
  groupId: 'main',
  role: 'follower',
  accountsById,
  profilesById,
  sourceGroupsById,
});

describe('copyTradeAccountLabel', () => {
  it('dodržuje jedinou kaskádu snapshot → profil displayName → accountName → source group → fallback', () => {
    const sourceGroupsById = new Map([['main', source(57, 'Source follower')]]);

    expect(resolve(
      57,
      new Map([[57, account(57, 'Snapshot follower')]]),
      new Map([[57, profile('Profile display', 'Profile account')]]),
      sourceGroupsById,
    )).toBe('Snapshot follower');
    expect(resolve(57, new Map(), new Map([[57, profile('Profile display', 'Profile account')]]), sourceGroupsById))
      .toBe('Profile display');
    expect(resolve(57, new Map(), new Map([[57, profile('', 'Profile account')]]), sourceGroupsById))
      .toBe('Profile account');
    expect(resolve(57, new Map(), new Map(), sourceGroupsById)).toBe('Source follower');
    expect(resolve(99, new Map(), new Map(), new Map())).toBe('Účet 99');
  });

  it('formátuje známý název s ID a neznámý účet bez zdvojeného fallbacku', () => {
    const sources = {
      accountsById: new Map([[57, account(57, 'TDFYG50335049318')]]),
      profilesById: new Map<number, TradovateAccountProfile>(),
      sourceGroupsById: new Map<string, LiveGroup>(),
    };
    expect(copyTradeAccountLabel({ accountId: 57, ...sources })).toBe('TDFYG50335049318 (ID 57)');
    expect(copyTradeAccountLabel({ accountId: 99, ...sources })).toBe('Účet 99');
  });

  it('překládá známé ID pouze při UI renderu a zachová již formátované ID', () => {
    const label = (accountId: number) => accountId === 57 ? 'TDFYG50335049318 (ID 57)' : `Účet ${accountId}`;
    expect(formatKnownCopyTradeAccountIds(
      'Účet 57 není viditelný; účet 99 také chybí.',
      [57, 99],
      label,
    )).toBe('Účet TDFYG50335049318 (ID 57) není viditelný; účet 99 také chybí.');
    expect(formatKnownCopyTradeAccountIds('TDFYG50335049318 (ID 57)', [57], label))
      .toBe('TDFYG50335049318 (ID 57)');
  });
});

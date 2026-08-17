import { describe, expect, it } from 'vitest';
import { copyGroupAccountIds, sameCopyGroupAccounts } from '../lib/localCopierAgentProtocol';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group = (id: string, leader: number | null, followers: number[]): CopyGroupConfig => ({
  id,
  name: id,
  enabled: true,
  leaderAccountId: leader,
  followers: followers.map(accountId => ({ accountId, mode: 'on-submit', multiplier: 1 })),
});

describe('local copier agent group matching', () => {
  it('matches UI and runtime groups only when the exact account set is equal', () => {
    expect(sameCopyGroupAccounts(group('ui', 11, [22]), group('runtime', 11, [22]))).toBe(true);
    expect(sameCopyGroupAccounts(group('ui', 11, [22, 33]), group('runtime', 11, [22]))).toBe(false);
    expect(sameCopyGroupAccounts(group('ui', 11, [33]), group('runtime', 11, [22]))).toBe(false);
    expect(sameCopyGroupAccounts(group('ui', 22, [11]), group('runtime', 11, [22]))).toBe(false);
  });

  it('sorts account ids and rejects an incomplete group', () => {
    expect(copyGroupAccountIds(group('ui', 22, [11]))).toEqual([11, 22]);
    expect(sameCopyGroupAccounts(group('ui', null, [22]), group('runtime', 11, [22]))).toBe(false);
  });
});

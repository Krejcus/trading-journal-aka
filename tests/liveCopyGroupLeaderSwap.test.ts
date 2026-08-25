import { describe, expect, it } from 'vitest';
import { changeCopyGroupLeader } from '../components/LiveCopyTradeOverview';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group = (): CopyGroupConfig => ({
  id: 'group-1',
  name: 'Hlavní',
  enabled: true,
  leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-fill', multiplier: 0.5, maxContracts: 3 },
    { accountId: 300, mode: 'on-submit', multiplier: 2 },
  ],
  localOnly: true,
});

describe('changeCopyGroupLeader', () => {
  it('atomically swaps the previous leader into the promoted follower slot', () => {
    const original = group();
    const changed = changeCopyGroupLeader(original, 200);

    expect(changed.leaderAccountId).toBe(200);
    expect(changed.followers).toEqual([
      { accountId: 300, mode: 'on-submit', multiplier: 2 },
      { accountId: 100, mode: 'on-fill', multiplier: 0.5, maxContracts: 3 },
    ]);
    expect(new Set([changed.leaderAccountId, ...changed.followers.map(follower => follower.accountId)])).toEqual(new Set([100, 200, 300]));
    expect(original).toEqual(group());
  });

  it('uses safe defaults when the new leader was not already a follower', () => {
    const changed = changeCopyGroupLeader(group(), 400);

    expect(changed.leaderAccountId).toBe(400);
    expect(changed.followers).toContainEqual({ accountId: 100, mode: 'on-submit', multiplier: 1 });
    expect(changed.followers.map(follower => follower.accountId)).toEqual([200, 300, 100]);
  });

  it('is a no-op when the selected leader is unchanged', () => {
    const original = group();
    expect(changeCopyGroupLeader(original, 100)).toBe(original);
  });
});

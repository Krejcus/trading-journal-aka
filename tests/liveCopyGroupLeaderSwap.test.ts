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
  it('promote follower@2 vrátí předchozího leadera jako bezpečného followera@1', () => {
    const original = group();
    const changed = changeCopyGroupLeader(original, 300);

    expect(changed.leaderAccountId).toBe(300);
    expect(changed.followers).toEqual([
      { accountId: 200, mode: 'on-fill', multiplier: 0.5, maxContracts: 3 },
      { accountId: 100, mode: 'on-submit', multiplier: 1 },
    ]);
    expect(new Set([changed.leaderAccountId, ...changed.followers.map(follower => follower.accountId)])).toEqual(new Set([100, 200, 300]));
    expect(original).toEqual(group());
  });

  it('promote follower bez legacy násobku vrátí předchozího leadera jako followera@1', () => {
    const legacyGroup = {
      ...group(),
      followers: [{ accountId: 200, mode: 'on-fill' }],
    } as CopyGroupConfig;
    const changed = changeCopyGroupLeader(legacyGroup, 200);

    expect(changed.leaderAccountId).toBe(200);
    expect(changed.followers).toEqual([
      { accountId: 100, mode: 'on-submit', multiplier: 1 },
    ]);
  });

  it('nepřidá předchozího leadera, který není v aktuálním OAuth snapshotu', () => {
    const changed = changeCopyGroupLeader(group(), 200, [200, 300]);

    expect(changed.leaderAccountId).toBe(200);
    expect(changed.followers).toEqual([
      { accountId: 300, mode: 'on-submit', multiplier: 2 },
    ]);
  });

  it('is a no-op when the selected leader is unchanged', () => {
    const original = group();
    expect(changeCopyGroupLeader(original, 100)).toBe(original);
  });
});

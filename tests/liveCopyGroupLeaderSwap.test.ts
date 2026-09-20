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
  it('nový leader z followerů mezi followery nezůstane — sám sebe nekopíruje', () => {
    const original = group();
    const changed = changeCopyGroupLeader(original, 300);

    expect(changed.leaderAccountId).toBe(300);
    expect(changed.followers).toEqual([
      { accountId: 200, mode: 'on-fill', multiplier: 0.5, maxContracts: 3 },
    ]);
    expect(original).toEqual(group());
  });

  it('předchozího leadera nepřesune mezi followery ani při povýšení followera', () => {
    // Přidat obchodující účet do skupiny musí být vědomé rozhodnutí. Dřív se
    // starý leader doplnil sám a proklikání seznamu označilo všechny účty.
    const changed = changeCopyGroupLeader(group(), 200);

    expect(changed.followers.map(follower => follower.accountId)).toEqual([300]);
    expect(changed.followers.some(follower => follower.accountId === 100)).toBe(false);
  });

  it('leader zvolený mimo skupinu nechá followery beze změny', () => {
    const changed = changeCopyGroupLeader(group(), 400);

    expect(changed.leaderAccountId).toBe(400);
    expect(changed.followers).toEqual(group().followers);
  });

  it('projití všech účtů jako leaderů skupinu nenafoukne', () => {
    let current = group();
    for (const accountId of [400, 500, 600, 400]) current = changeCopyGroupLeader(current, accountId);

    expect(current.leaderAccountId).toBe(400);
    expect(current.followers.map(follower => follower.accountId)).toEqual([200, 300]);
  });

  it('projití followerů jako leaderů je vratné bez ztráty nastavení ostatních', () => {
    const viaFollower = changeCopyGroupLeader(group(), 200);
    const back = changeCopyGroupLeader(viaFollower, 100);

    expect(back.leaderAccountId).toBe(100);
    // 200 se stal leaderem, takže z followerů vypadl a sám se nevrátí.
    expect(back.followers).toEqual([{ accountId: 300, mode: 'on-submit', multiplier: 2 }]);
  });

  it('volba stejného leadera nic nemění', () => {
    const original = group();
    expect(changeCopyGroupLeader(original, 100)).toBe(original);
  });
});

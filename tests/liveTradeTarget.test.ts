import { describe, expect, it } from 'vitest';
import {
  GROUP_TARGET,
  SAMPLE_LIVE_TRADE_GROUP,
  effectiveTarget,
  limitAccount,
  participatingFollowers,
  soloTradeBlockReason,
  targetMultiplier,
  type LiveTradeGroup,
} from '../lib/liveTradeTarget';

const armed: LiveTradeGroup = { ...SAMPLE_LIVE_TRADE_GROUP, armed: true };
const disarmed: LiveTradeGroup = { ...SAMPLE_LIVE_TRADE_GROUP, armed: false };
const byId = (group: LiveTradeGroup, id: string) => [group.leader, ...group.followers, ...group.outside].find(a => a.id === id)!;

describe('trade target picker', () => {
  it('blocks the leader and in-copy followers only while the copier is armed', () => {
    expect(soloTradeBlockReason(armed.leader, true)).toMatch(/rozkopíroval/);
    expect(soloTradeBlockReason(byId(armed, 'tradeify-50k-1'), true)).toMatch(/zastaví celou skupinu/);
    expect(soloTradeBlockReason(armed.leader, false)).toBeNull();
    expect(soloTradeBlockReason(byId(disarmed, 'tradeify-50k-1'), false)).toBeNull();
  });

  it('treats an unverified copier state as armed', () => {
    const unknown: LiveTradeGroup = { ...SAMPLE_LIVE_TRADE_GROUP, armed: null };
    expect(soloTradeBlockReason(unknown.leader, null)).toMatch(/není ověřený/);
    expect(soloTradeBlockReason(byId(unknown, 'tradeify-50k-2'), null)).toMatch(/není ověřený/);
    expect(effectiveTarget(unknown, { kind: 'account', accountId: 'tradeify-50k-1' })).toEqual(GROUP_TARGET);
    expect(targetMultiplier(unknown, GROUP_TARGET)).toBe(4);
  });

  it('always allows an excluded follower and an account outside the group', () => {
    expect(soloTradeBlockReason(byId(armed, 'tradeify-50k-3'), true)).toBeNull();
    expect(soloTradeBlockReason(byId(armed, 'tradeify-100k'), true)).toBeNull();
  });

  it('falls back to the group when a picked account becomes blocked', () => {
    const t1 = { kind: 'account', accountId: 'tradeify-50k-1' } as const;
    expect(effectiveTarget(disarmed, t1)).toEqual(t1);
    expect(effectiveTarget(armed, t1)).toEqual(GROUP_TARGET);
  });

  it('counts the leader plus in-copy followers for the group multiplier', () => {
    expect(participatingFollowers(armed)).toHaveLength(3);
    expect(targetMultiplier(armed, GROUP_TARGET)).toBe(4);
    expect(targetMultiplier(disarmed, GROUP_TARGET)).toBe(1);
    expect(targetMultiplier(armed, { kind: 'account', accountId: 'tradeify-50k-3' })).toBe(1);
  });

  it('checks the day limit of the picked account, the leader for the group', () => {
    expect(limitAccount(armed, GROUP_TARGET).id).toBe('lucid-50k');
    expect(limitAccount(armed, { kind: 'account', accountId: 'tradeify-100k' }).dayLimitUsd).toBe(2000);
  });
});

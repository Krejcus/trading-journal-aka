import { describe, expect, it } from 'vitest';
import { assertCopierArmConnections, CopierArmBlockedError, copierArmRejection, prepareCopierArmGroup } from '../lib/copierArmPreparation';
import { isWeakerRiskConfig } from '../lib/copierRiskConfig';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';

const group = (id: string, cooldown: number): CopyGroupConfig => ({
  id, name: id, enabled: true, leaderAccountId: 11,
  followers: [{ accountId: 22, multiplier: 1, mode: 'on-submit' }],
  safety: { ...structuredClone(DEFAULT_COPY_GROUP_SAFETY), entryCooldownMinutes: cooldown },
});
const runtime = (current: CopyGroupConfig, sessionArmedAt = 123) => ({
  group: current, controller: { sessionArmedAt },
}) as Pick<LocalCopierAgentStatus, 'group' | 'controller'>;

describe('ARM preserves the session risk floor', () => {
  it('switches Hlavní 1 minute to FN default 0 without weakening either config or changing topology', () => {
    const main = group('main', 1);
    main.safety!.armExpiryFlatten = 'off';
    const fn = group('fn', 0);
    fn.leaderAccountId = 33;
    fn.followers = [{ accountId: 44, multiplier: 1, mode: 'on-submit' }];
    const before = structuredClone({ main, fn });
    const result = prepareCopierArmGroup(fn, runtime(main));
    expect(result.group).toMatchObject({ id: 'fn', leaderAccountId: 33, followers: fn.followers, safety: { entryCooldownMinutes: 1, armExpiryFlatten: 'followers' } });
    expect(result.preservedRules).toEqual(['pauza mezi obchody']);
    expect(isWeakerRiskConfig(main, result.group)).toEqual([]);
    expect(isWeakerRiskConfig(fn, result.group)).toEqual([]);
    expect({ main, fn }).toEqual(before);
  });

  it('keeps stricter candidate limits and does not restore a stale same-ID risk value', () => {
    const previous = group('main', 2);
    previous.safety!.dailyLossLimitUsd = 500;
    const requested = group('main', 0);
    requested.safety!.dailyLossLimitUsd = 200;
    expect(prepareCopierArmGroup(requested, runtime(previous)).group.safety)
      .toMatchObject({ entryCooldownMinutes: 2, dailyLossLimitUsd: 200 });
  });

  it('does not carry yesterday rules when the worker reports a fresh session', () => {
    const requested = group('fn', 0);
    expect(prepareCopierArmGroup(requested, runtime(group('main', 20), 0)))
      .toEqual({ group: requested, preservedRules: [] });
  });

  it('preserves enabled daily limits and stronger rule actions', () => {
    const previous = group('main', 1);
    Object.assign(previous.safety!, { dailyLossLimitUsd: 500, dailyMaxTrades: 5, dailyMaxLosingTrades: 2, armExpiryFlatten: 'group' });
    previous.safety!.dayRuleActions.maxTrades.atLimit = { kind: 'lock' };
    const requested = group('fn', 0);
    const result = prepareCopierArmGroup(requested, runtime(previous));
    expect(result.group.safety).toMatchObject({ dailyLossLimitUsd: 500, dailyMaxTrades: 5, dailyMaxLosingTrades: 2, armExpiryFlatten: 'group' });
    expect(result.group.safety!.dayRuleActions.maxTrades.atLimit).toEqual({ kind: 'lock' });
    expect(isWeakerRiskConfig(previous, result.group)).toEqual([]);
  });

  it('preserves the prior trading window if the candidate had no window', () => {
    const previous = group('main', 1);
    previous.safety!.tradingWindow.enabled = true;
    const result = prepareCopierArmGroup(group('fn', 0), runtime(previous));
    expect(result.group.safety!.tradingWindow).toEqual(previous.safety!.tradingWindow);
  });

  it('blocks incompatible windows instead of widening the candidate window', () => {
    const previous = group('main', 1);
    previous.safety!.tradingWindow = { enabled: true, from: '09:00', to: '12:00', timeZone: 'UTC' };
    const requested = group('fn', 0);
    requested.safety!.tradingWindow = { enabled: true, from: '10:00', to: '14:00', timeZone: 'UTC' };
    expect(() => prepareCopierArmGroup(requested, runtime(previous))).toThrow('obchodní okno');
  });

  it('does not invent cuts for another account or silently increase multipliers', () => {
    const previous = group('main', 1);
    previous.followers[0].dailyLossCutUsd = 100;
    const requested = group('fn', 0);
    requested.followers = [{ accountId: 33, mode: 'on-submit', multiplier: 1 }];
    expect(() => prepareCopierArmGroup(requested, runtime(previous))).toThrow(CopierArmBlockedError);
    requested.followers = [{ ...previous.followers[0], multiplier: 2 }];
    expect(() => prepareCopierArmGroup(requested, runtime(previous))).toThrow('omezení follower účtu');
  });

  it('rejects invalid safety rather than replacing it with defaults', () => {
    const requested = group('fn', 0);
    requested.safety!.entryCooldownMinutes = Number.NaN;
    expect(() => prepareCopierArmGroup(requested, runtime(group('main', 1)))).toThrow('nejsou úplná');
  });
});

describe('execution connection precheck', () => {
  const device = (connectionId: string) => ({ connectionId, state: 'paired' as const, deviceId: connectionId, deviceName: 'Mac' });
  const connections = { lucid: { accounts: [{ id: 11 }] }, fn: { accounts: [{ id: 22 }] } };
  it('requires a loaded paired worker route even when all accounts are OAuth-visible', () => {
    expect(() => assertCopierArmConnections(group('fn', 0), { devices: [device('lucid')] }, connections)).toThrow('ještě není zapojené');
    expect(() => assertCopierArmConnections(group('fn', 0), { devices: [device('lucid'), device('fn')] }, connections)).not.toThrow();
  });
  it('rejects a pending pairing and ambiguous account ownership', () => {
    expect(() => assertCopierArmConnections(group('fn', 0), { devices: [device('lucid'), { ...device('fn'), state: 'pairing-required' }] }, connections)).toThrow(CopierArmBlockedError);
    expect(() => assertCopierArmConnections(group('fn', 0), { devices: [device('lucid'), device('fn')] }, { ...connections, duplicate: connections.fn })).toThrow('jednoznačně');
  });
  it('ignores disabled/excluded followers but never excludes the leader', () => {
    const requested = group('main', 0);
    requested.followers[0].mode = 'off';
    expect(() => assertCopierArmConnections(requested, { device: device('lucid') }, connections)).not.toThrow();
    expect(() => assertCopierArmConnections(group('main', 0), { device: device('lucid') }, connections, [22])).not.toThrow();
    expect(() => assertCopierArmConnections(group('main', 0), { device: device('fn') }, connections, [11])).toThrow('ještě není zapojené');
  });
});

describe('known rejection versus unknown outcome', () => {
  it('recognizes local prechecks, relay and worker risk rejection', () => {
    expect(copierArmRejection(new CopierArmBlockedError('Chybí připojení'))).toBe('Chybí připojení');
    expect(copierArmRejection(new Error('tighten-only'))).toContain('odmítnuto');
    expect(copierArmRejection(new Error('Pravidla jdou dnes jen zpřísnit: safety.entryCooldownMinutes (reset po konci session)'))).toContain('pauza mezi obchody');
  });
  it.each(['Worker timeout', 'Příkaz včas nepotvrdil', 'network error', 'tighten-only timeout'])('keeps %s unknown', message => {
    expect(copierArmRejection(new Error(message))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertCopierRiskConfigAcknowledged,
  COPIER_RISK_CONFIG_CAPABILITY,
  supportsCopierRiskConfig,
} from '../lib/copierWorkerCapabilities';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import { sanitizeCopyGroups, type CopyGroupConfig } from '../services/liveCopyTrading';

const group = (): CopyGroupConfig => sanitizeCopyGroups([{
  id: 'risk-test', name: 'Risk', enabled: true, leaderAccountId: 11,
  followers: [
    { accountId: 22, mode: 'on-submit', multiplier: 1, maxContracts: 3, dailyLossCutUsd: 500, onCut: 'let-run' },
    { accountId: 33, mode: 'on-submit', multiplier: 1 },
  ],
}])![0];

const ack = (confirmed = group()): LocalCopierAgentStatus => ({
  version: 1,
  capabilities: [COPIER_RISK_CONFIG_CAPABILITY],
  environment: 'demo', nonce: 'test-only', startedAt: '2026-09-05T00:00:00Z',
  group: confirmed,
  controller: {} as LocalCopierAgentStatus['controller'],
});

describe('copier worker Risk capabilities', () => {
  it('requires explicit support, not merely an available version-1 status', () => {
    expect(supportsCopierRiskConfig(null)).toBe(false);
    expect(supportsCopierRiskConfig(undefined)).toBe(false);
    expect(supportsCopierRiskConfig({})).toBe(false);
    expect(supportsCopierRiskConfig({ capabilities: ['another-feature'] })).toBe(false);
    expect(supportsCopierRiskConfig({ capabilities: 'risk-config-v1' as unknown as string[] })).toBe(false);
    expect(supportsCopierRiskConfig(ack())).toBe(true);
  });

  it('rejects an old worker ACK even when the returned defaults look equivalent', () => {
    const legacy = ack();
    delete legacy.capabilities;
    expect(() => assertCopierRiskConfigAcknowledged(group(), legacy)).toThrow('aktualizuj worker');
  });

  it('accepts equivalent defaults and follower order without comparing presentation fields', () => {
    const expected = group();
    const confirmed = group();
    confirmed.name = 'Worker name';
    confirmed.followers.reverse();
    confirmed.followers[0].onCut = 'close-copy';
    confirmed.followers[0].dailyLossCutUsd = 0;
    confirmed.safety!.tradingWindow.additional = [];
    expect(() => assertCopierRiskConfigAcknowledged(expected, ack(confirmed))).not.toThrow();
  });

  it.each(['maxContracts', 'dailyLossCutUsd', 'onCut'] as const)('rejects a silently dropped follower %s', key => {
    const confirmed = group();
    delete confirmed.followers[0][key];
    expect(() => assertCopierRiskConfigAcknowledged(group(), ack(confirmed))).toThrow(key);
  });

  it('rejects a silently dropped pause action', () => {
    const expected = group();
    expected.safety!.dayRuleActions.losingTrades.atLimit = { kind: 'pause', minutes: 45 };
    const confirmed = group();
    expect(() => assertCopierRiskConfigAcknowledged(expected, ack(confirmed))).toThrow('dayRuleActions');
  });

  it('rejects a silently dropped additional trading window', () => {
    const expected = group();
    expected.safety!.tradingWindow = {
      enabled: true, from: '09:00', to: '10:00', timeZone: 'Europe/Prague',
      additional: [{ from: '13:00', to: '14:00' }],
    };
    const confirmed = structuredClone(expected);
    delete confirmed.safety!.tradingWindow.additional;
    expect(() => assertCopierRiskConfigAcknowledged(expected, ack(confirmed))).toThrow('tradingWindow');
  });

  it('rejects a configuration from another group or a missing follower', () => {
    const other = group();
    other.id = 'other';
    expect(() => assertCopierRiskConfigAcknowledged(group(), ack(other))).toThrow('skupina');
    const missing = group();
    missing.followers.pop();
    expect(() => assertCopierRiskConfigAcknowledged(group(), ack(missing))).toThrow('účty skupiny');
  });
});

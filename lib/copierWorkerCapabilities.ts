import type { LocalCopierAgentStatus } from './localCopierAgentProtocol.js';
import { sanitizeCopyGroups, type CopyGroupConfig } from '../services/liveCopyTrading.js';

export const COPIER_RISK_CONFIG_CAPABILITY = 'risk-config-v1';

export const supportsCopierRiskConfig = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_RISK_CONFIG_CAPABILITY);

/**
 * A transport ACK does not prove that a worker understood every setting.
 * Legacy workers accepted update-group but stripped unknown risk fields.
 * Check capability and the returned configuration before announcing a save.
 * Defaults and follower order have no effect on the comparison.
 */
export const assertCopierRiskConfigAcknowledged = (
  requested: CopyGroupConfig,
  acknowledged: LocalCopierAgentStatus,
): void => {
  if (!supportsCopierRiskConfig(acknowledged)) {
    throw new Error('Mac worker nepodporuje nová Risk pravidla. Nejdřív aktualizuj worker; uložení nebylo potvrzeno.');
  }
  const expected = sanitizeCopyGroups([requested])?.[0];
  const actual = sanitizeCopyGroups([acknowledged.group])?.[0];
  if (!expected || !actual) {
    throw new Error('Worker nevrátil platnou konfiguraci Risk. Uložení nebylo potvrzeno.');
  }

  const differences: string[] = [];
  if (expected.id !== actual.id || expected.leaderAccountId !== actual.leaderAccountId) {
    differences.push('skupina');
  }
  for (const key of Object.keys(expected.safety!) as Array<keyof NonNullable<CopyGroupConfig['safety']>>) {
    if (JSON.stringify(expected.safety![key]) !== JSON.stringify(actual.safety![key])) {
      differences.push(`safety.${key}`);
    }
  }
  const actualFollowers = new Map(actual.followers.map(follower => [follower.accountId, follower]));
  if (actualFollowers.size !== actual.followers.length
    || new Set(expected.followers.map(follower => follower.accountId)).size !== expected.followers.length
    || expected.followers.length !== actual.followers.length) {
    differences.push('účty skupiny');
  }
  for (const follower of expected.followers) {
    const returned = actualFollowers.get(follower.accountId);
    if (!returned) {
      differences.push(`účet ${follower.accountId}`);
      continue;
    }
    for (const key of ['maxContracts', 'dailyLossCutUsd', 'onCut'] as const) {
      const fallback = key === 'onCut' ? 'close-copy' : undefined;
      if ((follower[key] ?? fallback) !== (returned[key] ?? fallback)) {
        differences.push(`účet ${follower.accountId}: ${key}`);
      }
    }
  }
  if (differences.length > 0) {
    throw new Error(`Worker nepotvrdil požadované Risk nastavení (${differences.join(', ')}). Zkontroluj skutečný stav workeru před dalším použitím.`);
  }
};

import type { LocalCopierAgentStatus } from './localCopierAgentProtocol.js';
import { sanitizeCopyGroups, type CopyGroupConfig } from '../services/liveCopyTrading.js';

export const COPIER_RISK_CONFIG_CAPABILITY = 'risk-config-v1';
/** Worker vyžaduje u ON po incidentu výslovné potvrzení (8. 10. 2026). */
export const COPIER_INCIDENT_ACK_CAPABILITY = 'incident-ack-v1';

/** Worker umí vyřadit followera i s jeho vlastní pozicí (10. 10. 2026). */
export const COPIER_FOLLOWER_EXCLUDE_EXPOSURE_CAPABILITY = 'follower-exclude-exposure-v1';

export const supportsCopierFollowerExcludeWithExposure = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_FOLLOWER_EXCLUDE_EXPOSURE_CAPABILITY);

/** Worker po výpadku spojení sám pokračuje (10. 10. 2026; jen se serverovou pojistkou). */
export const COPIER_TRANSPORT_AUTO_RESUME_CAPABILITY = 'transport-auto-resume-v1';

export const supportsCopierTransportAutoResume = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_TRANSPORT_AUTO_RESUME_CAPABILITY);

/** Worker umí odeslat ruční vstup z grafu na leadera (fáze 1b, 29. 10. 2026). */
export const COPIER_MANUAL_ENTRY_CAPABILITY = 'manual-entry-v1';

export const supportsCopierManualEntry = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ENTRY_CAPABILITY);

/** Worker umí spravovat vlastní ruční vstup z grafu (fáze 2a, 29. 10. 2026). */
export const COPIER_MANUAL_ORDER_MANAGE_CAPABILITY = 'manual-order-manage-v1';

export const supportsCopierManualOrderManage = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_MANUAL_ORDER_MANAGE_CAPABILITY);

/** Worker umí smazat svou skupinu a běžet bez skupiny (11. 10. 2026). */
export const COPIER_GROUP_DELETE_CAPABILITY = 'group-delete-v1';

export const supportsCopierGroupDelete = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_GROUP_DELETE_CAPABILITY);

/**
 * Execution skupina workeru, nebo `null`, když ji operátor smazal a worker
 * běží bez skupiny (`group` ve statusu je pak jen poslední známý zástupce).
 */
export const copierWorkerExecutionGroup = (
  status: Pick<LocalCopierAgentStatus, 'group' | 'controller'> | null | undefined,
): CopyGroupConfig | null => {
  if (!status) return null;
  const retired = status.controller?.retiredGroup;
  return retired && retired.groupId === status.group.id ? null : status.group;
};

export const supportsCopierIncidentAck = (
  status: Pick<LocalCopierAgentStatus, 'capabilities'> | null | undefined,
): boolean => Array.isArray(status?.capabilities)
  && status.capabilities.includes(COPIER_INCIDENT_ACK_CAPABILITY);

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

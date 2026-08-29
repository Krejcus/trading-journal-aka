import type {
  CopyGroupConfig,
  LiveCopyTradingCommand,
  LiveCopyTradingCommandResult,
} from '../services/liveCopyTrading';
import type {
  CopierControllerStatus,
  CopierStuckOperationKind,
} from '../services/copierRuntimeController';

export const LOCAL_COPIER_AGENT_PORT = 3211;
export const LOCAL_COPIER_AGENT_BASE_URL = `http://127.0.0.1:${LOCAL_COPIER_AGENT_PORT}`;

export interface LocalCopierAgentDevice {
  state: 'pairing-required' | 'paired';
  deviceId: string;
  connectionId: string;
  deviceName: string;
  /** Present only until the authenticated AlphaTrade UI confirms pairing. */
  deviceSecret?: string;
  publicKey?: string;
}

export type CopierSnapshotHealthState =
  | 'disabled'
  | 'checking'
  | 'ready'
  | 'cdp-offline'
  | 'layout-missing'
  | 'capture-failed'
  | 'upload-failed';

export interface CopierSnapshotHealth {
  enabled: boolean;
  state: CopierSnapshotHealthState;
  layoutName: string;
  chartIdConfigured: boolean;
  cdpReachable: boolean;
  targetFound: boolean;
  lastCheckedAt: number | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
}

export interface LocalCopierAgentStatus {
  version: 1;
  environment: 'demo';
  nonce: string;
  group: CopyGroupConfig;
  controller: CopierControllerStatus;
  startedAt: string;
  /** Primární relay zařízení; zachováno kvůli kompatibilitě starších UI. */
  device?: LocalCopierAgentDevice;
  /** Jedno odvolatelné zařízení pro každé samostatné OAuth připojení. */
  devices?: LocalCopierAgentDevice[];
  /** Diagnostika obrázků je read-only a nikdy neblokuje broker execution. */
  snapshotHealth?: CopierSnapshotHealth;
}

/**
 * Bezpečnostní zpřísnění odvozené z čerstvého LIVE broker snapshotu.
 * Klient smí účet pouze vyřadit; nikdy touto cestou nesmí obnovit `active`.
 */
export interface LocalCopierAccountExclusion {
  accountId: number;
  state: 'dll-locked' | 'breached';
  reason: string;
}

export type LocalCopierAgentCommand =
  | { type: 'copy-command'; command: LiveCopyTradingCommand }
  /**
   * `group` volitelně synchronizuje UI konfiguraci atomicky před ARMem —
   * jeden relay round-trip místo dvou (update-group + arm-live dělaly
   * z ARMu 5–6 s). Bez `group` se armuje aktuální runtime konfigurace.
   */
  | {
      type: 'arm-live';
      group?: CopyGroupConfig;
      accountEligibilityExclusions?: LocalCopierAccountExclusion[];
    }
  /** Bezpečně vybere jedinou execution skupinu; vždy zůstane DISARMED. */
  | { type: 'activate-group'; group: CopyGroupConfig }
  | { type: 'shadow'; accountEligibilityExclusions?: LocalCopierAccountExclusion[] }
  | { type: 'disarm' }
  | { type: 'kill-switch' }
  | { type: 'reconcile' }
  /** Cílená read-only kontrola jednoho účtu; nemění execution skupinu ani ARM. */
  | { type: 'verify-account-eligibility'; accountId: number }
  /** Pouze naplánuje test TradingView -> APNs; nikdy nečeká v brokerové cestě. */
  | { type: 'snapshot-test'; requestId?: string }
  | { type: 'resolve-stuck-operation'; kind: CopierStuckOperationKind; key: string; reason: string }
  | { type: 'lock-until-session-end'; reason: string }
  | { type: 'device-paired'; deviceId: string };

export interface LocalCopierAgentCommandResult {
  ok: true;
  status: LocalCopierAgentStatus;
  result?: LiveCopyTradingCommandResult;
}

export const copyGroupAccountIds = (group: CopyGroupConfig): number[] => {
  const leaderId = group.leaderAccountId;
  if (!Number.isSafeInteger(leaderId) || Number(leaderId) <= 0) return [];
  return [Number(leaderId), ...group.followers.map(follower => follower.accountId)].sort((a, b) => a - b);
};

export const sameCopyGroupAccounts = (left: CopyGroupConfig, right: CopyGroupConfig): boolean => {
  if (
    !Number.isSafeInteger(left.leaderAccountId)
    || !Number.isSafeInteger(right.leaderAccountId)
    || left.leaderAccountId !== right.leaderAccountId
  ) return false;
  const leftFollowers = left.followers.map(item => item.accountId).sort((a, b) => a - b);
  const rightFollowers = right.followers.map(item => item.accountId).sort((a, b) => a - b);
  return leftFollowers.length > 0
    && leftFollowers.length === rightFollowers.length
    && leftFollowers.every((accountId, index) => accountId === rightFollowers[index]);
};

/**
 * Najde UI skupinu řízenou jedním lokálním agentem.
 *
 * Přesná shoda účtů má přednost. Když operátor právě přidal nebo odebral
 * followera, runtime ještě drží předchozí topologii až do `update-group` před
 * ARM. V takové chvíli dovolíme jediného kandidáta se stejným leaderem. Dva
 * kandidáti jsou úmyslně nejednoznační a vrací null místo hádání.
 */
export const resolveLocalExecutionGroup = (
  groups: readonly CopyGroupConfig[],
  runtimeGroup: CopyGroupConfig,
): CopyGroupConfig | null => {
  // Během leader transition se topologie úmyslně neshoduje. Stabilní ID je
  // proto nejsilnější korelace, pokud je v UI unikátní.
  const sameId = groups.filter(group => group.id === runtimeGroup.id);
  if (sameId.length === 1) return sameId[0];
  if (sameId.length > 1) return null;
  const exact = groups.filter(group => sameCopyGroupAccounts(group, runtimeGroup));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  if (!Number.isSafeInteger(runtimeGroup.leaderAccountId) || Number(runtimeGroup.leaderAccountId) <= 0) {
    return null;
  }
  const sameLeader = groups.filter(group =>
    group.leaderAccountId === runtimeGroup.leaderAccountId
    && group.followers.length > 0);
  return sameLeader.length === 1 ? sameLeader[0] : null;
};

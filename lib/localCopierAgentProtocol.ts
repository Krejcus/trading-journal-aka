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
  /** Novější worker umí bezpečně restartovat TradingView s lokálním CDP. */
  repairSupported?: boolean;
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
  /**
   * Pouze naplánuje observability úkol; nikdy nečeká v brokerové cestě.
   * `repairCamera` je výslovná uživatelská žádost o bezpečný restart
   * TradingView, když běží bez lokálního CDP.
   */
  | { type: 'snapshot-test'; requestId?: string; repairCamera?: boolean }
  | { type: 'resolve-stuck-operation'; kind: CopierStuckOperationKind; key: string; reason: string }
  | { type: 'lock-until-session-end'; reason: string }
  | { type: 'device-paired'; deviceId: string };

export interface LocalCopierAgentCommandResult {
  ok: true;
  status: LocalCopierAgentStatus;
  result?: LiveCopyTradingCommandResult;
}

export type LocalCopierAgentRestartBlocker =
  | 'status-unavailable'
  | 'not-started'
  | 'armed'
  | 'kill-switch'
  | 'disconnected'
  | 'reconciliation-required'
  | 'group-not-flat'
  | 'divergent-accounts'
  | 'working-orders'
  | 'stuck-outbox'
  | 'stuck-operations'
  | 'preflight-missing'
  | 'preflight-inactive'
  | 'preflight-read-only-followers';

const LOCAL_COPIER_AGENT_RESTART_BLOCKERS = new Set<LocalCopierAgentRestartBlocker>([
  'status-unavailable',
  'not-started',
  'armed',
  'kill-switch',
  'disconnected',
  'reconciliation-required',
  'group-not-flat',
  'divergent-accounts',
  'working-orders',
  'stuck-outbox',
  'stuck-operations',
  'preflight-missing',
  'preflight-inactive',
  'preflight-read-only-followers',
]);

export interface SnapshotRepairBlockedIssue {
  code: 'snapshot-repair-blocked';
  blockers: LocalCopierAgentRestartBlocker[];
  divergentAccounts: number[];
  workingOrderAccounts: number[];
  missingAccounts: number[];
  inactiveAccounts: number[];
  readOnlyFollowerAccounts: number[];
}

export type LocalCopierAgentErrorDetails = SnapshotRepairBlockedIssue;

export class LocalCopierAgentCommandError extends Error {
  readonly details?: LocalCopierAgentErrorDetails;

  constructor(message: string, details?: LocalCopierAgentErrorDetails) {
    super(message);
    this.name = 'LocalCopierAgentCommandError';
    this.details = details;
  }
}

export const localCopierAgentErrorDetails = (reason: unknown): LocalCopierAgentErrorDetails | undefined => {
  if (!reason || typeof reason !== 'object') return undefined;
  const details = reason instanceof LocalCopierAgentCommandError
    ? reason.details
    : 'details' in reason ? (reason as { details?: unknown }).details
      : 'issue' in reason ? (reason as { issue?: unknown }).issue
        : undefined;
  if (!details || typeof details !== 'object') return undefined;
  const candidate = details as Partial<SnapshotRepairBlockedIssue>;
  if (candidate.code !== 'snapshot-repair-blocked' || !Array.isArray(candidate.blockers)) return undefined;
  const numberList = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is number => Number.isSafeInteger(item) && item > 0)
    : [];
  return {
    code: 'snapshot-repair-blocked',
    blockers: candidate.blockers.filter((item): item is LocalCopierAgentRestartBlocker => (
      typeof item === 'string'
      && LOCAL_COPIER_AGENT_RESTART_BLOCKERS.has(item as LocalCopierAgentRestartBlocker)
    )),
    divergentAccounts: numberList(candidate.divergentAccounts),
    workingOrderAccounts: numberList(candidate.workingOrderAccounts),
    missingAccounts: numberList(candidate.missingAccounts),
    inactiveAccounts: numberList(candidate.inactiveAccounts),
    readOnlyFollowerAccounts: numberList(candidate.readOnlyFollowerAccounts),
  };
};

/**
 * Diagnostické zrcadlo restart brány. Doplňkové OAuth položky se přidávají
 * jen k už zablokovanému stavu, takže `length === 0` zůstává přesně
 * ekvivalentní nezměněné `canSafelyRestartLocalCopierAgent` bráně.
 */
export const localCopierAgentRestartBlockers = (
  status: CopierControllerStatus | null | undefined,
): LocalCopierAgentRestartBlocker[] => {
  if (status == null) return ['status-unavailable'];
  const blockers: LocalCopierAgentRestartBlocker[] = [];
  if (!status.started) blockers.push('not-started');
  if (status.armed) blockers.push('armed');
  if (status.killSwitch) blockers.push('kill-switch');
  if (!status.connected) blockers.push('disconnected');
  if (status.reconciliationRequired) blockers.push('reconciliation-required');
  if (status.groupFlat !== true) blockers.push('group-not-flat');
  if (status.divergentAccounts.length > 0) blockers.push('divergent-accounts');
  if (status.workingOrderAccounts.length > 0) blockers.push('working-orders');
  if (status.stuckOutbox) blockers.push('stuck-outbox');
  if (status.stuckOperations.length > 0) blockers.push('stuck-operations');
  if (blockers.length > 0) {
    if ((status.oauthPreflight?.missingAccounts.length ?? 0) > 0) blockers.push('preflight-missing');
    if ((status.oauthPreflight?.inactiveAccounts.length ?? 0) > 0) blockers.push('preflight-inactive');
    if ((status.oauthPreflight?.readOnlyFollowerAccounts.length ?? 0) > 0) blockers.push('preflight-read-only-followers');
  }
  return blockers;
};

/** A maintenance restart is allowed only from a freshly verified safe state. */
export const canSafelyRestartLocalCopierAgent = (
  status: CopierControllerStatus | null | undefined,
): boolean => status != null
  && status.started
  && !status.armed
  && !status.killSwitch
  && status.connected
  && !status.reconciliationRequired
  && status.groupFlat === true
  && status.divergentAccounts.length === 0
  && status.workingOrderAccounts.length === 0
  && !status.stuckOutbox
  && status.stuckOperations.length === 0;

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

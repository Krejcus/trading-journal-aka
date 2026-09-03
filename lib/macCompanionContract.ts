export const MAC_COMPANION_CONTRACT_VERSION = 1 as const;
export const MAC_COMPANION_SCOPE = 'copier.status.read' as const;
export const MAC_COMPANION_AUDIENCE = 'mac-companion' as const;
export const MAC_COMPANION_VERIFIED_MAX_AGE_SECONDS = 10 as const;
export const MAC_COMPANION_OFFLINE_AFTER_SECONDS = 90 as const;

export type MacCompanionCopierState = 'live' | 'shadow' | 'disarmed';
export type MacCompanionWorkerLocation = 'mac' | 'vps';
export type MacCompanionReconciliationStatus = 'clean' | 'review' | 'unknown';
export type MacCompanionProblemKind =
  | 'divergence'
  | 'stuck-outbox'
  | 'reconciliation'
  | 'worker-offline';

export interface MacCompanionDivergenceDTO {
  /** Current runtime cannot identify the divergent symbol; null is honest. */
  symbol: string | null;
  /** Redacted role label such as "Follower 2", never an external account id. */
  account: string;
  detail: string;
}

export interface MacCompanionPositionDTO {
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  at: string;
}

export interface MacCompanionFollowerAckDTO {
  confirmed: number;
  total: number;
  failing: Array<{
    account: string;
    detail: string;
    sinceMinutes: number;
  }>;
}

export interface MacCompanionStatusDTO {
  contractVersion: typeof MAC_COMPANION_CONTRACT_VERSION;
  /** Server wall time lets a native client compensate for local clock skew. */
  serverTime: string;
  revision: number;
  observedAt: string;
  validUntil: string;
  freshness: {
    verifiedMaxAgeSeconds: typeof MAC_COMPANION_VERIFIED_MAX_AGE_SECONDS;
    offlineAfterSeconds: typeof MAC_COMPANION_OFFLINE_AFTER_SECONDS;
  };
  copierState: MacCompanionCopierState;
  sessionExpiresAt: string | null;
  worker: {
    lastHeartbeatAt: string;
    location: MacCompanionWorkerLocation;
  };
  brokerConnected: boolean | null;
  /** Leader-only copier ledger. The label is part of the DTO contract. */
  dailyStats?: {
    label: 'Leader · jen obchody přes kopírku · bez poplatků';
    realizedPnlUsd: number;
    losingTrades: number;
  } | null;
  safety: {
    reconciliation: {
      status: MacCompanionReconciliationStatus;
      /** The current runtime does not publish a reconciliation timestamp. */
      at: string | null;
    };
    divergences: MacCompanionDivergenceDTO[];
    outbox: {
      stuckCount: number;
      oldestStuckMinutes: number | null;
    };
    cooldownActive: boolean;
    dayLockActive: boolean;
    killSwitchTripped: boolean;
  };
  exposure: {
    /** Null until a separately approved authoritative broker read exists. */
    verifiedAt: string | null;
    positions: MacCompanionPositionDTO[];
    followerAck: MacCompanionFollowerAckDTO | null;
    accountsWithWorkingOrders: number | null;
  };
  snapshots: {
    cdpReady: boolean;
    lastEntryAt: string | null;
    lastExitAt: string | null;
  };
  problems: Array<{
    kind: MacCompanionProblemKind;
    text: string;
  }>;
}

export type MacCompanionFreshness = 'verified' | 'unknown' | 'worker-offline';
export type MacCompanionPresentationState =
  | MacCompanionCopierState
  | 'intervention'
  | 'unknown'
  | 'worker-offline';

const timestamp = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Pure boundary reducer shared by server tests and mirrored by native clients.
 * Exact specification: 10.000 s is still verified, 10.001 s is unknown,
 * 90.000 s is unknown, and 90.001 s is worker-offline.
 */
export function macCompanionFreshness(
  status: Pick<MacCompanionStatusDTO, 'observedAt' | 'validUntil'>,
  now: number,
): MacCompanionFreshness {
  const observedAt = timestamp(status.observedAt);
  const validUntil = timestamp(status.validUntil);
  if (observedAt == null || validUntil == null || !Number.isFinite(now)) return 'unknown';
  // A future heartbeat is never evidence that the present state is verified.
  if (observedAt > now) return 'unknown';
  const age = now - observedAt;
  if (age > MAC_COMPANION_OFFLINE_AFTER_SECONDS * 1_000) return 'worker-offline';
  const verifiedUntil = Math.min(
    validUntil,
    observedAt + MAC_COMPANION_VERIFIED_MAX_AGE_SECONDS * 1_000,
  );
  if (now > verifiedUntil) return 'unknown';
  return 'verified';
}

export function reduceMacCompanionPresentation(
  status: MacCompanionStatusDTO,
  now: number,
): MacCompanionPresentationState {
  const freshness = macCompanionFreshness(status, now);
  if (freshness !== 'verified') return freshness;
  const followerAckIncomplete = status.copierState === 'live'
    && status.exposure.followerAck != null
    && (
      status.exposure.followerAck.confirmed < status.exposure.followerAck.total
      || status.exposure.followerAck.failing.length > 0
    );
  const verifiedDisarmedExposure = status.copierState === 'disarmed'
    && status.exposure.verifiedAt != null
    && (
      status.exposure.positions.length > 0
      || (status.exposure.accountsWithWorkingOrders ?? 0) > 0
    );
  const hasConfirmedProblem = status.brokerConnected === false
    || status.safety.killSwitchTripped
    || status.safety.reconciliation.status === 'review'
    || status.safety.divergences.length > 0
    || status.safety.outbox.stuckCount > 0
    || followerAckIncomplete
    || verifiedDisarmedExposure
    || status.problems.some(problem =>
      problem.kind === 'divergence'
      || problem.kind === 'stuck-outbox'
      || (problem.kind === 'reconciliation'
        && status.safety.reconciliation.status === 'review'),
    );
  if (hasConfirmedProblem) return 'intervention';
  if (
    status.brokerConnected == null
    || status.safety.reconciliation.status === 'unknown'
  ) return 'unknown';
  if (status.copierState === 'live') {
    const sessionExpiresAt = status.sessionExpiresAt == null
      ? null
      : timestamp(status.sessionExpiresAt);
    if (sessionExpiresAt == null || sessionExpiresAt <= now) return 'unknown';
  }
  // DISARMED is not proof of flat. It needs an authoritative exposure time,
  // no positions and an explicit zero working-order count. A null order count
  // remains unknown even when the position snapshot itself was verified.
  if (status.copierState === 'disarmed') {
    const verifiedFlat = status.exposure.verifiedAt != null
      && status.exposure.positions.length === 0
      && status.exposure.accountsWithWorkingOrders === 0;
    return verifiedFlat ? 'disarmed' : 'unknown';
  }
  return status.copierState;
}

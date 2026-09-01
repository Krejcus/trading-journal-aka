/**
 * Pure state machine for the leader open -> flat safety guard.
 *
 * The module deliberately has no broker/store/runtime dependencies. The runtime
 * supplies one normalized, authoritative batch snapshot and performs any
 * resulting symbol-targeted action. This file can therefore never place or
 * cancel an order by itself.
 */

export type LeaderFlatReplicationMode = 'off' | 'on-submit' | 'on-fill';
export type LeaderFlatCopyLineage = 'confirmed' | 'unproven';

export interface LeaderFlatFollowerOwnership {
  accountId: number;
  /** Snapshot at the opening epoch; later UI/config changes must not erase ownership. */
  replicationModeAtOpen: LeaderFlatReplicationMode;
  /** Eligibility at open, not current eligibility at leader-flat time. */
  eligibleAtOpen: boolean;
  /** Only confirmed copier lineage may authorize an automatic risk-reducing close. */
  copyLineage: LeaderFlatCopyLineage;
  /**
   * Largest same-direction net exposure proven to have been created by this
   * copier epoch. Missing/zero evidence is detect-only. It is an authorization
   * ceiling, never a quantity inferred from the current broker position.
   */
  confirmedNetQuantity?: number;
}

export type LeaderFlatEpochPhase =
  | 'open'
  | 'grace'
  | 'waiting-inflight'
  | 'closing'
  | 'resolved'
  | 'blocked'
  | 'invalidated';

export interface LeaderFlatEpoch {
  id: string;
  groupId: string;
  leaderAccountId: number;
  symbol: string;
  openedAt: number;
  lastLeaderNet: number;
  generation: number;
  phase: LeaderFlatEpochPhase;
  followers: LeaderFlatFollowerOwnership[];
  leaderEntryOrderIds: string[];
  leaderExitOrderIds: string[];
  flatObservedAt?: number;
  graceUntil?: number;
  terminalAt?: number;
  terminalReason?: string;
}

export interface LeaderFlatGuardToken {
  epochId: string;
  generation: number;
}

export interface CreateLeaderFlatEpochInput {
  id: string;
  groupId: string;
  leaderAccountId: number;
  symbol: string;
  openedAt: number;
  leaderNet: number;
  generation?: number;
  followers: readonly LeaderFlatFollowerOwnership[];
  leaderEntryOrderIds?: readonly string[];
  leaderExitOrderIds?: readonly string[];
}

export interface PlanLeaderPositionTransitionInput {
  epoch: LeaderFlatEpoch | null;
  previousKnown: boolean;
  previousNet: number;
  nextNet: number;
  observedAt: number;
  graceMs: number;
  /** Used only when the transition opens a new epoch or directly flips sign. */
  nextEpochId?: string;
  groupId: string;
  leaderAccountId: number;
  symbol: string;
  followersAtOpen: readonly LeaderFlatFollowerOwnership[];
  leaderEntryOrderIds?: readonly string[];
  leaderExitOrderIds?: readonly string[];
}

export type LeaderPositionTransitionPlan =
  | {
    kind: 'ignored';
    reason: 'previous-unknown' | 'no-change';
    epoch: LeaderFlatEpoch | null;
  }
  | { kind: 'opened' | 'updated'; epoch: LeaderFlatEpoch }
  | { kind: 'scheduled'; epoch: LeaderFlatEpoch; token: LeaderFlatGuardToken }
  | {
    kind: 'blocked';
    reason:
      | 'missing-open-epoch'
      | 'epoch-mismatch'
      | 'epoch-position-mismatch'
      | 'epoch-not-open';
    epoch: LeaderFlatEpoch | null;
  };

export interface LeaderFlatPositionSnapshot {
  symbol: string;
  netQuantity: number;
}

export type LeaderFlatExitEvidenceRole =
  | 'copied-exit'
  | 'protective'
  | 'guard-liquidation'
  | 'other';

export type LeaderFlatExitEvidenceStatus =
  | 'sending'
  | 'unknown'
  | 'pending'
  | 'working'
  | 'filled'
  | 'canceled'
  | 'rejected';

/**
 * Normalized evidence built from the durable outbox and the same broker order
 * snapshot as positions. A merely working protective SL is intentionally not
 * an in-flight close: today's stale-SL incident must remain detectable.
 */
export interface LeaderFlatExitEvidence {
  accountId: number;
  symbol: string;
  role: LeaderFlatExitEvidenceRole;
  status: LeaderFlatExitEvidenceStatus;
  updatedAt?: number;
  /** Required lineage for a guard-issued liquidation recovered after restart. */
  epochId?: string;
  /** Leader exit whose copier-issued follower exit this evidence represents. */
  leaderOrderId?: string;
  brokerOrderId?: string;
}

export type LeaderFlatAccountBatchSnapshot =
  | {
    accountId: number;
    ok: true;
    positions: readonly LeaderFlatPositionSnapshot[];
    exitEvidence?: readonly LeaderFlatExitEvidence[];
  }
  | { accountId: number; ok: false; error: string };

export interface LeaderFlatBatchSnapshot {
  observedAt: number;
  accounts: readonly LeaderFlatAccountBatchSnapshot[];
}

export interface LeaderFlatCloseTarget {
  accountId: number;
  symbol: string;
}

export type LeaderFlatEvaluationKind =
  | 'resolved'
  | 'detect-only'
  | 'close-targets'
  | 'wait-inflight'
  | 'blocked';

export interface LeaderFlatEvaluation {
  kind: LeaderFlatEvaluationKind;
  epoch: LeaderFlatEpoch;
  reason: string;
  /** The only writable plan this module can produce. Never account-wide. */
  targets: LeaderFlatCloseTarget[];
  divergentAccountIds: number[];
  detectOnlyAccountIds: number[];
  waitingInflightAccountIds: number[];
  blockedAccountIds: number[];
  waitUntil?: number;
}

export interface EvaluateLeaderFlatBatchInput {
  epoch: LeaderFlatEpoch;
  snapshot: LeaderFlatBatchSnapshot;
  autoCloseFollowerPositions: boolean;
  /** Grace after a terminal copied/protective fill while Position catches up. */
  exitSettlementGraceMs: number;
  /** Delay before a new whole-batch verification of an in-flight exit. */
  inflightRetryMs: number;
}

const finite = (value: number, label: string) => {
  if (!Number.isFinite(value)) throw new Error(`${label} musí být konečné číslo`);
  return value;
};

const positiveAccountId = (value: number, label = 'accountId') => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} musí být kladné celé číslo`);
  return value;
};

const nonEmpty = (value: string, label: string) => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} nesmí být prázdné`);
  return normalized;
};

const duration = (value: number, label: string) => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} musí být nezáporné číslo`);
  return value;
};

const uniqueStrings = (values: readonly string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];

const cloneFollower = (follower: LeaderFlatFollowerOwnership): LeaderFlatFollowerOwnership => ({
  accountId: positiveAccountId(follower.accountId, 'follower accountId'),
  replicationModeAtOpen: follower.replicationModeAtOpen,
  eligibleAtOpen: follower.eligibleAtOpen === true,
  copyLineage: follower.copyLineage,
  ...(follower.confirmedNetQuantity == null
    ? {}
    : { confirmedNetQuantity: finite(follower.confirmedNetQuantity, 'confirmedNetQuantity') }),
});

export function snapshotLeaderFlatFollowers(
  followers: readonly LeaderFlatFollowerOwnership[],
): LeaderFlatFollowerOwnership[] {
  const byAccount = new Map<number, LeaderFlatFollowerOwnership>();
  for (const raw of followers) {
    const follower = cloneFollower(raw);
    if (!['off', 'on-submit', 'on-fill'].includes(follower.replicationModeAtOpen)) {
      throw new Error(`Follower ${follower.accountId} má neplatný replication mode`);
    }
    if (follower.copyLineage !== 'confirmed' && follower.copyLineage !== 'unproven') {
      throw new Error(`Follower ${follower.accountId} má neplatnou copy lineage`);
    }
    const current = byAccount.get(follower.accountId);
    if (!current) {
      byAccount.set(follower.accountId, follower);
      continue;
    }
    if (
      current.replicationModeAtOpen !== follower.replicationModeAtOpen
      || current.eligibleAtOpen !== follower.eligibleAtOpen
    ) {
      throw new Error(`Follower ${follower.accountId} má konfliktní ownership snapshot`);
    }
    // Late ACK may strengthen lineage, but must never weaken the opening snapshot.
    if (follower.copyLineage === 'confirmed') current.copyLineage = 'confirmed';
    if (follower.confirmedNetQuantity != null) {
      if (
        current.confirmedNetQuantity != null
        && current.confirmedNetQuantity !== 0
        && follower.confirmedNetQuantity !== 0
        && Math.sign(current.confirmedNetQuantity) !== Math.sign(follower.confirmedNetQuantity)
      ) {
        throw new Error(`Follower ${follower.accountId} má konfliktní quantity ownership`);
      }
      if (
        current.confirmedNetQuantity == null
        || Math.abs(follower.confirmedNetQuantity) > Math.abs(current.confirmedNetQuantity)
      ) {
        current.confirmedNetQuantity = follower.confirmedNetQuantity;
      }
    }
  }
  return [...byAccount.values()].sort((a, b) => a.accountId - b.accountId);
}

export function createLeaderFlatEpoch(input: CreateLeaderFlatEpochInput): LeaderFlatEpoch {
  if (input.leaderNet === 0) throw new Error('Leader exposure epoch vyžaduje nenulovou pozici');
  const generation = input.generation ?? 1;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Leader exposure generation musí být kladné celé číslo');
  }
  return {
    id: nonEmpty(input.id, 'epoch id'),
    groupId: nonEmpty(input.groupId, 'group id'),
    leaderAccountId: positiveAccountId(input.leaderAccountId, 'leader accountId'),
    symbol: nonEmpty(input.symbol, 'symbol'),
    openedAt: finite(input.openedAt, 'openedAt'),
    lastLeaderNet: finite(input.leaderNet, 'leaderNet'),
    generation,
    phase: 'open',
    followers: snapshotLeaderFlatFollowers(input.followers),
    leaderEntryOrderIds: uniqueStrings(input.leaderEntryOrderIds ?? []),
    leaderExitOrderIds: uniqueStrings(input.leaderExitOrderIds ?? []),
  };
}

export function mergeLeaderFlatEpochLineage(
  epoch: LeaderFlatEpoch,
  update: {
    followers?: readonly LeaderFlatFollowerOwnership[];
    leaderEntryOrderIds?: readonly string[];
    leaderExitOrderIds?: readonly string[];
  },
): LeaderFlatEpoch {
  return {
    ...epoch,
    followers: snapshotLeaderFlatFollowers([...epoch.followers, ...(update.followers ?? [])]),
    leaderEntryOrderIds: uniqueStrings([
      ...epoch.leaderEntryOrderIds,
      ...(update.leaderEntryOrderIds ?? []),
    ]),
    leaderExitOrderIds: uniqueStrings([
      ...epoch.leaderExitOrderIds,
      ...(update.leaderExitOrderIds ?? []),
    ]),
  };
}

const matchesEpoch = (
  epoch: LeaderFlatEpoch,
  input: Pick<PlanLeaderPositionTransitionInput, 'groupId' | 'leaderAccountId' | 'symbol'>,
) => epoch.groupId === input.groupId
  && epoch.leaderAccountId === input.leaderAccountId
  && epoch.symbol === input.symbol;

export function planLeaderPositionTransition(
  input: PlanLeaderPositionTransitionInput,
): LeaderPositionTransitionPlan {
  finite(input.previousNet, 'previousNet');
  finite(input.nextNet, 'nextNet');
  finite(input.observedAt, 'observedAt');
  duration(input.graceMs, 'graceMs');
  positiveAccountId(input.leaderAccountId, 'leader accountId');
  nonEmpty(input.groupId, 'group id');
  nonEmpty(input.symbol, 'symbol');

  if (!input.previousKnown) {
    return { kind: 'ignored', reason: 'previous-unknown', epoch: input.epoch };
  }
  if (input.previousNet === input.nextNet) {
    return { kind: 'ignored', reason: 'no-change', epoch: input.epoch };
  }

  const opening = input.previousNet === 0 && input.nextNet !== 0;
  const directFlip = input.previousNet !== 0
    && input.nextNet !== 0
    && Math.sign(input.previousNet) !== Math.sign(input.nextNet);
  if (opening || directFlip) {
    const next = createLeaderFlatEpoch({
      id: nonEmpty(input.nextEpochId ?? '', 'next epoch id'),
      groupId: input.groupId,
      leaderAccountId: input.leaderAccountId,
      symbol: input.symbol,
      openedAt: input.observedAt,
      leaderNet: input.nextNet,
      generation: (input.epoch?.generation ?? 0) + 1,
      followers: input.followersAtOpen,
      leaderEntryOrderIds: input.leaderEntryOrderIds,
      leaderExitOrderIds: input.leaderExitOrderIds,
    });
    return { kind: 'opened', epoch: next };
  }

  if (input.previousNet !== 0 && input.nextNet === 0) {
    if (!input.epoch) return { kind: 'blocked', reason: 'missing-open-epoch', epoch: null };
    if (!matchesEpoch(input.epoch, input)) {
      return { kind: 'blocked', reason: 'epoch-mismatch', epoch: input.epoch };
    }
    if (input.epoch.lastLeaderNet !== input.previousNet) {
      return { kind: 'blocked', reason: 'epoch-position-mismatch', epoch: input.epoch };
    }
    if (input.epoch.phase !== 'open') {
      return { kind: 'blocked', reason: 'epoch-not-open', epoch: input.epoch };
    }
    const epoch = mergeLeaderFlatEpochLineage(input.epoch, {
      leaderExitOrderIds: input.leaderExitOrderIds,
    });
    const scheduled: LeaderFlatEpoch = {
      ...epoch,
      lastLeaderNet: input.previousNet,
      generation: epoch.generation + 1,
      phase: 'grace',
      flatObservedAt: input.observedAt,
      graceUntil: input.observedAt + input.graceMs,
      terminalAt: undefined,
      terminalReason: undefined,
    };
    return {
      kind: 'scheduled',
      epoch: scheduled,
      token: { epochId: scheduled.id, generation: scheduled.generation },
    };
  }

  if (!input.epoch) return { kind: 'blocked', reason: 'missing-open-epoch', epoch: null };
  if (!matchesEpoch(input.epoch, input)) {
    return { kind: 'blocked', reason: 'epoch-mismatch', epoch: input.epoch };
  }
  if (input.epoch.phase !== 'open') {
    return { kind: 'blocked', reason: 'epoch-not-open', epoch: input.epoch };
  }
  return {
    kind: 'updated',
    epoch: {
      ...mergeLeaderFlatEpochLineage(input.epoch, {
        leaderEntryOrderIds: input.leaderEntryOrderIds,
        leaderExitOrderIds: input.leaderExitOrderIds,
      }),
      lastLeaderNet: input.nextNet,
    },
  };
}

export function invalidateLeaderFlatEpoch(
  epoch: LeaderFlatEpoch,
  reason: string,
  at: number,
): LeaderFlatEpoch {
  return {
    ...epoch,
    generation: epoch.generation + 1,
    phase: 'invalidated',
    terminalAt: finite(at, 'invalidatedAt'),
    terminalReason: nonEmpty(reason, 'invalidation reason'),
  };
}

export function isLeaderFlatGuardTokenCurrent(
  epoch: LeaderFlatEpoch | null,
  token: LeaderFlatGuardToken,
): boolean {
  return epoch != null && epoch.id === token.epochId && epoch.generation === token.generation;
}

const nextEpoch = (
  epoch: LeaderFlatEpoch,
  phase: LeaderFlatEpochPhase,
  at: number,
  reason: string,
  graceUntil?: number,
): LeaderFlatEpoch => ({
  ...epoch,
  generation: epoch.generation + 1,
  phase,
  graceUntil: phase === 'waiting-inflight' && graceUntil != null ? graceUntil : undefined,
  ...(phase === 'resolved' || phase === 'blocked'
    ? { terminalAt: at, terminalReason: reason }
    : { terminalAt: undefined, terminalReason: undefined }),
});

const sortedUniqueNumbers = (values: readonly number[]) => [...new Set(values)].sort((a, b) => a - b);

const evaluation = (
  kind: LeaderFlatEvaluationKind,
  epoch: LeaderFlatEpoch,
  at: number,
  reason: string,
  values: {
    targets?: LeaderFlatCloseTarget[];
    divergent?: number[];
    detectOnly?: number[];
    waiting?: number[];
    blocked?: number[];
    waitUntil?: number;
  } = {},
): LeaderFlatEvaluation => {
  const phase: LeaderFlatEpochPhase = kind === 'resolved'
    ? 'resolved'
    : kind === 'close-targets'
      ? 'closing'
      : kind === 'wait-inflight'
        ? 'waiting-inflight'
        : 'blocked';
  return {
    kind,
    epoch: nextEpoch(epoch, phase, at, reason, values.waitUntil),
    reason,
    targets: [...(values.targets ?? [])]
      .sort((a, b) => a.accountId - b.accountId || a.symbol.localeCompare(b.symbol)),
    divergentAccountIds: sortedUniqueNumbers(values.divergent ?? []),
    detectOnlyAccountIds: sortedUniqueNumbers(values.detectOnly ?? []),
    waitingInflightAccountIds: sortedUniqueNumbers(values.waiting ?? []),
    blockedAccountIds: sortedUniqueNumbers(values.blocked ?? []),
    ...(values.waitUntil != null ? { waitUntil: values.waitUntil } : {}),
  };
};

const accountNet = (
  account: Extract<LeaderFlatAccountBatchSnapshot, { ok: true }>,
  symbol: string,
): number | null => {
  let net = 0;
  for (const position of account.positions) {
    if (position.symbol !== symbol) continue;
    if (!Number.isFinite(position.netQuantity)) return null;
    net += position.netQuantity;
  }
  return Number.isFinite(net) ? net : null;
};

const isInflightExit = (
  evidence: LeaderFlatExitEvidence,
  epoch: LeaderFlatEpoch,
  observedAt: number,
  settlementGraceMs: number,
): boolean => {
  if (evidence.symbol !== epoch.symbol) return false;
  if (evidence.role === 'copied-exit') {
    if (!evidence.leaderOrderId || !epoch.leaderExitOrderIds.includes(evidence.leaderOrderId)) {
      return false;
    }
  }
  if (evidence.role === 'guard-liquidation' && evidence.epochId !== epoch.id) return false;
  const exitRole = evidence.role === 'copied-exit' || evidence.role === 'guard-liquidation';
  if (exitRole && (
    evidence.status === 'sending'
    || evidence.status === 'unknown'
    || evidence.status === 'pending'
    || evidence.status === 'working'
  )) return true;

  // Working/pending protective orders are standing protection, not an exit in
  // flight. Only a fresh terminal protective fill gets a short settlement wait.
  if (evidence.status !== 'filled' || evidence.role === 'other') return false;
  if (evidence.updatedAt == null || !Number.isFinite(evidence.updatedAt)) return false;
  if (epoch.flatObservedAt != null && evidence.updatedAt < epoch.flatObservedAt) return false;
  return observedAt - evidence.updatedAt <= settlementGraceMs;
};

const automaticOwnership = (follower: LeaderFlatFollowerOwnership) =>
  follower.replicationModeAtOpen !== 'off'
  && follower.eligibleAtOpen
  && follower.copyLineage === 'confirmed';

const quantityOwnershipCovers = (
  follower: LeaderFlatFollowerOwnership,
  followerNet: number,
): boolean => {
  const confirmed = follower.confirmedNetQuantity;
  return confirmed != null
    && Number.isFinite(confirmed)
    && confirmed !== 0
    && Math.sign(confirmed) === Math.sign(followerNet)
    && Math.abs(followerNet) <= Math.abs(confirmed);
};

export function evaluateLeaderFlatBatch(
  input: EvaluateLeaderFlatBatchInput,
): LeaderFlatEvaluation {
  const { epoch, snapshot } = input;
  const observedAt = finite(snapshot.observedAt, 'snapshot observedAt');
  const settlementGraceMs = duration(input.exitSettlementGraceMs, 'exitSettlementGraceMs');
  const inflightRetryMs = duration(input.inflightRetryMs, 'inflightRetryMs');
  if (epoch.phase !== 'grace' && epoch.phase !== 'waiting-inflight' && epoch.phase !== 'closing') {
    return evaluation('blocked', epoch, observedAt, `epoch není připravená ke kontrole (${epoch.phase})`);
  }
  if (epoch.graceUntil != null && observedAt < epoch.graceUntil) {
    return evaluation('wait-inflight', epoch, observedAt, 'leader-flat grace ještě neuplynula', {
      waitUntil: epoch.graceUntil,
    });
  }

  const byAccount = new Map<number, LeaderFlatAccountBatchSnapshot>();
  const duplicates = new Set<number>();
  for (const account of snapshot.accounts) {
    if (byAccount.has(account.accountId)) duplicates.add(account.accountId);
    else byAccount.set(account.accountId, account);
  }
  if (duplicates.size > 0) {
    return evaluation('blocked', epoch, observedAt, 'batch snapshot obsahuje duplicitní účty', {
      blocked: [...duplicates],
    });
  }

  const leader = byAccount.get(epoch.leaderAccountId);
  if (!leader || !leader.ok) {
    return evaluation('blocked', epoch, observedAt, 'leader snapshot není autoritativně dostupný', {
      blocked: [epoch.leaderAccountId],
    });
  }
  const leaderNet = accountNet(leader, epoch.symbol);
  if (leaderNet == null) {
    return evaluation('blocked', epoch, observedAt, 'leader snapshot obsahuje neplatnou pozici', {
      blocked: [epoch.leaderAccountId],
    });
  }
  if (leaderNet !== 0) {
    return evaluation('blocked', epoch, observedAt, `leader už není flat (${leaderNet})`, {
      blocked: [epoch.leaderAccountId],
    });
  }

  const divergent: number[] = [];
  const detectOnly: number[] = [];
  const waiting: number[] = [];
  const blocked: number[] = [];
  const targets: LeaderFlatCloseTarget[] = [];

  for (const follower of epoch.followers) {
    const account = byAccount.get(follower.accountId);
    if (!account || !account.ok) {
      blocked.push(follower.accountId);
      continue;
    }
    const followerNet = accountNet(account, epoch.symbol);
    if (followerNet == null) {
      blocked.push(follower.accountId);
      continue;
    }
    if (followerNet === 0) continue;
    divergent.push(follower.accountId);

    if (!automaticOwnership(follower) || !quantityOwnershipCovers(follower, followerNet)) {
      detectOnly.push(follower.accountId);
      continue;
    }
    const inflight = (account.exitEvidence ?? []).some(item => (
      item.accountId === follower.accountId
      && isInflightExit(item, epoch, observedAt, settlementGraceMs)
    ));
    if (inflight) {
      waiting.push(follower.accountId);
      continue;
    }
    if (input.autoCloseFollowerPositions) {
      targets.push({ accountId: follower.accountId, symbol: epoch.symbol });
    } else {
      detectOnly.push(follower.accountId);
    }
  }

  if (targets.length > 0) {
    return evaluation('close-targets', epoch, observedAt, 'leader je flat; potvrzené orphan kopie vyžadují cílené zavření', {
      targets, divergent, detectOnly, waiting, blocked,
    });
  }
  if (divergent.length > 0 && detectOnly.length > 0) {
    return evaluation('detect-only', epoch, observedAt, 'leader je flat; divergence není autorizovaná k automatickému zavření', {
      divergent, detectOnly, waiting, blocked,
    });
  }
  if (waiting.length > 0) {
    const waitUntil = observedAt + inflightRetryMs;
    return evaluation('wait-inflight', epoch, observedAt, 'copier exit nebo liquidation je stále v běhu', {
      divergent, waiting, blocked, waitUntil,
    });
  }
  if (blocked.length > 0) {
    return evaluation('blocked', epoch, observedAt, 'ne všechny follower snapshoty jsou autoritativně dostupné', {
      blocked,
    });
  }
  return evaluation('resolved', epoch, observedAt, 'leader i všichni účastníci epochy jsou flat');
}

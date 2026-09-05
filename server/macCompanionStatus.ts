import type { SupabaseClient } from '@supabase/supabase-js';

import {
  MAC_COMPANION_CONTRACT_VERSION,
  MAC_COMPANION_OFFLINE_AFTER_SECONDS,
  MAC_COMPANION_VERIFIED_MAX_AGE_SECONDS,
  type MacCompanionCopierState,
  type MacCompanionDailyRule,
  type MacCompanionDayLockTrigger,
  type MacCompanionProblemKind,
  type MacCompanionStatusDTO,
} from '../lib/macCompanionContract.js';
import { COPIER_LEADER_DAILY_STATS_LABEL } from '../lib/copierDailyStatsLabels.js';

interface MacCompanionRuntimeRow {
  device_id: string;
  user_id: string;
  connection_id: string;
  status: Record<string, unknown>;
  last_seen_at: string;
  started_at: string;
}

interface MacCompanionSnapshotRow {
  kind: 'entry' | 'exit' | 'sl-moved';
  at: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const strictBoolean = (value: unknown): boolean | null =>
  value === true ? true : value === false ? false : null;

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const positiveEpoch = (value: unknown): number | null => {
  const number = finite(value);
  if (number == null || !Number.isSafeInteger(number) || number <= 0) return null;
  return Number.isFinite(new Date(number).getTime()) ? number : null;
};

const nonNegativeInteger = (value: unknown): number | null => {
  const number = finite(value);
  return number != null && Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const isoEpoch = (value: unknown): string | null => {
  const number = positiveEpoch(value);
  return number == null ? null : new Date(number).toISOString();
};

const DAY_LOCK_TRIGGERS = new Set<MacCompanionDayLockTrigger>([
  'manual', 'daily-loss', 'losing-trades', 'max-trades', 'window-end',
]);
const DAILY_RULES = new Set<MacCompanionDailyRule>([
  'daily-loss', 'losing-trades', 'max-trades', 'window-end',
]);
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const hhmmMinutes = (value: string) => {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};
const validTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
};

const followerCutCount = (value: unknown, now: number): number => {
  if (!Array.isArray(value)) return 0;
  const accountIds = new Set<number>();
  for (const candidate of value) {
    const cut = object(candidate);
    const accountId = nonNegativeInteger(cut.accountId);
    const at = positiveEpoch(cut.at);
    const until = positiveEpoch(cut.until);
    const realizedPnlUsd = finite(cut.realizedPnlUsd);
    const cutUsd = finite(cut.cutUsd);
    const closed = cut.closed;
    const closedValid = closed === null
      || closed === false
      || positiveEpoch(closed) != null;
    if (accountId == null || accountId <= 0 || at == null || until == null
      || at > until || until <= now || realizedPnlUsd == null || cutUsd == null || cutUsd <= 0
      || (cut.source !== 'broker' && cut.source !== 'ledger') || !closedValid
      || accountIds.has(accountId)) return 0;
    accountIds.add(accountId);
  }
  return accountIds.size;
};

const positiveIntegerArray = (value: unknown): { known: boolean; values: number[] } => {
  if (!Array.isArray(value)) return { known: false, values: [] };
  const valid = value.every(candidate =>
    typeof candidate === 'number'
    && Number.isSafeInteger(candidate)
    && candidate > 0,
  );
  if (!valid) return { known: false, values: [] };
  return { known: true, values: [...new Set(value)].slice(0, 100) };
};

const copierState = (controller: Record<string, unknown>): MacCompanionCopierState => {
  if (controller.armed !== true) return 'disarmed';
  return controller.shadowMode === true ? 'shadow' : 'live';
};

const redactedAccountLabel = (
  accountId: number,
  group: Record<string, unknown>,
): string => {
  if (finite(group.leaderAccountId) === accountId) return 'Leader';
  const followers = Array.isArray(group.followers) ? group.followers : [];
  const index = followers.findIndex(candidate => finite(object(candidate).accountId) === accountId);
  return index >= 0 ? `Follower ${index + 1}` : 'Účet';
};

const newestSnapshotAt = (
  rows: readonly MacCompanionSnapshotRow[],
  kind: 'entry' | 'exit',
): string | null => {
  const timestamps = rows
    .filter(row => row.kind === kind)
    .map(row => Date.parse(row.at))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
};

const fixedProblem = (kind: MacCompanionProblemKind, text: string) => ({ kind, text });

export function buildMacCompanionStatus(options: {
  runtime: MacCompanionRuntimeRow;
  snapshots?: readonly MacCompanionSnapshotRow[];
  now?: number;
}): MacCompanionStatusDTO {
  const now = options.now ?? Date.now();
  const observedAt = Date.parse(options.runtime.last_seen_at);
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) {
    throw new Error('invalid-mac-companion-runtime-time');
  }

  const root = object(options.runtime.status);
  const controller = object(root.controller);
  const group = object(root.group);
  const snapshotHealth = object(root.snapshotHealth);
  const armed = strictBoolean(controller.armed);
  const shadowMode = strictBoolean(controller.shadowMode);
  const killSwitch = strictBoolean(controller.killSwitch);
  const stuckOutbox = strictBoolean(controller.stuckOutbox);
  const controllerShapeKnown = armed != null
    && shadowMode != null
    && killSwitch != null
    && stuckOutbox != null;
  const divergentEvidence = positiveIntegerArray(controller.divergentAccounts);
  const workingOrderEvidence = positiveIntegerArray(controller.workingOrderAccounts);
  const divergentAccounts = divergentEvidence.values;
  const workingOrderAccounts = workingOrderEvidence.values;
  const reconciliationRequired = strictBoolean(controller.reconciliationRequired);
  const reconciliation = reconciliationRequired === true
    || divergentAccounts.length > 0
    || workingOrderAccounts.length > 0
    ? 'review' as const
    : reconciliationRequired === false
        && divergentEvidence.known
        && workingOrderEvidence.known
        && controllerShapeKnown
      ? 'clean' as const
      : 'unknown' as const;

  const rawStuckOperations = Array.isArray(controller.stuckOperations)
    ? controller.stuckOperations.slice(0, 100)
    : [];
  const stuckUpdatedAt = rawStuckOperations
    .map(candidate => finite(object(candidate).updatedAt))
    .filter((candidate): candidate is number => candidate != null && candidate > 0);
  const stuckFlag = stuckOutbox === true;
  const stuckCount = Math.max(rawStuckOperations.length, stuckFlag ? 1 : 0);
  const oldestStuckAt = stuckUpdatedAt.length > 0 ? Math.min(...stuckUpdatedAt) : null;
  const oldestStuckMinutes = oldestStuckAt == null
    ? null
    : Math.max(0, Math.floor((now - oldestStuckAt) / 60_000));

  const killSwitchTripped = killSwitch === true;
  const cooldownUntil = finite(controller.entryCooldownUntil);
  const dayLockUntil = finite(controller.dayLockUntil);
  const brokerConnected = strictBoolean(controller.connected);
  const controllerDailyStats = object(controller.dailyStats);
  const groupSafety = object(group.safety);
  const dailyRealizedPnl = finite(controllerDailyStats.realizedPnlUsd);
  const dailyLosingTrades = finite(controllerDailyStats.losingTrades);
  const dailyStats: MacCompanionStatusDTO['dailyStats'] = dailyRealizedPnl != null
    && dailyLosingTrades != null
    && Number.isSafeInteger(dailyLosingTrades)
    && dailyLosingTrades >= 0
    ? {
      label: COPIER_LEADER_DAILY_STATS_LABEL,
      realizedPnlUsd: dailyRealizedPnl,
      losingTrades: dailyLosingTrades,
    }
    : null;
  const armExpiresAt = finite(controller.armExpiresAt);
  const state = copierState(controller);
  const divergences = divergentAccounts.map(accountId => ({
    symbol: null,
    account: redactedAccountLabel(accountId, group),
    detail: 'Pozice se liší od leadera.',
  }));

  const dayLock = (() => {
    if (dayLockUntil == null || dayLockUntil <= now) return null;
    const until = isoEpoch(dayLockUntil);
    const lockAtEpoch = finite(controller.dayLockAt);
    const at = isoEpoch(lockAtEpoch);
    const trigger = controller.dayLockTrigger;
    const reason = typeof controller.dayLockReason === 'string'
      ? controller.dayLockReason.trim()
      : '';
    const rawUnlock = controller.dayUnlock;
    let unlocked: { at: string } | null = null;
    if (rawUnlock != null) {
      const unlockedAt = isoEpoch(object(rawUnlock).at);
      if (!unlockedAt) return null;
      unlocked = { at: unlockedAt };
    }
    if (!until || !at || lockAtEpoch == null || lockAtEpoch > dayLockUntil || typeof trigger !== 'string'
      || !DAY_LOCK_TRIGGERS.has(trigger as MacCompanionDayLockTrigger) || !reason) return null;
    return {
      active: true,
      until,
      at,
      trigger: trigger as MacCompanionDayLockTrigger,
      reason,
      unlocked,
    };
  })();

  const dailyRules = (() => {
    const lossLimit = finite(groupSafety.dailyLossLimitUsd);
    const maxLosingTrades = nonNegativeInteger(groupSafety.dailyMaxLosingTrades);
    const maxTrades = nonNegativeInteger(groupSafety.dailyMaxTrades);
    const cooldownMinutes = nonNegativeInteger(groupSafety.entryCooldownMinutes);
    const realizedPnl = finite(controllerDailyStats.realizedPnlUsd);
    const losingTrades = nonNegativeInteger(controllerDailyStats.losingTrades);
    const tradesToday = nonNegativeInteger(controllerDailyStats.tradesToday);
    const sessionEndsAt = isoEpoch(controllerDailyStats.sessionEndAt);
    const windowState = controllerDailyStats.windowState;
    const rawWindow = object(groupSafety.tradingWindow);
    const rawWarnings = controllerDailyStats.warnedRules;
    if (lossLimit == null || lossLimit < 0 || lossLimit > 1_000_000
      || maxLosingTrades == null || maxLosingTrades > 50
      || maxTrades == null || maxTrades > 200
      || cooldownMinutes == null || cooldownMinutes > 720
      || realizedPnl == null || losingTrades == null
      || tradesToday == null || !sessionEndsAt
      || (windowState !== 'inside' && windowState !== 'outside' && windowState !== 'off')
      || typeof rawWindow.enabled !== 'boolean'
      || typeof rawWindow.from !== 'string' || typeof rawWindow.to !== 'string'
      || typeof rawWindow.timeZone !== 'string'
      || !HH_MM.test(rawWindow.from) || !HH_MM.test(rawWindow.to)
      || hhmmMinutes(rawWindow.from) >= hhmmMinutes(rawWindow.to)
      || !validTimeZone(rawWindow.timeZone)
      || !Array.isArray(rawWarnings)) return null;
    const validWindowState = windowState as 'inside' | 'outside' | 'off';
    const warnings: NonNullable<MacCompanionStatusDTO['dailyRules']>['warnings'] = [];
    for (const candidate of rawWarnings) {
      const warning = object(candidate);
      const rule = warning.rule;
      const current = finite(warning.current);
      const limit = finite(warning.limit);
      const warningAt = isoEpoch(warning.at);
      if (typeof rule !== 'string' || !DAILY_RULES.has(rule as MacCompanionDailyRule)
        || current == null || limit == null || !warningAt) return null;
      warnings.push({ rule: rule as MacCompanionDailyRule, current, limit, at: warningAt });
    }
    const cooldownAt = finite(controller.entryCooldownUntil);
    if (cooldownAt == null || cooldownAt < 0) return null;
    return {
      lossLimitUsd: lossLimit > 0 ? lossLimit : null,
      realizedLossUsd: lossLimit > 0 ? Math.min(0, realizedPnl) : null,
      maxLosingTrades: maxLosingTrades > 0 ? maxLosingTrades : null,
      losingTrades,
      maxTrades: maxTrades > 0 ? maxTrades : null,
      tradesToday,
      window: {
        enabled: rawWindow.enabled,
        from: rawWindow.from,
        to: rawWindow.to,
        state: validWindowState,
      },
      cooldownMinutes,
      cooldownUntil: cooldownAt > now ? new Date(cooldownAt).toISOString() : null,
      sessionEndsAt,
      warnings,
    };
  })();

  const pause = (() => {
    if (controller.pause == null) return null;
    const rawPause = object(controller.pause);
    const untilEpoch = positiveEpoch(rawPause.until);
    const atEpoch = positiveEpoch(rawPause.at);
    const rule = rawPause.rule;
    if (untilEpoch == null || atEpoch == null || atEpoch > untilEpoch || untilEpoch <= now
      || typeof rule !== 'string' || !DAILY_RULES.has(rule as MacCompanionDailyRule)) return null;
    return {
      until: new Date(untilEpoch).toISOString(),
      rule: rule as MacCompanionDailyRule,
    };
  })();
  const accountCuts = followerCutCount(controller.followerCuts, now);
  const tightenOnly = positiveEpoch(controller.sessionArmedAt) != null;

  const problems: MacCompanionStatusDTO['problems'] = [];
  if (now - observedAt > MAC_COMPANION_OFFLINE_AFTER_SECONDS * 1_000) {
    problems.push(fixedProblem('worker-offline', 'Worker neposlal heartbeat déle než 90 sekund.'));
  }
  if (divergences.length > 0) {
    problems.push(fixedProblem(
      'divergence',
      divergences.length === 1
        ? 'Jeden účet má rozdílnou pozici.'
        : `${divergences.length} účtů má rozdílnou pozici.`,
    ));
  }
  if (stuckCount > 0) {
    problems.push(fixedProblem('stuck-outbox', 'Nejasná operace vyžaduje kontrolu v LIVE.'));
  }
  if (reconciliation !== 'clean') {
    problems.push(fixedProblem(
      'reconciliation',
      reconciliation === 'review'
        ? 'Reconciliation vyžaduje kontrolu.'
        : 'Stav reconciliation není potvrzený.',
    ));
  }

  const snapshots = options.snapshots ?? [];
  return {
    contractVersion: MAC_COMPANION_CONTRACT_VERSION,
    serverTime: new Date(now).toISOString(),
    // Vercel writes last_seen_at at heartbeat receipt. Milliseconds are safe
    // integers and monotonic for the selected newest row without changing the
    // existing execution/runtime schema.
    revision: observedAt,
    observedAt: new Date(observedAt).toISOString(),
    validUntil: new Date(observedAt + MAC_COMPANION_VERIFIED_MAX_AGE_SECONDS * 1_000).toISOString(),
    freshness: {
      verifiedMaxAgeSeconds: MAC_COMPANION_VERIFIED_MAX_AGE_SECONDS,
      offlineAfterSeconds: MAC_COMPANION_OFFLINE_AFTER_SECONDS,
    },
    copierState: state,
    sessionExpiresAt: state !== 'disarmed' && armExpiresAt != null && armExpiresAt > 0
      ? new Date(armExpiresAt).toISOString()
      : null,
    worker: {
      lastHeartbeatAt: new Date(observedAt).toISOString(),
      // Today's canonical worker is the Mac runtime. A future VPS source must
      // add an explicit cloud field before this value can change.
      location: 'mac',
    },
    brokerConnected,
    dailyStats,
    dayLock,
    dailyRules,
    pause,
    accountCuts,
    tightenOnly,
    safety: {
      reconciliation: { status: reconciliation, at: null },
      divergences,
      outbox: { stuckCount, oldestStuckMinutes },
      cooldownActive: cooldownUntil != null && cooldownUntil > now,
      dayLockActive: dayLockUntil != null && dayLockUntil > now,
      killSwitchTripped,
    },
    // The heartbeat contains no authoritative position snapshot or
    // per-follower acknowledgement. Empty positions plus verifiedAt:null means
    // "unverified", never "flat".
    exposure: {
      verifiedAt: null,
      positions: [],
      followerAck: null,
      accountsWithWorkingOrders: null,
    },
    snapshots: {
      cdpReady: snapshotHealth.enabled === true && snapshotHealth.state === 'ready',
      lastEntryAt: newestSnapshotAt(snapshots, 'entry'),
      lastExitAt: newestSnapshotAt(snapshots, 'exit'),
    },
    problems,
  };
}

export async function loadMacCompanionStatus(options: {
  db: SupabaseClient;
  userId: string;
  now?: number;
}): Promise<MacCompanionStatusDTO> {
  const { data: runtime, error: runtimeError } = await options.db
    .from('tradovate_copier_device_runtime')
    .select('device_id,user_id,connection_id,status,last_seen_at,started_at')
    .eq('user_id', options.userId)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle<MacCompanionRuntimeRow>();
  if (runtimeError) throw new Error(`mac-companion-runtime-query-failed:${runtimeError.message}`);
  if (!runtime) throw new Error('copier-runtime-unavailable');

  const snapshotResult = await options.db
    .from('copier_trade_snapshots')
    .select('kind,at')
    .eq('user_id', options.userId)
    .in('kind', ['entry', 'exit'])
    .order('at', { ascending: false })
    .limit(100);
  // Snapshot observability is independent of copier safety. Its read failure
  // must not hide an otherwise valid heartbeat.
  const snapshots = snapshotResult.error
    ? []
    : (snapshotResult.data ?? []) as MacCompanionSnapshotRow[];
  return buildMacCompanionStatus({ runtime, snapshots, now: options.now });
}

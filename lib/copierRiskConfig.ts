import {
  sanitizeCopyGroupSafety,
  type CopierRuleAction,
  type CopyFollowerConfig,
  type CopyGroupConfig,
  type CopyGroupSafetySettings,
} from '../services/liveCopyTrading.js';

/**
 * Minimal shared shape available both on a copy-group command and in the
 * controller status cached by the relay.
 */
export interface CopierRiskConfig {
  safety?: CopyGroupSafetySettings;
  followers: CopyFollowerConfig[];
}

const sameFollowerOutsideCut = (left: CopyFollowerConfig, right: CopyFollowerConfig): boolean => (
  left.accountId === right.accountId
  && left.mode === right.mode
  && (left.enabled !== false) === (right.enabled !== false)
  && left.multiplier === right.multiplier
  && left.maxContracts === right.maxContracts
);

const sameGroupOutsideMetadataAndCut = (left: CopyGroupConfig, right: CopyGroupConfig): boolean => {
  if (left.id !== right.id || left.enabled !== right.enabled
    || left.leaderAccountId !== right.leaderAccountId
    || left.followers.length !== right.followers.length) return false;
  const rightByAccount = new Map(right.followers.map(follower => [follower.accountId, follower]));
  return left.followers.every(follower => {
    const candidate = rightByAccount.get(follower.accountId);
    return candidate != null && sameFollowerOutsideCut(follower, candidate);
  });
};

/** Pouze name/color/safety se smějí měnit bez execution cesty. */
export const isMetadataOnlyGroupChange = (
  previous: CopyGroupConfig,
  next: CopyGroupConfig,
): boolean => {
  if (!sameGroupOutsideMetadataAndCut(previous, next)) return false;
  const nextByAccount = new Map(next.followers.map(follower => [follower.accountId, follower]));
  return previous.followers.every(follower => {
    const candidate = nextByAccount.get(follower.accountId)!;
    return follower.dailyLossCutUsd === candidate.dailyLossCutUsd
      && (follower.onCut ?? 'close-copy') === (candidate.onCut ?? 'close-copy');
  });
};

/**
 * Jediná execution změna povolená in-place za otevřené pozice: přidání či
 * snížení follower cutu a let-run -> close-copy. Velikost, účty, leader,
 * participation i replikační mód musejí zůstat přesně stejné.
 */
export const isInPlaceCutTightening = (
  previous: CopyGroupConfig,
  next: CopyGroupConfig,
): boolean => {
  if (!sameGroupOutsideMetadataAndCut(previous, next)) return false;
  const nextByAccount = new Map(next.followers.map(follower => [follower.accountId, follower]));
  let changed = false;
  for (const follower of previous.followers) {
    const candidate = nextByAccount.get(follower.accountId)!;
    const previousCut = follower.dailyLossCutUsd ?? 0;
    const nextCut = candidate.dailyLossCutUsd ?? 0;
    if (previousCut !== nextCut) {
      changed = true;
      if (nextCut <= 0 || (previousCut > 0 && nextCut > previousCut)) return false;
    }
    const previousAction = follower.onCut ?? 'close-copy';
    const nextAction = candidate.onCut ?? 'close-copy';
    if (previousAction !== nextAction) {
      changed = true;
      if (previousAction !== 'let-run' || nextAction !== 'close-copy') return false;
    }
  }
  return changed;
};

const followerField = (accountId: number, field?: string): string => (
  field ? `followers.${accountId}.${field}` : `followers.${accountId}`
);

const positiveLimitIsWeaker = (previous: number | undefined, next: number | undefined): boolean => {
  const previousEnabled = previous != null && previous > 0;
  if (!previousEnabled) return false;
  return next == null || next <= 0 || next > previous;
};

const ruleActionIsWeaker = (
  previous: CopierRuleAction | null,
  next: CopierRuleAction | null,
): boolean => {
  if (previous == null) return false;
  if (next == null) return true;
  if (previous.kind === 'lock') return next.kind === 'pause';
  if (next.kind === 'lock') return false;
  return next.minutes < previous.minutes;
};

/**
 * Returns the exact risk fields made weaker by `next`.
 *
 * An empty list means that the change is compatible with the session's
 * tighten-only rule. Inputs normally arrive sanitized. Invalid safety is
 * nevertheless rejected as a single fail-closed `safety` violation.
 */
export function isWeakerRiskConfig(previous: CopierRiskConfig, next: CopierRiskConfig): string[] {
  const previousSafety = sanitizeCopyGroupSafety(previous.safety);
  const nextSafety = sanitizeCopyGroupSafety(next.safety);
  if (!previousSafety || !nextSafety) return ['safety'];

  const violations: string[] = [];
  const add = (field: string): void => {
    if (!violations.includes(field)) violations.push(field);
  };

  for (const field of [
    'autoCloseFollowerPositions',
    'preventHedging',
    'positionReconciler',
    'disableReplicationOnBreach',
  ] as const) {
    const requestedNext = next.safety?.[field] ?? nextSafety[field];
    if (previousSafety[field] && requestedNext === false) add(`safety.${field}`);
  }

  const comparePositiveSafetyLimit = (
    field: 'dailyMaxLosingTrades' | 'dailyMaxTrades' | 'dailyLossLimitUsd',
  ): void => {
    if (positiveLimitIsWeaker(previousSafety[field], nextSafety[field])) {
      add(`safety.${field}`);
    }
  };

  comparePositiveSafetyLimit('dailyMaxLosingTrades');
  comparePositiveSafetyLimit('dailyMaxTrades');
  comparePositiveSafetyLimit('dailyLossLimitUsd');

  if (nextSafety.entryCooldownMinutes < previousSafety.entryCooldownMinutes) {
    add('safety.entryCooldownMinutes');
  }

  const previousWindow = previousSafety.tradingWindow;
  const nextWindow = nextSafety.tradingWindow;
  if (previousWindow.enabled && !nextWindow.enabled) {
    add('safety.tradingWindow.enabled');
  } else if (previousWindow.enabled && nextWindow.enabled) {
    // Equal clock times in another zone can extend the real trading window.
    // Only accept known aliases (e.g. UTC / Etc/UTC); otherwise fail closed.
    const canonicalZone = (timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
    if (previousWindow.timeZone !== nextWindow.timeZone
      && canonicalZone(previousWindow.timeZone) !== canonicalZone(nextWindow.timeZone)) {
      add('safety.tradingWindow.timeZone');
    }
    // Sanitized HH:MM values are zero-padded, so lexical order is chronological.
    if (nextWindow.from < previousWindow.from) add('safety.tradingWindow.from');
    if (nextWindow.to > previousWindow.to) add('safety.tradingWindow.to');
    // Každé okno v nové konfiguraci musí ležet uvnitř některého okna té
    // předchozí — nové okno nebo rozšířené okno je zmírnění.
    const previousSlots = [{ from: previousWindow.from, to: previousWindow.to }, ...(previousWindow.additional ?? [])];
    const nextSlots = nextWindow.additional ?? [];
    const uncovered = nextSlots.some(slot => !previousSlots.some(previous => (
      previous.from <= slot.from && slot.to <= previous.to
    )));
    if (uncovered) add('safety.tradingWindow.additional');
  }

  const flattenStrength: Record<CopyGroupSafetySettings['armExpiryFlatten'], number> = {
    off: 0,
    followers: 1,
    group: 2,
  };
  if (flattenStrength[nextSafety.armExpiryFlatten] < flattenStrength[previousSafety.armExpiryFlatten]) {
    add('safety.armExpiryFlatten');
  }

  const ruleActions: Array<[
    string,
    CopierRuleAction | null,
    CopierRuleAction | null,
  ]> = [
    [
      'safety.dayRuleActions.losingTrades.beforeLimit',
      previousSafety.dayRuleActions.losingTrades.beforeLimit,
      nextSafety.dayRuleActions.losingTrades.beforeLimit,
    ],
    [
      'safety.dayRuleActions.losingTrades.atLimit',
      previousSafety.dayRuleActions.losingTrades.atLimit,
      nextSafety.dayRuleActions.losingTrades.atLimit,
    ],
    [
      'safety.dayRuleActions.dailyLoss.at80Percent',
      previousSafety.dayRuleActions.dailyLoss.at80Percent,
      nextSafety.dayRuleActions.dailyLoss.at80Percent,
    ],
    [
      'safety.dayRuleActions.dailyLoss.atLimit',
      previousSafety.dayRuleActions.dailyLoss.atLimit,
      nextSafety.dayRuleActions.dailyLoss.atLimit,
    ],
    [
      'safety.dayRuleActions.maxTrades.atLimit',
      previousSafety.dayRuleActions.maxTrades.atLimit,
      nextSafety.dayRuleActions.maxTrades.atLimit,
    ],
    [
      'safety.dayRuleActions.windowEnd.atEnd',
      previousSafety.dayRuleActions.windowEnd.atEnd,
      nextSafety.dayRuleActions.windowEnd.atEnd,
    ],
  ];
  for (const [field, previousAction, nextAction] of ruleActions) {
    if (ruleActionIsWeaker(previousAction, nextAction)) add(field);
  }

  const previousFollowers = new Map(
    previous.followers.map(follower => [follower.accountId, follower] as const),
  );
  const previousHasFollowerCut = previous.followers.some(
    follower => follower.dailyLossCutUsd != null && follower.dailyLossCutUsd > 0,
  );
  for (const nextFollower of next.followers) {
    const previousFollower = previousFollowers.get(nextFollower.accountId);
    if (!previousFollower) {
      if (
        previousHasFollowerCut
        && !(nextFollower.dailyLossCutUsd != null && nextFollower.dailyLossCutUsd > 0)
      ) add(followerField(nextFollower.accountId));
      continue;
    }

    if (previousFollower.mode === 'off' && nextFollower.mode !== 'off') {
      add(followerField(nextFollower.accountId, 'mode'));
    }

    if (positiveLimitIsWeaker(previousFollower.dailyLossCutUsd, nextFollower.dailyLossCutUsd)) {
      add(followerField(nextFollower.accountId, 'dailyLossCutUsd'));
    }
    if (
      previousFollower.maxContracts != null
      && (nextFollower.maxContracts == null || nextFollower.maxContracts > previousFollower.maxContracts)
    ) {
      add(followerField(nextFollower.accountId, 'maxContracts'));
    }
    if (
      (previousFollower.onCut ?? 'close-copy') === 'close-copy'
      && (nextFollower.onCut ?? 'close-copy') === 'let-run'
    ) {
      add(followerField(nextFollower.accountId, 'onCut'));
    }
    if (nextFollower.multiplier > previousFollower.multiplier) {
      add(followerField(nextFollower.accountId, 'multiplier'));
    }
  }

  return violations;
}

import { describe, expect, it } from 'vitest';
import {
  createLeaderFlatEpoch,
  evaluateLeaderFlatBatch,
  invalidateLeaderFlatEpoch,
  isLeaderFlatGuardTokenCurrent,
  mergeLeaderFlatEpochLineage,
  planLeaderPositionTransition,
  snapshotLeaderFlatFollowers,
  type LeaderFlatAccountBatchSnapshot,
  type LeaderFlatBatchSnapshot,
  type LeaderFlatEpoch,
  type LeaderFlatExitEvidence,
  type LeaderFlatFollowerOwnership,
} from '../services/copierLeaderFlatGuard';

const LEADER = 100;
const SYMBOL = 'MNQU6';
const OPENED_AT = 10_000;
const FLAT_AT = 11_000;

const follower = (
  accountId: number,
  partial: Partial<LeaderFlatFollowerOwnership> = {},
): LeaderFlatFollowerOwnership => ({
  accountId,
  replicationModeAtOpen: 'on-submit',
  eligibleAtOpen: true,
  copyLineage: 'confirmed',
  confirmedNetQuantity: 10,
  ...partial,
});

const openEpoch = (
  followers: readonly LeaderFlatFollowerOwnership[] = [follower(200)],
  partial: Partial<LeaderFlatEpoch> = {},
): LeaderFlatEpoch => ({
  ...createLeaderFlatEpoch({
    id: 'epoch-1',
    groupId: 'group-1',
    leaderAccountId: LEADER,
    symbol: SYMBOL,
    openedAt: OPENED_AT,
    leaderNet: 2,
    followers,
    leaderEntryOrderIds: ['leader-entry'],
    leaderExitOrderIds: ['leader-exit'],
  }),
  ...partial,
});

const scheduledEpoch = (
  followers: readonly LeaderFlatFollowerOwnership[] = [follower(200)],
  partial: Partial<LeaderFlatEpoch> = {},
): LeaderFlatEpoch => {
  const plan = planLeaderPositionTransition({
    epoch: openEpoch(followers),
    previousKnown: true,
    previousNet: 2,
    nextNet: 0,
    observedAt: FLAT_AT,
    graceMs: 250,
    groupId: 'group-1',
    leaderAccountId: LEADER,
    symbol: SYMBOL,
    followersAtOpen: followers,
    leaderExitOrderIds: ['leader-exit'],
  });
  if (plan.kind !== 'scheduled') throw new Error(`Expected scheduled plan, got ${plan.kind}`);
  return { ...plan.epoch, ...partial };
};

const evidence = (
  accountId: number,
  partial: Partial<LeaderFlatExitEvidence>,
): LeaderFlatExitEvidence => ({
  accountId,
  symbol: SYMBOL,
  role: 'copied-exit',
  status: 'working',
  ...partial,
});

const account = (
  accountId: number,
  positions: Record<string, number> = {},
  exitEvidence: readonly LeaderFlatExitEvidence[] = [],
): LeaderFlatAccountBatchSnapshot => ({
  accountId,
  ok: true,
  positions: Object.entries(positions).map(([symbol, netQuantity]) => ({ symbol, netQuantity })),
  exitEvidence,
});

const failedAccount = (accountId: number): LeaderFlatAccountBatchSnapshot => ({
  accountId,
  ok: false,
  error: 'authoritative read failed',
});

const batch = (
  accounts: readonly LeaderFlatAccountBatchSnapshot[],
  observedAt = FLAT_AT + 250,
): LeaderFlatBatchSnapshot => ({ observedAt, accounts });

const evaluate = (
  epoch: LeaderFlatEpoch,
  accounts: readonly LeaderFlatAccountBatchSnapshot[],
  partial: Partial<Parameters<typeof evaluateLeaderFlatBatch>[0]> = {},
) => evaluateLeaderFlatBatch({
  epoch,
  snapshot: batch(accounts),
  autoCloseFollowerPositions: true,
  exitSettlementGraceMs: 500,
  inflightRetryMs: 100,
  ...partial,
});

describe('leader flat epoch transition planner', () => {
  it('plánuje guard jen pro přesný známý nonzero -> zero přechod', () => {
    const epoch = openEpoch();
    expect(planLeaderPositionTransition({
      epoch,
      previousKnown: false,
      previousNet: 2,
      nextNet: 0,
      observedAt: FLAT_AT,
      graceMs: 250,
      groupId: 'group-1',
      leaderAccountId: LEADER,
      symbol: SYMBOL,
      followersAtOpen: epoch.followers,
    })).toMatchObject({ kind: 'ignored', reason: 'previous-unknown' });

    const planned = planLeaderPositionTransition({
      epoch,
      previousKnown: true,
      previousNet: 2,
      nextNet: 0,
      observedAt: FLAT_AT,
      graceMs: 250,
      groupId: 'group-1',
      leaderAccountId: LEADER,
      symbol: SYMBOL,
      followersAtOpen: epoch.followers,
      leaderExitOrderIds: ['leader-exit-2'],
    });

    expect(planned).toMatchObject({
      kind: 'scheduled',
      epoch: {
        id: 'epoch-1', phase: 'grace', flatObservedAt: FLAT_AT,
        graceUntil: FLAT_AT + 250, lastLeaderNet: 2, generation: 2,
        leaderExitOrderIds: ['leader-exit', 'leader-exit-2'],
      },
      token: { epochId: 'epoch-1', generation: 2 },
    });

    expect(planLeaderPositionTransition({
      epoch: planned.epoch,
      previousKnown: true,
      previousNet: 0,
      nextNet: 0,
      observedAt: FLAT_AT + 1,
      graceMs: 250,
      groupId: 'group-1',
      leaderAccountId: LEADER,
      symbol: SYMBOL,
      followersAtOpen: epoch.followers,
    })).toMatchObject({ kind: 'ignored', reason: 'no-change' });
  });

  it('blokuje flat přechod bez odpovídající otevřené epochy nebo z jiné pozice', () => {
    const base = {
      previousKnown: true,
      previousNet: 2,
      nextNet: 0,
      observedAt: FLAT_AT,
      graceMs: 250,
      groupId: 'group-1',
      leaderAccountId: LEADER,
      symbol: SYMBOL,
      followersAtOpen: [follower(200)],
    } as const;

    expect(planLeaderPositionTransition({ ...base, epoch: null }))
      .toMatchObject({ kind: 'blocked', reason: 'missing-open-epoch' });
    expect(planLeaderPositionTransition({ ...base, epoch: openEpoch([], { groupId: 'other' }) }))
      .toMatchObject({ kind: 'blocked', reason: 'epoch-mismatch' });
    expect(planLeaderPositionTransition({ ...base, epoch: openEpoch([], { lastLeaderNet: 3 }) }))
      .toMatchObject({ kind: 'blocked', reason: 'epoch-position-mismatch' });
    expect(planLeaderPositionTransition({ ...base, epoch: openEpoch([], { phase: 'blocked' }) }))
      .toMatchObject({ kind: 'blocked', reason: 'epoch-not-open' });
  });

  it('otevře novou epochu, průběžně aktualizuje exposure a přímý sign flip oddělí generace', () => {
    const opened = planLeaderPositionTransition({
      epoch: null,
      previousKnown: true,
      previousNet: 0,
      nextNet: 2,
      observedAt: OPENED_AT,
      graceMs: 250,
      nextEpochId: 'epoch-opened',
      groupId: 'group-1',
      leaderAccountId: LEADER,
      symbol: SYMBOL,
      followersAtOpen: [follower(200)],
    });
    expect(opened).toMatchObject({ kind: 'opened', epoch: { id: 'epoch-opened', lastLeaderNet: 2 } });
    if (opened.kind !== 'opened') throw new Error('Expected opened epoch');

    const updated = planLeaderPositionTransition({
      epoch: opened.epoch,
      previousKnown: true,
      previousNet: 2,
      nextNet: 5,
      observedAt: OPENED_AT + 1,
      graceMs: 250,
      groupId: 'group-1',
      leaderAccountId: LEADER,
      symbol: SYMBOL,
      // Pozdější eligibility/config nesmí přepsat ownership z opening epochy.
      followersAtOpen: [follower(200, { eligibleAtOpen: false })],
    });
    expect(updated).toMatchObject({
      kind: 'updated',
      epoch: {
        id: 'epoch-opened',
        lastLeaderNet: 5,
        followers: [expect.objectContaining({ eligibleAtOpen: true })],
      },
    });
    if (updated.kind !== 'updated') throw new Error('Expected updated epoch');

    const flipped = planLeaderPositionTransition({
      epoch: updated.epoch,
      previousKnown: true,
      previousNet: 5,
      nextNet: -1,
      observedAt: OPENED_AT + 2,
      graceMs: 250,
      nextEpochId: 'epoch-flipped',
      groupId: 'group-1',
      leaderAccountId: LEADER,
      symbol: SYMBOL,
      followersAtOpen: [follower(200)],
    });
    expect(flipped).toMatchObject({
      kind: 'opened',
      epoch: { id: 'epoch-flipped', generation: updated.epoch.generation + 1, lastLeaderNet: -1 },
    });
  });

  it('reopen nebo explicitní invalidace zneplatní starý grace token', () => {
    const epoch = scheduledEpoch();
    const token = { epochId: epoch.id, generation: epoch.generation };
    expect(isLeaderFlatGuardTokenCurrent(epoch, token)).toBe(true);

    const reopened = planLeaderPositionTransition({
      epoch,
      previousKnown: true,
      previousNet: 0,
      nextNet: 1,
      observedAt: FLAT_AT + 10,
      graceMs: 250,
      nextEpochId: 'epoch-2',
      groupId: 'group-1',
      leaderAccountId: LEADER,
      symbol: SYMBOL,
      followersAtOpen: [follower(200)],
    });
    expect(reopened).toMatchObject({ kind: 'opened', epoch: { id: 'epoch-2', phase: 'open' } });
    if (reopened.kind !== 'opened') throw new Error('Expected reopened epoch');
    expect(isLeaderFlatGuardTokenCurrent(reopened.epoch, token)).toBe(false);

    const invalidated = invalidateLeaderFlatEpoch(epoch, 'runtime restart', FLAT_AT + 20);
    expect(invalidated).toMatchObject({
      generation: epoch.generation + 1,
      phase: 'invalidated',
      terminalReason: 'runtime restart',
    });
    expect(isLeaderFlatGuardTokenCurrent(invalidated, token)).toBe(false);
  });
});

describe('leader flat ownership snapshot', () => {
  it('zachová všechny účastníky epochy včetně off/ineligible a potvrdí pozdní lineage ACK', () => {
    const mutable = follower(300, { copyLineage: 'unproven' });
    const snapshotted = snapshotLeaderFlatFollowers([
      follower(400, { replicationModeAtOpen: 'off', eligibleAtOpen: false }),
      mutable,
      follower(200, { eligibleAtOpen: false }),
      follower(300, { copyLineage: 'confirmed' }),
    ]);
    mutable.eligibleAtOpen = false;
    mutable.copyLineage = 'confirmed';

    expect(snapshotted).toEqual([
      follower(200, { eligibleAtOpen: false }),
      follower(300),
      follower(400, { replicationModeAtOpen: 'off', eligibleAtOpen: false }),
    ]);
  });

  it('odmítne konfliktní ownership a merge smí lineage jen posílit', () => {
    expect(() => snapshotLeaderFlatFollowers([
      follower(200),
      follower(200, { eligibleAtOpen: false }),
    ])).toThrow('konfliktní ownership');
    expect(() => snapshotLeaderFlatFollowers([
      follower(200, { confirmedNetQuantity: 5 }),
      follower(200, { confirmedNetQuantity: -5 }),
    ])).toThrow('konfliktní quantity ownership');

    const epoch = openEpoch([follower(200, { copyLineage: 'unproven' })]);
    const merged = mergeLeaderFlatEpochLineage(epoch, {
      followers: [follower(200, { copyLineage: 'confirmed' })],
      leaderExitOrderIds: ['leader-exit', 'leader-exit-2'],
    });
    expect(merged.followers).toEqual([follower(200)]);
    expect(merged.leaderExitOrderIds).toEqual(['leader-exit', 'leader-exit-2']);
  });
});

describe('leader flat authoritative batch evaluation', () => {
  it('čeká do konce grace a po JSON roundtripu drží epochu i generaci', () => {
    const original = scheduledEpoch();
    const restored = JSON.parse(JSON.stringify(original)) as LeaderFlatEpoch;
    const token = { epochId: original.id, generation: original.generation };
    expect(isLeaderFlatGuardTokenCurrent(restored, token)).toBe(true);

    const result = evaluateLeaderFlatBatch({
      epoch: restored,
      snapshot: batch([
        account(LEADER),
        account(200),
      ], FLAT_AT + 100),
      autoCloseFollowerPositions: true,
      exitSettlementGraceMs: 500,
      inflightRetryMs: 100,
    });

    expect(result).toMatchObject({
      kind: 'wait-inflight',
      waitUntil: FLAT_AT + 250,
      epoch: { phase: 'waiting-inflight', generation: original.generation + 1 },
    });
    expect(isLeaderFlatGuardTokenCurrent(result.epoch, token)).toBe(false);
  });

  it('je resolved jen když autoritativní leader i všichni follower účastníci jsou flat', () => {
    const result = evaluate(scheduledEpoch([follower(200), follower(300)]), [
      account(LEADER),
      account(200, { [SYMBOL]: 0 }),
      account(300, { NQU6: 9 }),
    ]);
    expect(result).toMatchObject({
      kind: 'resolved',
      targets: [],
      divergentAccountIds: [],
      epoch: { phase: 'resolved', terminalAt: FLAT_AT + 250 },
    });
  });

  it('chybějící lokální cache ani chybějící účet v batchi nikdy nepovažuje za flat', () => {
    const result = evaluate(scheduledEpoch(), [account(LEADER)]);
    expect(result).toMatchObject({
      kind: 'blocked',
      blockedAccountIds: [200],
      targets: [],
      epoch: { phase: 'blocked' },
    });
  });

  it('vrací jen přesný account+symbol cíl a nikdy account-wide pokyn', () => {
    const result = evaluate(scheduledEpoch(), [
      account(LEADER),
      account(200, { [SYMBOL]: 2, NQU6: -7 }),
    ]);
    expect(result).toMatchObject({
      kind: 'close-targets',
      targets: [{ accountId: 200, symbol: SYMBOL }],
      divergentAccountIds: [200],
      epoch: { phase: 'closing', graceUntil: undefined },
    });
    expect(Object.keys(result.targets[0] ?? {}).sort()).toEqual(['accountId', 'symbol']);
  });

  it('autorizuje dnešní přesné 5/10 copied nety, ale ne cizí scale-in ani opačný směr', () => {
    const followers = [
      follower(200, { confirmedNetQuantity: 5 }),
      follower(300, { confirmedNetQuantity: -10 }),
      follower(400, { confirmedNetQuantity: 5 }),
      follower(500, { confirmedNetQuantity: 5 }),
    ];
    const result = evaluate(scheduledEpoch(followers), [
      account(LEADER),
      account(200, { [SYMBOL]: 5 }),
      account(300, { [SYMBOL]: -10 }),
      account(400, { [SYMBOL]: 6 }),
      account(500, { [SYMBOL]: -1 }),
    ]);

    expect(result).toMatchObject({
      kind: 'close-targets',
      targets: [
        { accountId: 200, symbol: SYMBOL },
        { accountId: 300, symbol: SYMBOL },
      ],
      divergentAccountIds: [200, 300, 400, 500],
      detectOnlyAccountIds: [400, 500],
    });
  });

  it('bez quantity lineage proof nesmí symbolovou pozici automaticky zavřít', () => {
    const result = evaluate(scheduledEpoch([
      follower(200, { confirmedNetQuantity: undefined }),
    ]), [
      account(LEADER),
      account(200, { [SYMBOL]: 1 }),
    ]);
    expect(result).toMatchObject({
      kind: 'detect-only',
      targets: [],
      detectOnlyAccountIds: [200],
    });
  });

  it('policy off pouze detekuje divergence bez write cíle', () => {
    const result = evaluate(scheduledEpoch(), [
      account(LEADER),
      account(200, { [SYMBOL]: 2 }),
    ], { autoCloseFollowerPositions: false });
    expect(result).toMatchObject({
      kind: 'detect-only',
      targets: [],
      detectOnlyAccountIds: [200],
      divergentAccountIds: [200],
    });
  });

  it('ineligible, off a neprokázanou lineage vždy zahrne, ale nikdy automaticky nezavírá', () => {
    const followers = [
      follower(200, { eligibleAtOpen: false }),
      follower(300, { replicationModeAtOpen: 'off' }),
      follower(400, { copyLineage: 'unproven' }),
    ];
    const result = evaluate(scheduledEpoch(followers), [
      account(LEADER),
      account(200, { [SYMBOL]: 1 }),
      account(300, { [SYMBOL]: 1 }),
      account(400, { [SYMBOL]: 1 }),
    ]);
    expect(result).toMatchObject({
      kind: 'detect-only',
      divergentAccountIds: [200, 300, 400],
      detectOnlyAccountIds: [200, 300, 400],
      targets: [],
    });
  });

  it('working protective SL není exit v letu a orphan zůstane viditelný i zavíratelný', () => {
    const result = evaluate(scheduledEpoch(), [
      account(LEADER),
      account(200, { [SYMBOL]: 1 }, [evidence(200, {
        role: 'protective',
        status: 'working',
        brokerOrderId: 'follower-sl',
      })]),
    ]);
    expect(result).toMatchObject({
      kind: 'close-targets',
      targets: [{ accountId: 200, symbol: SYMBOL }],
      waitingInflightAccountIds: [],
    });
  });

  it('čeká na aktuální copied exit, ale historický nebo cizí order nesmí epochu blokovat', () => {
    const epoch = scheduledEpoch();
    const current = evaluate(epoch, [
      account(LEADER),
      account(200, { [SYMBOL]: 1 }, [evidence(200, {
        status: 'unknown',
        leaderOrderId: 'leader-exit',
      })]),
    ]);
    expect(current).toMatchObject({
      kind: 'wait-inflight',
      waitingInflightAccountIds: [200],
      waitUntil: FLAT_AT + 350,
      targets: [],
    });

    const historical = evaluate(epoch, [
      account(LEADER),
      account(200, { [SYMBOL]: 1 }, [evidence(200, {
        status: 'working',
        leaderOrderId: 'old-leader-exit',
      })]),
    ]);
    expect(historical).toMatchObject({
      kind: 'close-targets',
      targets: [{ accountId: 200, symbol: SYMBOL }],
    });
  });

  it('fresh protective fill dostane settlement wait, starý fill už ne', () => {
    const epoch = scheduledEpoch();
    const fresh = evaluate(epoch, [
      account(LEADER),
      account(200, { [SYMBOL]: 1 }, [evidence(200, {
        role: 'protective', status: 'filled', updatedAt: FLAT_AT + 200,
      })]),
    ]);
    expect(fresh).toMatchObject({ kind: 'wait-inflight', waitingInflightAccountIds: [200] });

    const old = evaluate(epoch, [
      account(LEADER),
      account(200, { [SYMBOL]: 1 }, [evidence(200, {
        role: 'protective', status: 'filled', updatedAt: FLAT_AT - 1,
      })]),
    ]);
    expect(old).toMatchObject({ kind: 'close-targets', waitingInflightAccountIds: [] });
  });

  it('po restartu čeká jen na guard liquidation stejné epochy', () => {
    const epoch = scheduledEpoch();
    const current = evaluate(epoch, [
      account(LEADER),
      account(200, { [SYMBOL]: 1 }, [evidence(200, {
        role: 'guard-liquidation', status: 'sending', epochId: epoch.id,
      })]),
    ]);
    expect(current).toMatchObject({ kind: 'wait-inflight', waitingInflightAccountIds: [200] });

    const foreign = evaluate(epoch, [
      account(LEADER),
      account(200, { [SYMBOL]: 1 }, [evidence(200, {
        role: 'guard-liquidation', status: 'sending', epochId: 'other-epoch',
      })]),
    ]);
    expect(foreign).toMatchObject({ kind: 'close-targets', waitingInflightAccountIds: [] });
  });

  it('při částečné chybě batchu vrátí známé bezpečné cíle a chybějící účet explicitně blokuje', () => {
    const result = evaluate(scheduledEpoch([follower(200), follower(300)]), [
      account(LEADER),
      account(200, { [SYMBOL]: 1 }),
      failedAccount(300),
    ]);
    expect(result).toMatchObject({
      kind: 'close-targets',
      targets: [{ accountId: 200, symbol: SYMBOL }],
      blockedAccountIds: [300],
    });
  });

  it('blokuje neautoritativního nebo znovu otevřeného leadera a duplicitní účty', () => {
    expect(evaluate(scheduledEpoch(), [failedAccount(LEADER), account(200)]))
      .toMatchObject({ kind: 'blocked', blockedAccountIds: [LEADER] });
    expect(evaluate(scheduledEpoch(), [account(LEADER, { [SYMBOL]: 1 }), account(200)]))
      .toMatchObject({ kind: 'blocked', blockedAccountIds: [LEADER] });
    expect(evaluate(scheduledEpoch(), [account(LEADER), account(200), account(200)]))
      .toMatchObject({ kind: 'blocked', blockedAccountIds: [200] });
  });
});

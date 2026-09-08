import { describe, expect, it } from 'vitest';
import type { NativeLiveActivityBrokerSnapshot } from '../server/nativeLiveActivityBrokerSnapshot';
import { planNativeLiveActivityUpdate, type NativeLiveActivityRuntimeRow } from '../server/nativeLiveActivityUpdater';

const now = Date.parse('2026-09-07T14:30:00.000Z');
const runtime: NativeLiveActivityRuntimeRow = {
  device_id: 'device', user_id: 'user', connection_id: 'connection',
  last_seen_at: new Date(now).toISOString(), started_at: new Date(now - 3_600_000).toISOString(),
  status: {
    group: { id: 'group', name: 'Hlavní', leaderAccountId: 10, followers: [{ accountId: 11, mode: 'on-fill', multiplier: 1 }] },
    controller: { armed: true, connected: true, armedAt: now - 60_000, dailyStats: { realizedPnlUsd: 0, losingTrades: 0 }, recentCopyEvents: [] },
  },
};
const broker: NativeLiveActivityBrokerSnapshot = {
  accounts: [
    { accountId: 10, accountName: 'Leader', balance: 0, realizedPnl: 0, openPnl: 0, totalPnl: 0, canTrade: true, changesLocked: false },
    { accountId: 11, accountName: 'Follower', balance: 0, realizedPnl: 0, openPnl: 0, totalPnl: 0, canTrade: true, changesLocked: false },
  ],
  positions: [
    { accountId: 10, symbol: 'MNQZ6', side: 'Long', quantity: 1, entryPrice: 23_400, currentPrice: 23_450, stopPrice: 23_350, targetPrice: 23_550 },
    { accountId: 11, symbol: 'MNQZ6', side: 'Long', quantity: 2, entryPrice: 23_400, currentPrice: 23_450, stopPrice: 23_350, targetPrice: 23_550 },
  ],
  pendingOrder: null, workingOrderCount: 4,
  realizedPnl: 0, openPnl: 75.5, totalPnl: 75.5,
  completeOpenPnl: true, completeRealizedPnl: true, accountStatusComplete: true, accountLockStatusComplete: true,
  capturedAt: now,
};

describe('Live Activity J5D: P&L při SL/TP a kompaktní hero', () => {
  it('sečte P&L při zásahu SL i TP přes všechny účty (MNQ $2/bod)', () => {
    const plan = planNativeLiveActivityUpdate({ runtime, broker, now });
    // SL: (23350−23400)×(1+2)×2 = −300; TP: (23550−23400)×3×2 = +900
    expect(plan.update.state.stopPnlText).toBe('−$300');
    expect(plan.update.state.targetPnlText).toBe('+$900');
    expect(plan.update.state.riskAtStopText).toBe('−$300 na SL');
    expect(plan.update.state.pnlCompactText).toBe('+$76');
    expect(plan.update.state.pnlText).toBe('+$75.50');
  });

  it('bez TP na některém účtu TP P&L chybí, SL zůstává', () => {
    const plan = planNativeLiveActivityUpdate({
      runtime,
      broker: { ...broker, positions: [broker.positions[0], { ...broker.positions[1], targetPrice: null }] },
      now,
    });
    expect(plan.update.state.stopPnlText).toBe('−$300');
    expect(plan.update.state.targetPnlText).toBeUndefined();
  });

  it('bez broker snapshotu je hero „—" a úrovně chybí', () => {
    const plan = planNativeLiveActivityUpdate({ runtime, broker: null, now });
    expect(plan.update.state.pnlCompactText === '—' || plan.update.state.pnlCompactText?.startsWith('+$') || plan.update.state.pnlCompactText?.startsWith('−$')).toBe(true);
    expect(plan.update.state.stopPnlText).toBeUndefined();
    expect(plan.update.state.targetPnlText).toBeUndefined();
  });
});

describe('Live Activity mimo pozici: denní přehled, limity, shrnutí', () => {
  const flatBroker: NativeLiveActivityBrokerSnapshot = { ...broker, positions: [], openPnl: 0, totalPnl: 0, workingOrderCount: 0 };
  const withDay = (controller: Record<string, unknown>, safety: Record<string, unknown> = {}): NativeLiveActivityRuntimeRow => ({
    ...runtime,
    status: {
      group: { ...(runtime.status.group as Record<string, unknown>), safety: { dailyMaxLosingTrades: 2, dailyLossLimitUsd: 1_000, dailyMaxTrades: 10, ...safety } },
      controller: {
        ...(runtime.status.controller as Record<string, unknown>),
        armedAt: now - 71 * 60_000,
        dailyStats: {
          sessionEndAt: now + 5 * 60 * 60_000, realizedPnlUsd: 240, losingTrades: 1, tradesToday: 3, unpricedSymbols: [],
          recentClosedTrades: [
            { id: 't3', symbol: 'MNQZ6', side: 'Short', quantity: 2, realizedPnlUsd: -129, exitReason: 'sl', closedAt: now - 3 * 60_000, openedAt: now - 9 * 60_000 },
            { id: 't1', symbol: 'MNQZ6', side: 'Long', quantity: 1, realizedPnlUsd: 88, exitReason: 'tp', closedAt: now - 71 * 60_000, openedAt: now - 80 * 60_000 },
            { id: 't2', symbol: 'MNQZ6', side: 'Long', quantity: 2, realizedPnlUsd: 281, exitReason: 'tp', closedAt: now - 40 * 60_000, openedAt: now - 50 * 60_000 },
          ],
        },
        ...controller,
      },
    },
  });

  it('po obchodu (armováno, flat) posílá obchody dne chronologicky, limity a čas zapnutí', () => {
    const plan = planNativeLiveActivityUpdate({ runtime: withDay({}), broker: flatBroker, now });
    const state = plan.update.state;
    expect(state.mode).toBe('idle');
    expect(state.dayTrades).toEqual([
      { pnl: 88, exit: 'TP', closedAt: (now - 71 * 60_000) / 1_000 },
      { pnl: 281, exit: 'TP', closedAt: (now - 40 * 60_000) / 1_000 },
      { pnl: -129, exit: 'SL', closedAt: (now - 3 * 60_000) / 1_000 },
    ]);
    expect(state).toMatchObject({
      tradesToday: 3, losingTrades: 1, dayPnlText: '+$240', dayLossUsd: 0,
      maxLosingTrades: 2, dailyLossLimitUsd: 1_000, maxTrades: 10,
      armedAt: (now - 71 * 60_000) / 1_000, sessionEndAt: (now + 5 * 60 * 60_000) / 1_000,
    });
    expect(state.cooldownUntil).toBeUndefined();
    expect(plan.shouldEnd).toBe(false);
  });

  it('vypnuté pravidlo (0) limit neposílá a cooldown / zámek jdou jen když běží', () => {
    const plan = planNativeLiveActivityUpdate({
      runtime: withDay({ entryCooldownUntil: now + 4 * 60_000 + 32_000, dayLockUntil: now - 1 }, { dailyMaxTrades: 0 }),
      broker: flatBroker, now,
    });
    expect(plan.update.state.maxTrades).toBeUndefined();
    expect(plan.update.state.cooldownUntil).toBe((now + 4 * 60_000 + 32_000) / 1_000);
    expect(plan.update.state.dayLockUntil).toBeUndefined();
    expect(plan.update.state.status).toBe('COOLDOWN');
  });

  it('zámek dne nese čas i důvod', () => {
    const plan = planNativeLiveActivityUpdate({
      runtime: withDay({ dayLockUntil: now + 60 * 60_000, dayLockReason: 'Dva ztrátové obchody' }),
      broker: flatBroker, now,
    });
    expect(plan.update.state.status).toBe('DAY-LOCK');
    expect(plan.update.state.dayLockUntil).toBe((now + 60 * 60_000) / 1_000);
    expect(plan.update.state.dayLockReason).toBe('Dva ztrátové obchody');
  });

  it('po DISARM a flat končí shrnutím dne, které zůstane 15 minut', () => {
    const plan = planNativeLiveActivityUpdate({ runtime: withDay({ armed: false, armedAt: undefined }), broker: flatBroker, now });
    expect(plan.shouldEnd).toBe(true);
    expect(plan.update.event).toBe('end');
    expect(plan.update.state.mode).toBe('summary');
    expect(plan.update.state.dayTrades).toHaveLength(3);
    expect(plan.update.state.armedAt).toBeUndefined();
    expect(plan.update.dismissalAt).toBe(now / 1_000 + 15 * 60);
  });
});

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

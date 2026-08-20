import { describe, expect, it } from 'vitest';
import type { NativeWidgetLiveState } from '../services/nativeWidgetSnapshot';
import { planNativeWidgetLocalAlerts } from '../services/nativeWidgetNotificationPlan';

const live = (partial: Partial<NativeWidgetLiveState> = {}): NativeWidgetLiveState => ({
  connected: true,
  armed: false,
  shadowMode: false,
  killSwitch: false,
  status: 'DISARMED',
  statusDetail: 'Kopírování stojí.',
  armExpiresAt: 0,
  cooldownUntil: 0,
  dayLockUntil: 0,
  dayLockReason: null,
  dailyRealizedPnl: 0,
  losingTrades: 0,
  followerCount: 2,
  openPositionCount: 0,
  workingOrderCount: 0,
  realizedPnl: 0,
  openPnl: 0,
  totalPnl: 0,
  accounts: [],
  positions: [],
  recentTrades: [],
  ...partial,
});

describe('lokální live PnL a account-lock notifikace', () => {
  it('první snapshot nikdy nepřehrává historii', () => {
    const next = live({
      dailyRealizedPnl: 125,
      recentTrades: [{ id: 't1', symbol: 'MNQ', side: 'Long', pnl: 125, quantity: 2, timestamp: 10 }],
    });
    expect(planNativeWidgetLocalAlerts(null, next)).toEqual([]);
  });

  it('nový broker potvrzený obchod nese trade PnL i denní PnL právě jednou', () => {
    const trade = { id: 't1', symbol: 'MNQ', side: 'Long' as const, pnl: 125, quantity: 2, timestamp: 10 };
    const first = planNativeWidgetLocalAlerts(live(), live({ dailyRealizedPnl: 125, recentTrades: [trade] }));
    expect(first).toEqual([expect.objectContaining({
      key: 'trade-pnl:t1',
      title: 'MNQ Long: +$125.00',
      body: expect.stringContaining('Denní realizované PnL +$125.00'),
      kind: 'trade',
    })]);
    expect(planNativeWidgetLocalAlerts(
      live({ dailyRealizedPnl: 125, recentTrades: [trade] }),
      live({ dailyRealizedPnl: 125, recentTrades: [trade] }),
    )).toEqual([]);
  });

  it('zamčení i odemčení účtu jsou samostatné risk hrany', () => {
    const open = { id: 'a1', name: 'Apex 50K', balance: 50_000, pnl: 0, openPnl: 0, locked: false, lockReason: null };
    const locked = { ...open, locked: true, lockReason: 'DAY-LOCK: limit ztrát' };
    expect(planNativeWidgetLocalAlerts(live({ accounts: [open] }), live({ accounts: [locked] })))
      .toEqual([expect.objectContaining({ key: 'account-locked:a1', kind: 'risk' })]);
    expect(planNativeWidgetLocalAlerts(live({ accounts: [locked] }), live({ accounts: [open] })))
      .toEqual([expect.objectContaining({ key: 'account-unlocked:a1', kind: 'risk' })]);
  });
});

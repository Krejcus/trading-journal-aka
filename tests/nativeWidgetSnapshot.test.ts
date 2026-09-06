import { describe, expect, it } from 'vitest';

import {
  buildNativeJournalWidgetState,
  buildNativeLiveWidgetState,
  nativeLiveActivityFallbackPayload,
  planNativeLiveActivityFallback,
  type NativeWidgetLiveState,
} from '../services/nativeWidgetSnapshot';
import type { Account, Trade } from '../types';

const account = (id: string, name: string, initialBalance = 50_000): Account => ({
  id, name, initialBalance, type: 'Funded', status: 'Active', currency: 'USD', createdAt: 1,
});

const trade = (overrides: Partial<Trade>): Trade => ({
  id: overrides.id ?? 'trade',
  accountId: overrides.accountId ?? 'a1',
  signal: 'MSS', pnl: 0, runUp: 0, drawdown: 0,
  date: '2026-08-20', direction: 'Long', timestamp: 1,
  duration: '1m', durationMinutes: 1,
  ...overrides,
});

describe('native widget snapshot', () => {
  const fallbackState = (overrides: Partial<NativeWidgetLiveState> = {}): NativeWidgetLiveState => ({
    ...buildNativeLiveWidgetState({ accounts: [], profiles: [], controller: null, followerCount: 0, now: 1_000_000 }),
    armed: true, status: 'ARM LIVE', connected: true, workerObservedAt: 1_000_000, workerValidUntil: 1_090_000,
    brokerUpdatedAt: 1_000_000, brokerValidUntil: 2_800_000, positionsAvailable: true, ordersAvailable: true,
    openPositionCount: 1, realizedPnl: 250, openPnl: 100, totalPnl: 350, realizedPnlAvailable: true, openPnlAvailable: true,
    ...overrides,
  });

  it('local fallback uses the same open-only position P&L as the remote activity', () => {
    expect(nativeLiveActivityFallbackPayload(fallbackState(), 1_000_000)).toMatchObject({
      automatic: true, pnlText: '+$100.00', validUntilMs: 1_090_000,
    });
    expect(nativeLiveActivityFallbackPayload(fallbackState({ openPnlAvailable: false }), 1_000_000)).toMatchObject({ pnlText: '+$250.00' });
    expect(nativeLiveActivityFallbackPayload(fallbackState({ openPnlAvailable: false, realizedPnlAvailable: false }), 1_000_000).pnlText).toBe('—');
  });

  it('does not renew worker health from a fresh broker response', () => {
    const payload = nativeLiveActivityFallbackPayload(fallbackState({ workerValidUntil: 999_999 }), 1_000_000);
    expect(payload.status).toBe('STAV NEOVĚŘEN');
    expect(payload.validUntilMs).toBeLessThan(1_000_000);
  });

  it('preserves pending entries and refuses to end on partial exposure coverage', () => {
    expect(planNativeLiveActivityFallback(fallbackState({ armed: false, openPositionCount: 0, workingOrderCount: 1 }), 1_000_000).shouldBeActive).toBe(true);
    expect(planNativeLiveActivityFallback(fallbackState({ armed: false, openPositionCount: 0, ordersAvailable: false }), 1_000_000).canEnd).toBe(false);
  });
  it('staví journal widget pouze ze skutečných live účtů a dnešních obchodů', () => {
    const state = buildNativeJournalWidgetState({
      now: new Date(2026, 7, 20, 12),
      accounts: [account('a1', 'Tradeify'), { ...account('bt', 'Replay'), type: 'Backtest' }],
      trades: [
        trade({ id: 'win', pnl: 200, riskAmount: 100, riskPercent: 0.5, planAdherence: 'Yes' }),
        trade({ id: 'loss', pnl: -50, riskAmount: 100, riskPercent: 0.5, planAdherence: 'Partial', timestamp: 2 }),
        trade({ id: 'old', pnl: 999, date: '2026-08-19', timestamp: 0 }),
        trade({ id: 'backtest', accountId: 'bt', pnl: 5_000, timestamp: 3 }),
      ],
    });

    expect(state.dayPnl).toBe(150);
    expect(state.dayR).toBe(1.5);
    expect(state.tradeCount).toBe(2);
    expect(state.discipline).toBe(75);
    expect(state.accounts).toEqual([
      expect.objectContaining({ id: 'a1', balance: 51_149, pnl: 150, locked: false }),
    ]);
    expect(state.recentTrades.map(item => item.id)).not.toContain('backtest');
  });

  it('promítá ARM, day-lock, pozice a broker PnL do jednoho live snapshotu', () => {
    const state = buildNativeLiveWidgetState({
      now: 1_000,
      followerCount: 5,
      profiles: [],
      controller: {
        started: true, armed: true, shadowMode: false, killSwitch: false, connected: true,
        reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [],
        stuckOutbox: false, stuckOperations: [], lastError: null, revision: 1, lastSequence: 1,
        dayLockUntil: 10_000, dayLockReason: 'Denní limit dosažen',
        dailyStats: { sessionEndAt: 10_000, realizedPnlUsd: -350, losingTrades: 2, unpricedSymbols: [] },
      },
      accounts: [{
        id: 42, name: 'Tradeify 1', canTrade: true, netPositionCount: 1, workingOrderCount: 2,
        balance: { netLiq: 49_650, totalCashValue: 49_600, totalPnL: -350, realizedPnL: -400, openPnL: 50 },
        risk: { changesLocked: false },
        activity: { knownFees: 0, fillCount: 0 },
        positions: [{ symbol: 'MNQU6', netPosition: 2, averagePrice: 22_500 }],
        orders: [], fills: [], fillPairs: [], daily: [], ledger: [],
      } as any],
    });

    expect(state.status).toBe('DAY-LOCK');
    expect(state.dayLockReason).toBe('Denní limit dosažen');
    expect(state.dailyRealizedPnl).toBe(-350);
    expect(state.losingTrades).toBe(2);
    expect(state.openPositionCount).toBe(1);
    expect(state.workingOrderCount).toBe(2);
    expect(state.totalPnl).toBe(-350);
    expect(state.accounts[0]).toMatchObject({ locked: true, pnl: -350, openPnl: 50 });
    expect(state.positions[0]).toMatchObject({ symbol: 'MNQU6', side: 'Long', quantity: 2 });
  });

  it('do posledních obchodů nepustí vstupní ani samostatný exit fill', () => {
    const state = buildNativeLiveWidgetState({
      followerCount: 1,
      profiles: [],
      controller: null,
      accounts: [{
        id: 42, name: 'Tradeify 1', canTrade: true, netPositionCount: 0, workingOrderCount: 0,
        balance: { totalCashValue: 50_100, realizedPnL: 100, openPnL: 0 },
        risk: { changesLocked: false },
        activity: { knownFees: 0, fillCount: 2 },
        positions: [], orders: [], daily: [], ledger: [],
        fills: [
          { id: 1, orderId: 101, timestamp: '2026-08-20T10:00:00Z', symbol: 'MNQU6', action: 'Buy', quantity: 1, price: 22_500 },
          { id: 2, orderId: 102, timestamp: '2026-08-20T10:05:00Z', symbol: 'MNQU6', action: 'Sell', quantity: 1, price: 22_502 },
        ],
        fillPairs: [{
          id: 7,
          buyFillId: 1,
          sellFillId: 2,
          symbol: 'MNQU6',
          side: 'Long',
          quantity: 1,
          openedAt: '2026-08-20T10:00:00Z',
          closedAt: '2026-08-20T10:05:00Z',
          buyPrice: 22_500,
          sellPrice: 22_502,
          grossPnl: 100,
          netPnl: 96,
        }],
      } as any],
    });

    expect(state.recentTrades).toEqual([
      expect.objectContaining({ id: 'trade:42:7', pnl: 96, symbol: 'MNQU6' }),
    ]);
  });
});

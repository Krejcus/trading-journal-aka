import { describe, expect, it } from 'vitest';
import type { TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import { tradovateCopyTradeOrders, tradovateCopyTradeSnapshot } from '../lib/tradovateCopyTradeBridge';

const coverage = { availability: 'available' as const, count: 1, httpStatus: 200 };

const data = {
  capturedAt: '2026-08-15T08:00:00.000Z',
  contracts: [],
  coverage: { accounts: coverage, positions: coverage, orders: coverage, fills: coverage, fillPairs: coverage, fillFees: coverage, contracts: coverage },
  accounts: [{
    id: 42, name: 'TDFY42', active: true, canTrade: true, netPositionCount: 1, workingOrderCount: 1,
    balance: { totalCashValue: 49_000, netLiq: 48_900, realizedPnL: 120, weekRealizedPnL: 220, openPnL: -100 },
    activity: { fillCount: 2 },
    risk: { minNetLiq: null, maxNetLiq: null, dailyLossAutoLiq: 1_200 },
    positions: [{ id: 1, contractId: 7, symbol: 'MNQZ6', timestamp: null, tradeDate: null, netPosition: 1, bought: 1, boughtValue: null, sold: 0, soldValue: null, previousPosition: 0, averagePrice: 20_000, previousPrice: null }],
    orders: [{ id: 3, contractId: 7, symbol: 'MNQZ6', timestamp: '2026-08-15T08:00:00.000Z', action: 'Buy', orderType: 'Limit', quantity: 1, price: 20_000, stopPrice: null, status: 'Working', admin: false, ocoId: null, parentId: null, linkedId: null }],
    fills: [], fillPairs: [], daily: [{
      tradeDate: '2026-08-15', reportedRealizedPnl: 120, reportedWeekRealizedPnl: 220,
      endingBalance: 49_000, cashDelta: 95, grossTradePnl: 100, feeDelta: -5,
      knownFillFees: 5, fillCount: 2, pairedTradeCount: 1, ledgerEntryCount: 3,
    }], ledger: [],
  }],
} as unknown as TradovateAccountDataResult;

const profiles = [{
  externalAccountId: '42', displayName: 'Leader 50K', propFirm: 'Tradeify', accountSize: 50_000, maxLoss: 2_000,
  drawdownType: 'eod_trailing',
}] as TradovateAccountProfile[];

describe('Tradovate copy-trade bridge', () => {
  it('feeds the TradeCopia-style UI exclusively from the OAuth account snapshot', () => {
    const snapshot = tradovateCopyTradeSnapshot(data, profiles);
    expect(snapshot.accounts[0]).toMatchObject({ name: 'Leader 50K', firm: 'Tradeify', dailyLossLimit: 1_200, balance: 49_000, equity: 48_900, realizedPnl: 95, unrealizedPnl: -100, cushion: 900 });
    expect(snapshot.connections).toEqual([expect.objectContaining({ firm: 'Tradeify', connected: true, accountCount: 1 })]);
    expect(snapshot.groups).toEqual([]);
  });

  it('does not label a cumulative balance P&L as the current daily result', () => {
    const withoutCurrentDay = structuredClone(data);
    withoutCurrentDay.accounts[0].daily[0].tradeDate = '2026-08-14';
    expect(tradovateCopyTradeSnapshot(withoutCurrentDay, profiles).accounts[0].realizedPnl).toBe(0);
  });

  it('maps broker orders without changing their working state', () => {
    expect(tradovateCopyTradeOrders(data)).toEqual([expect.objectContaining({ id: 3, accountId: 42, symbol: 'MNQZ6', working: true, price: 20_000 })]);
  });
});

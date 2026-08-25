import { describe, expect, it, vi } from 'vitest';
import type { TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
import {
  applyTradovateLivePnlTick,
  tradovateContractRoot,
  tradovateLiveTickClosedLastPosition,
  tradovateValuePerPoint,
} from '../lib/tradovateLivePnl';
import type { TradovateLivePnlTick } from '../lib/tradovateLivePnlTypes';
import { loadTradovateLivePnlTick } from '../server/tradovateLivePnl';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Tradovate lightweight live P&L reader', () => {
  it('takes only one anchor snapshot for many accounts on the same contract', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/position/list')) return json([
        { id: 1, accountId: 10, contractId: 7, netPos: 1, netPrice: 20_000 },
        { id: 2, accountId: 11, contractId: 7, netPos: 1, netPrice: 20_000.25 },
        { id: 3, accountId: 12, contractId: 7, netPos: 2, netPrice: 20_001 },
      ]);
      if (path.endsWith('/order/list')) return json([]);
      if (path.endsWith('/cashBalance/getcashbalancesnapshot')) {
        return json({ openPnL: 20, netLiq: 50_020, totalCashValue: 50_000 });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const tick = await loadTradovateLivePnlTick({
      baseUrl: 'https://demo.example.test/v1',
      accessToken: 'token',
      connectionId: 'connection',
      environment: 'demo',
      fetchImpl,
      now: Date.parse('2026-08-15T10:00:00.000Z'),
    });

    expect(tick.anchor).toMatchObject({ accountId: 10, contractId: 7, openPnl: 20 });
    expect(tick.activeContractCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rotates contracts and never takes more than one snapshot per tick', async () => {
    const snapshotAccounts: number[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/position/list')) return json([
        { accountId: 10, contractId: 7, netPos: 1, netPrice: 20_000 },
        { accountId: 11, contractId: 8, netPos: 1, netPrice: 6_000 },
      ]);
      if (path.endsWith('/order/list')) return json([]);
      const body = JSON.parse(String(init?.body)) as { accountId: number };
      snapshotAccounts.push(body.accountId);
      return json({ openPnL: 0 });
    }) as unknown as typeof fetch;

    const first = await loadTradovateLivePnlTick({
      baseUrl: 'https://demo.example.test/v1', accessToken: 'token', connectionId: 'c',
      environment: 'demo', contractCursor: 0, fetchImpl,
    });
    const second = await loadTradovateLivePnlTick({
      baseUrl: 'https://demo.example.test/v1', accessToken: 'token', connectionId: 'c',
      environment: 'demo', contractCursor: first.nextContractCursor, fetchImpl,
    });

    expect(snapshotAccounts).toEqual([10, 11]);
    expect(second.nextContractCursor).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('enriches a broker working order from its newest orderVersion', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/position/list')) return json([]);
      if (path.endsWith('/order/list')) return json([{
        id: 91, accountId: 10, contractId: 7, timestamp: '2026-08-15T10:00:00.000Z',
        action: 'Sell', ordStatus: 'Working',
      }]);
      if (path.endsWith('/orderVersion/list')) return json([
        { id: 910, orderId: 91, orderType: 'Stop', orderQty: 2, stopPrice: 30_900 },
        { id: 911, orderId: 91, orderType: 'Stop', orderQty: 1, stopPrice: 30_950 },
      ]);
      return json({}, 404);
    }) as unknown as typeof fetch;

    const tick = await loadTradovateLivePnlTick({
      baseUrl: 'https://demo.example.test/v1', accessToken: 'token', connectionId: 'c',
      environment: 'demo', fetchImpl,
    });

    expect(tick.orders).toEqual([expect.objectContaining({
      id: 91,
      orderType: 'Stop',
      quantity: 1,
      stopPrice: 30_950,
      status: 'Working',
    })]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

const coverage = { availability: 'available' as const, count: 1, httpStatus: 200 };
const account = (id: number, averagePrice: number, netPosition = 1) => ({
  id,
  name: `TDFY${id}`,
  createdAt: null,
  active: true,
  canTrade: true,
  netPositionCount: 1,
  workingOrderCount: 0,
  balance: {
    coverage,
    totalCashValue: 50_000,
    totalCashValueSOD: 50_000,
    totalPnL: 0,
    netLiq: 50_000,
    netLiqSOD: 50_000,
    openPnL: 0,
    realizedPnL: 0,
    weekRealizedPnL: 0,
    cashUSD: 50_000,
    cashSODUSD: 50_000,
    currencyCashAvailWithdrawalUSD: null,
    initialMargin: null,
    maintenanceMargin: null,
    fullInitialMargin: null,
    fullInitialMarginSOD: null,
    autoLiqLevel: null,
    withdrawalRejectReason: null,
  },
  activity: { positionCount: 1, netPositionCount: 1, workingOrderCount: 0, orderCount: 0, fillCount: 0, fillPairCount: 0, knownFees: 0, firstFillAt: null, lastFillAt: null },
  history: { coverage, entryCount: 0, firstEntryAt: null, lastEntryAt: null, realizedBalanceDrawdown: null },
  risk: { statusCoverage: coverage, limitsCoverage: coverage, adminAction: null, maxNetLiq: null, minNetLiq: null, dailyLossAutoLiq: null, weeklyLossAutoLiq: null, trailingMaxDrawdown: null, trailingMaxDrawdownLimit: null, trailingMaxDrawdownMode: null, changesLocked: null },
  positions: [{ id, contractId: 7, symbol: 'MNQZ6', timestamp: null, tradeDate: null, netPosition, bought: null, boughtValue: null, sold: null, soldValue: null, previousPosition: null, averagePrice, previousPrice: null }],
  orders: [], fills: [], fillPairs: [], daily: [], ledger: [],
});

const dataset = {
  capturedAt: '2026-08-15T09:59:00.000Z',
  accounts: [account(10, 20_000), account(11, 20_000.25), account(12, 20_001, 2)],
  contracts: [{ id: 7, name: 'MNQZ6', contractMaturityId: null, timestamp: null }],
  coverage: { accounts: coverage, positions: coverage, orders: coverage, fills: coverage, fillPairs: coverage, fillFees: coverage, contracts: coverage },
} as TradovateAccountDataResult;

describe('Tradovate follower live P&L estimation', () => {
  it('detects only the first open to flat transition that needs a full refresh', () => {
    const flatTick: TradovateLivePnlTick = {
      connectionId: 'c', environment: 'demo', capturedAt: '2026-08-15T10:01:00.000Z',
      positions: [], orders: [], anchor: null, activeContractCount: 0, nextContractCursor: 0,
    };
    const stillOpenTick: TradovateLivePnlTick = {
      ...flatTick,
      positions: [{ id: 10, accountId: 10, contractId: 7, netPosition: 1, averagePrice: 20_000, timestamp: null }],
      activeContractCount: 1,
    };
    const alreadyFlat = {
      ...dataset,
      accounts: dataset.accounts.map(value => ({ ...value, netPositionCount: 0, positions: [] })),
    };

    expect(tradovateLiveTickClosedLastPosition(dataset, flatTick)).toBe(true);
    expect(tradovateLiveTickClosedLastPosition(dataset, stillOpenTick)).toBe(false);
    expect(tradovateLiveTickClosedLastPosition(alreadyFlat, flatTick)).toBe(false);
  });

  it('uses each account fill price instead of copying the leader P&L', () => {
    const tick: TradovateLivePnlTick = {
      connectionId: 'c', environment: 'demo', capturedAt: '2026-08-15T10:00:00.000Z',
      positions: [
        { id: 10, accountId: 10, contractId: 7, netPosition: 1, averagePrice: 20_000, timestamp: null },
        { id: 11, accountId: 11, contractId: 7, netPosition: 1, averagePrice: 20_000.25, timestamp: null },
        { id: 12, accountId: 12, contractId: 7, netPosition: 2, averagePrice: 20_001, timestamp: null },
      ],
      orders: [],
      anchor: { accountId: 10, contractId: 7, openPnl: 20, netLiq: 50_020, totalCashValue: 50_000 },
      activeContractCount: 1, nextContractCursor: 0,
    };
    const result = applyTradovateLivePnlTick(dataset, tick);

    expect(result.marks['7'].price).toBe(20_010);
    expect(result.data.accounts.map(value => value.balance.openPnL)).toEqual([20, 19.5, 36]);
    expect(result.data.accounts.map(value => value.balance.openPnlSource)).toEqual(['broker', 'estimated', 'estimated']);
    expect(result.data.accounts.map(value => value.balance.netLiq)).toEqual([50_020, 50_019.5, 50_036]);
  });

  it('refreshes working orders in the lightweight tick', () => {
    const tick: TradovateLivePnlTick = {
      connectionId: 'c', environment: 'demo', capturedAt: '2026-08-15T10:00:00.000Z',
      positions: [],
      orders: [{
        id: 91, accountId: 10, contractId: 7, timestamp: '2026-08-15T10:00:00.000Z',
        action: 'Buy', orderType: 'Limit', quantity: 1, price: 31_500, stopPrice: null,
        status: 'Working', admin: false, ocoId: null, parentId: null, linkedId: null,
      }],
      anchor: null, activeContractCount: 0, nextContractCursor: 0,
    };

    const result = applyTradovateLivePnlTick(dataset, tick);

    expect(result.data.accounts[0].orders).toEqual([expect.objectContaining({ id: 91, symbol: 'MNQZ6', status: 'Working' })]);
    expect(result.data.accounts[0].workingOrderCount).toBe(1);
    expect(result.data.accounts[0].activity).toMatchObject({ workingOrderCount: 1, orderCount: 1 });
    expect(result.data.coverage.orders).toEqual({ availability: 'available', count: 1, httpStatus: 200 });
  });

  it('does not treat Suspended or unknown orders as working protection', () => {
    const tick: TradovateLivePnlTick = {
      connectionId: 'c', environment: 'demo', capturedAt: '2026-08-15T10:00:00.000Z',
      positions: [],
      orders: [
        {
          id: 92, accountId: 10, contractId: 7, timestamp: null,
          action: 'Sell', orderType: 'Stop', quantity: 1, price: null, stopPrice: 31_000,
          status: 'Suspended', admin: false, ocoId: null, parentId: null, linkedId: null,
        },
        {
          id: 93, accountId: 10, contractId: 7, timestamp: null,
          action: 'Sell', orderType: 'Stop', quantity: 1, price: null, stopPrice: 31_000,
          status: null, admin: false, ocoId: null, parentId: null, linkedId: null,
        },
      ],
      anchor: null, activeContractCount: 0, nextContractCursor: 0,
    };

    const result = applyTradovateLivePnlTick(dataset, tick);

    expect(result.data.accounts[0].orders).toHaveLength(2);
    expect(result.data.accounts[0].workingOrderCount).toBe(0);
    expect(result.data.accounts[0].activity.workingOrderCount).toBe(0);
  });

  it('supports only explicitly verified contract values', () => {
    expect(tradovateContractRoot('MNQZ6')).toBe('MNQ');
    expect(tradovateValuePerPoint('MNQZ6')).toBe(2);
    expect(tradovateValuePerPoint('NQH27')).toBe(20);
    expect(tradovateValuePerPoint('ESZ6')).toBeNull();
  });
});

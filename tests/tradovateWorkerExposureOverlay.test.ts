import { describe, expect, it } from 'vitest';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { TradovateAccountDataAccount, TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
import { overlayWorkerExposure, WORKER_EXPOSURE_MAX_AGE_MS } from '../lib/tradovateWorkerExposureOverlay';

const NOW = Date.UTC(2026, 8, 18, 9, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const coverage = (count: number) => ({ availability: count > 0 ? 'available' as const : 'empty' as const, count, httpStatus: 200 });
const account = (id: number, extras: Partial<TradovateAccountDataAccount> = {}): TradovateAccountDataAccount => ({
  id, name: `A${id}`, createdAt: null, active: true, canTrade: true, netPositionCount: 0, workingOrderCount: 0,
  readState: { positions: coverage(0), orders: coverage(0), positionsAsOf: iso(NOW - 600_000), ordersAsOf: iso(NOW - 600_000), cashAsOf: null, requestedAt: iso(NOW - 600_000) },
  balance: { coverage: coverage(1), totalCashValue: 50_000, totalCashValueSOD: 50_000, totalPnL: 0, netLiq: 50_000, netLiqSOD: 50_000, openPnL: 0,
    realizedPnL: 0, weekRealizedPnL: 0, cashUSD: 50_000, cashSODUSD: 50_000, currencyCashAvailWithdrawalUSD: 0, initialMargin: 0, maintenanceMargin: 0,
    fullInitialMargin: 0, fullInitialMarginSOD: 0, autoLiqLevel: null, withdrawalRejectReason: null },
  activity: { positionCount: 0, netPositionCount: 0, workingOrderCount: 0, orderCount: 0, fillCount: 0, fillPairCount: 0, knownFees: 0, firstFillAt: null, lastFillAt: null },
  history: { coverage: coverage(0), entryCount: 0, firstEntryAt: null, lastEntryAt: null, realizedBalanceDrawdown: null },
  risk: { statusCoverage: coverage(0), limitsCoverage: coverage(0), adminAction: null, maxNetLiq: null, minNetLiq: null, dailyLossAutoLiq: null,
    weeklyLossAutoLiq: null, trailingMaxDrawdown: null, trailingMaxDrawdownLimit: null, trailingMaxDrawdownMode: null, changesLocked: null },
  positions: [], orders: [], fills: [], fillPairs: [], daily: [], ledger: [],
  ...extras,
} as TradovateAccountDataAccount);
const data = (): TradovateAccountDataResult => ({
  capturedAt: iso(NOW - 600_000), requestedAt: iso(NOW - 600_000),
  accounts: [
    account(100, { positions: [{ id: 1, contractId: 7, symbol: 'MNQZ6', timestamp: null, tradeDate: null, netPosition: -7, bought: null, boughtValue: null, sold: null, soldValue: null, previousPosition: null, averagePrice: 29_730.75, previousPrice: null }], netPositionCount: 1 }),
    account(200, { orders: [{ id: 5, contractId: 7, symbol: 'MNQZ6', timestamp: null, action: 'Buy', orderType: 'Stop', quantity: 7, price: null, stopPrice: 29_748.25, status: 'Working', admin: null, ocoId: null, parentId: null, linkedId: null }], workingOrderCount: 1 }),
    account(300, { positions: [{ id: 2, contractId: 7, symbol: 'MNQZ6', timestamp: null, tradeDate: null, netPosition: 3, bought: null, boughtValue: null, sold: null, soldValue: null, previousPosition: null, averagePrice: 1, previousPrice: null }] }),
  ],
  contracts: [{ id: 7, name: 'MNQZ6', contractMaturityId: null, timestamp: null }],
  coverage: { accounts: coverage(3), positions: coverage(2), orders: coverage(1), fills: coverage(0), fillPairs: coverage(0), fillFees: coverage(0), contracts: coverage(1) },
});
const status = (extras: Partial<LocalCopierAgentStatus['controller']> = {}, exposureExtras: Record<string, unknown> = {}): LocalCopierAgentStatus => ({
  version: 1, environment: 'demo', nonce: 'n', startedAt: iso(NOW - 3_600_000),
  group: { id: 'g', name: 'G', enabled: true, leaderAccountId: 100, followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }] },
  controller: {
    started: true, armed: true, killSwitch: false, shadowMode: false, connected: true, reconciliationRequired: false,
    divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false, stuckOperations: [], lastError: null, revision: 1, lastSequence: 1,
    exposure: {
      verifiedAt: NOW - 1_000,
      positions: [{ accountId: 100, symbol: 'MNQZ6', netQuantity: -7 }, { accountId: 200, symbol: 'MNQZ6', netQuantity: -7 }],
      followers: [{ accountId: 200, ok: true, detail: null }],
      orders: [{ accountId: 200, brokerOrderId: '663908070136', symbol: 'MNQZ6', side: 'Buy', orderType: 'Stop', quantity: 7, filledQuantity: 0, limitPrice: null, stopPrice: 29_748.25, status: 'working', updatedAt: NOW - 2_000 }],
      ...exposureExtras,
    },
    ...extras,
  },
} as unknown as LocalCopierAgentStatus);

describe('worker exposure overlay', () => {
  it('replaces positions and orders of group accounts with the fresh heartbeat and stamps the heartbeat time', () => {
    const out = overlayWorkerExposure(data(), status(), NOW - 1_500, NOW)!;
    const follower = out.accounts.find(a => a.id === 200)!;
    expect(follower.positions).toEqual([expect.objectContaining({ symbol: 'MNQZ6', netPosition: -7, contractId: 7, timestamp: iso(NOW - 1_500) })]);
    expect(follower.orders).toEqual([expect.objectContaining({ id: 663908070136, action: 'Buy', orderType: 'Stop', stopPrice: 29_748.25, status: 'Working', contractId: 7 })]);
    expect(follower.netPositionCount).toBe(1);
    expect(follower.workingOrderCount).toBe(1);
    expect(follower.readState).toMatchObject({ positionsAsOf: iso(NOW - 1_500), ordersAsOf: iso(NOW - 1_500),
      positions: { availability: 'available', count: 1 }, orders: { availability: 'available', count: 1 } });
    const leader = out.accounts.find(a => a.id === 100)!;
    expect(leader.positions[0]).toMatchObject({ netPosition: -7, averagePrice: 29_730.75 });
    expect(leader.orders).toEqual([]);
    expect(leader.readState?.orders).toMatchObject({ availability: 'empty', count: 0 });
    expect(leader.balance.totalCashValue).toBe(50_000);
  });
  it('leaves accounts outside the copy group untouched', () => {
    const before = data();
    const out = overlayWorkerExposure(before, status(), NOW - 1_000, NOW)!;
    expect(out.accounts.find(a => a.id === 300)).toBe(before.accounts[2]);
  });
  it.each([
    ['stale heartbeat', status(), NOW - WORKER_EXPOSURE_MAX_AGE_MS - 1],
    ['future heartbeat', status(), NOW + 10_000],
    ['no observation time', status(), null],
    ['stream disconnected', status({ connected: false }), NOW - 1_000],
    ['no exposure block', status({ exposure: null }), NOW - 1_000],
    ['no status at all', null, NOW - 1_000],
  ])('returns the REST data unchanged for %s', (_label, current, observedAt) => {
    const before = data();
    expect(overlayWorkerExposure(before, current, observedAt, NOW)).toBe(before);
  });
  it('keeps REST orders when the worker heartbeat predates the orders field', () => {
    const out = overlayWorkerExposure(data(), status({}, { orders: undefined }), NOW - 1_000, NOW)!;
    const follower = out.accounts.find(a => a.id === 200)!;
    expect(follower.orders).toHaveLength(1);
    expect(follower.orders[0].id).toBe(5);
    expect(follower.readState?.ordersAsOf).toBe(iso(NOW - 600_000));
    expect(follower.readState?.positionsAsOf).toBe(iso(NOW - 1_000));
  });
  it('a flat account from the worker becomes an explicit empty read, never a stale position', () => {
    const out = overlayWorkerExposure(data(), status({}, { positions: [] }), NOW - 1_000, NOW)!;
    const leader = out.accounts.find(a => a.id === 100)!;
    expect(leader.positions).toEqual([]);
    expect(leader.readState).toMatchObject({ positions: { availability: 'empty', count: 0 }, positionsAsOf: iso(NOW - 1_000) });
  });
});

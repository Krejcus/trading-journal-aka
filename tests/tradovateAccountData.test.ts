import { describe, expect, it } from 'vitest';
import {
  buildDailyAccountSummaries,
  calculateRealizedBalanceDrawdown,
  loadTradovateAccountIdentity,
  loadTradovateAccountData,
} from '../server/tradovateAccountData';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Tradovate read-only account data', () => {
  it('načte přesný Account.timestamp lehkým read-only dotazem', async () => {
    const identity = await loadTradovateAccountIdentity({
      baseUrl: 'https://demo.tradovateapi.com/v1',
      accessToken: 'secret',
      accountId: 10,
      fetchImpl: async input => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/v1/account/item');
        expect(url.searchParams.get('id')).toBe('10');
        return json({ id: 10, name: 'TDFY10', timestamp: '2026-08-13T19:45:00.000Z' });
      },
    });
    expect(identity).toEqual({ id: 10, name: 'TDFY10', createdAt: '2026-08-13T19:45:00.000Z' });
  });

  it('počítá realized balance drawdown chronologicky', () => {
    expect(calculateRealizedBalanceDrawdown([
      { timestamp: '2026-08-14T10:02:00Z', amount: 49_300 },
      { timestamp: '2026-08-14T10:00:00Z', amount: 50_000 },
      { timestamp: '2026-08-14T10:01:00Z', amount: 50_250 },
    ])).toBe(950);
    expect(calculateRealizedBalanceDrawdown([])).toBeNull();
  });

  it('skládá broker-reported denní P&L, cash delta, trade P&L a poplatky podle tradeDate', () => {
    const fees = new Map([
      [40, { id: 40, commission: 2.5, exchangeFee: 1.2 }],
      [41, { id: 41, commission: 2.5, exchangeFee: 1.2 }],
    ]);
    const daily = buildDailyAccountSummaries([
      {
        timestamp: '2026-08-13T20:00:00Z',
        tradeDate: { year: 2026, month: 8, day: 13 },
        amount: 49_900,
        delta: -100,
        cashChangeType: 'TradePaired',
        realizedPnL: -100,
        fillPairId: 49,
      },
      {
        timestamp: '2026-08-14T10:00:00Z',
        tradeDate: { year: 2026, month: 8, day: 14 },
        amount: 50_100,
        delta: 200,
        cashChangeType: 'TradePaired',
        realizedPnL: 200,
        weekRealizedPnL: 100,
        fillPairId: 50,
      },
      {
        timestamp: '2026-08-14T10:00:01Z',
        tradeDate: { year: 2026, month: 8, day: 14 },
        amount: 50_092.6,
        delta: -7.4,
        cashChangeType: 'Commission',
        realizedPnL: 192.6,
        weekRealizedPnL: 92.6,
        fillId: 41,
      },
    ], [
      { id: 40, orderId: 30, contractId: 99, tradeDate: { year: 2026, month: 8, day: 14 } },
      { id: 41, orderId: 31, contractId: 99, tradeDate: { year: 2026, month: 8, day: 14 } },
    ], fees);

    expect(daily.map(day => day.tradeDate)).toEqual(['2026-08-14', '2026-08-13']);
    expect(daily[0]).toMatchObject({
      reportedRealizedPnl: 192.6,
      reportedWeekRealizedPnl: 92.6,
      endingBalance: 50_092.6,
      cashDelta: 192.6,
      grossTradePnl: 200,
      feeDelta: -7.4,
      knownFillFees: 7.4,
      fillCount: 2,
      pairedTradeCount: 1,
    });
  });

  it('koreluje účty, fills, poplatky, historii a risk bez broker write volání', async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ path: `${url.pathname}${url.search}`, method, body });

      if (url.pathname.endsWith('/account/list')) return json([{ id: 10, name: 'TDFY10', active: true, readonly: false }]);
      if (url.pathname.endsWith('/position/list')) return json([{
        id: 20,
        accountId: 10,
        contractId: 99,
        timestamp: '2026-08-14T10:00:00Z',
        tradeDate: { year: 2026, month: 8, day: 14 },
        netPos: 0,
        bought: 1,
        boughtValue: 20_000,
        sold: 1,
        soldValue: 20_010,
        netPrice: 20_000,
      }]);
      if (url.pathname.endsWith('/order/list')) return json([
        { id: 30, accountId: 10, contractId: 99, timestamp: '2026-08-14T09:30:00Z', action: 'Buy', orderType: 'Limit', orderQty: 1, price: 20_000, ordStatus: 'Filled' },
        { id: 31, accountId: 10, contractId: 99, timestamp: '2026-08-14T10:00:00Z', action: 'Sell', ordStatus: 'Filled' },
      ]);
      if (url.pathname.endsWith('/fill/list')) return json([
        { id: 40, orderId: 30, contractId: 99, timestamp: '2026-08-14T09:30:00Z', tradeDate: { year: 2026, month: 8, day: 14 }, action: 'Buy', qty: 1, price: 20_000 },
        { id: 41, orderId: 31, contractId: 99, timestamp: '2026-08-14T10:00:00Z', tradeDate: { year: 2026, month: 8, day: 14 }, action: 'Sell', qty: 1, price: 20_010 },
      ]);
      if (url.pathname.endsWith('/fillPair/list')) return json([{ id: 50, positionId: 20, buyFillId: 40, sellFillId: 41, qty: 1, buyPrice: 20_000, sellPrice: 20_010, active: true }]);
      if (url.pathname.endsWith('/fillFee/list')) return json([
        { id: 40, commission: 2.5, exchangeFee: 1.2 },
        { id: 41, commission: 2.5, exchangeFee: 1.2 },
      ]);
      if (url.pathname.endsWith('/cashBalance/list')) return json([
        {
          id: 70,
          accountId: 10,
          timestamp: '2026-08-13T22:00:00Z',
          tradeDate: { year: 2026, month: 8, day: 13 },
          amountSOD: 50_000,
          amount: 50_275,
          realizedPnL: 275,
          weekRealizedPnL: 275,
        },
      ]);
      if (url.pathname.endsWith('/contract/items')) return json([{ id: 99, name: 'NQZ6', contractMaturityId: 900, timestamp: '2026-08-01T00:00:00Z' }]);
      if (url.pathname.endsWith('/cashBalance/getcashbalancesnapshot')) return json({
        totalCashValue: 50_100,
        netLiq: 50_125,
        realizedPnL: 100,
        openPnL: 25,
      });
      if (url.pathname.endsWith('/cashBalanceLog/deps')) return json([
        { id: 60, timestamp: '2026-08-14T09:00:00Z', tradeDate: { year: 2026, month: 8, day: 14 }, amount: 50_000, delta: 0, realizedPnL: 0, cashChangeType: 'NewSession' },
        { id: 61, timestamp: '2026-08-14T09:30:01Z', tradeDate: { year: 2026, month: 8, day: 14 }, amount: 49_996.3, delta: -3.7, realizedPnL: -3.7, cashChangeType: 'Commission', fillId: 40 },
        { id: 62, timestamp: '2026-08-14T10:00:00Z', tradeDate: { year: 2026, month: 8, day: 14 }, amount: 50_196.3, delta: 200, realizedPnL: 196.3, cashChangeType: 'TradePaired', fillPairId: 50 },
        { id: 63, timestamp: '2026-08-14T10:00:01Z', tradeDate: { year: 2026, month: 8, day: 14 }, amount: 50_192.6, delta: -3.7, realizedPnL: 192.6, cashChangeType: 'Commission', fillId: 41 },
      ]);
      if (url.pathname.endsWith('/accountRiskStatus/deps')) return json([{ adminAction: 'Normal', maxNetLiq: 50_500, minNetLiq: 49_000 }]);
      if (url.pathname.endsWith('/userAccountAutoLiq/deps')) return json([{
        changesLocked: true,
        dailyLossAutoLiq: 1_000,
        trailingMaxDrawdownLimit: 999_999_999,
        trailingMaxDrawdownMode: 'EOD',
      }]);
      return json({ error: 'unexpected' }, 404);
    }) as typeof fetch;

    const result = await loadTradovateAccountData({
      baseUrl: 'https://demo.tradovateapi.com/v1',
      accessToken: 'secret-token',
      fetchImpl,
      now: Date.UTC(2026, 7, 14, 12),
    });

    expect(result.capturedAt).toBe('2026-08-14T12:00:00.000Z');
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      name: 'TDFY10',
      balance: { totalCashValue: 50_100, netLiq: 50_125, realizedPnL: 100 },
      activity: { fillCount: 2, fillPairCount: 1, knownFees: 7.4 },
      history: { entryCount: 4 },
      risk: { adminAction: 'Normal', dailyLossAutoLiq: 1_000, trailingMaxDrawdownLimit: null },
    });
    expect(result.accounts[0].history.realizedBalanceDrawdown).toBeCloseTo(3.7);
    expect(result.contracts).toEqual([{ id: 99, name: 'NQZ6', contractMaturityId: 900, timestamp: '2026-08-01T00:00:00Z' }]);
    expect(result.accounts[0].positions[0]).toMatchObject({ symbol: 'NQZ6', bought: 1, sold: 1, averagePrice: 20_000 });
    expect(result.accounts[0].orders.map(order => order.id)).toEqual([31, 30]);
    expect(result.accounts[0].orders[1]).toMatchObject({ orderType: 'Limit', quantity: 1, price: 20_000, stopPrice: null });
    expect(result.accounts[0].fills[0]).toMatchObject({ id: 41, symbol: 'NQZ6', action: 'Sell', quantity: 1, price: 20_010, fees: { total: 3.7 } });
    expect(result.accounts[0].fillPairs[0]).toMatchObject({
      id: 50,
      symbol: 'NQZ6',
      side: 'Long',
      quantity: 1,
      grossPnl: 200,
      knownFees: 7.4,
      netPnl: 192.6,
    });
    expect(result.accounts[0].daily[0]).toMatchObject({ tradeDate: '2026-08-14', reportedRealizedPnl: 192.6, grossTradePnl: 200, knownFillFees: 7.4 });
    expect(result.accounts[0].daily[1]).toMatchObject({
      tradeDate: '2026-08-13',
      reportedRealizedPnl: 275,
      endingBalance: 50_275,
      cashDelta: 275,
    });
    expect(result.accounts[0].ledger).toHaveLength(4);
    expect(requests.find(request => request.path.endsWith('/cashBalance/getcashbalancesnapshot'))).toMatchObject({
      method: 'POST',
      body: { accountId: 10 },
    });
    expect(requests.every(request => request.method === 'GET' || request.path.endsWith('/cashBalance/getcashbalancesnapshot'))).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('secret-token');
  });

  it('přiřadí historické filly k účtu i přes cash ledger, když už order/list příkaz neobsahuje', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/account/list')) return json([{ id: 10 }]);
      if (path.endsWith('/order/list') || path.endsWith('/position/list')) return json([]);
      if (path.endsWith('/fillFee/list')) return json({}, 403);
      if (path.endsWith('/fill/list')) return json([
        { id: 40, orderId: 30, contractId: 99, timestamp: '2026-08-13T09:30:00Z', action: 'Buy', qty: 1, price: 20_000 },
        { id: 41, orderId: 31, contractId: 99, timestamp: '2026-08-13T10:00:00Z', action: 'Sell', qty: 1, price: 20_005 },
      ]);
      if (path.endsWith('/fillPair/list')) return json([{ id: 50, buyFillId: 40, sellFillId: 41, qty: 1 }]);
      if (path.endsWith('/contract/items')) return json([{ id: 99, name: 'MNQZ6' }]);
      if (path.endsWith('/cashBalance/getcashbalancesnapshot')) return json({ totalCashValue: 50_000 });
      if (path.endsWith('/cashBalanceLog/deps')) return json([{
        timestamp: '2026-08-13T10:00:00Z',
        tradeDate: { year: 2026, month: 8, day: 13 },
        cashChangeType: 'TradePaired',
        delta: 10,
        fillPairId: 50,
      }]);
      return json([]);
    }) as typeof fetch;

    const result = await loadTradovateAccountData({
      baseUrl: 'https://demo.tradovateapi.com/v1',
      accessToken: 'token',
      fetchImpl,
    });

    expect(result.accounts[0].orders).toEqual([]);
    expect(result.accounts[0].fills.map(fill => fill.id)).toEqual([41, 40]);
    expect(result.accounts[0].fillPairs[0]).toMatchObject({
      id: 50,
      symbol: 'MNQZ6',
      grossPnl: 10,
      knownFees: null,
      netPnl: null,
    });
    expect(result.coverage.fillFees.availability).toBe('denied');
  });

  it('nezastaví balance, když prop-firm risk endpoint odmítne přístup', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/account/list')) return json([{ id: 10 }]);
      if (path.endsWith('/cashBalance/getcashbalancesnapshot')) return json({ totalCashValue: 50_000 });
      if (path.endsWith('/accountRiskStatus/deps') || path.endsWith('/userAccountAutoLiq/deps')) return json({}, 403);
      return json([]);
    }) as typeof fetch;

    const result = await loadTradovateAccountData({
      baseUrl: 'https://demo.tradovateapi.com/v1',
      accessToken: 'token',
      fetchImpl,
    });

    expect(result.accounts[0].balance.totalCashValue).toBe(50_000);
    expect(result.accounts[0].risk.statusCoverage.availability).toBe('denied');
    expect(result.accounts[0].risk.limitsCoverage.availability).toBe('denied');
  });
});

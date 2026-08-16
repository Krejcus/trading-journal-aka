import { describe, expect, it } from 'vitest';
import { calculateRealizedBalanceDrawdown, loadTradovateAccountData } from '../server/tradovateAccountData';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Tradovate read-only account data', () => {
  it('počítá realized balance drawdown chronologicky', () => {
    expect(calculateRealizedBalanceDrawdown([
      { timestamp: '2026-08-14T10:02:00Z', amount: 49_300 },
      { timestamp: '2026-08-14T10:00:00Z', amount: 50_000 },
      { timestamp: '2026-08-14T10:01:00Z', amount: 50_250 },
    ])).toBe(950);
    expect(calculateRealizedBalanceDrawdown([])).toBeNull();
  });

  it('koreluje účty, fills, poplatky, historii a risk bez broker write volání', async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ path: `${url.pathname}${url.search}`, method, body });

      if (url.pathname.endsWith('/account/list')) return json([{ id: 10, name: 'TDFY10', active: true, readonly: false }]);
      if (url.pathname.endsWith('/position/list')) return json([{ id: 20, accountId: 10, netPos: 0 }]);
      if (url.pathname.endsWith('/order/list')) return json([{ id: 30, accountId: 10, ordStatus: 'Filled' }]);
      if (url.pathname.endsWith('/fill/list')) return json([{ id: 40, orderId: 30, timestamp: '2026-08-14T10:00:00Z' }]);
      if (url.pathname.endsWith('/fillPair/list')) return json([{ buyFillId: 40, sellFillId: 41 }]);
      if (url.pathname.endsWith('/fillFee/list')) return json([{ id: 40, commission: 2.5, exchangeFee: 1.2 }]);
      if (url.pathname.endsWith('/cashBalance/getcashbalancesnapshot')) return json({
        totalCashValue: 50_100,
        netLiq: 50_125,
        realizedPnL: 100,
        openPnL: 25,
      });
      if (url.pathname.endsWith('/cashBalanceLog/deps')) return json([
        { timestamp: '2026-08-14T09:00:00Z', amount: 50_000 },
        { timestamp: '2026-08-14T10:00:00Z', amount: 49_800 },
      ]);
      if (url.pathname.endsWith('/accountRiskStatus/deps')) return json([{ adminAction: 'Normal', maxNetLiq: 50_500, minNetLiq: 49_000 }]);
      if (url.pathname.endsWith('/userAccountAutoLiq/deps')) return json([{
        changesLocked: true,
        dailyLossAutoLiq: 1_000,
        trailingMaxDrawdownLimit: 2_000,
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
      activity: { fillCount: 1, fillPairCount: 1, knownFees: 3.7 },
      history: { entryCount: 2, realizedBalanceDrawdown: 200 },
      risk: { adminAction: 'Normal', dailyLossAutoLiq: 1_000, trailingMaxDrawdownLimit: 2_000 },
    });
    expect(requests.find(request => request.path.endsWith('/cashBalance/getcashbalancesnapshot'))).toMatchObject({
      method: 'POST',
      body: { accountId: 10 },
    });
    expect(requests.every(request => request.method === 'GET' || request.path.endsWith('/cashBalance/getcashbalancesnapshot'))).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('secret-token');
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

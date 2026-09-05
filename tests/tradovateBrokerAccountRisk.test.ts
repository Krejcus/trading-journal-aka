import { describe, expect, it, vi } from 'vitest';
import { createMockBroker } from '../services/mockBroker';
import { createTradovateBroker } from '../services/tradovateBroker';

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

describe('Tradovate broker account risk snapshots', () => {
  it('uses only the three read-only dependent GETs and maps broker fields', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      const accountId = Number(url.searchParams.get('masterid'));
      if (url.pathname.endsWith('/cashBalance/deps')) {
        return json(accountId === 101
          ? [{ accountId, amount: 49_675.25, realizedPnL: -324.75 }]
          : [{ accountId, amount: 50_125, realizedPnL: 125 }]);
      }
      if (url.pathname.endsWith('/accountRiskStatus/deps')) {
        return json(accountId === 101
          ? [{ maxNetLiq: 50_250, minNetLiq: 48_750 }]
          : [{ maxNetLiq: 50_500, minNetLiq: 50_000 }]);
      }
      if (url.pathname.endsWith('/userAccountAutoLiq/deps')) {
        return json(accountId === 101
          ? [{ dailyLossAutoLiq: 1_250, trailingMaxDrawdown: 2_000 }]
          : [{ dailyLossAutoLiq: 1_200, trailingMaxDrawdown: 1_800 }]);
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });
    const broker = createTradovateBroker({
      environment: 'demo',
      accessToken: 'token',
      clock: () => 1_789_000_000_000,
      fetchImpl: fetchImpl as typeof fetch,
      webSocketFactory: () => { throw new Error('WebSocket is not used'); },
    });

    await expect(broker.listAccountRiskSnapshots([101, 202, 101])).resolves.toEqual([
      {
        accountId: 101,
        at: 1_789_000_000_000,
        realizedPnlUsd: -324.75,
        netLiq: 50_250,
        minNetLiq: 48_750,
        dailyLossAutoLiq: 1_250,
        trailingMaxDrawdown: 2_000,
      },
      {
        accountId: 202,
        at: 1_789_000_000_000,
        realizedPnlUsd: 125,
        netLiq: 50_500,
        minNetLiq: 50_000,
        dailyLossAutoLiq: 1_200,
        trailingMaxDrawdown: 1_800,
      },
    ]);

    expect(calls).toHaveLength(6);
    expect(calls.every(call => call.init?.method === 'GET')).toBe(true);
    expect(calls.map(call => `${call.url.pathname}?${call.url.searchParams}`).sort()).toEqual([
      '/v1/accountRiskStatus/deps?masterid=101',
      '/v1/accountRiskStatus/deps?masterid=202',
      '/v1/cashBalance/deps?masterid=101',
      '/v1/cashBalance/deps?masterid=202',
      '/v1/userAccountAutoLiq/deps?masterid=101',
      '/v1/userAccountAutoLiq/deps?masterid=202',
    ]);
  });

  it('returns null for absent, malformed and disabled-sentinel fields instead of inventing zeroes', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/cashBalance/deps')) {
        // `amount` je cash balance, nikoli net liquidation value.
        return json([{ accountId: 303, realizedPnL: '0', amount: 49_900 }]);
      }
      if (path.endsWith('/accountRiskStatus/deps')) {
        return json([{ minNetLiq: 999_999_999 }]);
      }
      if (path.endsWith('/userAccountAutoLiq/deps')) {
        return json([{ dailyLossAutoLiq: 999_999_999 }]);
      }
      throw new Error(`unexpected request ${path}`);
    });
    const broker = createTradovateBroker({
      environment: 'demo',
      accessToken: 'token',
      clock: () => 321,
      fetchImpl: fetchImpl as typeof fetch,
      webSocketFactory: () => { throw new Error('WebSocket is not used'); },
    });

    await expect(broker.listAccountRiskSnapshots([303])).resolves.toEqual([{
      accountId: 303,
      at: 321,
      realizedPnlUsd: null,
      netLiq: null,
      minNetLiq: null,
      dailyLossAutoLiq: null,
      trailingMaxDrawdown: null,
    }]);
  });
});

describe('mock broker account risk snapshots', () => {
  it('returns configured snapshots for requested accounts without sharing mutable objects', async () => {
    const broker = createMockBroker({
      accountRiskSnapshots: [
        {
          accountId: 10,
          at: 100,
          realizedPnlUsd: -50,
          netLiq: 49_950,
          minNetLiq: 48_750,
          dailyLossAutoLiq: 1_250,
          trailingMaxDrawdown: 2_000,
        },
        {
          accountId: 20,
          at: 200,
          realizedPnlUsd: -75,
          netLiq: 49_925,
          minNetLiq: 48_800,
          dailyLossAutoLiq: null,
          trailingMaxDrawdown: null,
        },
      ],
    });

    const snapshots = await broker.listAccountRiskSnapshots([20, 10, 20, 30]);
    expect(snapshots.map(snapshot => snapshot.accountId)).toEqual([20, 10]);
    expect(snapshots[0]).toMatchObject({ at: 200, realizedPnlUsd: -75 });
    expect(snapshots[0]).not.toBe((await broker.listAccountRiskSnapshots([20]))[0]);
  });

  it('defaults requested accounts to fresh unknown values', async () => {
    const broker = createMockBroker({ clock: () => 777 });
    await expect(broker.listAccountRiskSnapshots([10, 20])).resolves.toEqual([
      {
        accountId: 10,
        at: 777,
        realizedPnlUsd: null,
        netLiq: null,
        minNetLiq: null,
        dailyLossAutoLiq: null,
        trailingMaxDrawdown: null,
      },
      {
        accountId: 20,
        at: 777,
        realizedPnlUsd: null,
        netLiq: null,
        minNetLiq: null,
        dailyLossAutoLiq: null,
        trailingMaxDrawdown: null,
      },
    ]);
  });
});

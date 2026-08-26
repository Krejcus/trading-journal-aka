import { describe, expect, it, vi } from 'vitest';
import { createBrokerRouter } from '../services/brokerRouter';
import {
  refreshDynamicBrokerRoutes,
  resolveDynamicBrokerRoutes,
  type DynamicOAuthConnection,
} from '../services/dynamicBrokerRouting';
import { createMockBroker } from '../services/mockBroker';
import type { TradovateBrokerPort, TradovateVisibleAccount } from '../services/tradovateBroker';

const connection = (connectionId: string, accounts: TradovateVisibleAccount[]) => {
  const broker = createMockBroker() as unknown as TradovateBrokerPort;
  broker.renewSocket = vi.fn(() => false);
  broker.refreshAccountDirectory = vi.fn(async () => accounts);
  return { connectionId, broker } satisfies DynamicOAuthConnection;
};

const account = (
  accountId: number,
  options: Partial<TradovateVisibleAccount> = {},
): TradovateVisibleAccount => ({
  accountId,
  accountSpec: `ACCOUNT-${accountId}`,
  active: true,
  canTrade: true,
  ...options,
});

describe('dynamic account -> OAuth routing', () => {
  it('najde nově přidaný účet a přepne ho bez worker reinstallu', async () => {
    const tradeify = connection('tradeify', [account(11)]);
    const lucid = connection('lucid', [account(22), account(63338592)]);
    const router = createBrokerRouter([
      { broker: tradeify.broker, accountIds: [11] },
      { broker: lucid.broker, accountIds: [22] },
    ]);

    await expect(refreshDynamicBrokerRoutes([tradeify, lucid], router, [11, 63338592]))
      .resolves.toEqual([
        expect.objectContaining({ id: 11, connectionId: 'tradeify' }),
        expect.objectContaining({ id: 63338592, connectionId: 'lucid' }),
      ]);
    await router.placeOrder({
      tag: 'dynamic', accountId: 63338592, symbol: 'MNQ', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    expect((lucid.broker as unknown as ReturnType<typeof createMockBroker>).placedRequests())
      .toEqual([expect.objectContaining({ accountId: 63338592 })]);
  });

  it('při chybějícím, duplicitním nebo netradovatelném účtu failne nahlas', () => {
    const first = connection('first', [account(11), account(44, { canTrade: false })]);
    const second = connection('second', [account(11)]);
    const snapshots = new Map([
      ['first', [account(11), account(44, { canTrade: false })]],
      ['second', [account(11)]],
    ]);
    expect(() => resolveDynamicBrokerRoutes([first, second], snapshots, [999]))
      .toThrow('není viditelný v žádném připojeném OAuth');
    expect(() => resolveDynamicBrokerRoutes([first, second], snapshots, [11]))
      .toThrow('ve více OAuth spojeních');
    expect(() => resolveDynamicBrokerRoutes([first, second], snapshots, [44]))
      .toThrow('nemá execution oprávnění');
  });

  it('selhání refresh jednoho OAuth nechá původní router beze změny', async () => {
    const first = connection('first', [account(11)]);
    const second = connection('second', [account(22)]);
    vi.mocked(second.broker.refreshAccountDirectory).mockRejectedValueOnce(new Error('oauth-down'));
    const router = createBrokerRouter([
      { broker: first.broker, accountIds: [11] },
      { broker: second.broker, accountIds: [22] },
    ]);

    await expect(refreshDynamicBrokerRoutes([first, second], router, [11, 33])).rejects.toThrow('oauth-down');
    await router.placeOrder({
      tag: 'old-route', accountId: 22, symbol: 'MNQ', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    expect((second.broker as unknown as ReturnType<typeof createMockBroker>).placedRequests())
      .toEqual([expect.objectContaining({ accountId: 22 })]);
  });
});

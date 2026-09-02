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

    await expect(refreshDynamicBrokerRoutes([tradeify, lucid], router, {
      required: [11, 63338592], optional: [],
    })).resolves.toEqual({
      accounts: [
        expect.objectContaining({ id: 11, connectionId: 'tradeify' }),
        expect.objectContaining({ id: 63338592, connectionId: 'lucid' }),
      ],
      missingOptional: [],
    });
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
    expect(() => resolveDynamicBrokerRoutes([first, second], snapshots, { required: [999], optional: [] }))
      .toThrow('není viditelný v žádném připojeném OAuth');
    expect(() => resolveDynamicBrokerRoutes([first, second], snapshots, { required: [11], optional: [] }))
      .toThrow('ve více OAuth spojeních');
    expect(() => resolveDynamicBrokerRoutes([first, second], snapshots, { required: [44], optional: [] }))
      .toThrow('nemá execution oprávnění');
  });

  it('vynechá jen chybějící optional účet; viditelný optional účet dál routuje a validuje přísně', async () => {
    const first = connection('first', [account(11), account(22)]);
    const second = connection('second', [account(33), account(44, { canTrade: false })]);
    const router = createBrokerRouter([
      { broker: first.broker, accountIds: [11] },
      { broker: second.broker, accountIds: [33] },
    ]);

    const refreshed = await refreshDynamicBrokerRoutes([first, second], router, {
      required: [11, 33], optional: [22, 999],
    });
    expect(refreshed).toEqual({
      accounts: [
        expect.objectContaining({ id: 11, connectionId: 'first' }),
        expect.objectContaining({ id: 33, connectionId: 'second' }),
        expect.objectContaining({ id: 22, connectionId: 'first' }),
      ],
      missingOptional: [999],
    });
    await router.placeOrder({
      tag: 'visible-optional', accountId: 22, symbol: 'MNQ', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    expect((first.broker as unknown as ReturnType<typeof createMockBroker>).placedRequests())
      .toEqual([expect.objectContaining({ accountId: 22 })]);

    await expect(refreshDynamicBrokerRoutes([first, second], router, {
      required: [11], optional: [44],
    })).rejects.toThrow('nemá execution oprávnění');
  });

  it('selhání refresh jednoho OAuth nechá původní router beze změny', async () => {
    const first = connection('first', [account(11)]);
    const second = connection('second', [account(22)]);
    vi.mocked(second.broker.refreshAccountDirectory).mockRejectedValueOnce(new Error('oauth-down'));
    const router = createBrokerRouter([
      { broker: first.broker, accountIds: [11] },
      { broker: second.broker, accountIds: [22] },
    ]);

    await expect(refreshDynamicBrokerRoutes([first, second], router, {
      required: [11, 33], optional: [],
    })).rejects.toThrow('oauth-down');
    await router.placeOrder({
      tag: 'old-route', accountId: 22, symbol: 'MNQ', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    expect((second.broker as unknown as ReturnType<typeof createMockBroker>).placedRequests())
      .toEqual([expect.objectContaining({ accountId: 22 })]);
  });
});

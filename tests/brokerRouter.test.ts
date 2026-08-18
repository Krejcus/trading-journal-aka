import { describe, expect, it, vi } from 'vitest';
import { createBrokerRouter } from '../services/brokerRouter';
import { createMockBroker } from '../services/mockBroker';

describe('broker router', () => {
  it('routes follower side effects by account across OAuth connections', async () => {
    const first = createMockBroker();
    const second = createMockBroker();
    const router = createBrokerRouter([
      { broker: first, accountIds: [11, 12] },
      { broker: second, accountIds: [21, 22] },
    ]);
    await router.placeOrder({
      tag: 'first', accountId: 12, symbol: 'MNQ', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    await router.placeOrder({
      tag: 'second', accountId: 22, symbol: 'MNQ', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    expect(first.placedRequests().map(item => item.accountId)).toEqual([12]);
    expect(second.placedRequests().map(item => item.accountId)).toEqual([22]);
  });

  it('reports connected only when every OAuth connection is connected', () => {
    const first = createMockBroker();
    const second = createMockBroker();
    const router = createBrokerRouter([
      { broker: first, accountIds: [11] },
      { broker: second, accountIds: [22] },
    ]);
    const listener = vi.fn();
    const unsubscribe = router.subscribe(listener);
    first.setConnected(true);
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'connection', connected: true }));
    second.setConnected(true);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'connection', connected: true }));
    first.setConnected(false);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'connection', connected: false }));
    unsubscribe();
  });

  it('forwards account entities only from the route that owns the account', () => {
    const first = createMockBroker();
    const second = createMockBroker();
    const router = createBrokerRouter([
      { broker: first, accountIds: [11] },
      { broker: second, accountIds: [22] },
    ]);
    const listener = vi.fn();
    router.subscribe(listener);
    first.emitEvent({
      type: 'position',
      position: { accountId: 22, symbol: 'MNQ', netQuantity: 1 },
    });
    expect(listener).not.toHaveBeenCalled();
    second.emitEvent({
      type: 'position',
      position: { accountId: 22, symbol: 'MNQ', netQuantity: 1 },
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fails closed for unknown or duplicate account routes and mixed environments', async () => {
    const demo = createMockBroker({ environment: 'demo' });
    const live = createMockBroker({ environment: 'live' });
    expect(() => createBrokerRouter([
      { broker: demo, accountIds: [11] }, { broker: demo, accountIds: [11] },
    ])).toThrow('Stejné OAuth spojení');
    expect(() => createBrokerRouter([
      { broker: demo, accountIds: [11] }, { broker: demo, accountIds: [22] },
    ])).toThrow('Stejné OAuth spojení');
    expect(() => createBrokerRouter([
      { broker: demo, accountIds: [11] }, { broker: live, accountIds: [22] },
    ])).toThrow('DEMO a LIVE');
    const router = createBrokerRouter([{ broker: demo, accountIds: [11] }]);
    expect(() => router.listPositions(22)).toThrow('není nakonfigurované OAuth');
  });
});

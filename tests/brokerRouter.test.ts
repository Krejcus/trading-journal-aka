import { describe, expect, it, vi } from 'vitest';
import { createBrokerRouter } from '../services/brokerRouter';
import type { BrokerEvent } from '../services/brokerPort';
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

  it('atomicky přepne nový účet i event filtr bez restartu socketů', async () => {
    const first = createMockBroker();
    const second = createMockBroker();
    const router = createBrokerRouter([
      { broker: first, accountIds: [11] },
      { broker: second, accountIds: [22] },
    ]);
    const listener = vi.fn();
    router.subscribe(listener);

    router.replaceRoutes([
      { broker: first, accountIds: [11] },
      { broker: second, accountIds: [22, 33] },
    ]);
    await router.placeOrder({
      tag: 'new-account', accountId: 33, symbol: 'MNQ', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    expect(second.placedRequests()).toEqual([expect.objectContaining({ accountId: 33 })]);
    listener.mockClear();

    first.emitEvent({ type: 'position', position: { accountId: 33, symbol: 'MNQ', netQuantity: 1 } });
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'position', position: expect.objectContaining({ accountId: 33 }),
    }));
    second.emitEvent({ type: 'position', position: { accountId: 33, symbol: 'MNQ', netQuantity: 1 } });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'position', position: expect.objectContaining({ accountId: 33 }),
    }));
  });

  it('vadnou dynamickou routu odmítne bez poškození předchozí mapy', async () => {
    const first = createMockBroker();
    const second = createMockBroker();
    const router = createBrokerRouter([
      { broker: first, accountIds: [11] },
      { broker: second, accountIds: [22] },
    ]);
    expect(() => router.replaceRoutes([
      { broker: first, accountIds: [11, 33] },
      { broker: second, accountIds: [22, 33] },
    ])).toThrow('ve více broker routes');

    await router.placeOrder({
      tag: 'old-route-survives', accountId: 22, symbol: 'MNQ', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    expect(second.placedRequests()).toEqual([expect.objectContaining({ accountId: 22 })]);
    expect(() => router.listPositions(33)).toThrow('není nakonfigurované OAuth');
  });
});

describe('reconnect grace nekritických spojení', () => {
  const graceRouter = (events: BrokerEvent[], graceMs = 20) => {
    const critical = createMockBroker();
    const follower = createMockBroker();
    const router = createBrokerRouter([
      { broker: critical, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200], critical: false },
    ], { reconnectGraceMs: graceMs });
    const unsubscribe = router.subscribe(event => events.push(event));
    critical.setConnected(true);
    follower.setConnected(true);
    return { critical, follower, unsubscribe };
  };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  it('mrknutí follower spojení kratší než lhůta se nikdy neohlásí', async () => {
    const events: BrokerEvent[] = [];
    const { follower, unsubscribe } = graceRouter(events, 40);
    expect(events.filter(event => event.type === 'connection').map(event => event.connected)).toEqual([true]);

    follower.emitEvent({ type: 'error', error: new Error('Tradovate WebSocket transport error'), at: 5 });
    follower.setConnected(false);
    await wait(10);
    follower.setConnected(true);
    await wait(60);

    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.filter(event => event.type === 'connection').map(event => event.connected)).toEqual([true]);
    unsubscribe();
  });

  it('výpadek delší než lhůta se ohlásí včetně zadržené chyby', async () => {
    const events: BrokerEvent[] = [];
    const { follower, unsubscribe } = graceRouter(events, 20);

    follower.emitEvent({ type: 'error', error: new Error('Tradovate WebSocket transport error'), at: 5 });
    follower.setConnected(false);
    await wait(50);

    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(events.filter(event => event.type === 'connection').map(event => event.connected)).toEqual([true, false]);

    follower.setConnected(true);
    expect(events.filter(event => event.type === 'connection').map(event => event.connected)).toEqual([true, false, true]);
    unsubscribe();
  });

  it('kritické spojení lhůtu nedostává — výpadek se hlásí okamžitě', async () => {
    const events: BrokerEvent[] = [];
    const { critical, unsubscribe } = graceRouter(events, 1_000);

    critical.emitEvent({ type: 'error', error: new Error('Tradovate WebSocket transport error'), at: 5 });
    critical.setConnected(false);

    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(events.filter(event => event.type === 'connection').map(event => event.connected)).toEqual([true, false]);
    unsubscribe();
  });

  it('po změně leadera přehodí kritickou OAuth route bez restartu routeru', async () => {
    const events: BrokerEvent[] = [];
    const first = createMockBroker();
    const second = createMockBroker();
    const router = createBrokerRouter([
      { broker: first, accountIds: [100], critical: true },
      { broker: second, accountIds: [200], critical: false },
    ], { reconnectGraceMs: 1_000 });
    const unsubscribe = router.subscribe(event => events.push(event));
    first.setConnected(true);
    second.setConnected(true);
    expect(events.filter(event => event.type === 'connection').map(event => event.connected)).toEqual([true]);

    router.setCriticalAccounts?.([200]);

    // Původní leader route je už follower-only, takže její krátký výpadek
    // zůstane v grace okně a nesestřelí skupinu okamžitě.
    first.setConnected(false);
    expect(events.filter(event => event.type === 'connection').map(event => event.connected)).toEqual([true]);

    // Nový leader je kritický ihned.
    second.emitEvent({ type: 'error', error: new Error('new leader transport error'), at: 5 });
    second.setConnected(false);
    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(events.filter(event => event.type === 'connection').map(event => event.connected)).toEqual([true, false]);
    unsubscribe();
  });
});

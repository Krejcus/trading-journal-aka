import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closeCalls = 0;
  throwOnSend = false;

  send(data: string) {
    if (this.throwOnSend) throw new Error('send failed');
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(messages: unknown[]) {
    this.onmessage?.({ data: `a${JSON.stringify(messages)}` });
  }
}

const flush = async () => {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
};

const completeHandshake = async (socket: FakeSocket) => {
  socket.open();
  socket.onmessage?.({ data: 'o' });
  await flush();
  socket.deliver([{ i: 0, s: 200, d: {} }]);
  await flush();
  socket.deliver([{ i: 1, s: 200, d: [] }]);
  await flush();
};

const orderRequest = {
  tag: 'ws-order-1', accountId: 200, symbol: 'MNQZ6', side: 'Buy' as const,
  quantity: 1, orderType: 'Market' as const,
};

const response = (value: unknown) => Response.json(value);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Tradovate DEMO order writes over the authenticated WebSocket', () => {
  it('resolves a correlated ACK immediately even while an older semantic frame is blocked', async () => {
    let resolveVersions!: (value: Response) => void;
    const slowVersions = new Promise<Response>(resolve => { resolveVersions = resolve; });
    const socket = new FakeSocket();
    const fetchCalls: string[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO8661118',
      preferWebSocketOrderWrites: true,
      webSocketFactory: () => socket,
      fetchImpl: (async input => {
        const url = String(input);
        fetchCalls.push(url);
        if (url.includes('/orderVersion/deps?masterid=41')) return slowVersions;
        if (url.includes('/contract/items')) return response([{ id: 7, name: 'MNQZ6' }]);
        return response([]);
      }) as typeof fetch,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    await completeHandshake(socket);

    // Starší Order frame čeká na REST hydrataci a drží semantic tail.
    socket.deliver([{ e: 'props', d: [{
      entityType: 'Order', entity: {
        id: 41, accountId: 200, contractId: 7, action: 'Buy', ordStatus: 'Working',
      },
    }] }]);
    await flush();

    let settled = false;
    const write = broker.placeOso!({
      ...orderRequest,
      first: { side: 'Sell', orderType: 'Stop', stopPrice: 29_990 },
      second: { side: 'Sell', orderType: 'Limit', limitPrice: 30_020 },
    }).then(value => { settled = true; return value; });
    const wire = socket.sent.at(-1)?.split('\n') ?? [];
    expect(wire.slice(0, 3)).toEqual(['order/placeoso', '2', '']);
    expect(JSON.parse(wire[3])).toMatchObject({
      accountId: 200, accountSpec: 'DEMO8661118', symbol: 'MNQZ6', orderType: 'Market',
      isAutomated: true, clOrdId: 'ws-order-1',
    });
    expect(fetchCalls.some(url => url.endsWith('/order/placeoso'))).toBe(false);

    socket.deliver([{ i: 2, s: 200, d: { orderId: 50, oso1Id: 51, oso2Id: 52, failureReason: 'Success' } }]);
    await flush();
    expect(settled).toBe(true);
    await expect(write).resolves.toMatchObject({
      accepted: true, entryBrokerOrderId: '50', firstBrokerOrderId: '51', secondBrokerOrderId: '52',
    });

    resolveVersions(response([{ id: 41, orderId: 41, orderQty: 1, orderType: 'Market' }]));
    await flush();
    unsubscribe();
  });

  it.each([false, true])('ACK-only frame does not block adjacent metadata; semantic barrier=%s', async semanticBarrier => {
    let resolveVersions!: (value: Response) => void;
    const slowVersions = new Promise<Response>(resolve => { resolveVersions = resolve; });
    const socket = new FakeSocket();
    const events: Array<{ type: string }> = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO8661118',
      preferWebSocketOrderWrites: true, webSocketFactory: () => socket,
      fetchImpl: (async input => {
        const url = String(input);
        if (url.includes('/orderVersion/deps?masterid=41')) return slowVersions;
        if (url.includes('/contract/items')) return response([{ id: 7, name: 'MNQZ6' }]);
        return response([]);
      }) as typeof fetch,
    });
    const unsubscribe = broker.subscribe(event => events.push(event));
    await completeHandshake(socket);
    const rawOrder = { id: 41, accountId: 200, contractId: 7, action: 'Buy', ordStatus: 'Working' };
    socket.deliver([{ e: 'props', d: [{ entityType: 'Order', entity: rawOrder }] }]);
    await flush();
    const write = broker.placeOrder(orderRequest);
    const requestId = Number(socket.sent.at(-1)!.split('\n')[1]);
    socket.deliver([{ i: requestId, s: 200, d: { orderId: 50, failureReason: 'Success' } }]);
    await write;
    if (semanticBarrier) socket.deliver([{ e: 'props', d: [{ entityType: 'Order', entity: { ...rawOrder, ordStatus: 'Filled' } }] }]);
    socket.deliver([{ e: 'props', d: [{ entityType: 'OrderVersion', entity: { id: 41, orderId: 41, orderQty: 1, orderType: 'Market' } }] }]);
    try {
      if (semanticBarrier) {
        await flush();
        expect(events.some(event => event.type === 'order')).toBe(false);
      } else {
        // No REST response yet: broker metadata already delivered in the next semantic frame suffices.
        await flush();
        await flush();
        expect(events.some(event => event.type === 'order')).toBe(true);
      }
    } finally {
      resolveVersions(response([{ id: 41, orderId: 41, orderQty: 1, orderType: 'Market' }]));
      await flush();
      unsubscribe();
    }
  });

  it('falls back to REST only when no synchronized socket exists before sending', async () => {
    const calls: string[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO8661118',
      preferWebSocketOrderWrites: true,
      fetchImpl: (async input => {
        calls.push(String(input));
        return response({ orderId: 70, failureReason: 'Success' });
      }) as typeof fetch,
    });

    await expect(broker.placeOrder(orderRequest)).resolves.toMatchObject({ accepted: true, brokerOrderId: '70' });
    expect(calls.filter(url => url.endsWith('/order/placeorder'))).toHaveLength(1);
  });

  it('never retries over REST after a WS timeout', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const calls: string[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO8661118',
      preferWebSocketOrderWrites: true, webSocketWriteTimeoutMs: 25,
      webSocketFactory: () => socket,
      fetchImpl: (async input => { calls.push(String(input)); return response([]); }) as typeof fetch,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    await completeHandshake(socket);

    const write = broker.placeOrder(orderRequest);
    const rejected = expect(write).rejects.toThrow(/výsledek zápisu je neznámý/);
    expect(socket.sent.at(-1)?.startsWith('order/placeorder\n2\n')).toBe(true);
    await vi.advanceTimersByTimeAsync(26);
    await rejected;
    expect(calls.some(url => url.endsWith('/order/placeorder'))).toBe(false);

    // Pozdní ACK je ignorovaný a nikdy nespustí druhé vyřízení.
    socket.deliver([{ i: 2, s: 200, d: { orderId: 70 } }]);
    await flush();
    expect(calls.some(url => url.endsWith('/order/placeorder'))).toBe(false);
    unsubscribe();
  });

  it('rejects an in-flight write on socket close and does not retry it', async () => {
    const socket = new FakeSocket();
    const calls: string[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO8661118',
      preferWebSocketOrderWrites: true,
      webSocketFactory: () => socket,
      fetchImpl: (async input => { calls.push(String(input)); return response([]); }) as typeof fetch,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    await completeHandshake(socket);

    const write = broker.placeOrder(orderRequest);
    expect(broker.renewSocket()).toBe(false);
    socket.onerror?.();
    await expect(write).rejects.toThrow(/výsledek zápisu je neznámý/);
    expect(calls.some(url => url.endsWith('/order/placeorder'))).toBe(false);
    unsubscribe();
  });

  it('treats a send exception as unknown and never falls through to REST', async () => {
    const socket = new FakeSocket();
    const calls: string[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO8661118',
      preferWebSocketOrderWrites: true,
      webSocketFactory: () => socket,
      fetchImpl: (async input => { calls.push(String(input)); return response([]); }) as typeof fetch,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    await completeHandshake(socket);
    socket.throwOnSend = true;

    await expect(broker.placeOrder(orderRequest)).rejects.toThrow(/send failed; výsledek zápisu je neznámý/);
    expect(calls.some(url => url.endsWith('/order/placeorder'))).toBe(false);
    unsubscribe();
  });

  it('routes a WS rate limit to the shared breaker without closing the healthy stream', async () => {
    const socket = new FakeSocket();
    const calls: string[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO8661118',
      preferWebSocketOrderWrites: true,
      webSocketFactory: () => socket,
      fetchImpl: (async input => { calls.push(String(input)); return response([]); }) as typeof fetch,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    await completeHandshake(socket);

    const write = broker.placeOrder(orderRequest);
    socket.deliver([{ i: 2, s: 429, d: { 'p-ticket': 'ticket', 'p-time': 60, 'p-message': 'slow down' } }]);
    await expect(write).rejects.toThrow(/slow down/);
    expect(socket.closeCalls).toBe(0);
    await expect(broker.listPositions(200)).rejects.toThrow(/rate limit breaker aktivní/);
    expect(calls.some(url => url.includes('/position/list'))).toBe(false);
    unsubscribe();
  });
});

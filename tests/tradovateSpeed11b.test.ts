import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

const flushMicrotasks = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('balicek 11b: rychlost Tradovate kriticke cesty', () => {
  it('prekryje dve 60ms OrderVersion hydratace, ale order eventy emituje v poradi ramcu', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requestedVersions: number[] = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() {},
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO',
      webSocketFactory: () => socket,
      fetchImpl: (async input => {
        const url = String(input);
        if (url.includes('/order/list') || url.includes('/orderVersion/list')
          || url.includes('/command/list') || url.includes('/fill/list')) return jsonResponse([]);
        if (url.includes('/orderVersion/deps?masterid=')) {
          const orderId = Number(new URL(url).searchParams.get('masterid'));
          requestedVersions.push(orderId);
          return new Promise<Response>(resolve => {
            setTimeout(() => resolve(jsonResponse([{
              id: orderId, orderId, orderQty: 1, orderType: orderId === 41 ? 'Stop' : 'Limit',
              ...(orderId === 41 ? { stopPrice: 29_950 } : { price: 30_050 }),
            }])), 60);
          });
        }
        if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
        throw new Error(`unexpected url ${url}`);
      }) as typeof fetch,
    });
    const events: BrokerEvent[] = [];
    const unsubscribe = broker.subscribe(event => events.push(event));
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await flushMicrotasks();

    const orderFrame = (id: number, action: 'Buy' | 'Sell') => `a[${JSON.stringify({
      e: 'props', d: [{
        entityType: 'Order', entity: {
          id, accountId: 100, contractId: 7, action, ordStatus: 'Working',
        },
      }],
    })}]`;
    socket.onmessage?.({ data: orderFrame(41, 'Sell') });
    socket.onmessage?.({ data: orderFrame(43, 'Buy') });
    await flushMicrotasks();

    // Baseline byl seriovy: pred uplynutim prvnich 60 ms zacal jen request 41
    // a order 43 potreboval dalsich 60 ms. Optimalizovana cesta zahaji oba.
    expect(requestedVersions).toEqual([41, 43]);
    expect(events.filter(event => event.type === 'order')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(65);
    await flushMicrotasks();
    expect(events.filter((event): event is Extract<BrokerEvent, { type: 'order' }> => event.type === 'order')
      .map(event => event.order.brokerOrderId)).toEqual(['41', '43']);
    unsubscribe();
  });

  it('presny pre-modify lookup nepouzije globalni command ani executionReport list', async () => {
    const calls: string[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO',
      fetchImpl: (async input => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/order/item?id=42')) return jsonResponse({
          id: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working',
        });
        if (url.includes('/orderVersion/deps?masterid=42')) return jsonResponse([
          { id: 42, orderId: 42, orderQty: 2, orderType: 'Stop', stopPrice: 29_900 },
          { id: 43, orderId: 42, orderQty: 2, orderType: 'Stop', stopPrice: 29_950 },
        ]);
        if (url.includes('/command/deps?masterid=42')) return jsonResponse([
          { id: 42, orderId: 42, commandType: 'New' },
          { id: 43, orderId: 42, commandType: 'Modify' },
        ]);
        if (url.includes('/executionReport/deps?masterid=42')) return jsonResponse([]);
        if (url.includes('/executionReport/deps?masterid=43')) return jsonResponse([{
          id: 44, commandId: 43, orderId: 42, accountId: 200, contractId: 7,
          action: 'Sell', ordStatus: 'Working', execType: 'Replaced',
        }]);
        if (url.includes('/fill/deps?masterid=42')) return jsonResponse([]);
        if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
        if (url.includes('/command/list') || url.includes('/executionReport/list')) {
          throw new Error(`globalni lookup je v modify kriticke ceste zakazan: ${url}`);
        }
        throw new Error(`unexpected url ${url}`);
      }) as typeof fetch,
    });

    await expect(broker.findOrderById(200, '42')).resolves.toMatchObject({
      completeness: 'authoritative',
      order: { brokerOrderId: '42', quantity: 2, filledQuantity: 0, stopPrice: 29_950 },
    });
    expect(calls.some(url => url.includes('/command/list'))).toBe(false);
    expect(calls.some(url => url.includes('/executionReport/list'))).toBe(false);
    expect(calls.some(url => url.includes('/command/deps?masterid=42'))).toBe(true);
    expect(calls.some(url => url.includes('/executionReport/deps?masterid=43'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const fill = { id: 12, orderId: 42, contractId: 7, action: 'Buy', qty: 1, price: 29_500 };
const rawOrder = { id: 42, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Filled' };
const version = { id: 42, orderId: 42, orderQty: 1, orderType: 'Market' };

const harness = () => {
  let now = 100;
  const socket: WebSocketLike = {
    readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
    send() {}, close() {},
  };
  const events: BrokerEvent[] = [];
  const broker = createTradovateBroker({
    environment: 'demo', accessToken: 'token', accountSpec: 'DEMO', clock: () => now,
    webSocketFactory: () => socket,
    fetchImpl: (async input => {
      const url = String(input);
      if (url.includes('/order/list') || url.includes('/orderVersion/list')
        || url.includes('/command/list') || url.includes('/fill/list')) return jsonResponse([]);
      if (url.includes('/order/item')) return jsonResponse(rawOrder);
      if (url.includes('/orderVersion/deps')) return jsonResponse([version]);
      if (url.includes('/fill/deps')) return jsonResponse([fill]);
      if (url.includes('/executionReport/list')) return jsonResponse([]);
      if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch,
    setIntervalImpl: (() => 1) as unknown as typeof setInterval,
    clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    setTimeoutImpl: (() => 0) as unknown as typeof setTimeout,
    clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
  });
  broker.subscribe(event => events.push(event));
  const settle = async () => {
    for (let index = 0; index < 20; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
  };
  const props = (items: unknown[]) => socket.onmessage?.({
    data: `a[${JSON.stringify({ e: 'props', d: items })}]`,
  });
  return { broker, socket, events, settle, props, setNow: (value: number) => { now = value; } };
};

describe('V7/V8 adversarial: fill delivery', () => {
  it('REST lookup následovaný Created a Updated emituje fill právě jednou a nese receivedAt frame', async () => {
    const h = harness();
    h.socket.onopen?.();
    h.socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await h.settle();
    await h.broker.findOrderById(100, '42');
    h.setNow(1_234);
    h.props([{ entityType: 'Fill', eventType: 'Created', entity: fill }]);
    await h.settle();
    h.setNow(9_999);
    h.props([{ entityType: 'Fill', eventType: 'Updated', entity: fill }]);
    await h.settle();

    const fills = h.events.filter((event): event is Extract<BrokerEvent, { type: 'fill' }> => event.type === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ receivedAt: 1_234, fill: { fillId: '12' } });
  });

  it('pending Created fill se nevysílá až z pozdního Updated', async () => {
    const h = harness();
    h.socket.onopen?.();
    h.socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await h.settle();
    h.props([{ entityType: 'Fill', eventType: 'Created', entity: fill }]);
    await h.settle();
    await h.broker.findOrderById(100, '42');
    h.props([{ entityType: 'Fill', eventType: 'Updated', entity: fill }]);
    await h.settle();

    expect(h.events.filter(event => event.type === 'fill')).toHaveLength(0);
  });

  it('Order event nese receivedAt původního a-frame', async () => {
    const h = harness();
    h.socket.onopen?.();
    h.socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await h.settle();
    h.setNow(4_321);
    h.props([
      { entityType: 'Order', entity: { ...rawOrder, ordStatus: 'Working' } },
      { entityType: 'OrderVersion', entity: version },
    ]);
    await h.settle();

    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'order', receivedAt: 4_321, order: expect.objectContaining({ brokerOrderId: '42' }),
    }));
  });
});

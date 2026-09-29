import { describe, expect, it } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe('BRK2: REST počet /orderVersion/deps při běžném životním cyklu orderu', () => {
  it('Order+OV, ER New, ER Trade, Fill, ER Canceled jiného orderu', async () => {
    const now = 0;
    const intervals: Array<() => void> = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: () => undefined, close: () => undefined,
    };
    const urls: string[] = [];
    const events: BrokerEvent[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO', clock: () => now,
      webSocketFactory: () => socket,
      fetchImpl: (async input => {
        const url = String(input);
        urls.push(url.replace(/^https?:\/\/[^/]+/, ''));
        if (url.includes('/orderVersion/deps?masterid=')) {
          const id = Number(url.split('masterid=')[1]);
          return jsonResponse([{ id, orderId: id, orderQty: 1, orderType: 'Market' }]);
        }
        if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
        return jsonResponse([]);
      }) as typeof fetch,
      setIntervalImpl: ((handler: TimerHandler) => { intervals.push(handler as () => void); return intervals.length; }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      setTimeoutImpl: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    });
    broker.subscribe(event => events.push(event));
    socket.onopen?.();
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await expect.poll(() => events.some(event => event.type === 'connection' && event.connected)).toBe(true);
    const before = urls.length;
    const props = async (d: unknown[]) => { socket.onmessage?.({ data: `a[${JSON.stringify({ e: "props", d })}]` }); for (let i = 0; i < 20; i += 1) await new Promise(r => setTimeout(r, 0)); };
    await props([
      { entityType: 'Order', eventType: 'Created', entity: { id: 43, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Working' } },
      { entityType: 'OrderVersion', eventType: 'Created', entity: { id: 43, orderId: 43, orderQty: 1, orderType: 'Market' } },
    ]);
    await props([{ entityType: 'ExecutionReport', eventType: 'Created', entity: { id: 501, orderId: 43, commandId: 43, accountId: 100, contractId: 7, action: 'Buy', execType: 'New', ordStatus: 'Working' } }]);
    await props([{ entityType: 'ExecutionReport', eventType: 'Created', entity: { id: 502, orderId: 43, commandId: 43, accountId: 100, contractId: 7, action: 'Buy', execType: 'Trade', ordStatus: 'Filled' } }]);
    await props([{ entityType: 'Fill', eventType: 'Created', entity: { id: 901, orderId: 43, accountId: 100, contractId: 7, action: 'Buy', qty: 1, price: 29500, timestamp: '2026-09-29T13:30:00Z' } }]);
    await props([{ entityType: 'Order', eventType: 'Updated', entity: { id: 43, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Filled' } }]);
    for (let index = 0; index < 50; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
    const after = urls.slice(before);
    const deps = after.filter(u => u.includes('/orderVersion/deps'));
    console.log('PREFETCH', JSON.stringify({ deps: deps.length, all: after }));
    expect(deps).toEqual([]);
  });
});

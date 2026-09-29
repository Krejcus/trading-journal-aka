import { describe, expect, it } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe('BRK2 V8/V6: rozpracovaný frame po zavření socketu', () => {
  it('emituje stuck frame svůj order až po close?', async () => {
    let now = 0;
    let resolveSlow!: (response: Response) => void;
    const slow = new Promise<Response>(resolve => { resolveSlow = resolve; });
    const intervals: Array<() => void> = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: () => undefined, close: () => undefined,
    };
    const log: Array<{ at: number; event: BrokerEvent }> = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO', clock: () => now,
      webSocketFactory: () => socket,
      socketIdleTimeoutMs: 15_000,
      fetchImpl: (async input => {
        const url = String(input);
        if (url.includes('/orderVersion/deps?masterid=41')) return slow;
        if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
        return jsonResponse([]);
      }) as typeof fetch,
      setIntervalImpl: ((handler: TimerHandler) => { intervals.push(handler as () => void); return intervals.length; }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      setTimeoutImpl: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    });
    broker.subscribe(event => log.push({ at: now, event }));
    socket.onopen?.();
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await expect.poll(() => log.some(item => item.event.type === 'connection' && item.event.connected)).toBe(true);
    now = 1_000;
    // leader Market entry, jehož OrderVersion přijde až z REST (visí)
    socket.onmessage?.({ data: `a[${JSON.stringify({ e: 'props', d: [{
      entityType: 'Order', entity: { id: 41, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Working' },
    }] })}]` });
    for (now = 2_000; now <= 20_000; now += 1_000) { socket.onmessage?.({ data: 'h' }); intervals.at(-1)?.(); }
    now = 30_000;
    resolveSlow(jsonResponse([{ id: 41, orderId: 41, orderQty: 1, orderType: 'Market' }]));
    for (let index = 0; index < 50; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
    const summary = log.filter(item => item.event.type !== 'heartbeat')
      .map(item => `${item.at}:${item.event.type}${item.event.type === 'connection' ? `=${item.event.connected}` : ''}${item.event.type === 'order' ? `#${item.event.order.brokerOrderId}(${item.event.order.status},rx=${(item.event as { receivedAt?: number }).receivedAt})` : ''}${item.event.type === 'error' ? `(${item.event.error.message.replace(/connection=\S+ phase=\S+ /, '').slice(0, 40)})` : ''}`);
    console.log('STALEEMIT', JSON.stringify(summary));
    expect(log.some(item => item.event.type === 'error'
      && item.event.error.message.includes('semantic lag'))).toBe(true);
    expect(log.some(item => item.event.type === 'connection' && !item.event.connected)).toBe(true);
    expect(log.some(item => item.event.type === 'order')).toBe(false);
  });
});

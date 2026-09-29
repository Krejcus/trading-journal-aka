import { describe, expect, it, vi } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe('V8 adversarial: semantic queue watchdog', () => {
  it('zavře socket při starém nezpracovaném a-frame, i když h heartbeat dál chodí', async () => {
    let now = 0;
    let resolveSlow!: (response: Response) => void;
    const slow = new Promise<Response>(resolve => { resolveSlow = resolve; });
    const intervals: Array<() => void> = [];
    const sent: string[] = [];
    const close = vi.fn();
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: data => sent.push(data), close,
    };
    const events: BrokerEvent[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO', clock: () => now,
      webSocketFactory: () => socket,
      socketIdleTimeoutMs: 15_000,
      fetchImpl: (async input => {
        const url = String(input);
        if (url.includes('/order/list') || url.includes('/orderVersion/list')
          || url.includes('/command/list') || url.includes('/fill/list')) return jsonResponse([]);
        if (url.includes('/orderVersion/deps?masterid=41')) return slow;
        if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
        throw new Error(`unexpected url ${url}`);
      }) as typeof fetch,
      setIntervalImpl: ((handler: TimerHandler) => {
        intervals.push(handler as () => void);
        return intervals.length;
      }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      setTimeoutImpl: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    });
    broker.subscribe(event => events.push(event));
    socket.onopen?.();
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await expect.poll(() => events.some(event => event.type === 'connection' && event.connected)).toBe(true);

    now = 1_000;
    socket.onmessage?.({ data: `a[${JSON.stringify({ e: 'props', d: [{
      entityType: 'Order', entity: { id: 41, accountId: 100, contractId: 7, action: 'Sell', ordStatus: 'Working' },
    }] })}]` });
    now = 2_000;
    socket.onmessage?.({ data: `a[${JSON.stringify({ e: 'props', d: [
      { entityType: 'Order', entity: { id: 43, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Working' } },
      { entityType: 'OrderVersion', entity: { id: 43, orderId: 43, orderQty: 1, orderType: 'Market' } },
    ] })}]` });

    for (now = 2_500; now <= 17_500; now += 2_500) {
      socket.onmessage?.({ data: 'h' });
      intervals.at(-1)?.();
    }

    expect(sent.filter(value => value === '[]').length).toBeGreaterThan(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', error: expect.objectContaining({ message: expect.stringContaining('semantic lag') }),
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'connection', connected: false }));
    expect(close).toHaveBeenCalledTimes(1);

    resolveSlow(jsonResponse([{ id: 41, orderId: 41, orderQty: 1, orderType: 'Stop', stopPrice: 29_450 }]));
    for (let index = 0; index < 20; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(events.some(event => event.type === 'order' && event.order.brokerOrderId === '43')).toBe(false);
  });
});

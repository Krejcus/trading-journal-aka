import { describe, expect, it } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe('BRK2 V8: semantic-lag watchdog vs. pomalý baseline sync (prod syncTimeoutMs=45 s)', () => {
  it('/order/list trvá 20 s během syncu, h heartbeat chodí', async () => {
    let now = 0;
    let resolveSlow!: (response: Response) => void;
    const slow = new Promise<Response>(resolve => { resolveSlow = resolve; });
    const intervals: Array<() => void> = [];
    let closes = 0;
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: () => undefined, close: () => { closes += 1; },
    };
    const factoryCalls: number[] = [];
    const events: Array<{ at: number; event: BrokerEvent }> = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO', clock: () => now,
      webSocketFactory: () => { factoryCalls.push(now); return socket; },
      syncTimeoutMs: 45_000,
      fetchImpl: (async input => {
        const url = String(input);
        if (url.includes('/order/list')) return slow;
        if (url.includes('/orderVersion/list') || url.includes('/command/list') || url.includes('/fill/list')
          || url.includes('/executionReport/list') || url.includes('/commandReport/list')) return jsonResponse([]);
        if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
        return jsonResponse([]);
      }) as typeof fetch,
      setIntervalImpl: ((handler: TimerHandler) => { intervals.push(handler as () => void); return intervals.length; }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      setTimeoutImpl: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    });
    broker.subscribe(event => events.push({ at: now, event }));
    socket.onopen?.();
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    for (now = 1_000; now <= 20_000; now += 1_000) {
      socket.onmessage?.({ data: 'h' });
      intervals.at(-1)?.();
    }
    resolveSlow(jsonResponse([]));
    for (let index = 0; index < 50; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
    const summary = events.filter(item => item.event.type !== 'heartbeat')
      .map(item => `${item.at}:${item.event.type}${item.event.type === 'connection' ? `=${item.event.connected}` : ''}${item.event.type === 'error' ? `(${item.event.error.message.replace(/connection=\S+ phase=\S+ /, '').slice(0, 50)})` : ''}`);
    console.log('SYNCLAG', JSON.stringify({ summary, closes, factoryCalls }));
    expect(events.some(item => item.event.type === 'error')).toBe(false);
    expect(events.some(item => item.event.type === 'connection' && item.event.connected)).toBe(true);
    expect(closes).toBe(0);
  });
});

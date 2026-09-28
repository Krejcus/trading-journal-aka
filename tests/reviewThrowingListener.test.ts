import { describe, expect, it, vi } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe('V8 adversarial: synchronní listener nesmí uniknout z onmessage', () => {
  it('ohlásí chybu a zavře socket', async () => {
    const close = vi.fn();
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close,
    };
    const seen: BrokerEvent[] = [];
    let throwOnHeartbeat = false;
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO', webSocketFactory: () => socket,
      fetchImpl: (async input => String(input).includes('/contract/items')
        ? jsonResponse([{ id: 7, name: 'MNQU6' }]) : jsonResponse([])) as typeof fetch,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      setTimeoutImpl: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    });
    broker.subscribe(event => {
      if (event.type === 'heartbeat' && throwOnHeartbeat) {
        throwOnHeartbeat = false;
        throw new Error('listener boom');
      }
      seen.push(event);
    });
    socket.onopen?.();
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    for (let index = 0; index < 10; index += 1) await new Promise(resolve => setTimeout(resolve, 0));

    throwOnHeartbeat = true;
    expect(() => socket.onmessage?.({ data: `a[${JSON.stringify({ e: 'props', d: [
      { entityType: 'Order', entity: { id: 43, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Working' } },
      { entityType: 'OrderVersion', entity: { id: 43, orderId: 43, orderQty: 1, orderType: 'Market' } },
    ] })}]` })).not.toThrow();

    expect(seen).toContainEqual(expect.objectContaining({
      type: 'error', error: expect.objectContaining({ message: expect.stringContaining('listener boom') }),
    }));
    expect(seen).toContainEqual(expect.objectContaining({ type: 'connection', connected: false }));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

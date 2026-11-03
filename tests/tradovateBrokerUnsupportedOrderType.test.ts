import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';
import { toPlaceOrderPayload, toPlaceOcoPayload } from '../services/tradovateMapping';

/**
 * Trailing stop, MIT a jiné typy, které adaptér neumí, zadané v Tradovate na kterémkoli účtu
 * stejného přihlášení (3. 11. 2026, docs/reviews/trading-gaps-20261103.md „Riziko“): složení
 * příkazu dřív vyhodilo výjimku, synchronizace spadla a po reconnectu znovu (crash loop).
 */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closeCalls = 0;
  send(data: string) { this.sent.push(data); }
  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.onclose?.();
  }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(data: string) { this.onmessage?.({ data }); }
}

const flush = async () => {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
};

const CONTRACT = { id: 3570918, name: 'MNQZ6' };

const createHarness = (orders: { id: number; accountId: number; orderType: string; ordStatus?: string }[]) => {
  const sockets: FakeSocket[] = [];
  const diagnostics: string[] = [];
  const events: BrokerEvent[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/order/list')) {
      return Response.json(orders.map(order => ({
        id: order.id, accountId: order.accountId, contractId: CONTRACT.id, action: 'Sell',
        ordStatus: order.ordStatus ?? 'Working', timestamp: '2026-11-03T15:00:00.000Z',
      })));
    }
    if (url.includes('/orderVersion/list')) {
      return Response.json(orders.map(order => ({
        // První verze příkazu má u Tradovate stejné id jako příkaz (promoteVersion: initial).
        id: order.id, orderId: order.id, orderQty: 1, orderType: order.orderType, stopPrice: 25_000,
      })));
    }
    if (url.includes('/contract/items')) return Response.json([CONTRACT]);
    return Response.json([]);
  });
  const broker = createTradovateBroker({
    environment: 'demo',
    accountSpec: 'DEMO123',
    accessToken: 'token',
    fetchImpl,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    connectionLabel: 'conn:test',
    connectTimeoutMs: 10_000,
    closeTimeoutMs: 5_000,
    reconnectDelayMs: 1_000,
    reconnectJitterRatio: 0,
    disconnectedLogIntervalMs: 60_000,
    onReconnectDiagnostic: message => diagnostics.push(message),
  });
  const unsubscribe = broker.subscribe(event => events.push(event));
  return { broker, sockets, diagnostics, events, unsubscribe };
};

const completeHandshake = async (socket: FakeSocket) => {
  socket.open();
  socket.deliver('o');
  await flush();
  socket.deliver('a[{"i":0,"s":200,"d":{}}]');
  await flush();
  socket.deliver('a[{"i":1,"s":200,"d":[]}]');
  await flush();
};

describe('Tradovate: nepodporovaný typ příkazu nesmí shodit stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T15:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it.each(['TrailingStop', 'TrailingStopLimit', 'MIT'])('%s na cizím účtu přihlášení: synchronizace doběhne a socket zůstane otevřený', async orderType => {
    const harness = createHarness([{ id: 501, accountId: 99, orderType }]);
    await flush();
    await completeHandshake(harness.sockets[0]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0].closeCalls).toBe(0);
    expect(harness.events.some(event => event.type === 'error')).toBe(false);
    harness.unsubscribe();
  });

  it('na účtu skupiny i ukončený v baseline: sync doběhne a listOrders vrátí Unsupported se surovým typem', async () => {
    const harness = createHarness([
      { id: 601, accountId: 10, orderType: 'TrailingStop' },
      { id: 602, accountId: 10, orderType: 'MIT', ordStatus: 'Filled' },
      { id: 603, accountId: 10, orderType: 'QTS', ordStatus: 'Canceled' },
    ]);
    await flush();
    await completeHandshake(harness.sockets[0]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0].closeCalls).toBe(0);
    const orders = await harness.broker.listOrders(10);
    const trailing = orders.find(order => order.brokerOrderId === '601');
    expect(trailing).toMatchObject({ orderType: 'Unsupported', brokerOrderType: 'TrailingStop', status: 'working' });
    harness.unsubscribe();
  });
});

describe('Tradovate: pojistka zápisu nepodporovaného typu', () => {
  it('placeorder ani OCO noha s typem mimo Market/Limit/Stop/StopLimit se nesestaví', () => {
    const request = { tag: 't', accountId: 10, symbol: 'MNQZ6', side: 'Sell' as const, quantity: 1, stopPrice: 25_000 };
    expect(() => toPlaceOrderPayload({ ...request, orderType: 'Unsupported' as never }, 'DEMO123')).toThrow(/unsupported-order-type-write/);
    expect(() => toPlaceOrderPayload({ ...request, orderType: 'TrailingStop' as never }, 'DEMO123')).toThrow(/unsupported-order-type-write/);
    expect(() => toPlaceOcoPayload({
      tag: 't', accountId: 10, symbol: 'MNQZ6',
      first: { tag: 'a', side: 'Sell', quantity: 1, orderType: 'Limit', limitPrice: 25_100 },
      second: { tag: 'b', side: 'Sell', quantity: 1, orderType: 'TrailingStop' as never, stopPrice: 24_900 },
    } as never, 'DEMO123')).toThrow(/unsupported-order-type-write/);
    expect(toPlaceOrderPayload({ ...request, orderType: 'Stop' }, 'DEMO123').orderType).toBe('Stop');
  });
});

import { describe, expect, it } from 'vitest';
import type { BrokerOrderRequest, BrokerOsoRequest } from '../services/brokerPort';
import {
  fillIncrement,
  fromOrderEntity,
  fromPlaceOcoResult,
  fromPlaceOsoResult,
  fromPlaceOrderResult,
  toOrderStatus,
  toPlaceOcoPayload,
  toPlaceOsoPayload,
  toPlaceOrderPayload,
  TRADOVATE_HEARTBEAT_MS,
  TRADOVATE_HOSTS,
} from '../services/tradovateMapping';
import {
  createTradovateBroker,
  TradovateRateLimitError,
  type WebSocketLike,
} from '../services/tradovateBroker';

const request = (partial: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest => ({
  tag: 'cpabc123', accountId: 200, symbol: 'MNQU6', side: 'Buy',
  quantity: 2, orderType: 'Market', ...partial,
});

describe('toPlaceOrderPayload', () => {
  it('přenese tag jako clOrdId, accountSpec a automated flag bez customTag50', () => {
    expect(toPlaceOrderPayload(request(), 'DEMO123')).toMatchObject({
      clOrdId: 'cpabc123', accountSpec: 'DEMO123', isAutomated: true,
    });
    expect(toPlaceOrderPayload(request(), 'DEMO123')).not.toHaveProperty('customTag50');
  });
  it('u market objednávky neposílá cenu', () => {
    expect(toPlaceOrderPayload(request(), 'DEMO123')).not.toHaveProperty('price');
  });
  it('u limitní objednávky přenese cenu', () => {
    expect(toPlaceOrderPayload(request({ orderType: 'Limit', limitPrice: 29_500 }), 'DEMO123'))
      .toMatchObject({ orderType: 'Limit', price: 29_500 });
  });
  it('StopLimit zachová obě ceny', () => {
    expect(toPlaceOrderPayload(request({
      orderType: 'StopLimit', limitPrice: 29_505, stopPrice: 29_500,
    }), 'DEMO123')).toMatchObject({
      orderType: 'StopLimit', price: 29_505, stopPrice: 29_500,
    });
  });
});

describe('OCO mapping', () => {
  const ocoRequest = {
    tag: 'cpoco123', accountId: 200, symbol: 'MNQU6', quantity: 1,
    first: { side: 'Buy' as const, orderType: 'Stop' as const, stopPrice: 30_315 },
    second: { side: 'Buy' as const, orderType: 'Limit' as const, limitPrice: 30_272 },
  };

  it('mapuje dvě legs do nativního placeOCO payloadu', () => {
    expect(toPlaceOcoPayload(ocoRequest, 'DEMO123')).toEqual({
      accountId: 200, accountSpec: 'DEMO123', symbol: 'MNQU6', orderQty: 1,
      action: 'Buy', orderType: 'Stop', stopPrice: 30_315,
      clOrdId: 'cpoco123', isAutomated: true,
      other: { action: 'Buy', orderType: 'Limit', price: 30_272, clOrdId: 'cpoco123b' },
    });
  });

  it('přijme jen odpověď s oběma OCO order ID', () => {
    expect(fromPlaceOcoResult({ orderId: 10, ocoId: 11, failureReason: 'Success' }))
      .toEqual({ firstBrokerOrderId: '10', secondBrokerOrderId: '11', accepted: true, definitive: true });
    expect(fromPlaceOcoResult({ orderId: 10, failureReason: 'Success' }))
      .toMatchObject({ accepted: false, definitive: false });
  });
});

describe('OSO mapping', () => {
  const osoRequest: BrokerOsoRequest = {
    tag: 'cposo123', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1,
    orderType: 'Limit', limitPrice: 30_250,
    first: { side: 'Sell', orderType: 'Stop', stopPrice: 30_220 },
    second: { side: 'Sell', orderType: 'Limit', limitPrice: 30_310 },
  };

  it('mapuje čekající entry a oba bracket legs do jednoho placeOSO payloadu', () => {
    expect(toPlaceOsoPayload(osoRequest, 'DEMO123')).toEqual({
      accountId: 200, accountSpec: 'DEMO123', symbol: 'MNQU6', orderQty: 1,
      action: 'Buy', orderType: 'Limit', price: 30_250,
      clOrdId: 'cposo123', isAutomated: true,
      bracket1: {
        action: 'Sell', orderType: 'Stop', stopPrice: 30_220, clOrdId: 'cposo123s',
      },
      bracket2: {
        action: 'Sell', orderType: 'Limit', price: 30_310, clOrdId: 'cposo123t',
      },
    });
  });

  it('přijme jen odpověď se všemi třemi order ID', () => {
    expect(fromPlaceOsoResult({ orderId: 10, oso1Id: 11, oso2Id: 12, failureReason: 'Success' }))
      .toEqual({
        entryBrokerOrderId: '10', firstBrokerOrderId: '11', secondBrokerOrderId: '12',
        accepted: true, definitive: true,
      });
    expect(fromPlaceOsoResult({ orderId: 10, oso1Id: 11, failureReason: 'Success' }))
      .toMatchObject({ accepted: false, definitive: false });
  });
});

describe('mapping výsledků a entit', () => {
  it('orderId znamená definitivní přijetí', () => {
    expect(fromPlaceOrderResult({ orderId: 42 }))
      .toEqual({ brokerOrderId: '42', accepted: true, definitive: true });
  });
  it('explicitní failureText je definitivní reject', () => {
    expect(fromPlaceOrderResult({ failureReason: 'Margin', failureText: 'Not enough margin' }))
      .toMatchObject({ accepted: false, definitive: true, rejectReason: 'Not enough margin' });
  });
  it('prázdná odpověď zůstává nejednoznačná', () => {
    expect(fromPlaceOrderResult({})).toMatchObject({ accepted: false, definitive: false });
  });
  it('Success bez orderId není falešné potvrzení ani definitivní reject', () => {
    expect(fromPlaceOrderResult({ failureReason: 'Success', failureText: '' }))
      .toMatchObject({ accepted: false, definitive: false });
  });
  it('mapuje stavy konzervativně', () => {
    expect(toOrderStatus('Filled')).toBe('filled');
    expect(toOrderStatus('Completed')).toBe('filled');
    expect(toOrderStatus('Canceled')).toBe('canceled');
    expect(toOrderStatus('Rejected')).toBe('rejected');
    expect(toOrderStatus('SomethingNew')).toBe('working');
  });
  it('převede order entitu včetně partial fillu a cen', () => {
    expect(fromOrderEntity({
      id: 42, accountId: 200, contractId: 7, action: 'Buy', orderType: 'Limit',
      ordStatus: 'Working', orderQty: 3, cumQty: 1, price: 29_500,
      customTag50: 'cpabc123',
    }, 'MNQU6')).toMatchObject({
      brokerOrderId: '42', symbol: 'MNQU6', orderType: 'Limit', quantity: 3,
      filledQuantity: 1, limitPrice: 29_500, status: 'working',
    });
  });
  it('zachová nativní parent/OCO/linked vazby order strategie', () => {
    expect(fromOrderEntity({
      id: 43, accountId: 200, contractId: 7, action: 'Sell', orderType: 'Stop',
      ordStatus: 'Working', orderQty: 1, stopPrice: 29_450,
      parentId: 42, ocoId: 99, linkedId: 44,
    }, 'MNQU6')).toMatchObject({
      brokerOrderId: '43',
      parentOrderId: '42',
      ocoId: '99',
      linkedOrderId: '44',
    });
  });
});

describe('fillIncrement a konfigurace', () => {
  it('převádí kumulativní množství na přírůstek', () => {
    expect(fillIncrement(0, 1)).toBe(1);
    expect(fillIncrement(1, 3)).toBe(2);
    expect(fillIncrement(3, 1)).toBe(0);
  });
  it('odděluje demo/live a heartbeat je pod 2,5 s', () => {
    expect(TRADOVATE_HOSTS.demo.rest).not.toBe(TRADOVATE_HOSTS.live.rest);
    expect(TRADOVATE_HEARTBEAT_MS).toBeLessThan(2_500);
  });
});

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('createTradovateBroker REST', () => {
  it('account preflight mapuje active a readonly oprávnění', async () => {
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123',
      fetchImpl: async input => {
        expect(String(input)).toContain('/account/list');
        return jsonResponse([
          { id: 100, active: true, readonly: true },
          { id: 200, active: true, readonly: false },
          { id: 300, active: false, readonly: false },
        ]);
      },
    });
    await expect(broker.listAccountCapabilities([100, 200, 999])).resolves.toEqual([
      { accountId: 100, active: true, canTrade: false },
      { accountId: 200, active: true, canTrade: true },
    ]);
  });

  it('refresh adresáře doplní Account.name nového účtu pro následný order', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpecsByAccountId: { 100: 'OLD-ACCOUNT' },
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/account/list')) return jsonResponse([
          { id: 100, name: 'OLD-ACCOUNT', active: true, readonly: false },
          { id: 63338592, name: 'LUCID-NEW', active: true, readonly: false },
        ]);
        return jsonResponse({ orderId: 42, failureReason: 'Success' });
      },
    });

    await expect(broker.refreshAccountDirectory()).resolves.toEqual([
      { accountId: 100, accountSpec: 'OLD-ACCOUNT', active: true, canTrade: true },
      { accountId: 63338592, accountSpec: 'LUCID-NEW', active: true, canTrade: true },
    ]);
    await broker.placeOrder(request({ accountId: 63338592 }));
    expect(calls.at(-1)?.body).toMatchObject({ accountId: 63338592, accountSpec: 'LUCID-NEW' });
  });

  it('odmítne prázdný token ještě před síťovým requestem', async () => {
    let calls = 0;
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: '   ', accountSpec: 'DEMO123',
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    await expect(broker.placeOrder(request())).rejects.toThrow('token is missing');
    expect(calls).toBe(0);
  });

  it('place/OSO/cancel/modify používají správné endpointy a automated flag', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/order/placeorder')) return jsonResponse({ orderId: 42, failureReason: 'Success' });
      if (url.endsWith('/order/placeoso')) {
        return jsonResponse({ orderId: 50, oso1Id: 51, oso2Id: 52, failureReason: 'Success' });
      }
      return jsonResponse({ commandId: 9, failureReason: 'Success' });
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
    });
    await expect(broker.placeOrder(request())).resolves.toMatchObject({ accepted: true, brokerOrderId: '42' });
    await expect(broker.placeOso?.({
      ...request({ orderType: 'Limit', limitPrice: 30_250 }),
      first: { side: 'Sell', orderType: 'Stop', stopPrice: 30_220 },
      second: { side: 'Sell', orderType: 'Limit', limitPrice: 30_310 },
    })).resolves.toMatchObject({
      accepted: true,
      entryBrokerOrderId: '50',
      firstBrokerOrderId: '51',
      secondBrokerOrderId: '52',
    });
    await broker.cancelOrder(200, '42');
    await broker.modifyOrder(200, '42', { quantity: 3, orderType: 'Limit', limitPrice: 29_600 });
    expect(calls.map(call => call.url.split('/v1')[1])).toEqual([
      '/order/placeorder', '/order/placeoso', '/order/cancelorder', '/order/modifyorder',
    ]);
    expect(calls.every(call => call.body?.isAutomated === true)).toBe(true);
  });

  it('pro multi-account příkaz použije Account.name odpovídající accountId', async () => {
    let body: Record<string, unknown> | undefined;
    const broker = createTradovateBroker({
      environment: 'demo',
      accessToken: 'test-token',
      accountSpec: 'legacy-wrong-value',
      accountSpecsByAccountId: { 200: 'TDFYG50534566527' },
      fetchImpl: async (_input, init) => {
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return jsonResponse({ orderId: 42, failureReason: 'Success' });
      },
    });

    await broker.placeOrder(request({ accountId: 200 }));
    expect(body).toMatchObject({ accountId: 200, accountSpec: 'TDFYG50534566527' });
  });

  it('fail-closed odmítne příkaz bez Account.name pro dané accountId', async () => {
    const broker = createTradovateBroker({
      environment: 'demo',
      accessToken: 'test-token',
      accountSpecsByAccountId: { 201: 'OTHER' },
      fetchImpl: async () => jsonResponse({ orderId: 42 }),
    });

    await expect(broker.placeOrder(request({ accountId: 200 })))
      .rejects.toThrow('accountSpec is missing for account 200');
  });

  it('recovery lookup hydratuje symbol, ale prázdno nepovažuje za cross-session autoritu', async () => {
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('/order/list')) return jsonResponse([{
        id: 42, accountId: 200, contractId: 7, action: 'Buy', ordStatus: 'Working',
      }]);
      if (url.includes('/orderVersion/list')) return jsonResponse([{
        id: 101, orderId: 42, orderType: 'Limit', orderQty: 2,
      }]);
      if (url.includes('/command/list')) return jsonResponse([{
        id: 102, orderId: 42, commandType: 'New', clOrdId: 'cpabc123',
      }]);
      if (url.includes('/fill/list')) return jsonResponse([]);
      if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
      throw new Error(`unexpected url ${url}`);
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
    });
    const lookup = await broker.findOrdersByTag(200, 'cpabc123');
    expect(lookup.completeness).toBe('eventual');
    expect(lookup.orders[0]).toMatchObject({ brokerOrderId: '42', symbol: 'MNQU6' });
  });

  it('hydratuje více kontraktů jedním comma-separated ids parametrem', async () => {
    let contractItemsUrl = '';
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('/position/list')) return jsonResponse([
        { id: 42, accountId: 200, contractId: 7, netPos: 1 },
        { id: 43, accountId: 200, contractId: 8, netPos: -1 },
      ]);
      if (url.includes('/contract/items')) {
        contractItemsUrl = url;
        return jsonResponse([{ id: 7, name: 'MNQU6' }, { id: 8, name: 'NQU6' }]);
      }
      throw new Error(`unexpected url ${url}`);
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
    });

    await broker.listPositions(200);

    expect(contractItemsUrl).toContain('/contract/items?ids=7,8');
    expect(contractItemsUrl).not.toContain('&ids=');
  });

  it('penalty ticket nikdy automaticky neopakuje', async () => {
    let calls = 0;
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123',
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({
          'p-ticket': 'ticket', 'p-time': 15, 'p-captcha': false, 'p-message': 'slow down',
        });
      },
    });
    const error = await broker.placeOrder(request()).catch(value => value);
    expect(error).toBeInstanceOf(TradovateRateLimitError);
    expect(error).toMatchObject({ retryAfterMs: 15_000, captchaRequired: false });
    expect(calls).toBe(1);
  });

  it('cancel Success bez commandId zůstává nejednoznačný a musí se ověřit lookupem', async () => {
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123',
      fetchImpl: async () => jsonResponse({ failureReason: 'Success', failureText: '' }),
    });
    await expect(broker.cancelOrder(200, '42')).rejects.toThrow('ambiguous response');
  });
});

describe('createTradovateBroker WebSocket', () => {
  it('REST baseline emituje před connected=true, aby se po startu nekopírovala historie', async () => {
    const events: Array<{ type: string }> = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() {},
    };
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('/order/list')) return jsonResponse([{
        id: 42, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Working',
      }]);
      if (url.includes('/orderVersion/list')) return jsonResponse([{
        id: 11, orderId: 42, orderQty: 1, orderType: 'Limit', price: 29_500,
      }]);
      if (url.includes('/command/list')) return jsonResponse([]);
      if (url.includes('/fill/list')) return jsonResponse([]);
      if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
      throw new Error(`unexpected url ${url}`);
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    const unsubscribe = broker.subscribe(event => events.push(event));
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await expect.poll(() => events.some(event => event.type === 'connection')).toBe(true);
    expect(events.map(event => event.type)).toEqual(['heartbeat', 'order', 'connection']);
    unsubscribe();
  });

  it('autorizuje, čeká na dokončení sync, odešle jeden syncrequest a odpoví na heartbeat', async () => {
    const sent: string[] = [];
    const events: Array<{ type: string; connected?: boolean }> = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: value => sent.push(value), close() {},
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123',
      webSocketFactory: () => socket,
      fetchImpl: async () => jsonResponse([]),
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    const unsubscribe = broker.subscribe(event => events.push(event));
    socket.onopen?.();
    expect(events.some(event => event.type === 'connection' && event.connected)).toBe(false);
    socket.onmessage?.({ data: 'o' });
    await expect.poll(() => sent[0]).toBe('authorize\n0\n\ntest-token');
    expect(sent[0]).toBe('authorize\n0\n\ntest-token');
    socket.onmessage?.({ data: 'a[{"i":0,"s":200,"d":{}}]' });
    await expect.poll(() => sent.filter(value => value.startsWith('user/syncrequest')).length).toBe(1);
    expect(sent.filter(value => value.startsWith('user/syncrequest'))).toHaveLength(1);
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await expect.poll(() => events.some(event => event.type === 'connection' && event.connected)).toBe(true);
    expect(events.some(event => event.type === 'connection' && event.connected)).toBe(true);
    socket.onmessage?.({ data: 'h' });
    await expect.poll(() => sent.at(-1)).toBe('[]');
    unsubscribe();
  });

  it('koreluje Order, OrderVersion, Command a Fill bez dvojího započtení fillu', async () => {
    const events: Array<{ type: string; fill?: { quantity: number }; order?: { filledQuantity: number; tag: string } }> = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() {},
    };
    const fetchImpl: typeof fetch = async input => {
      if (String(input).includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
      throw new Error(`unexpected url ${String(input)}`);
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    const unsubscribe = broker.subscribe(event => events.push(event));
    const props = [
      { entityType: 'Command', entity: { id: 10, orderId: 42, commandType: 'New', clOrdId: 'cpabc123' } },
      { entityType: 'OrderVersion', entity: { id: 11, orderId: 42, orderQty: 3, orderType: 'Limit', price: 29500 } },
      { entityType: 'Order', entity: { id: 42, accountId: 200, contractId: 7, action: 'Buy', ordStatus: 'Working' } },
      { entityType: 'Fill', entity: { id: 12, orderId: 42, accountId: 200, contractId: 7, action: 'Buy', qty: 1, price: 29500 } },
      { entityType: 'Fill', entity: { id: 12, orderId: 42, accountId: 200, contractId: 7, action: 'Buy', qty: 1, price: 29500 } },
    ];
    socket.onmessage?.({ data: `a[${JSON.stringify({ e: 'props', d: props })}]` });
    await expect.poll(() => events.filter(event => event.type === 'fill').length).toBe(1);
    expect(events.filter(event => event.type === 'fill')).toHaveLength(1);
    expect(events.find(event => event.type === 'fill')?.fill?.quantity).toBe(1);
    expect(events.filter(event => event.type === 'order').at(-1)?.order)
      .toMatchObject({ filledQuantity: 1, tag: 'cpabc123' });
    unsubscribe();
  });

  it('fill doručený před Order neztratí a doplní accountId až po korelaci', async () => {
    const fills: Array<{ accountId: number; quantity: number }> = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() {},
    };
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('/orderVersion/deps')) return jsonResponse([{
        id: 11, orderId: 42, orderQty: 1, orderType: 'Market',
      }]);
      if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
      throw new Error(`unexpected url ${url}`);
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    const unsubscribe = broker.subscribe(event => {
      if (event.type === 'fill') fills.push({ accountId: event.fill.accountId, quantity: event.fill.quantity });
    });
    const props = [
      { entityType: 'Fill', entity: { id: 12, orderId: 42, contractId: 7, qty: 1, price: 29_500 } },
      { entityType: 'Order', entity: { id: 42, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Filled' } },
    ];
    socket.onmessage?.({ data: `a[${JSON.stringify({ e: 'props', d: props })}]` });
    await expect.poll(() => fills.length).toBe(1);
    expect(fills).toEqual([{ accountId: 100, quantity: 1 }]);
    unsubscribe();
  });

  it('pozdní CommandReport reject koreluje přes Command a zachová důvod', async () => {
    const rejected: Array<{ status: string; rejectReason?: string }> = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() {},
    };
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('/orderVersion/deps')) return jsonResponse([{
        id: 11, orderId: 42, orderQty: 1, orderType: 'Limit', price: 29_500,
      }]);
      if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
      throw new Error(`unexpected url ${url}`);
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    const unsubscribe = broker.subscribe(event => {
      if (event.type === 'order' && event.order.status === 'rejected') {
        rejected.push({ status: event.order.status, rejectReason: event.order.rejectReason });
      }
    });
    const props = [
      { entityType: 'commandReport', entity: {
        id: 90, commandId: 10, commandStatus: 'ExecutionRejected',
        ordStatus: 'Rejected', rejectReason: 'InvalidPrice', text: 'Price is invalid',
      } },
      { entityType: 'Command', entity: {
        id: 10, orderId: 42, commandType: 'New', clOrdId: 'cpabc123',
      } },
      { entityType: 'Order', entity: {
        id: 42, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Working',
      } },
    ];
    socket.onmessage?.({ data: `a[${JSON.stringify({ e: 'props', d: props })}]` });
    await expect.poll(() => rejected.length).toBe(1);
    expect(rejected).toEqual([{ status: 'rejected', rejectReason: 'Price is invalid' }]);
    unsubscribe();
  });

  it('ExecutionReport aktualizuje terminální stav, ale nevyrábí duplicitní Fill', async () => {
    const orderStatuses: string[] = [];
    let fills = 0;
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() {},
    };
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('/orderVersion/deps')) return jsonResponse([{
        id: 11, orderId: 42, orderQty: 1, orderType: 'Market',
      }]);
      if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
      throw new Error(`unexpected url ${url}`);
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    const unsubscribe = broker.subscribe(event => {
      if (event.type === 'order') orderStatuses.push(event.order.status);
      if (event.type === 'fill') fills += 1;
    });
    socket.onmessage?.({ data: `a[${JSON.stringify({ e: 'props', d: [{
      entityType: 'executionReport', entity: {
        id: 12, orderId: 42, accountId: 100, contractId: 7,
        action: 'Buy', ordStatus: 'Completed', lastQty: 1, lastPx: 29_500,
      },
    }] })}]` });
    await expect.poll(() => orderStatuses.at(-1)).toBe('filled');
    expect(fills).toBe(0);
    unsubscribe();
  });

  it('WebSocket penalty ticket zavře spojení a předá přesný fail-closed error', async () => {
    const errors: Error[] = [];
    let closed = 0;
    const reconnectDelays: number[] = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() { closed += 1; },
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123',
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      setTimeoutImpl: ((_handler: TimerHandler, delay?: number) => {
        reconnectDelays.push(Number(delay));
        return 1;
      }) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    });
    const unsubscribe = broker.subscribe(event => {
      if (event.type === 'error') errors.push(event.error);
    });
    socket.onmessage?.({ data: 'a[{"i":9,"s":200,"d":{"p-ticket":"ticket","p-time":15,"p-message":"slow down"}}]' });
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0]).toMatchObject({ name: 'TradovateRateLimitError', retryAfterMs: 15_000 });
    expect(closed).toBe(1);
    socket.onclose?.();
    expect(reconnectDelays).toEqual([15_000]);
    unsubscribe();
  });

  it('syncrequest P-ticket zopakuje bezpečně se stejným ticketem až po p-time', async () => {
    const sent: string[] = [];
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: value => sent.push(value), close() {},
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123',
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      setTimeoutImpl: ((handler: TimerHandler, delay?: number) => {
        callbacks.push(handler as () => void);
        delays.push(Number(delay));
        return callbacks.length;
      }) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    socket.onopen?.();
    socket.onmessage?.({ data: 'o' });
    await expect.poll(() => sent.length).toBe(1);
    socket.onmessage?.({ data: 'a[{"i":0,"s":200,"d":{}}]' });
    await expect.poll(() => sent.filter(value => value.startsWith('user/syncrequest')).length).toBe(1);

    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":{"p-ticket":"sync-ticket","p-time":15,"p-captcha":false}}]' });
    await expect.poll(() => delays.includes(15_000)).toBe(true);
    const retryIndex = delays.indexOf(15_000);
    callbacks[retryIndex]();
    expect(sent.at(-1)).toContain('"p-ticket":"sync-ticket"');
    expect(sent.filter(value => value.startsWith('user/syncrequest'))).toHaveLength(2);
    unsubscribe();
  });

  it('heartbeat nefalšuje příjem dat a po 15 s ticha spojení zavře', () => {
    let now = 0;
    let heartbeatCallback: (() => void) | null = null;
    let closed = 0;
    const sent: string[] = [];
    const errors: Error[] = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: value => sent.push(value), close() { closed += 1; },
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123',
      clock: () => now,
      webSocketFactory: () => socket,
      setIntervalImpl: ((handler: TimerHandler) => {
        heartbeatCallback = handler as () => void;
        return 1;
      }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      setTimeoutImpl: (() => 1) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    });
    const unsubscribe = broker.subscribe(event => {
      if (event.type === 'error') errors.push(event.error);
    });
    socket.onopen?.();

    now = TRADOVATE_HEARTBEAT_MS + 1;
    (heartbeatCallback as unknown as () => void)();
    expect(sent).toEqual(['[]']);
    now = (TRADOVATE_HEARTBEAT_MS * 2) + 2;
    (heartbeatCallback as unknown as () => void)();
    expect(sent).toEqual(['[]', '[]']);

    now = 15_001;
    (heartbeatCallback as unknown as () => void)();
    expect(closed).toBe(1);
    expect(errors[0]?.message).toContain('heartbeat timeout');
    unsubscribe();
  });

  it('nedokončený initial sync po timeoutu spojení zavře', () => {
    let timeoutCallback: (() => void) | null = null;
    let closed = 0;
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() { closed += 1; },
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123',
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      setTimeoutImpl: ((handler: TimerHandler) => {
        timeoutCallback = handler as () => void;
        return 1;
      }) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
      syncTimeoutMs: 50,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    socket.onopen?.();
    expect(timeoutCallback).not.toBeNull();
    (timeoutCallback as unknown as () => void)();
    expect(closed).toBe(1);
    unsubscribe();
  });

  it('cancel po command ACK počká na Order update ze sync streamu a lookup použije tento stav', async () => {
    const sent: string[] = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: value => sent.push(value), close() {},
    };
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url.endsWith('/order/cancelorder')) return jsonResponse({ commandId: 9, failureReason: 'Success' });
      if (url.includes('/order/item')) return jsonResponse({
        id: 42, accountId: 200, contractId: 7, action: 'Buy', ordStatus: 'Canceled',
      });
      if (url.includes('/order/list') || url.includes('/orderVersion/list') || url.includes('/command/list') || url.includes('/fill/list')) return jsonResponse([]);
      if (url.includes('/fill/deps')) return jsonResponse([]);
      if (url.includes('/orderVersion/deps')) return jsonResponse([{
        id: 11, orderId: 42, orderQty: 1, orderType: 'Limit', price: 29_500,
      }]);
      if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
      throw new Error(`unexpected url ${url}`);
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await expect.poll(() => sent.length).toBe(0);

    const cancel = broker.cancelOrder(200, '42');
    await Promise.resolve();
    socket.onmessage?.({ data: `a[${JSON.stringify({ e: 'props', d: [{
      entityType: 'Order', entity: {
        id: 42, accountId: 200, contractId: 7, action: 'Buy', ordStatus: 'Canceled',
      },
    }] })}]` });
    await cancel;
    await expect(broker.findOrderById(200, '42')).resolves.toMatchObject({
      order: { status: 'canceled', brokerOrderId: '42' },
      completeness: 'authoritative',
    });
    unsubscribe();
  });

  it('lookup po modify obnoví nový OrderVersion a nevrátí starý stream cache', async () => {
    const observedPrices: number[] = [];
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() {},
    };
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('/order/item')) return jsonResponse({
        id: 42, accountId: 200, contractId: 7, action: 'Buy', ordStatus: 'Working',
      });
      if (url.includes('/orderVersion/deps')) return jsonResponse([{
        id: 12, orderId: 42, orderQty: 1, orderType: 'Limit', price: 29_501,
      }]);
      if (url.includes('/command/list') || url.includes('/fill/deps')) return jsonResponse([]);
      if (url.includes('/contract/items')) return jsonResponse([{ id: 7, name: 'MNQU6' }]);
      throw new Error(`unexpected url ${url}`);
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    const unsubscribe = broker.subscribe(event => {
      if (event.type === 'order' && event.order.limitPrice != null) {
        observedPrices.push(event.order.limitPrice);
      }
    });
    socket.onmessage?.({ data: `a[${JSON.stringify({ e: 'props', d: [
      { entityType: 'OrderVersion', entity: {
        id: 11, orderId: 42, orderQty: 1, orderType: 'Limit', price: 29_500,
      } },
      { entityType: 'Order', entity: {
        id: 42, accountId: 200, contractId: 7, action: 'Buy', ordStatus: 'Working',
      } },
    ] })}]` });
    await expect.poll(() => observedPrices.at(-1)).toBe(29_500);

    await expect(broker.findOrderById(200, '42')).resolves.toMatchObject({
      order: { brokerOrderId: '42', limitPrice: 29_501, status: 'working' },
      completeness: 'authoritative',
    });
    unsubscribe();
  });

  it('modify timeout dohledá CommandReport a zachová broker rejection i commandId', async () => {
    const socket: WebSocketLike = {
      readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() {},
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/order/modifyorder')) {
        return jsonResponse({ commandId: 91, failureReason: 'Success' });
      }
      if (url.includes('/commandReport/deps?masterid=91')) {
        return jsonResponse([{
          id: 92,
          commandId: 91,
          commandStatus: 'ExecutionRejected',
          ordStatus: 'Rejected',
          rejectReason: 'InvalidPrice',
          text: 'Order rejected due to invalid price.',
        }]);
      }
      if (
        url.includes('/order/list')
        || url.includes('/orderVersion/list')
        || url.includes('/command/list')
        || url.includes('/fill/list')
      ) {
        return jsonResponse([]);
      }
      throw new Error(`unexpected url ${url}`);
    };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'test-token', accountSpec: 'DEMO123', fetchImpl,
      webSocketFactory: () => socket,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
      commandConfirmationTimeoutMs: 1,
    });
    let connected = false;
    const unsubscribe = broker.subscribe(event => {
      if (event.type === 'connection') connected = event.connected;
    });
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await expect.poll(() => connected).toBe(true);

    await expect(broker.modifyOrder(200, '42', {
      quantity: 1,
      orderType: 'Limit',
      limitPrice: 29_501,
    })).rejects.toThrow('modifyOrder command 91 rejected: Order rejected due to invalid price.');
    unsubscribe();
  });
});

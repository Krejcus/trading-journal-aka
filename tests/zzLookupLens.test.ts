import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
const log = (...a: unknown[]) => appendFileSync(process.env.LENS_OUT ?? '/dev/null', a.map(String).join(' ') + '\n');
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const flush = async () => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); await new Promise(r => setTimeout(r, 5)); };

const makeSocket = (): WebSocketLike => ({
  readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null, send() {}, close() {},
});

describe('LOOKUP lens', () => {
  it('A: stream Canceled/Trade execution report on an already hydrated order -> extra /orderVersion/deps?', async () => {
    const calls: string[] = [];
    const socket = makeSocket();
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 't', accountSpec: 'DEMO',
      webSocketFactory: () => socket,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url.replace(/^https?:\/\/[^/]+\/v1/, ''));
        if (/\/(order|orderVersion|command|fill|executionReport)\/list/.test(url)) return json([]);
        if (url.includes('/orderVersion/deps')) return json([{ id: 50, orderId: 50, orderQty: 1, orderType: 'Stop', stopPrice: 100 }]);
        if (url.includes('/contract/items')) return json([{ id: 7, name: 'MNQZ6' }]);
        throw new Error(`unexpected ${url}`);
      }) as typeof fetch,
    });
    const events: BrokerEvent[] = [];
    broker.subscribe(e => events.push(e));
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await flush();
    const frame = (...items: unknown[]) => socket.onmessage?.({ data: `a${JSON.stringify([{ e: 'props', d: items }])}` });
    frame(
      { entityType: 'command', entity: { id: 50, orderId: 50, commandType: 'New', clOrdId: 'x' } },
      { entityType: 'orderVersion', entity: { id: 50, orderId: 50, orderQty: 1, orderType: 'Stop', stopPrice: 100 } },
      { entityType: 'order', entity: { id: 50, accountId: 100, contractId: 7, action: 'Sell', ordStatus: 'Working' } },
    );
    await flush();
    const before = calls.filter(c => c.startsWith('/orderVersion/deps')).length;
    // Cancel command 60 -> Canceled execution report (no OrderVersion for a cancel command)
    frame({ entityType: 'executionReport', entity: { id: 61, commandId: 60, orderId: 50, accountId: 100, contractId: 7, action: 'Sell', ordStatus: 'Canceled', execType: 'Canceled' } });
    await flush();
    frame({ entityType: 'executionReport', entity: { id: 62, commandId: 50, orderId: 50, accountId: 100, contractId: 7, action: 'Sell', ordStatus: 'Canceled', execType: 'Trade' } });
    await flush();
    const after = calls.filter(c => c.startsWith('/orderVersion/deps')).length;
    log('A: /orderVersion/deps before', before, 'after two exec reports', after);
    expect(after).toBe(before);
  });

  it('B: findOrderById request count vs number of modify versions', async () => {
    const repeatCounts: number[] = [];
    for (const n of [0, 1, 5, 20]) {
      const calls: string[] = [];
      const versions = [{ id: 42, orderId: 42, orderQty: 2, orderType: 'Stop', stopPrice: 29_900 }];
      const commands: Array<Record<string, unknown>> = [{ id: 42, orderId: 42, commandType: 'New', clOrdId: 'tag' }];
      const reports: Array<Record<string, unknown>> = [];
      for (let k = 1; k <= n; k += 1) {
        const cid = 1000 + k * 2;
        versions.push({ id: cid, orderId: 42, orderQty: 2, orderType: 'Stop', stopPrice: 29_900 + k });
        commands.push({ id: cid, orderId: 42, commandType: 'Modify' });
        reports.push({ id: cid + 1, commandId: cid, orderId: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working', execType: 'Replaced' });
      }
      const broker = createTradovateBroker({
        environment: 'demo', accessToken: 't', accountSpec: 'DEMO',
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          const path = url.pathname.replace('/v1', '');
          calls.push(path);
          const m = Number(url.searchParams.get('masterid'));
          if (path === '/order/item') return json({ id: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working' });
          if (path === '/orderVersion/deps') return json(versions.filter(v => v.orderId === m));
          if (path === '/command/deps') return json(commands.filter(c => c.orderId === m));
          if (path === '/command/list') return json(commands);
          if (path === '/fill/deps') return json([]);
          if (path === '/executionReport/deps') return json(reports.filter(r => r.commandId === m));
          if (path === '/executionReport/list') return json(reports);
          if (path === '/contract/items') return json([{ id: 7, name: 'MNQZ6' }]);
          throw new Error(`unexpected ${path}`);
        }) as typeof fetch,
      });
      const first = await broker.findOrderById(200, '42');
      const firstCount = calls.length;
      calls.length = 0;
      const second = await broker.findOrderById(200, '42');
      log(`B n=${n}: first call ${firstCount} req, repeat call ${calls.length} req; stop=${first.order?.stopPrice}/${second.order?.stopPrice}`);
      repeatCounts.push(calls.length);
      expect(second.order?.stopPrice).toBe(29_900 + n);
    }
    expect(repeatCounts).toEqual([4, 4, 4, 4]);
  });

  it('C: /command/deps failure is swallowed (base: /command/list failure throws)', async () => {
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 't', accountSpec: 'DEMO',
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const path = url.pathname.replace('/v1', '');
        if (path === '/order/item') return json({ id: 42, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working' });
        if (path === '/orderVersion/deps') return json([{ id: 42, orderId: 42, orderQty: 2, orderType: 'Stop', stopPrice: 29_900 }]);
        if (path === '/command/deps' || path === '/command/list') return new Response('boom', { status: 500 });
        if (path === '/fill/deps') return json([]);
        if (path === '/executionReport/deps' || path === '/executionReport/list') return json([]);
        if (path === '/contract/items') return json([{ id: 7, name: 'MNQZ6' }]);
        throw new Error(`unexpected ${path}`);
      }) as typeof fetch,
    });
    const r = await broker.findOrderById(200, '42').then(v => ({ ok: v.order?.stopPrice, tag: v.order?.tag }), e => ({ err: String(e).slice(0, 120) }));
    log('C:', JSON.stringify(r));
    expect(r).toEqual({ ok: 29_900, tag: '' });
  });

  it('D: executionReport deps of a shared command are applied to OTHER orders (no orderId filter)', async () => {
    // order 50 has initial version id 60 (!= orderId) created by command 60,
    // command 60 deps also returns a report for sibling order 51.
    const socket = makeSocket();
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 't', accountSpec: 'DEMO',
      webSocketFactory: () => socket,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const path = url.pathname.replace('/v1', '');
        const m = Number(url.searchParams.get('masterid') ?? url.searchParams.get('id'));
        if (/\/(order|orderVersion|command|fill|executionReport)\/list/.test(path)) return json([]);
        if (path === '/order/item') return json({ id: m, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working' });
        if (path === '/orderVersion/deps') return json(m === 50
          ? [{ id: 60, orderId: 50, orderQty: 1, orderType: 'Stop', stopPrice: 100 }]
          : [{ id: 51, orderId: 51, orderQty: 1, orderType: 'Limit', price: 200 }]);
        if (path === '/command/deps') return json(m === 50 ? [{ id: 60, orderId: 50, commandType: 'New' }] : []);
        if (path === '/fill/deps') return json([]);
        if (path === '/executionReport/deps') return json(m === 60 ? [
          { id: 70, commandId: 60, orderId: 50, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working', execType: 'New' },
          { id: 71, commandId: 60, orderId: 51, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working', execType: 'New' },
        ] : []);
        if (path === '/contract/items') return json([{ id: 7, name: 'MNQZ6' }]);
        throw new Error(`unexpected ${path}`);
      }) as typeof fetch,
    });
    const events: BrokerEvent[] = [];
    broker.subscribe(e => events.push(e));
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await flush();
    await broker.findOrderById(200, '50');
    // now the stream delivers order 51 with its own initial version id 51
    socket.onmessage?.({ data: `a${JSON.stringify([{ e: 'props', d: [
      { entityType: 'orderVersion', entity: { id: 51, orderId: 51, orderQty: 1, orderType: 'Limit', price: 200 } },
      { entityType: 'order', entity: { id: 51, accountId: 200, contractId: 7, action: 'Sell', ordStatus: 'Working' } },
    ] }])}` });
    await flush();
    const o51 = events.filter((e): e is Extract<BrokerEvent, { type: 'order' }> => e.type === 'order' && e.order.brokerOrderId === '51');
    const errs = events.filter(e => e.type === 'error').map(e => (e as { error: Error }).error.message);
    log('D: order 51 events', o51.length, 'errors', JSON.stringify(errs));
    const f51 = await broker.findOrderById(200, '51').then(v => v.order?.brokerOrderId ?? 'null', e => String(e).slice(0, 160));
    log('D: findOrderById(51)', JSON.stringify(f51));
    expect(o51).toHaveLength(1);
    expect(errs).toEqual([]);
    expect(f51).toBe('51');
  });
});

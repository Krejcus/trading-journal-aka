import { describe, expect, it, vi } from 'vitest';
import { createTradovateBroker } from '../services/tradovateBroker';
import type { JournalObservation } from '../lib/tradovateJournalEvidence';

const setup = (fetchImpl: typeof fetch = async () => Response.json([]), overrides: Partial<Parameters<typeof createTradovateBroker>[0]> = {}) => {
  const socket = {
    readyState: 0, onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as (() => void) | null, onclose: null as (() => void) | null,
    send: vi.fn(), close: vi.fn(),
  };
  const factory = vi.fn(() => socket);
  const broker = createTradovateBroker({ environment: 'demo', accessToken: 'test-only', webSocketFactory: factory,
    fetchImpl, ...overrides,
  });
  return { broker, socket, factory };
};

describe('passive journal observer', () => {
  it('does not start a socket and does not retain it after execution unsubscribes', () => {
    const { broker, factory, socket } = setup();
    const unsubscribeEvidence = broker.subscribeEvidence(() => {});
    expect(factory).not.toHaveBeenCalled();
    const unsubscribeExecution = broker.subscribe(() => {});
    expect(factory).toHaveBeenCalledTimes(1);
    unsubscribeExecution();
    expect(socket.close).toHaveBeenCalledTimes(1);
    unsubscribeEvidence();
  });
  it('retains every raw version and isolates failing or mutating observers', async () => {
    const { broker, socket } = setup();
    const events: JournalObservation[] = [];
    const bad = broker.subscribeEvidence(event => { event.entity.id = 999; throw new Error('observer-failure'); });
    const good = broker.subscribeEvidence(event => events.push(event));
    const stop = broker.subscribe(() => {});
    socket.onmessage?.({ data: `a${JSON.stringify([{ e: 'props', d: [
      { entityType: 'orderVersion', eventType: 'Created', entity: { id: 1, orderId: 10, orderType: 'Stop', stopPrice: 100, secret: 'never-capture' } },
      { entityType: 'orderVersion', eventType: 'Created', entity: { id: 2, orderId: 10, orderType: 'Stop', stopPrice: 101 } },
    ] }])}` });
    await vi.waitFor(() => expect(events.filter(event => event.entityType === 'orderversion')).toHaveLength(2));
    expect(events.filter(event => event.entityType === 'orderversion').map(event => event.entity.id)).toEqual([1, 2]);
    expect(JSON.stringify(events)).not.toContain('never-capture');
    stop(); good(); bad();
  });
  it('captures exact receipt times while the execution metadata queue is blocked', async () => {
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const { broker, socket } = setup(fetchImpl);
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => events.push(event));
    const stop = broker.subscribe(() => {});
    socket.onmessage?.({ data: 'a[{"e":"props","d":{"entityType":"position","entity":{"accountId":1,"contractId":10,"netPos":1}}}]' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const before = Date.now();
    socket.onmessage?.({ data: 'a[{"e":"props","d":[{"entityType":"orderVersion","entity":{"id":1,"orderId":20,"stopPrice":100}},{"entityType":"orderVersion","entity":{"id":2,"orderId":20,"stopPrice":101}}]}]' });
    const versions = events.filter(event => event.entityType === 'orderversion');
    // This assertion runs synchronously, before blocked metadata work can finish.
    expect(versions.map(event => event.entity.id)).toEqual([1, 2]);
    expect(versions[0].receivedAt).toBeGreaterThanOrEqual(before);
    expect(versions[0].receivedAt).toBe(versions[1].receivedAt);
    stop();
    const count = events.length;
    socket.onmessage?.({ data: 'a[{"e":"props","d":{"entityType":"orderVersion","entity":{"id":3,"orderId":20}}}]' });
    expect(events).toHaveLength(count);
    release(Response.json([{ id: 10, name: 'MNQ' }]));
    good();
  });

  it('subscribes once to journal entity types and retains object snapshots without flat inference', async () => {
    const { broker, socket } = setup();
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => events.push(event));
    const stop = broker.subscribe(() => {});
    socket.readyState = 1;
    socket.onmessage?.({ data: 'a[{"i":0,"s":200,"d":{}}]' });
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(1));
    const request = JSON.parse(socket.send.mock.calls[0][0].split('\n')[3]);
    expect(request).toEqual({ splitResponses: true, entityTypes: expect.arrayContaining([
      'orderVersion', 'fillFee', 'fillPair', 'cashBalanceLog', 'executionReport', 'commandReport',
    ]) });
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":{"positions":[],"orderVersions":[{"id":1,"orderId":20,"stopPrice":100}],"fillPairs":[{"id":4,"buyFillId":1,"sellFillId":2}],"fillFees":[{"id":1,"commission":1}],"cashBalanceLogs":[{"id":5,"accountId":1,"delta":100}]}}]' });
    expect(events.filter(event => event.source === 'snapshot').map(event => event.entityType))
      .toEqual(['orderversion', 'fillfee', 'fillpair', 'cashbalancelog']);
    expect(events.some(event => event.entityType === 'position')).toBe(false);
    await vi.waitFor(() => expect(events.some(event => event.entity.state === 'synced')).toBe(true));
    expect(socket.send).toHaveBeenCalledTimes(1);
    stop(); good();
  });

  it('keeps a requested new stop out of an already populated execution order', async () => {
    const { broker, socket } = setup(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/order/list') return Response.json([{ id: 20, accountId: 1, contractId: 10, action: 'Sell', ordStatus: 'Working' }]);
      if (path === '/v1/orderVersion/list') return Response.json([{ id: 1, orderId: 20, orderQty: 1, orderType: 'Stop', stopPrice: 100 }]);
      if (path === '/v1/contract/items') return Response.json([{ id: 10, name: 'MNQ' }]);
      return Response.json([]);
    });
    const execution = vi.fn();
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => events.push(event));
    const stop = broker.subscribe(execution);
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(execution.mock.calls.some(([event]) => event.type === 'order' && event.order.stopPrice === 100)).toBe(true));
    execution.mockClear();
    socket.onmessage?.({ data: 'a[{"e":"props","d":{"entityType":"orderVersion","entity":{"id":2,"orderId":20,"orderQty":1,"orderType":"Stop","stopPrice":999}}}]' });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(events.some(event => event.entityType === 'orderversion' && event.entity.stopPrice === 999)).toBe(true);
    expect(execution.mock.calls.some(([event]) => event.type === 'order')).toBe(false);
    // An unrelated Order notification must not later pick up the requested
    // price, including when the same requested version is replayed beside it.
    socket.onmessage?.({ data: `a${JSON.stringify([{ e: 'props', d: [
      { entityType: 'orderVersion', entity: { id: 2, orderId: 20, orderQty: 1, orderType: 'Stop', stopPrice: 999 } },
      { entityType: 'order', entity: { id: 20, accountId: 1, contractId: 10, action: 'Sell', ordStatus: 'Working' } },
    ] }])}` });
    await vi.waitFor(() => expect(execution.mock.calls.some(([event]) => event.type === 'order')).toBe(true));
    expect(execution.mock.calls.filter(([event]) => event.type === 'order')
      .every(([event]) => event.order.stopPrice === 100)).toBe(true);
    stop(); good();
  });

  it('does not emit a requested version into copier execution or mark a closed socket synced', async () => {
    let release!: (response: Response) => void;
    const { broker, socket } = setup(async input => String(input).includes('/order/list')
      ? new Promise<Response>(resolve => { release = resolve; }) : Response.json([]));
    const events: JournalObservation[] = [];
    const execution = vi.fn();
    const good = broker.subscribeEvidence(event => events.push(event));
    const stop = broker.subscribe(execution);
    socket.onmessage?.({ data: 'a[{"e":"props","d":{"entityType":"orderVersion","entity":{"id":1,"orderId":20,"orderType":"Stop","stopPrice":999}}}]' });
    await Promise.resolve(); await Promise.resolve();
    expect(execution.mock.calls.some(([event]) => event.type === 'order')).toBe(false);
    // REST baseline waits, then the socket is closed before it resolves.
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    stop();
    release(Response.json([]));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(events.some(event => event.entity.state === 'synced')).toBe(false);
    good();
  });

  it('records one complete snapshot for 12 accounts after sync with two fresh GET requests', async () => {
    const fetchImpl = vi.fn(async input => Response.json(String(input).includes('/account/list')
      ? Array.from({ length: 12 }, (_, index) => ({ id: index + 1, secret: 'omit' })) : []));
    const { broker, socket } = setup(fetchImpl);
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => events.push(event));
    expect(fetchImpl).not.toHaveBeenCalled();
    const execution = vi.fn(); const stop = broker.subscribe(execution);
    socket.readyState = 1;
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(events.filter(event => event.entity.kind === 'complete')).toHaveLength(12));
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes('/account/list'))).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes('/position/list'))).toHaveLength(1);
    expect(events.filter(event => event.entity.kind === 'complete').every(event => event.entity.rowCount === 0 && event.source === 'snapshot')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(execution.mock.calls.some(([event]) => event.type === 'order' || event.type === 'position')).toBe(false);
    stop(); good();
  });

  it('records a failed snapshot as unavailable without disconnecting execution or claiming flat', async () => {
    const { broker, socket } = setup(async input => String(input).includes('/position/list')
      ? new Response('denied', { status: 403 }) : Response.json(String(input).includes('/account/list') ? [{ id: 1 }] : []));
    const events: JournalObservation[] = []; const execution = vi.fn();
    const good = broker.subscribeEvidence(event => events.push(event)); const stop = broker.subscribe(execution);
    socket.readyState = 1;
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(events.some(event => event.entity.kind === 'failed')).toBe(true));
    expect(events.some(event => event.entity.kind === 'complete')).toBe(false);
    expect(socket.close).not.toHaveBeenCalled();
    expect(execution.mock.calls.some(([event]) => event.type === 'connection' && event.connected)).toBe(true);
    stop(); good();
  });

  it('aborts an in-flight position snapshot when execution releases its socket', async () => {
    let signal: AbortSignal | null = null;
    const { broker, socket } = setup(async (input, options) => {
      if (String(input).includes('/position/list')) {
        signal = options!.signal!;
        return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      }
      return Response.json(String(input).includes('/account/list') ? [{ id: 1 }] : []);
    });
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => events.push(event)); const stop = broker.subscribe(() => {});
    socket.readyState = 1;
    socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(signal).not.toBeNull());
    stop();
    expect(signal!.aborted).toBe(true);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(events.some(event => event.entity.kind === 'complete')).toBe(false);
    good();
  });

  it('backfills once per connection, deduplicates repeats and retains later accounting corrections', async () => {
    let periodic!: () => void; let commission = 1;
    const fetchImpl = vi.fn(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/list') return Response.json(Array.from({ length: 12 }, (_, i) => ({ id: i + 1 })));
      if (path === '/v1/fillFee/list') return Response.json([{ id: 1, commission, commissionCurrencyId: 840 }]);
      if (path === '/v1/fillPair/list') return Response.json([{ id: 1, buyFillId: 1, sellFillId: 2, active: true, qty: 1 }]);
      return Response.json([]);
    });
    const { broker, socket } = setup(fetchImpl, { setIntervalImpl: ((callback: () => void, ms: number) => {
      if (ms === 300_000) periodic = callback;
      return setInterval(callback, ms);
    }) as typeof setInterval });
    const events: JournalObservation[] = []; const execution = vi.fn();
    const good = broker.subscribeEvidence(event => events.push(event)); const stop = broker.subscribe(execution);
    socket.readyState = 1; socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(events.filter(row => row.entityType === 'journalbackfill')).toHaveLength(10));
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes('/fillFee/list'))).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes('/fillPair/list'))).toHaveLength(1);
    periodic(); periodic();
    await vi.waitFor(() => expect(events.filter(row => row.entityType === 'journalbackfill')).toHaveLength(20));
    expect(events.filter(row => row.entityType === 'fillfee')).toHaveLength(1);
    commission = 2; periodic();
    await vi.waitFor(() => expect(events.filter(row => row.entityType === 'fillfee')).toHaveLength(2));
    expect(events.filter(row => row.entityType === 'fillfee').at(-1)?.entity.commission).toBe(2);
    expect(execution.mock.calls.some(([event]) => event.type === 'order' || event.type === 'fill' || event.type === 'position')).toBe(false);
    stop(); good();
  });

  it('fences an old accounting response when a stream correction arrives during the request', async () => {
    let release!: (response: Response) => void;
    const { broker, socket } = setup(async input => String(input).includes('/fillFee/list')
      ? new Promise<Response>(resolve => { release = resolve; }) : Response.json([]));
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => events.push(event)); const stop = broker.subscribe(() => {});
    socket.readyState = 1; socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    socket.onmessage?.({ data: 'a[{"e":"props","d":{"entityType":"fillFee","entity":{"id":1,"commission":3,"commissionCurrencyId":840}}}]' });
    release(Response.json([{ id: 1, commission: 1, commissionCurrencyId: 840 }]));
    await vi.waitFor(() => expect(events.some(row => row.entityType === 'journalbackfill' && row.entity.contended === 1)).toBe(true));
    expect(events.filter(row => row.entityType === 'fillfee').map(row => row.entity.commission)).toEqual([3]);
    stop(); good();
  });

  it('keeps available pair evidence when fees or the position snapshot are denied', async () => {
    const { broker, socket } = setup(async input => {
      if (String(input).includes('/fillFee/list') || String(input).includes('/position/list')) return new Response('denied', { status: 403 });
      if (String(input).includes('/fillPair/list')) return Response.json([{ id: 1, buyFillId: 1, sellFillId: 2, qty: 1, active: true }]);
      return Response.json([]);
    });
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => events.push(event)); const stop = broker.subscribe(() => {});
    socket.readyState = 1; socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(events.some(row => row.entityType === 'fillpair')).toBe(true));
    expect(events.some(row => row.entityType === 'journalbackfill' && row.entity.kind === 'unavailable')).toBe(true);
    expect(events.some(row => row.entityType === 'fillfee')).toBe(false);
    expect(socket.close).not.toHaveBeenCalled(); stop(); good();
  });

  it('aborts accounting reads and discards even a fetch implementation that resolves after abort', async () => {
    let release!: (response: Response) => void; let signal: AbortSignal | null = null;
    const { broker, socket } = setup(async (input, options) => {
      if (String(input).includes('/fillFee/list')) {
        signal = options!.signal!;
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return Response.json([]);
    });
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => events.push(event)); const stop = broker.subscribe(() => {});
    socket.readyState = 1; socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    stop(); expect(signal!.aborted).toBe(true);
    release(Response.json([{ id: 1, commission: 1 }]));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(events.some(row => row.entityType === 'fillfee' || row.entityType === 'journalbackfill')).toBe(false);
    good();
  });

  it('waits for durable receipts without blocking execution and rechecks later rows against the stream', async () => {
    const { broker, socket } = setup(async input => String(input).includes('/fillFee/list')
      ? Response.json([{ id: 1, commission: 1 }, { id: 2, commission: 1 }]) : Response.json([]));
    let persist!: (value: boolean) => void;
    const events: JournalObservation[] = []; const execution = vi.fn();
    const good = broker.subscribeEvidence(event => {
      events.push(event);
      if (event.entityType === 'fillfee' && event.entity.id === 1 && event.eventType === 'Backfill') {
        return new Promise<boolean>(resolve => { persist = resolve; });
      }
    });
    const stop = broker.subscribe(execution);
    socket.readyState = 1; socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(persist).toBeTypeOf('function'));
    expect(events.filter(row => row.entityType === 'fillfee')).toHaveLength(1);
    expect(execution.mock.calls.some(([event]) => event.type === 'connection' && event.connected)).toBe(true);
    socket.onmessage?.({ data: 'a[{"e":"props","d":{"entityType":"fillFee","entity":{"id":2,"commission":3}}}]' });
    persist(true);
    await vi.waitFor(() => expect(events.some(row => row.entityType === 'journalbackfill' && row.entity.contended === 1)).toBe(true));
    expect(events.filter(row => row.entityType === 'fillfee' && row.entity.id === 2).map(row => row.entity.commission)).toEqual([3]);
    stop(); good();
  });

  it('reports a refused durable append and retries the same fact after the recorder recovers', async () => {
    let periodic!: () => void; let available = false;
    const { broker, socket } = setup(async input => String(input).includes('/fillFee/list')
      ? Response.json([{ id: 1, commission: 1 }]) : Response.json([]), {
      setIntervalImpl: ((callback: () => void, ms: number) => {
        if (ms === 300_000) periodic = callback;
        return setInterval(callback, ms);
      }) as typeof setInterval,
    });
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => {
      events.push(event);
      if (event.entityType === 'fillfee') return Promise.resolve(available);
    });
    const stop = broker.subscribe(() => {});
    socket.readyState = 1; socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(events.filter(row => row.entityType === 'journalbackfill')).toHaveLength(10));
    expect(events.some(row => row.entityType === 'journalbackfill' && row.entity.entityType === 'fillfee' && row.entity.kind === 'unavailable')).toBe(true);
    available = true; periodic();
    await vi.waitFor(() => expect(events.filter(row => row.entityType === 'journalbackfill')).toHaveLength(20));
    expect(events.filter(row => row.entityType === 'fillfee')).toHaveLength(2);
    expect(events.some(row => row.entityType === 'journalbackfill' && row.entity.entityType === 'fillfee' && row.entity.recorded === 1)).toBe(true);
    stop(); good();
  });

  it('honors a rate limit before reading its body and stops further accounting requests', async () => {
    const fetchImpl = vi.fn(async input => String(input).includes('/fillFee/list')
      ? new Response('limited', { status: 429, headers: { 'content-length': '8000000' } }) : Response.json([]));
    const { broker, socket } = setup(fetchImpl);
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => events.push(event)); const stop = broker.subscribe(() => {});
    socket.readyState = 1; socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(events.some(row => row.entityType === 'journalbackfill' && row.entity.kind === 'unavailable')).toBe(true));
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/fillPair/list'))).toBe(false);
    stop(); good();
  });

  it('ends a background pass at its deadline even when a durable receipt is stuck', async () => {
    let deadline!: () => void; let periodic!: () => void;
    const { broker, socket } = setup(async input => String(input).includes('/fillFee/list')
      ? Response.json([{ id: 1, commission: 1 }]) : Response.json([]), {
      setTimeoutImpl: ((callback: () => void, ms: number) => {
        if (ms === 20_000) deadline = callback;
        return setTimeout(callback, ms);
      }) as typeof setTimeout,
      setIntervalImpl: ((callback: () => void, ms: number) => {
        if (ms === 300_000) periodic = callback;
        return setInterval(callback, ms);
      }) as typeof setInterval,
    });
    const events: JournalObservation[] = [];
    const good = broker.subscribeEvidence(event => {
      events.push(event);
      if (event.entityType === 'fillfee') return new Promise<boolean>(() => {});
    });
    const stop = broker.subscribe(() => {});
    socket.readyState = 1; socket.onmessage?.({ data: 'a[{"i":1,"s":200,"d":[]}]' });
    await vi.waitFor(() => expect(events.some(row => row.entityType === 'fillfee')).toBe(true));
    deadline();
    await vi.waitFor(() => expect(events.some(row => row.entityType === 'journalbackfill' && row.entity.kind === 'unavailable')).toBe(true));
    periodic();
    await vi.waitFor(() => expect(events.filter(row => row.entityType === 'fillfee')).toHaveLength(2));
    expect(socket.close).not.toHaveBeenCalled(); stop(); good();
  });
  it('captures historical order/command/report lists without feeding execution and resolves only known contract IDs', async () => {
    const data: Record<string, unknown[]> = {
      '/account/list': [{ id:1 },{ id:2 }], '/position/list': [],
      '/order/list': [{ id:10,accountId:1,contractId:50,action:'Sell',parentId:9 }],
      '/fill/list': [{ id:30,orderId:10,accountId:1,contractId:50,action:'Sell',qty:1,price:105,timestamp:'2026-09-12T13:00:00.125Z' }],
      '/orderVersion/list': [{ id:20,orderId:10,orderType:'Stop',stopPrice:100,orderQty:1 }],
      '/command/list': [{id:20,orderId:10,commandType:'Modify'}],
      '/executionReport/list': [{id:40,orderId:10,commandId:20,execType:'Replaced',timestamp:'2026-09-12T12:59:00.635Z'}],
      '/commandReport/list': [], '/contract/items': [{ id:50,name:'MNQU6' }], '/cashBalanceLog/ldeps': [{id:60,accountId:1,cashChangeType:'TradePaired',fillId:30,delta:10,currencyId:840}],
    };
    let historical = false;
    const fetchImpl = vi.fn(async input => {
      const path = new URL(String(input)).pathname.replace('/v1','');
      if (path === '/fillFee/list') historical = true;
      return Response.json(historical || path === '/account/list' ? data[path] ?? [] : []);
    });
    const {broker,socket}=setup(fetchImpl); const events:JournalObservation[]=[]; const execution=vi.fn();
    const good=broker.subscribeEvidence(event=>events.push(event)); const stop=broker.subscribe(execution);
    socket.readyState=1; socket.onmessage?.({data:'a[{"i":1,"s":200,"d":[]}]'});
    await vi.waitFor(()=>expect(events.filter(event=>event.entityType==='journalbackfill')).toHaveLength(10));
    for(const type of ['order','fill','orderversion','command','executionreport','contract','cashbalancelog']) expect(events.some(event=>event.entityType===type && event.eventType==='Backfill'), type).toBe(true);
    expect(fetchImpl.mock.calls.map(([url])=>new URL(String(url)).search).filter(Boolean)).toEqual(['?ids=50','?masterids=1,2']);
    expect(execution.mock.calls.some(([event])=>['order','fill','position'].includes(event.type))).toBe(false);
    expect(events.find(event=>event.entityType==='executionreport')?.entity.timestamp).toBe('2026-09-12T12:59:00.635Z');
    expect(events.filter(event=>event.entityType==='journalbackfill').every(event=>event.entity.scope==='available-list' || event.entity.scope==='known-parents')).toBe(true);
    stop();good();
  });

  it('recovers an oversized fee source through exact known-fill batches on the next pass', async () => {
    let periodic!:()=>void;
    const fetchImpl=vi.fn(async input=>{
      const url=new URL(String(input));
      if(url.pathname.endsWith('/fillFee/list')) return new Response('[]',{headers:{'content-length':'5000000'}});
      if(url.pathname.endsWith('/fill/list')) return Response.json([{id:10,orderId:1},{id:20,orderId:2}]);
      if(url.pathname.endsWith('/fillFee/ldeps')) return Response.json([{id:10,commission:1,commissionCurrencyId:840},{id:20,commission:2,commissionCurrencyId:840}]);
      return Response.json([]);
    });
    const {broker,socket}=setup(fetchImpl,{setIntervalImpl:((callback:()=>void,ms:number)=>{if(ms===300000)periodic=callback;return setInterval(callback,ms);}) as typeof setInterval});
    const events:JournalObservation[]=[];const good=broker.subscribeEvidence(event=>events.push(event));const stop=broker.subscribe(()=>{});
    socket.readyState=1;socket.onmessage?.({data:'a[{"i":1,"s":200,"d":[]}]'});
    await vi.waitFor(()=>expect(events.filter(event=>event.entityType==='journalbackfill')).toHaveLength(10));
    expect(events.some(event=>event.entityType==='fillfee')).toBe(false);
    periodic();await vi.waitFor(()=>expect(events.filter(event=>event.entityType==='journalbackfill')).toHaveLength(20));
    expect(fetchImpl.mock.calls.filter(([url])=>String(url).includes('/fillFee/list'))).toHaveLength(1);
    expect(fetchImpl.mock.calls.some(([url])=>String(url).endsWith('/fillFee/ldeps?masterids=10,20'))).toBe(true);
    expect(events.filter(event=>event.entityType==='fillfee').map(event=>event.entity.commission)).toEqual([1,2]);
    expect(events.filter(event=>event.entityType==='journalbackfill' && event.entity.entityType==='fillfee').at(-1)?.entity).toMatchObject({scope:'known-parents',requested:2,scanned:2,recorded:2,remaining:0});
    stop();good();
  });

});

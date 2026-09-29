import { describe, expect, it } from 'vitest';
import type { BrokerEvent } from '../../services/brokerPort';
import { createTradovateBroker } from '../../services/tradovateBroker';

const VERSION = 'assertions';
const log = (..._args: unknown[]) => undefined;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const response = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const fakeSocket = () => {
  const s: any = { onopen: null, onmessage: null, onerror: null, onclose: null, readyState: 0, sent: [] as string[],
    send(d: string) { s.sent.push(d); }, close() { if (s.readyState === 3) return; s.readyState = 3; s.onclose?.(); },
    deliver(d: string) { s.onmessage?.({ data: d }); }, open() { s.readyState = 1; s.onopen?.(); } };
  return s;
};
const handshake = async (socket: any, syncData: unknown[] = []) => {
  socket.open(); socket.deliver('o'); await flush();
  socket.deliver(`a${JSON.stringify([{ i: 0, s: 200 }])}`); await flush();
  socket.deliver(`a${JSON.stringify([{ i: 1, s: 200, d: syncData }])}`); await flush(); await flush(); await flush();
};

describe(`V6 broker gap [${VERSION}]`, () => {
  it('PK: leader SL (Stop) zalozeny v mezere -> live order event pred resync?', async () => {
    const sockets: any[] = [];
    let gap = false;
    const slRaw = { id: 43, accountId: 100, contractId: 7, action: 'Sell', ordStatus: 'Working' };
    const slVersion = { id: 43, orderId: 43, orderQty: 1, orderType: 'Stop', stopPrice: 29_900 };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpecsByAccountId: { 100: 'L1' },
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        if (url.includes('/order/list')) return response(gap ? [slRaw] : []);
        if (url.includes('/orderVersion/list')) return response(gap ? [slVersion] : []);
        if (url.includes('/position/list')) return response(gap ? [{ accountId: 100, contractId: 7, netPos: 1 }] : []);
        if (url.includes('/contract/items')) return response([{ id: 7, name: 'MNQU6' }]);
        return response([]);
      }) as unknown as typeof fetch,
      webSocketFactory: () => { const s = fakeSocket(); sockets.push(s); return s; },
      reconnectDelayMs: 1, reconnectJitterRatio: 0, renewalDeadlineMs: 200,
    } as any);
    const events: BrokerEvent[] = [];
    const unsubscribe = broker.subscribe(event => events.push(event));
    await handshake(sockets[0], [{ entityType: 'Contract', entity: { id: 7, name: 'MNQU6' } }]);
    events.length = 0;
    gap = true;
    expect(broker.renewSocket()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    await handshake(sockets[1], [
      { entityType: 'OrderVersion', entity: slVersion },
      { entityType: 'Order', entity: slRaw },
    ]);
    // Udalost prijata na novem socketu po sync odpovedi (behem snapshotu) - nesmi se ztratit.
    const seq = events.filter(e => e.type !== 'heartbeat').map(e => e.type === 'connection' ? `connection:${(e as any).resynced ? 'resynced' : 'plain'}` : `${e.type}:${(e as any).order?.brokerOrderId ?? ''}`);
    const resync = events.find(e => e.type === 'connection' && (e as any).resynced) as any;
    log('PK', JSON.stringify({ seq, resyncOrders: resync?.resync?.orders?.map((o: any) => `${o.brokerOrderId}:${o.orderType}:${o.stopPrice}`) ?? null }));
    unsubscribe();
    expect(seq).toContain('order:43');
    expect(seq.indexOf('order:43')).toBeLessThan(seq.indexOf('connection:resynced'));
  });

  it('PL: frame prijaty behem REST snapshotu se neztrati ani nezapocte dvakrat', async () => {
    const sockets: any[] = [];
    let gap = false;
    let releasePositions: (() => void) | null = null;
    const raw44 = { id: 44, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Filled' };
    const v44 = { id: 44, orderId: 44, orderQty: 1, orderType: 'Market' };
    const fill90 = { id: 90, orderId: 44, contractId: 7, action: 'Buy', qty: 1, price: 30_000, timestamp: '2026-09-29T14:00:00Z' };
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpecsByAccountId: { 100: 'L1' },
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        if (url.includes('/position/list') && gap) {
          await new Promise<void>(resolve => { releasePositions = resolve; });
          return response([]);
        }
        if (url.includes('/contract/items')) return response([{ id: 7, name: 'MNQU6' }]);
        return response([]);
      }) as unknown as typeof fetch,
      webSocketFactory: () => { const s = fakeSocket(); sockets.push(s); return s; },
      reconnectDelayMs: 1, reconnectJitterRatio: 0, renewalDeadlineMs: 500,
    } as any);
    const events: BrokerEvent[] = [];
    const unsubscribe = broker.subscribe(event => events.push(event));
    await handshake(sockets[0], [{ entityType: 'Contract', entity: { id: 7, name: 'MNQU6' } }]);
    events.length = 0;
    gap = true;
    expect(broker.renewSocket()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    await handshake(sockets[1], []);
    for (let i = 0; i < 20 && !releasePositions; i += 1) await flush();
    const heldAtSnapshot = releasePositions != null;
    sockets[1].deliver(`a${JSON.stringify([{ e: 'props', d: [
      { entityType: 'OrderVersion', eventType: 'Created', entity: v44 },
      { entityType: 'Order', eventType: 'Created', entity: raw44 },
      { entityType: 'Fill', eventType: 'Created', entity: fill90 },
    ] }])}`);
    await flush();
    gap = false;
    (releasePositions as unknown as () => void)?.();
    for (let i = 0; i < 10; i += 1) await flush();
    const seq = events.filter(e => e.type !== 'heartbeat').map(e => e.type === 'connection' ? `connection:${(e as any).resynced ? 'resynced' : 'plain'}` : `${e.type}:${(e as any).order?.brokerOrderId ?? (e as any).fill?.fillId ?? ''}`);
    const resync = events.find(e => e.type === 'connection' && (e as any).resynced) as any;
    log('PL', JSON.stringify({ heldAtSnapshot, seq, gapFills: resync?.resync?.gapFills?.map((f: any) => f.fillId) ?? null }));
    unsubscribe();
    expect(seq.filter(x => x === 'fill:90')).toHaveLength(1);
  });

  it('PM: order bez OrderVersion v /order/list -> planovana obmena selze na realny vypadek?', async () => {
    const sockets: any[] = [];
    const calls: string[] = [];
    let gap = false;
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpecsByAccountId: { 100: 'L1' },
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/order/list')) return response(gap ? [
          { id: 45, accountId: 100, contractId: 7, action: 'Buy', ordStatus: 'Canceled' },
          { id: 46, accountId: 999, contractId: 7, action: 'Buy', ordStatus: 'Working' },
        ] : []);
        if (url.includes('/contract/items')) return response([{ id: 7, name: 'MNQU6' }]);
        return response([]);
      }) as unknown as typeof fetch,
      webSocketFactory: () => { const s = fakeSocket(); sockets.push(s); return s; },
      reconnectDelayMs: 1, reconnectJitterRatio: 0, renewalDeadlineMs: 60,
    } as any);
    const events: BrokerEvent[] = [];
    const unsubscribe = broker.subscribe(event => events.push(event));
    await handshake(sockets[0], [{ entityType: 'Contract', entity: { id: 7, name: 'MNQU6' } }]);
    events.length = 0;
    gap = true;
    expect(broker.renewSocket()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    await handshake(sockets[1], []);
    await new Promise(resolve => setTimeout(resolve, 120));
    const seq = events.filter(e => e.type !== 'heartbeat').map(e => e.type === 'connection' ? `connection:${(e as any).connected}:${(e as any).resynced ? 'resynced' : ''}` : e.type === 'error' ? `error:${String((e as any).error?.message).slice(0, 70)}` : e.type);
    log('PM', JSON.stringify({ sockets: sockets.length, seq }));
    unsubscribe();
    expect(seq).not.toContain('connection:false:');
    expect(seq).toContain('connection:true:resynced');
    expect(seq.some(item => item.startsWith('error:'))).toBe(false);
    expect(sockets).toHaveLength(2);
    expect(calls.some(url => url.includes('/account/list'))).toBe(false);
  });

  it('PM2: otevreny order route bez potvrzeneho tvaru vrati neautoritativni resync bez reconnect smycky', async () => {
    const sockets: any[] = [];
    let gap = false;
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpecsByAccountId: { 100: 'L1' },
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        if (url.includes('/order/list')) return response(gap ? [
          { id: 47, accountId: 100, contractId: 7, action: 'Sell', ordStatus: 'Working' },
        ] : []);
        if (url.includes('/contract/items')) return response([{ id: 7, name: 'MNQU6' }]);
        return response([]);
      }) as unknown as typeof fetch,
      webSocketFactory: () => { const s = fakeSocket(); sockets.push(s); return s; },
      reconnectDelayMs: 1, reconnectJitterRatio: 0, renewalDeadlineMs: 100,
    } as any);
    const events: BrokerEvent[] = [];
    const unsubscribe = broker.subscribe(event => events.push(event));
    await handshake(sockets[0], [{ entityType: 'Contract', entity: { id: 7, name: 'MNQU6' } }]);
    events.length = 0;
    gap = true;
    expect(broker.renewSocket()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    await handshake(sockets[1], []);
    await new Promise(resolve => setTimeout(resolve, 20));
    const resync = events.find(event => event.type === 'connection' && event.resynced);
    expect(resync).toMatchObject({
      type: 'connection', connected: true, resynced: true,
      resync: { complete: false, failureReason: expect.stringContaining('orderu 47') },
    });
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(sockets).toHaveLength(2);
    unsubscribe();
  });
});

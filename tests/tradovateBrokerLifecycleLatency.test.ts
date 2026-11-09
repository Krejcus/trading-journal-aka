import { describe, expect, it, vi } from 'vitest';
import type { TradovateRequestControlSnapshot } from '../lib/tradovateRequestControl';
import { tradovateRequestContext } from '../server/tradovateRequestContext';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';
import { createTradovateRequestGovernor } from '../services/tradovateRequestControlGovernor';

const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const flush = async () => { for (let index = 0; index < 12; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); };

class Socket implements WebSocketLike {
  readyState = 0; onopen: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null; onclose: (() => void) | null = null; sent: string[] = [];
  send(value: string) { this.sent.push(value); } close() { this.readyState = 3; this.onclose?.(); }
  deliver(value: unknown) { this.onmessage?.({ data: `a${JSON.stringify(value)}` }); }
}

function fixture() {
  let now = 1_000_000;
  const state: TradovateRequestControlSnapshot = { version: 1, brokerUserId: 77, serverNow: now, epoch: 0, blockedUntil: null, captchaRequired: false,
    evidence: null, reason: null, backgroundReservedHour: 0, backgroundReservedMinute: 0, policyVersion: 2, riskReservedHour: 0, riskReservedMinute: 0,
    controlReservedHour: 0, controlReservedMinute: 0, totalReservedHour: 0 };
  const remote = {
    read: vi.fn(async () => ({ ...state, serverNow: now })),
    reserve: vi.fn(async (input: { grantId: string; purpose: 'background' | 'risk' | 'entry' | 'management' | 'control'; units: number; ttlMs: number }) => ({ version: 1 as const,
      brokerUserId: 77, grantId: input.grantId, purpose: input.purpose, units: input.units, serverNow: now, validUntil: now + input.ttlMs, epoch: state.epoch })),
    penalize: vi.fn(async () => state),
  };
  const governor = createTradovateRequestGovernor({ brokerUserId: 77, remote, store: { load: async () => null, save: async () => undefined },
    clock: () => now, monotonic: () => now, wait: async ms => { now += ms; await Promise.resolve(); } });
  return { governor, remote, clock: () => now, advance: (ms: number) => { now += ms; } };
}

async function connected(options: { accepted: boolean; coverage?: boolean; wire: (path: string, init?: RequestInit) => unknown }) {
  const f = fixture(); await f.governor.initialize();
  const socket = new Socket();
  const paths: string[] = [];
  const broker = createTradovateBroker({
    environment: 'demo', connectionId: 'own', accessToken: 'token', accountSpecsByAccountId: { 101: 'DEMO' }, requestControl: f.governor,
    requestPurpose: tradovateRequestContext.current, runWithRecoveryRequests: tradovateRequestContext.recovery,
    ...(options.accepted ? { runWithAcceptedRequests: tradovateRequestContext.accepted, runWithLifecycleReads: tradovateRequestContext.lifecycleRead } : {}),
    fetchImpl: async (input, init) => { const path = new URL(String(input)).pathname; paths.push(path); return response(options.wire(path, init)); },
    clock: f.clock, webSocketFactory: () => socket, displayCoverageRebaseline: options.coverage === true,
  });
  const events: unknown[] = [];
  const unsubscribe = broker.subscribe(event => { events.push(event); });
  socket.readyState = 1; socket.onopen?.(); socket.onmessage?.({ data: 'o' }); await flush();
  socket.deliver([{ i: 0, s: 200, d: {} }]); await flush();
  socket.deliver([{ i: 1, s: 200, d: [] }]); await flush();
  expect(broker.usage().phase).toBe('connected');
  return { f, socket, broker, paths, events, unsubscribe };
}

const props = (entityType: string, entity: Record<string, unknown>, eventType = 'Updated') => ({ e: 'props', d: { entityType, eventType, entity } });

describe('lifecycle latency: liquidation contract from the live stream', () => {
  it('uses the synced stream position and skips the pre-write /position/list', async () => {
    const t = await connected({ accepted: true, wire: path => {
      if (path.endsWith('/order/liquidateposition')) return { orderId: 991 };
      if (path.endsWith('/contract/items')) return [{ id: 77, name: 'MNQZ6' }];
      return [];
    } });
    t.socket.deliver([props('contract', { id: 77, name: 'MNQZ6' }), props('position', { id: 5, accountId: 101, contractId: 77, netPos: 1, netPrice: 28000 })]);
    await flush();
    t.paths.length = 0;
    await expect(t.broker.liquidatePosition!({ tag: 'mclose1', accountId: 101, symbol: 'MNQZ6' })).resolves.toEqual({ status: 'submitted', brokerOrderId: '991' });
    expect(t.paths.filter(path => path.endsWith('/position/list'))).toEqual([]);
    expect(t.paths.filter(path => path.endsWith('/order/liquidateposition'))).toHaveLength(1);
    t.unsubscribe();
  });

  it('falls back to the fresh REST read (and its already-flat no-op) when the stream shows no position', async () => {
    const t = await connected({ accepted: true, wire: () => [] });
    t.socket.deliver([props('contract', { id: 77, name: 'MNQZ6' }), props('position', { id: 5, accountId: 101, contractId: 77, netPos: 0, netPrice: 28000 })]);
    await flush();
    t.paths.length = 0;
    await expect(t.broker.liquidatePosition!({ tag: 'mclose2', accountId: 101, symbol: 'MNQZ6' })).resolves.toEqual({ status: 'already-flat' });
    expect(t.paths.filter(path => path.endsWith('/position/list'))).toHaveLength(1);
    expect(t.paths.some(path => path.endsWith('/order/liquidateposition'))).toBe(false);
    t.unsubscribe();
  });

  it('a position frame still waiting in the semantic queue never selects the target: REST decides', async () => {
    let releaseVersion: (() => void) | null = null;
    const t = await connected({ accepted: true, wire: path => {
      if (path.endsWith('/orderVersion/deps')) return new Promise(resolve => { releaseVersion = () => resolve([{ id: 9000, orderId: 500, orderQty: 1, orderType: 'Market' }]); });
      return [];
    } });
    t.socket.deliver([props('contract', { id: 77, name: 'MNQZ6' }), props('position', { id: 5, accountId: 101, contractId: 77, netPos: 1 })]);
    await flush();
    // SL se vyplnil: rámec s příkazem čeká na dotažení verze, flat pozice stojí ve frontě za ním.
    t.socket.deliver([props('order', { id: 500, accountId: 101, contractId: 77, ordStatus: 'Filled', action: 'Sell', timestamp: '2026-11-09T20:00:00Z' }, 'Created')]);
    t.socket.deliver([props('position', { id: 5, accountId: 101, contractId: 77, netPos: 0 })]);
    await flush();
    t.paths.length = 0;
    await expect(t.broker.liquidatePosition!({ tag: 'mclose4', accountId: 101, symbol: 'MNQZ6' })).resolves.toEqual({ status: 'already-flat' });
    expect(t.paths.filter(path => path.endsWith('/position/list'))).toHaveLength(1);
    expect(t.paths.some(path => path.endsWith('/order/liquidateposition'))).toBe(false);
    releaseVersion?.(); await flush();
    t.unsubscribe();
  });

  it('without a synced live socket the contract always comes from the fresh REST read', async () => {
    const paths: string[] = [];
    const broker = createTradovateBroker({ environment: 'demo', accessToken: 'token', accountSpecsByAccountId: { 101: 'DEMO' },
      fetchImpl: async input => { const path = new URL(String(input)).pathname; paths.push(path);
        return response(path.endsWith('/position/list') ? [{ accountId: 101, contractId: 77, netPos: 1 }] : path.endsWith('/contract/items') ? [{ id: 77, name: 'MNQZ6' }] : { orderId: 5 }); },
      webSocketFactory: () => { throw new Error('WebSocket is not used'); } });
    await expect(broker.liquidatePosition!({ tag: 'mclose5', accountId: 101, symbol: 'MNQZ6' })).resolves.toEqual({ status: 'submitted', brokerOrderId: '5' });
    expect(paths.filter(path => path.endsWith('/position/list'))).toHaveLength(1);
  });

  it('a stale non-zero stream position on a flat account yields a state-verified outcome, never a retry', async () => {
    // Broker odmítne likvidaci flat účtu (4xx) → `rejected`; volající dál ověřuje stavem (INV-MODE-02).
    const t = await connected({ accepted: true, wire: () => [] });
    t.socket.deliver([props('contract', { id: 77, name: 'MNQZ6' }), props('position', { id: 5, accountId: 101, contractId: 77, netPos: 1 })]);
    await flush();
    const posts: string[] = [];
    const original = t.broker.liquidatePosition!;
    t.paths.length = 0;
    const outcome = await original({ tag: 'mclose6', accountId: 101, symbol: 'MNQZ6' });
    posts.push(...t.paths.filter(path => path.endsWith('/order/liquidateposition')));
    expect(posts).toHaveLength(1);
    expect(['submitted', 'rejected', 'indeterminate']).toContain(outcome.status);
    t.unsubscribe();
  });

  it('a stream position of another account or contract never selects the liquidation target', async () => {
    const t = await connected({ accepted: true, wire: () => [] });
    t.socket.deliver([props('contract', { id: 77, name: 'MNQZ6' }), props('contract', { id: 78, name: 'NQZ6' }),
      props('position', { id: 5, accountId: 202, contractId: 77, netPos: 1 }), props('position', { id: 6, accountId: 101, contractId: 78, netPos: 1 })]);
    await flush();
    t.paths.length = 0;
    await expect(t.broker.liquidatePosition!({ tag: 'mclose3', accountId: 101, symbol: 'MNQZ6' })).resolves.toEqual({ status: 'already-flat' });
    expect(t.paths.some(path => path.endsWith('/order/liquidateposition'))).toBe(false);
    t.unsubscribe();
  });
});

describe('lifecycle latency: OrderVersion hydration lane', () => {
  const versionWire = (path: string) => (path.endsWith('/orderVersion/deps') ? [{ id: 9000, orderId: 500, orderQty: 1, orderType: 'Market' }] : []);
  const orderFrame = (orderId: number) => [props('order', { id: orderId, accountId: 101, contractId: 77, ordStatus: 'Working', action: 'Buy', timestamp: '2026-11-09T20:00:00Z' }, 'Created')];

  it('hydrates a stream order without a remote reservation when the accepted scope exists', async () => {
    const t = await connected({ accepted: true, wire: versionWire });
    const before = t.f.remote.reserve.mock.calls.length;
    t.paths.length = 0;
    t.socket.deliver(orderFrame(500)); await flush();
    expect(t.paths.filter(path => path.endsWith('/orderVersion/deps'))).toHaveLength(1);
    expect(t.f.remote.reserve.mock.calls.length).toBe(before);
    t.unsubscribe();
  });

  it('the accepted class ends with the hydration read: a timer started inside it is background again', async () => {
    let insideRead: string | undefined; let lateTimer: string | undefined = 'unset';
    const t = await connected({ accepted: true, wire: path => {
      if (path.endsWith('/orderVersion/deps')) {
        insideRead = tradovateRequestContext.current();
        setTimeout(() => { lateTimer = tradovateRequestContext.current(); }, 5);
      }
      return versionWire(path);
    } });
    t.socket.deliver(orderFrame(500)); await flush();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(insideRead).toBe('management');
    expect(lateTimer).toBeUndefined();
    expect(tradovateRequestContext.current()).toBeUndefined();
    t.unsubscribe();
  });

  it('keeps the bounded recovery reservation when no accepted scope is configured', async () => {
    const t = await connected({ accepted: false, wire: versionWire });
    const before = t.f.remote.reserve.mock.calls.length;
    t.socket.deliver(orderFrame(500)); await flush();
    const added = t.f.remote.reserve.mock.calls.slice(before).map(([input]) => input.purpose);
    expect(added).toEqual(['control']);
    t.unsubscribe();
  });

  it('returns to the reserved recovery lane once the local per-minute allowance is used', async () => {
    // (90/min, 900/h)
    const t = await connected({ accepted: true, wire: versionWire });
    const before = t.f.remote.reserve.mock.calls.length;
    for (let index = 0; index < 90; index += 1) { t.socket.deliver(orderFrame(1000 + index)); await flush(); }
    expect(t.f.remote.reserve.mock.calls.length).toBe(before);
    t.socket.deliver(orderFrame(2000)); await flush();
    expect(t.f.remote.reserve.mock.calls.slice(before).map(([input]) => input.purpose)).toEqual(['control']);
    t.f.advance(60_001);
    await t.f.governor.sync();
    t.socket.deliver(orderFrame(3000)); await flush();
    expect(t.f.remote.reserve.mock.calls.slice(before)).toHaveLength(1);
    t.unsubscribe();
  });

  it('applies the hourly allowance independently of the per-minute one', async () => {
    const t = await connected({ accepted: true, wire: versionWire });
    const before = t.f.remote.reserve.mock.calls.length;
    for (let minute = 0; minute < 10; minute += 1) {
      for (let index = 0; index < 90; index += 1) { t.socket.deliver(orderFrame(10_000 + minute * 100 + index)); await flush(); }
      t.f.advance(60_001); await t.f.governor.sync();
      // Tichý socket by po minutě vypadal mrtvý; heartbeat drží spojení živé.
      t.socket.onmessage?.({ data: 'h' }); await flush();
    }
    expect(t.f.remote.reserve.mock.calls.length).toBe(before);
    t.socket.deliver(orderFrame(99_000)); await flush();
    expect(t.f.remote.reserve.mock.calls.slice(before).map(([input]) => input.purpose)).toEqual(['control']);
    t.unsubscribe();
  }, 90_000);

  it('a broker cooldown stops the accepted-class hydration before dispatch', async () => {
    const t = await connected({ accepted: true, wire: versionWire });
    await t.f.governor.penalize({ evidence: 'p-time', retryAfterMs: 60_000, reason: 'penalty' });
    t.paths.length = 0;
    t.socket.deliver(orderFrame(500)); await flush();
    expect(t.paths.filter(path => path.endsWith('/orderVersion/deps'))).toEqual([]);
    t.unsubscribe();
  });
});

describe('display coverage re-baseline after trade ingress', () => {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const listWire = (path: string) => (path.endsWith('/contract/items') ? [{ id: 77, name: 'MNQZ6' }] : []);
  const positionReads = (paths: string[]) => paths.filter(path => path.endsWith('/position/list')).length;

  it('earns the proof on its own while flat, never reads while a position is open, and keeps the minimum gap', async () => {
    const t = await connected({ accepted: true, coverage: true, wire: listWire });
    const reservedBefore = t.f.remote.reserve.mock.calls.length;
    expect(t.broker.streamCoverage?.(101)).toBeNull();
    await wait(3_300);
    expect(t.broker.streamCoverage?.(101)).toMatchObject({ synchronized: true, gap: false, backlog: false });
    expect(positionReads(t.paths)).toBe(1);
    // Všechna čtení obnovy jdou běžnou background třídou, nikdy recovery.
    expect(t.f.remote.reserve.mock.calls.slice(reservedBefore).map(([input]) => input.purpose).filter(purpose => purpose !== 'background')).toEqual([]);

    // Otevřená pozice: doklad zmizí (INV-TRAD-09) a adaptér nečte — správa obchodu má přednost.
    t.f.advance(30_001); await t.f.governor.sync();
    t.socket.deliver([props('contract', { id: 77, name: 'MNQZ6' }), props('position', { id: 5, accountId: 101, contractId: 77, netPos: 1 })]);
    await flush();
    expect(t.broker.streamCoverage?.(101)).toBeNull();
    await wait(3_300);
    expect(positionReads(t.paths)).toBe(1);

    // Pozice zavřená: po klidu se baseline obnoví sama.
    t.f.advance(30_001); await t.f.governor.sync();
    t.socket.deliver([props('position', { id: 5, accountId: 101, contractId: 77, netPos: 0 })]); await flush();
    await wait(3_300);
    expect(positionReads(t.paths)).toBe(2);
    expect(t.broker.streamCoverage?.(101)).not.toBeNull();

    // Další rámec dřív než za 30 s: žádné čtení navíc.
    t.socket.deliver([props('position', { id: 5, accountId: 101, contractId: 77, netPos: 0 })]); await flush();
    await wait(3_300);
    expect(positionReads(t.paths)).toBe(2);
    t.unsubscribe();
  }, 30_000);

  it('a refused background read is not retried through another class', async () => {
    const t = await connected({ accepted: true, coverage: true, wire: listWire });
    const reservedBefore = t.f.remote.reserve.mock.calls.length;
    t.f.remote.reserve.mockImplementation(async () => { throw new Error('remote budget'); });
    await wait(3_300);
    expect(positionReads(t.paths)).toBe(0);
    expect(t.broker.streamCoverage?.(101)).toBeNull();
    expect(t.f.remote.reserve.mock.calls.slice(reservedBefore).every(([input]) => input.purpose === 'background')).toBe(true);
    t.unsubscribe();
  }, 15_000);

  it('does nothing unless enabled', async () => {
    const t = await connected({ accepted: true, wire: listWire });
    await wait(3_300);
    expect(positionReads(t.paths)).toBe(0);
    expect(t.broker.streamCoverage?.(101)).toBeNull();
    t.unsubscribe();
  }, 10_000);
});

describe('OrderVersion read primed at the write ACK', () => {
  const order = { accountId: 101, tag: 'own-entry', symbol: 'MNQZ6', quantity: 1, side: 'Buy' as const, orderType: 'Market' as const };
  const frame = (orderId: number) => [props('order', { id: orderId, accountId: 101, contractId: 77, ordStatus: 'Working', action: 'Buy', timestamp: '2026-11-09T20:00:00Z' }, 'Created')];
  const versionReads = (paths: string[]) => paths.filter(path => path.endsWith('/orderVersion/deps')).length;

  it('starts the read at the ACK and the first Order frame reuses it instead of reading again', async () => {
    const t = await connected({ accepted: true, wire: path => {
      if (path.endsWith('/order/placeorder')) return { orderId: 900 };
      if (path.endsWith('/orderVersion/deps')) return [{ id: 9900, orderId: 900, orderQty: 1, orderType: 'Market' }];
      if (path.endsWith('/contract/find') || path.endsWith('/contract/items')) return [{ id: 77, name: 'MNQZ6' }];
      return [];
    } });
    t.socket.deliver([props('contract', { id: 77, name: 'MNQZ6' })]); await flush();
    t.paths.length = 0;
    await t.broker.runWithAcceptedRequests!(() => t.broker.placeOrder(order));
    await flush();
    expect(versionReads(t.paths)).toBe(1);
    t.socket.deliver(frame(900)); await flush();
    expect(versionReads(t.paths)).toBe(1);
    // Předčtení je jednorázové: jiný nový příkaz si verzi čte sám jako dřív.
    t.socket.deliver(frame(950)); await flush();
    expect(versionReads(t.paths)).toBe(2);
    t.unsubscribe();
  });

  it('a failed primed read is discarded and the frame reads the version itself', async () => {
    let reads = 0;
    const t = await connected({ accepted: true, wire: path => {
      if (path.endsWith('/order/placeorder')) return { orderId: 901 };
      if (path.endsWith('/orderVersion/deps')) { reads += 1; if (reads === 1) throw new Error('first read failed'); return [{ id: 9901, orderId: 901, orderQty: 1, orderType: 'Market' }]; }
      return [];
    } });
    t.socket.deliver([props('contract', { id: 77, name: 'MNQZ6' })]); await flush();
    await t.broker.runWithAcceptedRequests!(() => t.broker.placeOrder(order));
    await flush();
    expect(reads).toBe(1);
    t.socket.deliver(frame(901)); await flush();
    expect(reads).toBe(2);
    expect(t.socket.readyState).toBe(1);
    t.unsubscribe();
  });

  it('an empty primed list (read raced the broker commit) is not a result: the frame reads again', async () => {
    let reads = 0;
    const t = await connected({ accepted: true, wire: path => {
      if (path.endsWith('/order/placeorder')) return { orderId: 903 };
      if (path.endsWith('/orderVersion/deps')) { reads += 1; return reads === 1 ? [] : [{ id: 9903, orderId: 903, orderQty: 1, orderType: 'Market' }]; }
      return [];
    } });
    await t.broker.runWithAcceptedRequests!(() => t.broker.placeOrder(order));
    await flush();
    expect(reads).toBe(1);
    t.socket.deliver(frame(903)); await flush();
    expect(reads).toBe(2);
    t.unsubscribe();
  });

  it('without the expiring lifecycle class nothing is primed (no read outside the budget lanes)', async () => {
    const t = await connected({ accepted: false, wire: path => (path.endsWith('/order/placeorder') ? { orderId: 904 } : []) });
    t.paths.length = 0;
    await t.broker.placeOrder(order);
    await flush();
    expect(versionReads(t.paths)).toBe(0);
    t.unsubscribe();
  });

  it('when the stream beats the HTTP response the frame read is the only read', async () => {
    let releasePost: (() => void) | null = null;
    const holder: { socket?: Socket } = {};
    const t = await connected({ accepted: true, wire: path => {
      if (path.endsWith('/order/placeorder')) return new Promise(resolve => { releasePost = () => resolve({ orderId: 905 }); });
      if (path.endsWith('/orderVersion/deps')) return [{ id: 9905, orderId: 905, orderQty: 1, orderType: 'Market' }];
      return [];
    } });
    holder.socket = t.socket;
    t.paths.length = 0;
    const placing = t.broker.runWithAcceptedRequests!(() => t.broker.placeOrder(order));
    await flush();
    t.socket.deliver(frame(905)); await flush();
    expect(versionReads(t.paths)).toBe(1);
    releasePost!(); await placing; await flush();
    expect(versionReads(t.paths)).toBe(1);
    t.unsubscribe();
  });

  it('nothing is primed without a synced live socket', async () => {
    const paths: string[] = [];
    const broker = createTradovateBroker({ environment: 'demo', accessToken: 'token', accountSpecsByAccountId: { 101: 'DEMO' }, accountSpec: 'DEMO',
      fetchImpl: async input => { const path = new URL(String(input)).pathname; paths.push(path); return response(path.endsWith('/order/placeorder') ? { orderId: 902 } : []); },
      webSocketFactory: () => { throw new Error('WebSocket is not used'); } });
    await broker.placeOrder(order);
    await flush();
    expect(versionReads(paths)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { sanitizeTradovateApiHosts, tradovateReportingBaseUrl, tradovateRestBaseUrl, tradovateWebSocketUrl } from '../lib/tradovateApiHosts';
import { createTradovateBroker } from '../services/tradovateBroker';

// Skutečné hosty Lucidu ze sondy 7. 11. 2026.
const LUCID = {
  live: 'live.tradovateapi.com', demo: 'demo-api.lucid.ninjatrader.com', mdDemo: 'md-demo-api.lucid.ninjatrader.com',
  reportingDemo: 'rpt-demo-api.lucid.ninjatrader.com', userContext: 'user-context-api.ninjatrader.com',
};

describe('dynamické hosty Tradovate', () => {
  it('bere jen povolené hostname a cizí zahodí', () => {
    expect(sanitizeTradovateApiHosts({ ...LUCID, evil: 'attacker.example.com', bad: 'demo.tradovateapi.com/x', spoof: 'tradovateapi.com.evil.io' }))
      .toEqual(LUCID);
    expect(sanitizeTradovateApiHosts({ evil: 'attacker.example.com' })).toBeNull();
    expect(sanitizeTradovateApiHosts(null)).toBeNull();
    expect(sanitizeTradovateApiHosts('demo.tradovateapi.com')).toBeNull();
  });
  it('staví URL z hostů organizace, bez nich z výchozích', () => {
    const hosts = sanitizeTradovateApiHosts(LUCID);
    expect(tradovateRestBaseUrl('demo', hosts)).toBe('https://demo-api.lucid.ninjatrader.com/v1');
    expect(tradovateWebSocketUrl('demo', hosts)).toBe('wss://demo-api.lucid.ninjatrader.com/v1/websocket');
    expect(tradovateReportingBaseUrl('demo', hosts)).toBe('https://rpt-demo-api.lucid.ninjatrader.com/v1');
    expect(tradovateRestBaseUrl('demo', null)).toBe('https://demo.tradovateapi.com/v1');
    expect(tradovateWebSocketUrl('demo')).toBe('wss://demo.tradovateapi.com/v1/websocket');
  });
  it('broker otevře WebSocket na hostu organizace a host čte při každém připojení', () => {
    const urls: string[] = [];
    let hosts: Record<string, string> | null = LUCID;
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO1',
      resolveApiHosts: () => sanitizeTradovateApiHosts(hosts),
      webSocketFactory: url => { urls.push(url); throw new Error('test-stop'); },
      fetchImpl: (async () => new Response('[]')) as typeof fetch,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    unsubscribe();
    hosts = null;
    const second = broker.subscribe(() => undefined);
    second();
    expect(urls[0]).toBe('wss://demo-api.lucid.ninjatrader.com/v1/websocket');
    expect(urls.at(-1)).toBe('wss://demo.tradovateapi.com/v1/websocket');
  });
});

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closeCalls = 0;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(data); }
  close() { this.closeCalls += 1; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
}
const flush = async () => { for (let index = 0; index < 40; index += 1) await Promise.resolve(); };

describe('dynamické hosty: bezpečnost a oddělení připojení', () => {
  it('demo klíč nesmí mířit na live host a naopak', () => {
    expect(sanitizeTradovateApiHosts({ demo: 'live.tradovateapi.com', reportingDemo: 'rpt-live.tradovateapi.com', mdDemo: 'md.tradovateapi.com' })).toBeNull();
    expect(sanitizeTradovateApiHosts({ live: 'demo-api.lucid.ninjatrader.com' })).toBeNull();
    expect(sanitizeTradovateApiHosts({ demo: 'demo-api.lucid.ninjatrader.com', live: 'live.tradovateapi.com', mdLive: 'md.tradovateapi.com' }))
      .toEqual({ demo: 'demo-api.lucid.ninjatrader.com', live: 'live.tradovateapi.com', mdLive: 'md.tradovateapi.com' });
  });
  it('výměna tokenu přesměrování nenásleduje (client_secret by odešel s POST)', async () => {
    const { exchangeTradovateAuthorizationCode } = await import('../server/tradovateOAuth');
    const inits: RequestInit[] = [];
    await exchangeTradovateAuthorizationCode({
      code: 'c', clientId: 'id', clientSecret: 's', redirectUri: 'https://x/cb', environment: 'demo',
      fetchImpl: (async (_url: string, init: RequestInit) => { inits.push(init); return Response.json({ access_token: 't', expires_in: 4800, apiHosts: LUCID }); }) as unknown as typeof fetch,
    }).then(token => expect(token.apiHosts?.demo).toBe('demo-api.lucid.ninjatrader.com'));
    expect(inits[0].redirect).toBe('error');
  });
  it('REST přesměrování je chyba přenosu, ne „příkaz neexistuje“', async () => {
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO1',
      fetchImpl: (async () => new Response(null, { status: 307, headers: { location: 'https://demo-api.lucid.ninjatrader.com/v1/order/item' } })) as unknown as typeof fetch,
    });
    await expect(broker.findOrderById(1, '42')).rejects.toThrow();
  });
  it('dvě připojení: každý broker a jeho REST jedou jen na svém hostu', async () => {
    const calls: Array<{ url: string; token: string }> = [];
    const fetchFor = (async (url: string, init: RequestInit) => {
      calls.push({ url, token: String((init.headers as Record<string, string>).Authorization) });
      return Response.json([]);
    }) as unknown as typeof fetch;
    const lucid = createTradovateBroker({ environment: 'demo', accessToken: 'lucid-token', accountSpec: 'L1', resolveApiHosts: () => sanitizeTradovateApiHosts(LUCID), fetchImpl: fetchFor });
    const tradeify = createTradovateBroker({ environment: 'demo', accessToken: 'tradeify-token', accountSpec: 'T1', fetchImpl: fetchFor });
    await lucid.findOrderById(1, '1').catch(() => undefined);
    await tradeify.findOrderById(2, '2').catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      if (call.token.includes('lucid')) expect(call.url).toMatch(/^https:\/\/demo-api\.lucid\.ninjatrader\.com\//);
      else expect(call.url).toMatch(/^https:\/\/demo\.tradovateapi\.com\//);
    }
  });
  it('změna hostů během autorizace: token nového lease nejde na starý host', async () => {
    const sockets: FakeSocket[] = [];
    let hosts: Record<string, string> = LUCID;
    const broker = createTradovateBroker({
      environment: 'demo', accountSpec: 'L1',
      resolveApiHosts: () => sanitizeTradovateApiHosts(hosts),
      getAccessToken: async () => { hosts = { demo: 'demo-api.other.ninjatrader.com' }; return 'new-lease-token'; },
      webSocketFactory: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
      fetchImpl: (async () => Response.json([])) as unknown as typeof fetch,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    sockets[0].open();
    sockets[0].onmessage?.({ data: 'o' });
    await flush();
    expect(sockets[0].url).toBe('wss://demo-api.lucid.ninjatrader.com/v1/websocket');
    expect(sockets[0].sent.some(message => message.includes('new-lease-token'))).toBe(false);
    expect(sockets[0].closeCalls).toBe(1);
    unsubscribe();
  });
});

describe('dynamické hosty: plánovaná obnova', () => {
  const handshake = async (socket: FakeSocket) => {
    socket.open();
    socket.onmessage?.({ data: 'o' });
    await flush();
    socket.onmessage?.({ data: `a${JSON.stringify([{ i: 0, s: 200, d: {} }])}` });
    await flush();
    socket.onmessage?.({ data: `a${JSON.stringify([{ i: 1, s: 200, d: [] }])}` });
    await flush();
  };
  const setup = (hostsRef: { value: Record<string, string> }) => {
    const sockets: FakeSocket[] = [];
    const events: Array<{ type: string; connected?: boolean }> = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'L1',
      resolveApiHosts: () => sanitizeTradovateApiHosts(hostsRef.value),
      webSocketFactory: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
      fetchImpl: (async () => Response.json([])) as unknown as typeof fetch,
    });
    const unsubscribe = broker.subscribe(event => events.push(event as { type: string; connected?: boolean }));
    return { broker, sockets, events, unsubscribe };
  };
  it('změna hostu při obnově je poctivý výpadek a nový socket jde na nový host', async () => {
    const hosts = { value: LUCID as Record<string, string> };
    const { broker, sockets, events, unsubscribe } = setup(hosts);
    await handshake(sockets[0]);
    events.length = 0;
    hosts.value = { demo: 'demo-api.other.ninjatrader.com' };
    expect(broker.renewSocket()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    await flush();
    expect(sockets.at(-1)?.url).toBe('wss://demo-api.other.ninjatrader.com/v1/websocket');
    expect(events.some(event => event.type === 'connection' && event.connected === false)).toBe(true);
    unsubscribe();
  });
  it('obnova bez změny hostu zůstane tichá', async () => {
    const hosts = { value: LUCID as Record<string, string> };
    const { broker, sockets, events, unsubscribe } = setup(hosts);
    await handshake(sockets[0]);
    events.length = 0;
    expect(broker.renewSocket()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    await flush();
    expect(sockets.at(-1)?.url).toBe('wss://demo-api.lucid.ninjatrader.com/v1/websocket');
    expect(events.some(event => event.type === 'connection' && event.connected === false)).toBe(false);
    unsubscribe();
  });
});

describe('dynamické hosty: REST po obnově tokenu se změnou hostu', () => {
  it('nový token nejde na starý host; živá session se zavře a nic se neodešle', async () => {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    let hosts: Record<string, string> = LUCID;
    let tokens = 0;
    const broker = createTradovateBroker({
      environment: 'demo', accountSpec: 'L1',
      resolveApiHosts: () => sanitizeTradovateApiHosts(hosts),
      getAccessToken: async () => { tokens += 1; return `token-${tokens}`; },
      webSocketFactory: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
      fetchImpl: (async (url: string) => { urls.push(url); return Response.json([]); }) as unknown as typeof fetch,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    sockets[0].open();
    sockets[0].onmessage?.({ data: 'o' });
    await flush();
    sockets[0].onmessage?.({ data: `a${JSON.stringify([{ i: 0, s: 200, d: {} }])}` });
    await flush();
    sockets[0].onmessage?.({ data: `a${JSON.stringify([{ i: 1, s: 200, d: [] }])}` });
    await flush();
    urls.length = 0;
    hosts = { demo: 'demo-api.other.ninjatrader.com' };
    await expect(broker.findOrderById(1, '42')).rejects.toThrow(/host changed/);
    // Nic s novým tokenem na starý host; souběžná čtení po zavření session už jdou na nový host.
    expect(urls.filter(url => url.includes('demo-api.lucid'))).toEqual([]);
    expect(sockets[0].closeCalls).toBeGreaterThan(0);
    unsubscribe();
  });
});

describe('dynamické hosty: nevyřízený WS zápis', () => {
  it('změna hostu v REST nezavře socket s čekajícím zápisem a zápis nezamítne', async () => {
    const sockets: FakeSocket[] = [];
    let hosts: Record<string, string> = LUCID;
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO8661118', preferWebSocketOrderWrites: true,
      resolveApiHosts: () => sanitizeTradovateApiHosts(hosts),
      webSocketFactory: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
      fetchImpl: (async () => Response.json([])) as unknown as typeof fetch,
    });
    const unsubscribe = broker.subscribe(() => undefined);
    sockets[0].open();
    sockets[0].onmessage?.({ data: 'o' });
    await flush();
    sockets[0].onmessage?.({ data: `a${JSON.stringify([{ i: 0, s: 200, d: {} }])}` });
    await flush();
    sockets[0].onmessage?.({ data: `a${JSON.stringify([{ i: 1, s: 200, d: [] }])}` });
    await flush();
    let settled = false;
    const write = broker.placeOrder({ tag: 'ws-1', accountId: 200, symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Market' })
      .then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(sockets[0].sent.some(message => message.startsWith('order/placeorder'))).toBe(true);
    hosts = { demo: 'demo-api.other.ninjatrader.com' };
    await expect(broker.findOrderById(1, '42')).rejects.toThrow(/host changed/);
    await flush();
    expect(sockets[0].closeCalls).toBe(0);
    expect(settled).toBe(false);
    unsubscribe();
    void write;
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import {
  createTradovateBroker,
  type WebSocketLike,
} from '../services/tradovateBroker';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closeCalls = 0;

  constructor(private readonly emitClose: boolean) {}

  send(data: string) { this.sent.push(data); }

  close() {
    this.closeCalls += 1;
    this.readyState = 2;
    if (this.emitClose) {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(data: string) {
    this.onmessage?.({ data });
  }
}

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
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

const createHarness = (options: {
  socketFactory?: () => FakeSocket;
  getAccessToken?: () => Promise<string>;
  reconnectMaxDelayMs?: number;
} = {}) => {
  const sockets: FakeSocket[] = [];
  const diagnostics: string[] = [];
  const events: BrokerEvent[] = [];
  const factory = options.socketFactory ?? (() => new FakeSocket(true));
  const broker = createTradovateBroker({
    environment: 'demo',
    accountSpec: 'DEMO123',
    accessToken: options.getAccessToken ? undefined : 'token',
    getAccessToken: options.getAccessToken,
    fetchImpl: async () => Response.json([]),
    webSocketFactory: () => {
      const socket = factory();
      sockets.push(socket);
      return socket;
    },
    connectionLabel: 'conn:test',
    connectTimeoutMs: 10_000,
    closeTimeoutMs: 5_000,
    reconnectDelayMs: 1_000,
    reconnectMaxDelayMs: options.reconnectMaxDelayMs,
    reconnectJitterRatio: 0,
    disconnectedLogIntervalMs: 60_000,
    onReconnectDiagnostic: message => diagnostics.push(message),
  });
  const unsubscribe = broker.subscribe(event => events.push(event));
  return { broker, sockets, diagnostics, events, unsubscribe };
};

describe('Tradovate WebSocket konečný reconnect automat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T05:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('CONNECTING navždy watchdog zavře a po close watchdogu otevře druhý socket', async () => {
    const harness = createHarness({ socketFactory: () => new FakeSocket(false) });
    expect(harness.sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.sockets[0].closeCalls).toBe(1);
    expect(harness.diagnostics.some(line => line.includes('reason=connect-watchdog'))).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.sockets).toHaveLength(2);
    harness.sockets[1].open();
    expect(harness.sockets[1].readyState).toBe(1);
    harness.unsubscribe();
  });

  it('close bez onclose ručně uvolní stav a reconnectuje', async () => {
    const harness = createHarness({ socketFactory: () => new FakeSocket(false) });
    harness.sockets[0].open();
    harness.sockets[0].onerror?.();
    expect(harness.sockets[0].closeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.diagnostics.some(line => line.includes('WS CLOSE WATCHDOG'))).toBe(true);
    harness.unsubscribe();
  });

  it('opožděný onclose starého socketu nesmí shodit nového kandidáta', async () => {
    const harness = createHarness({ socketFactory: () => new FakeSocket(false) });
    const staleClose = harness.sockets[0].onclose as () => void;
    harness.sockets[0].onerror?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.sockets).toHaveLength(2);

    staleClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.sockets).toHaveLength(2);
    harness.unsubscribe();
  });

  it('synchronní výjimka factory vždy naplánuje další pokus', async () => {
    let attempts = 0;
    const sockets: FakeSocket[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO123',
      reconnectDelayMs: 1_000, reconnectJitterRatio: 0,
      webSocketFactory: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('factory exploded');
        const socket = new FakeSocket(true);
        sockets.push(socket);
        return socket;
      },
    });
    const unsubscribe = broker.subscribe(() => undefined);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    expect(sockets).toHaveLength(1);
    unsubscribe();
  });

  it('tři chyby tokenu v authorize použijí rostoucí backoff a čtvrtý pokus projde', async () => {
    let tokenAttempts = 0;
    const harness = createHarness({
      getAccessToken: async () => {
        tokenAttempts += 1;
        if (tokenAttempts <= 3) throw new Error(`token-${tokenAttempts}`);
        return 'token-ok';
      },
    });

    for (const delay of [1_000, 2_000, 4_000]) {
      const socket = harness.sockets.at(-1) as FakeSocket;
      socket.open();
      socket.deliver('o');
      await flush();
      await vi.advanceTimersByTimeAsync(delay);
    }
    const fourth = harness.sockets.at(-1) as FakeSocket;
    fourth.open();
    fourth.deliver('o');
    await flush();

    expect(tokenAttempts).toBe(4);
    expect(fourth.sent).toContain('authorize\n0\n\ntoken-ok');
    expect(harness.diagnostics.filter(line => line.includes('WS RECONNECT')).map(line => (
      Number(line.match(/nextAttemptIn=([\d.]+)s/)?.[1])
    ))).toEqual([1, 2, 4]);
    harness.unsubscribe();
  });

  it('backoff má strop, úspěšný sync jej resetuje a rate limit zůstává minimem', async () => {
    const harness = createHarness({ reconnectMaxDelayMs: 4_000 });
    for (const delay of [1_000, 2_000, 4_000, 4_000]) {
      harness.sockets.at(-1)?.onerror?.();
      await vi.advanceTimersByTimeAsync(delay);
    }
    const delays = harness.diagnostics.filter(line => line.includes('WS RECONNECT')).map(line => (
      Number(line.match(/nextAttemptIn=([\d.]+)s/)?.[1])
    ));
    expect(delays.slice(0, 4)).toEqual([1, 2, 4, 4]);

    const current = harness.sockets.at(-1) as FakeSocket;
    await completeHandshake(current);
    current.onerror?.();
    expect(harness.diagnostics.filter(line => line.includes('WS RECONNECT')).at(-1)).toContain('nextAttemptIn=1.000s');
    await vi.advanceTimersByTimeAsync(1_000);

    const rateLimited = harness.sockets.at(-1) as FakeSocket;
    rateLimited.open();
    rateLimited.deliver('a[{"i":9,"s":200,"d":{"p-ticket":"ticket","p-time":15,"p-message":"slow"}}]');
    await flush();
    expect(harness.diagnostics.filter(line => line.includes('WS RECONNECT')).at(-1)).toContain('nextAttemptIn=15.000s');
    harness.unsubscribe();
  });

  it('při dlouhém odpojení vypíše souhrn nejméně jednou za minutu', async () => {
    const diagnostics: string[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO123',
      webSocketFactory: () => { throw new Error('offline'); },
      reconnectDelayMs: 60_000,
      reconnectMaxDelayMs: 60_000,
      reconnectJitterRatio: 0,
      disconnectedLogIntervalMs: 60_000,
      onReconnectDiagnostic: message => diagnostics.push(message),
    });
    const unsubscribe = broker.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(diagnostics.filter(line => line.includes('WS DISCONNECTED')).length).toBeGreaterThanOrEqual(5);
    unsubscribe();
  });

  it('odhlášení posledního listeneru ukončí nekonečný retry i souhrnný log', async () => {
    let attempts = 0;
    const diagnostics: string[] = [];
    const broker = createTradovateBroker({
      environment: 'demo', accessToken: 'token', accountSpec: 'DEMO123',
      webSocketFactory: () => {
        attempts += 1;
        throw new Error('offline');
      },
      reconnectDelayMs: 1_000,
      reconnectJitterRatio: 0,
      onReconnectDiagnostic: message => diagnostics.push(message),
    });
    const unsubscribe = broker.subscribe(() => undefined);
    unsubscribe();
    const before = diagnostics.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(attempts).toBe(1);
    expect(diagnostics).toHaveLength(before);
  });
});

import { describe, expect, it } from 'vitest';
import { createTradovateBroker, type TradovateSessionSuspect } from '../services/tradovateBroker';

/** Socket, který se otevře, ale sync dokončí jen na povel (mrtvá session 18. 9. 2026). */
interface FakeSocket {
  onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null; onclose: (() => void) | null;
  readyState: number; send(data: string): void; close(): void; open(): void; deliver(data: string): void;
}
const createFakeSocket = (): FakeSocket => {
  const socket: FakeSocket = {
    onopen: null, onmessage: null, onerror: null, onclose: null, readyState: 0,
    send() {},
    close() { if (socket.readyState === 3) return; socket.readyState = 3; socket.onclose?.(); },
    open() { socket.readyState = 1; socket.onopen?.(); },
    deliver(data) { socket.onmessage?.({ data }); },
  };
  return socket;
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const completeHandshake = async (socket: FakeSocket) => {
  socket.deliver('o'); await flush();
  socket.deliver(`a${JSON.stringify([{ i: 0, s: 200 }])}`); await flush();
  socket.deliver(`a${JSON.stringify([{ i: 1, s: 200, d: [] }])}`); await flush(); await flush();
};

describe('podezření na mrtvou broker session', () => {
  it('počítá sync timeouty v řadě, hlásí je volajícímu a po dokončeném syncu počítá od nuly', async () => {
    const sockets: FakeSocket[] = [];
    const suspects: TradovateSessionSuspect[] = [];
    const broker = createTradovateBroker({
      environment: 'demo',
      accessToken: 'token',
      accountSpecsByAccountId: { 200: 'F1' },
      fetchImpl: (async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => [], text: async () => '[]' })) as unknown as typeof fetch,
      webSocketFactory: () => { const socket = createFakeSocket(); sockets.push(socket); return socket; },
      reconnectDelayMs: 1,
      reconnectMaxDelayMs: 1,
      reconnectJitterRatio: 0,
      syncTimeoutMs: 15,
      connectionLabel: 'conn:test',
      onSessionSuspect: info => suspects.push(info),
    });
    const unsubscribe = broker.subscribe(() => {});
    await flush();
    sockets[0].open();
    await wait(30);
    expect(suspects.map(item => item.consecutive)).toEqual([1]);
    expect(suspects[0].reason).toBe('sync-timeout');

    await wait(10);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    sockets[sockets.length - 1].open();
    await wait(30);
    expect(suspects.map(item => item.consecutive)).toEqual([1, 2]);

    await wait(10);
    const healthy = sockets[sockets.length - 1];
    healthy.open();
    await completeHandshake(healthy);
    expect(suspects.map(item => item.consecutive)).toEqual([1, 2]);

    // Nová mrtvá session po zdravém syncu začíná zase od jedničky.
    healthy.close();
    await wait(10);
    sockets[sockets.length - 1].open();
    await wait(30);
    expect(suspects.map(item => item.consecutive)).toEqual([1, 2, 1]);
    unsubscribe();
  });
});

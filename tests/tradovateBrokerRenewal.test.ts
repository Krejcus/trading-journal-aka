import { describe, expect, it } from 'vitest';
import type { BrokerEvent } from '../services/brokerPort';
import { createTradovateBroker } from '../services/tradovateBroker';

/**
 * Plynulá obměna WebSocketu: údržbový swap nesmí controlleru ukázat
 * disconnect (ztratil by ARM), selhaná obnova ho ukázat MUSÍ.
 */

interface FakeSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  readyState: number;
  sent: string[];
  send(data: string): void;
  close(): void;
  deliver(data: string): void;
  open(): void;
}

const createFakeSocket = (): FakeSocket => {
  const socket: FakeSocket = {
    onopen: null, onmessage: null, onerror: null, onclose: null,
    readyState: 0,
    sent: [],
    send(data: string) { socket.sent.push(data); },
    close() {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      socket.onclose?.();
    },
    deliver(data: string) { socket.onmessage?.({ data }); },
    open() {
      socket.readyState = 1;
      socket.onopen?.();
    },
  };
  return socket;
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Provede celý handshake: open -> 'o' -> authorize ok -> sync ok. */
const completeHandshake = async (socket: FakeSocket) => {
  socket.open();
  socket.deliver('o');
  await flush();
  socket.deliver(JSON.stringify([{ i: 0, s: 200 }]).replace(/^/, 'a'));
  await flush();
  socket.deliver(`a${JSON.stringify([{ i: 1, s: 200, d: [] }])}`);
  await flush();
  await flush();
};

const harness = () => {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const broker = createTradovateBroker({
    environment: 'demo',
    accessToken: 'token',
    accountSpecsByAccountId: { 200: 'F1' },
    fetchImpl: (async (url: unknown) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => (String(url).includes('/fill') || String(url).includes('/orderVersion') || String(url).includes('/command') || String(url).includes('/order/list') ? [] : []),
      text: async () => '[]',
    })) as unknown as typeof fetch,
    webSocketFactory: () => {
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectDelayMs: 1,
    renewalDeadlineMs: 40,
    connectionLabel: 'conn:test',
  });
  const events: BrokerEvent[] = [];
  const unsubscribe = broker.subscribe(event => events.push(event));
  const connections = () => events
    .filter((event): event is Extract<BrokerEvent, { type: 'connection' }> => event.type === 'connection')
    .map(event => event.connected);
  const errors = () => events.filter(event => event.type === 'error');
  return { broker, sockets, events, connections, errors, unsubscribe, timers };
};

describe('plynulá obměna socketu', () => {
  it('úspěšný swap nikdy neukáže disconnect a starý socket zavře', async () => {
    const { broker, sockets, connections, errors, events, unsubscribe } = harness();
    await completeHandshake(sockets[0]);
    expect(connections()).toEqual([true]);

    expect(broker.renewSocket()).toBe(true);
    // Druhé volání během běžící obměny se odmítne.
    expect(broker.renewSocket()).toBe(false);
    // Reconnect (delay 1 ms) otevře nový socket.
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(2);
    expect(sockets[0].readyState).toBe(3);
    await completeHandshake(sockets[1]);

    // Jediné, co controller viděl: true (start) a true (po obnově).
    expect(connections()).toEqual([true, true]);
    expect(errors()).toHaveLength(0);
    // Obnova se ale musí přiznat příznakem: v mezeře mezi zavřením a
    // resyncem mohl uniknout celý vyplněný příkaz, takže si příjemce
    // vynutí kontrolu pozic. Start spojení příznak nemá.
    const spojeni = events.filter(
      (event): event is Extract<BrokerEvent, { type: 'connection' }> => event.type === 'connection',
    );
    expect(spojeni[0].resynced).toBeUndefined();
    expect(spojeni[1].resynced).toBe(true);
    unsubscribe();
  });

  it('nezdařená obnova se po deadline přizná jako výpadek', async () => {
    const { broker, sockets, connections, errors, unsubscribe } = harness();
    await completeHandshake(sockets[0]);
    expect(broker.renewSocket()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    // Nový socket se otevře, ale NIKDY nedokončí sync -> deadline 40 ms.
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(connections()).toEqual([true, false]);
    expect(errors().length).toBeGreaterThan(0);
    unsubscribe();
  });

  it('renewSocket mimo plný provoz nic nedělá', async () => {
    const { broker, sockets, unsubscribe } = harness();
    // Socket otevřený, ale sync nedokončený.
    sockets[0].open();
    expect(broker.renewSocket()).toBe(false);
    unsubscribe();
  });
});

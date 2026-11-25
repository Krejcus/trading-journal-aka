import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RithmicLocalConnection, type RithmicLinkSocket } from '../lib/rithmicLocalConnection';

class FakeSocket implements RithmicLinkSocket {
  readyState = 0;
  sent: Array<{ id: string; command: { op: string } }> = [];
  closed = false;
  throwOnSend = false;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send(data: string): void { if (this.throwOnSend) throw new Error('boom'); this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  drop(): void { this.readyState = 3; this.onclose?.({}); }
  push(message: unknown): void { this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) }); }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const log: string[] = [];
  const uncertain: Array<{ id: string; op: string; reason: string }> = [];
  const messages: Array<Record<string, unknown>> = [];
  let n = 0;
  const connection = new RithmicLocalConnection({
    url: 'ws://127.0.0.1:3311/?token=t',
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    newId: () => `c${(n += 1)}`,
    handlers: {
      onLink: (state) => log.push(`link:${state}`),
      onMessage: (message) => { messages.push(message); },
      onSessionReset: () => log.push('reset'),
      onSilent: (silent) => log.push(`silent:${silent}`),
      onUncertain: (item) => uncertain.push({ id: item.id, op: item.op, reason: item.reason }),
    },
  });
  return { connection, sockets, log, uncertain, messages };
}

describe('spojení s místní službou Rithmicu', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('retries once immediately if iOS delivers the old close just after resume', () => {
    const { connection, sockets } = setup();
    connection.start();
    sockets[0].open();
    connection.visibility(false);
    vi.advanceTimersByTime(7_000);
    connection.visibility(true);
    connection.kick();
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(45);
    sockets[0].drop();
    vi.advanceTimersByTime(0);
    expect(sockets).toHaveLength(2);
    sockets[1].drop();
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    connection.stop();
  });

  it('po uspání odmítne vstup už při kliku a stará zpráva neobnoví stav účtu', async () => {
    const t = setup();
    t.connection.start();
    const old = t.sockets[0];
    old.open();
    const before = Date.now();
    vi.setSystemTime(before + 6_000); // No timer callbacks during suspension.
    old.push({ type: 'tick', at: before });
    expect(await t.connection.send({ op: 'entry' })).toMatchObject({ ok: false, sent: false });
    expect(t.messages).toEqual([]);
    const close = t.connection.send({ op: 'flatten' });
    old.push({ type: 'reply', id: 'c1', ok: true, result: { status: 'already-flat' } });
    expect(await close).toMatchObject({ ok: true });
    expect(await t.connection.send({ op: 'entry' })).toMatchObject({ ok: false, sent: false });
    vi.setSystemTime(before + 90_000);
    old.push({ type: 'state', state: { connected: true } });
    expect(old.closed).toBe(true);
    old.drop(); // Browser close event after close().
    await vi.advanceTimersByTimeAsync(2_000);
    t.sockets[1].open();
    t.sockets[1].push({ type: 'state', state: { connected: true } });
    expect(t.sockets[1].sent).toEqual([]);
    expect(t.messages).toHaveLength(1);
    t.connection.stop();
  });

  it('bez otevřeného spojení příkaz neodejde a není nejistý', async () => {
    const t = setup();
    t.connection.start();
    expect(await t.connection.send({ op: 'entry' })).toMatchObject({ ok: false, sent: false });
    expect(t.sockets[0].sent).toEqual([]);
    expect(t.uncertain).toEqual([]);
    t.connection.stop();
  });

  it('odpověď se páruje podle id; nejistá odpověď služby se zapíše jednou, odmítnutá ne', async () => {
    const t = setup();
    t.connection.start();
    t.sockets[0].open();
    const ok = t.connection.send({ op: 'entry' });
    const refused = t.connection.send({ op: 'move' });
    const unknown = t.connection.send({ op: 'cancel' });
    expect(t.sockets[0].sent.map((frame) => frame.id)).toEqual(['c1', 'c2', 'c3']);
    t.sockets[0].push({ type: 'reply', id: 'c2', ok: false, sent: false, error: 'ne' });
    t.sockets[0].push({ type: 'reply', id: 'c3', ok: false, sent: 'unknown', error: 'nevím' });
    t.sockets[0].push({ type: 'reply', id: 'c1', ok: true });
    expect(await ok).toMatchObject({ ok: true });
    expect(await refused).toMatchObject({ ok: false, sent: false });
    expect(await unknown).toMatchObject({ ok: false, sent: 'unknown' });
    expect(t.uncertain).toEqual([{ id: 'c3', op: 'cancel', reason: 'nevím' }]);
    // odpověď na neznámé id se zahodí a nejde dál jako zpráva
    t.sockets[0].push({ type: 'reply', id: 'zzz', ok: true });
    expect(t.messages).toEqual([]);
    t.connection.stop();
  });

  it('výpadek uprostřed příkazu: výsledek není znám, nic se neposílá znovu ani po obnově', async () => {
    const t = setup();
    t.connection.start();
    t.sockets[0].open();
    const pending = t.connection.send({ op: 'entry' });
    const ack = t.connection.send({ op: 'ack' });
    t.sockets[0].drop();
    expect(await pending).toMatchObject({ ok: false, sent: 'unknown' });
    expect(await ack).toMatchObject({ ok: false, sent: 'unknown' });
    // potvrzení incidentu se mezi nejisté nezapisuje
    expect(t.uncertain).toEqual([{ id: 'c1', op: 'entry', reason: 'spojení s místním procesem spadlo' }]);
    expect(t.log).toEqual(['link:connecting', 'link:open', 'reset', 'link:closed']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.sockets).toHaveLength(2);
    t.sockets[1].open();
    expect(t.sockets[1].sent).toEqual([]); // žádné opakování starého příkazu
    // pozdní odpověď ze starého socketu se nepočítá
    t.sockets[0].push({ type: 'reply', id: 'c1', ok: true });
    t.sockets[0].push({ type: 'state', state: { seq: 1 } });
    expect(t.messages).toEqual([]);
    expect(t.uncertain).toHaveLength(1);
    t.connection.stop();
  });

  it('bez odpovědi do lhůty je výsledek neznámý; pozdní odpověď už nic nezmění', async () => {
    const t = setup();
    t.connection.start();
    t.sockets[0].open();
    const pending = t.connection.send({ op: 'flatten' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ ok: false, sent: 'unknown' });
    expect(t.uncertain).toEqual([{ id: 'c1', op: 'flatten', reason: 'místní proces neodpověděl' }]);
    t.sockets[0].push({ type: 'reply', id: 'c1', ok: true });
    expect(t.uncertain).toHaveLength(1);
    expect(t.sockets[0].sent).toHaveLength(1);
    t.connection.stop();
  });

  it('odeslání, které vyhodí chybu, je nejisté a neopakuje se', async () => {
    const t = setup();
    t.connection.start();
    t.sockets[0].open();
    t.sockets[0].throwOnSend = true;
    expect(await t.connection.send({ op: 'entry' })).toMatchObject({ ok: false, sent: 'unknown' });
    expect(t.uncertain).toEqual([{ id: 'c1', op: 'entry', reason: 'odeslání místnímu procesu selhalo' }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.uncertain).toHaveLength(1);
    t.connection.stop();
  });

  it('obnova spojení: zprávy jen z aktuálního socketu, obnova bez nejistých příkazů', async () => {
    const t = setup();
    t.connection.start();
    t.sockets[0].open();
    t.sockets[0].push({ type: 'hello', symbol: 'MNQZ6' });
    t.sockets[0].drop();
    await vi.advanceTimersByTimeAsync(2_000);
    t.sockets[1].open();
    t.sockets[1].push({ type: 'hello', symbol: 'MNQZ6' });
    t.sockets[1].push('není json');
    expect(t.messages.map((message) => message.type)).toEqual(['hello', 'hello']);
    expect(t.uncertain).toEqual([]);
    expect(t.log.filter((entry) => entry === 'reset')).toHaveLength(1);
    t.connection.stop();
  });

  it('hlídač tepu: mlčení se ohlásí jednou a čerstvý tep ho zruší', async () => {
    const t = setup();
    t.connection.start();
    t.sockets[0].open();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.log).not.toContain('silent:true');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.log.filter((entry) => entry === 'silent:true')).toHaveLength(1);
    t.sockets[0].push({ type: 'beat', at: Date.now(), feed: true });
    expect(t.log.at(-1)).toBe('silent:false');
    t.connection.stop();
  });

  it('ukončení: čekající příkaz je nejistý, spojení se zavře a už se neobnovuje', async () => {
    const t = setup();
    t.connection.start();
    t.sockets[0].open();
    const pending = t.connection.send({ op: 'move' });
    t.connection.stop();
    expect(await pending).toMatchObject({ ok: false, sent: 'unknown' });
    expect(t.sockets[0].closed).toBe(true);
    // zavření starého socketu po ukončení nic nespustí
    t.sockets[0].drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.log.filter((entry) => entry === 'reset')).toHaveLength(1);
    expect(await t.connection.send({ op: 'entry' })).toMatchObject({ ok: false, sent: false });
  });
});

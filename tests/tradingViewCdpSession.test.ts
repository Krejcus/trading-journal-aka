import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TradingViewCdpSession } from '../services/tradingViewCdpSession';
import { realtimeChannelCanPush } from '../services/tradingViewPriceStream';

class FakeSocket {
  listeners = new Map<string, Array<(event: any) => void>>();
  sent: Array<{ id: number; method: string }> = [];
  failSend = false;
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send(data: string) {
    if (this.failSend) throw new Error('socket-not-open');
    this.sent.push(JSON.parse(data));
  }
  close() { this.emit('close'); }
  reply(id: number, value: unknown) { this.emit('message', { data: JSON.stringify({ id, result: { result: { value } } }) }); }
}

const open = async () => {
  const socket = new FakeSocket();
  const opening = TradingViewCdpSession.open('ws://fake', 1_000, () => socket);
  socket.emit('open');
  return { socket, session: await opening };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('trvalé CDP spojení na TradingView (jen Runtime.evaluate)', () => {
  it('posílá jen Runtime.evaluate s returnByValue a vrací hodnotu', async () => {
    const { socket, session } = await open();
    const pending = session.evaluate('1 + 1', 1_000);
    expect(socket.sent).toEqual([{ id: 1, method: 'Runtime.evaluate', params: { expression: '1 + 1', returnByValue: true } }]);
    socket.reply(1, 2);
    await expect(pending).resolves.toMatchObject({ value: 2 });
  });

  it('timeout odmítne požadavek a pozdní odpověď se ignoruje', async () => {
    const { socket, session } = await open();
    const pending = session.evaluate('slow()', 500);
    const assertion = expect(pending).rejects.toThrow('cdp-evaluate-timeout');
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(() => socket.reply(1, 'late')).not.toThrow();
  });

  it('zavření spojení odmítne rozpracované požadavky a další evaluate rovnou selže', async () => {
    const { socket, session } = await open();
    const closed = vi.fn();
    session.onClose(closed);
    const pending = session.evaluate('x', 5_000);
    socket.emit('close');
    await expect(pending).rejects.toThrow('cdp-closed');
    expect(session.closed).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    await expect(session.evaluate('y', 1_000)).rejects.toThrow('cdp-closed');
  });

  it('chyba při odeslání odmítne jen ten požadavek a nic nevisí', async () => {
    const { socket, session } = await open();
    socket.failSend = true;
    await expect(session.evaluate('x', 1_000)).rejects.toThrow('socket-not-open');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('chyba výrazu v TV se hlásí jako chyba, ne jako hodnota', async () => {
    const { socket, session } = await open();
    const pending = session.evaluate('throw 1', 1_000);
    socket.emit('message', { data: JSON.stringify({ id: 1, result: { exceptionDetails: { text: 'x' } } }) });
    await expect(pending).rejects.toThrow('cdp-evaluate-failed');
  });
});

describe('brána odeslání do Realtime kanálu', () => {
  it('posílá jen při připojeném socketu a joinutém kanálu (jinak by realtime-js šel přes REST)', () => {
    expect(realtimeChannelCanPush(true, 'joined')).toBe(true);
    expect(realtimeChannelCanPush(false, 'joined')).toBe(false);
    expect(realtimeChannelCanPush(true, 'joining')).toBe(false);
    expect(realtimeChannelCanPush(true, 'closed')).toBe(false);
    expect(realtimeChannelCanPush(true, undefined)).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { captureTradingViewChartSnapshot } from '../services/copierChartSnapshot';

class FakeSocket {
  listeners = new Map<string, Set<(event: any) => void>>();
  sent: string[] = [];
  closed = false;

  addEventListener(type: string, listener: (event: any) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
}

const targetResponse = () => new Response(JSON.stringify([{
  type: 'page',
  url: 'https://www.tradingview.com/chart/abc/',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1',
}]), { status: 200 });

describe('copier TradingView CDP snapshot', () => {
  it('pošle pouze pasivní Page.captureScreenshot s fromSurface false', async () => {
    const socket = new FakeSocket();
    const promise = captureTradingViewChartSnapshot({
      fetchImpl: vi.fn(async () => targetResponse()) as typeof fetch,
      webSocketFactory: () => socket,
      timeoutMs: 100,
    });
    await vi.waitUntil(() => socket.listeners.has('open'), { timeout: 100 });
    socket.emit('open');
    const command = JSON.parse(socket.sent[0]);
    expect(command).toEqual({
      id: 1,
      method: 'Page.captureScreenshot',
      params: { format: 'png', fromSurface: false },
    });
    socket.emit('message', { data: JSON.stringify({ id: 1, result: { data: Buffer.from('png').toString('base64') } }) });
    await expect(promise).resolves.toEqual(Buffer.from('png'));
    expect(socket.closed).toBe(true);
  });

  it('tiše skončí null při timeoutu /json/list', async () => {
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
    })) as typeof fetch;
    await expect(captureTradingViewChartSnapshot({ fetchImpl, timeoutMs: 10 })).resolves.toBeNull();
  });

  it('tiše skončí null při timeoutu websocket odpovědi', async () => {
    const socket = new FakeSocket();
    const promise = captureTradingViewChartSnapshot({
      fetchImpl: vi.fn(async () => targetResponse()) as typeof fetch,
      webSocketFactory: () => socket,
      timeoutMs: 10,
    });
    await vi.waitUntil(() => socket.listeners.has('open'), { timeout: 100 });
    socket.emit('open');
    await expect(promise).resolves.toBeNull();
    expect(socket.closed).toBe(true);
  });
});

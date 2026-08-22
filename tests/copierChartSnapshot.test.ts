import { describe, expect, it, vi } from 'vitest';
import { captureTradingViewAlertSnapshot, captureTradingViewChartSnapshot } from '../services/copierChartSnapshot';

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
    await vi.waitUntil(() => socket.listeners.has('open'), { timeout: 1_000 });
    socket.emit('open');
    await vi.waitUntil(() => socket.sent.length > 0, { timeout: 1_000 });
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
    await vi.waitUntil(() => socket.listeners.has('open'), { timeout: 1_000 });
    socket.emit('open');
    await expect(promise).resolves.toBeNull();
    expect(socket.closed).toBe(true);
  });
});

describe('TV alert dedicated chart navigation', () => {
  it('navigates only the configured target, sets chart viewport and captures after render', async () => {
    const socket = new FakeSocket();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { id: 'other', type: 'page', url: 'https://www.tradingview.com/chart/other/', webSocketDebuggerUrl: 'ws://other' },
      { id: 'dedicated', type: 'page', url: 'https://www.tradingview.com/chart/alpha/', webSocketDebuggerUrl: 'ws://dedicated' },
    ]), { status: 200 })) as typeof fetch;
    const promise = captureTradingViewAlertSnapshot({
      symbol: 'MNQ1!', timeframe: '5', dedicated: { chartId: 'alpha' },
      fetchImpl, webSocketFactory: url => {
        expect(url).toBe('ws://dedicated');
        return socket;
      },
      sleepImpl: async () => undefined,
      timeoutMs: 500,
    });
    await vi.waitUntil(() => socket.listeners.has('open'), { timeout: 1_000 });
    socket.emit('open');
    const navigation = JSON.parse(socket.sent[0]);
    expect(navigation.method).toBe('Runtime.evaluate');
    expect(navigation.params.expression).toContain('TradingViewApi');
    expect(navigation.params.expression).toContain('setSymbol("MNQ1!")');
    expect(navigation.params.expression).toContain('setResolution("5")');
    expect(navigation.params.expression).toContain('setRightOffset(40)');
    expect(navigation.params.expression).toContain('setBarSpacing(3)');
    socket.emit('message', { data: JSON.stringify({ id: 1, result: { result: { value: true } } }) });
    // Krok 2: měření bounds plochy grafu — vrátíme obdélník, capture pak
    // musí jít s clipem (scale 2) přesně na něj.
    await vi.waitUntil(() => socket.sent.length === 2, { timeout: 1_000 });
    expect(JSON.parse(socket.sent[1])).toMatchObject({ method: 'Runtime.evaluate' });
    expect(JSON.parse(socket.sent[1]).params.expression).toContain('layout__area--center');
    socket.emit('message', { data: JSON.stringify({ id: 2, result: { result: { value: { x: 10, y: 20, width: 800, height: 600 } } } }) });
    await vi.waitUntil(() => socket.sent.length === 3, { timeout: 1_000 });
    expect(JSON.parse(socket.sent[2])).toMatchObject({
      method: 'Page.captureScreenshot',
      params: { clip: { x: 10, y: 20, width: 800, height: 600, scale: 2 } },
    });
    socket.emit('message', { data: JSON.stringify({ id: 3, result: { data: Buffer.from('dedicated').toString('base64') } }) });
    await expect(promise).resolves.toEqual(Buffer.from('dedicated'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the passive F1b target when dedicated render navigation fails', async () => {
    const dedicated = new FakeSocket();
    const passive = new FakeSocket();
    let lists = 0;
    const fetchImpl = vi.fn(async () => {
      lists += 1;
      return new Response(JSON.stringify(lists === 1 ? [{
        id: 'dedicated', type: 'page', url: 'https://www.tradingview.com/chart/alpha/', webSocketDebuggerUrl: 'ws://dedicated',
      }] : [{
        id: 'current', type: 'page', url: 'https://www.tradingview.com/chart/current/', webSocketDebuggerUrl: 'ws://current',
      }]), { status: 200 });
    }) as typeof fetch;
    const promise = captureTradingViewAlertSnapshot({
      symbol: 'MNQ1!', timeframe: '1', dedicated: { chartId: 'alpha' },
      fetchImpl,
      webSocketFactory: url => url === 'ws://dedicated' ? dedicated : passive,
      sleepImpl: async () => undefined,
      timeoutMs: 500,
    });
    await vi.waitUntil(() => dedicated.listeners.has('open'), { timeout: 1_000 });
    dedicated.emit('open');
    dedicated.emit('message', { data: JSON.stringify({ id: 1, result: { result: { value: false } } }) });
    await vi.waitUntil(() => passive.listeners.has('open'), { timeout: 1_000 });
    passive.emit('open');
    expect(JSON.parse(passive.sent[0])).toEqual({
      id: 1, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: false },
    });
    passive.emit('message', { data: JSON.stringify({ id: 1, result: { data: Buffer.from('fallback').toString('base64') } }) });
    await expect(promise).resolves.toEqual(Buffer.from('fallback'));
    expect(dedicated.sent).toHaveLength(1);
  });
});

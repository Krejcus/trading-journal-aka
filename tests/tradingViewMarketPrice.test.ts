import { describe, expect, it, vi } from 'vitest';
import {
  MARKET_PRICE_EXPRESSION,
  readTradingViewMarketPrices,
  startTradingViewMarketPriceFeed,
} from '../services/tradingViewMarketPrice';

class FakeSocket {
  listeners = new Map<string, Set<(event: any) => void>>();
  sent: string[] = [];
  closed = false;
  constructor(private readonly reply: unknown) {}
  addEventListener(type: string, listener: (event: any) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    if (type === 'close') queueMicrotask(() => this.emit('open'));
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: string) {
    this.sent.push(data);
    const request = JSON.parse(data) as { id: number };
    queueMicrotask(() => this.emit('message', {
      data: JSON.stringify({ id: request.id, result: { result: { value: this.reply } } }),
    }));
  }
  close() { this.closed = true; }
}

const targets = (urls: string[]) => new Response(JSON.stringify(urls.map((url, index) => ({
  type: 'page', url, webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${index}`,
}))), { status: 200 });

describe('TradingView market price feed (read-only CDP)', () => {
  it('reads symbol + last close from every chart target, strips the exchange prefix and flags continuous', async () => {
    const sockets: FakeSocket[] = [];
    const replies = [
      { symbol: 'CME_MINI:MNQ1!', price: 29541.5, typespecs: ['continuous', 'micro'] },
      { symbol: 'CME_MINI:MNQU6', price: 29546, typespecs: ['micro'] },
    ];
    const prices = await readTradingViewMarketPrices({
      fetchImpl: vi.fn(async () => targets([
        'https://www.tradingview.com/chart/abc/',
        'https://www.tradingview.com/chart/def/',
        'file:///Applications/TradingView.app/x.html',
      ])) as typeof fetch,
      webSocketFactory: () => { const socket = new FakeSocket(replies[sockets.length]); sockets.push(socket); return socket; },
      now: () => 1_000,
    });
    expect(prices).toEqual([
      { symbol: 'MNQ1!', price: 29541.5, at: 1_000, continuous: true },
      { symbol: 'MNQU6', price: 29546, at: 1_000, continuous: false },
    ]);
    expect(sockets).toHaveLength(2);
    for (const socket of sockets) {
      const command = JSON.parse(socket.sent[0]);
      expect(command).toEqual({
        id: 1, method: 'Runtime.evaluate', params: { expression: MARKET_PRICE_EXPRESSION, returnByValue: true },
      });
      expect(socket.closed).toBe(true);
    }
    // Nic, co by měnilo graf: žádné setSymbol / setResolution / navigate.
    expect(MARKET_PRICE_EXPRESSION).not.toMatch(/setSymbol|setResolution|location\.|navigate/);
  });

  it('returns nothing when TradingView / CDP is down or the page has no chart', async () => {
    const offline = await readTradingViewMarketPrices({
      fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
      webSocketFactory: () => new FakeSocket(null),
    });
    expect(offline).toEqual([]);

    const noChart = await readTradingViewMarketPrices({
      fetchImpl: vi.fn(async () => targets(['https://www.tradingview.com/chart/abc/'])) as typeof fetch,
      webSocketFactory: () => new FakeSocket(null),
    });
    expect(noChart).toEqual([]);

    const junk = await readTradingViewMarketPrices({
      fetchImpl: vi.fn(async () => targets(['https://www.tradingview.com/chart/abc/'])) as typeof fetch,
      webSocketFactory: () => new FakeSocket({ symbol: 'CME_MINI:MNQ1!', price: Number.NaN }),
    });
    expect(junk).toEqual([]);
  });

  it('feed keeps the last fresh reading, never overlaps and drops stale values', async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      let calls = 0;
      let release: (() => void) | null = null;
      const read = vi.fn(async () => {
        calls += 1;
        const at = clock;
        if (calls === 2) await new Promise<void>(resolve => { release = resolve; });
        return calls === 3 ? [] : [{ symbol: 'MNQ1!', price: 100 + calls, at, continuous: true }];
      });
      const feed = startTradingViewMarketPriceFeed({ intervalMs: 1_000, maxAgeMs: 5_000, read, now: () => clock });
      await vi.advanceTimersByTimeAsync(0);
      expect(feed.current()).toEqual([{ symbol: 'MNQ1!', price: 101, at: 0, continuous: true }]);

      clock = 1_000;
      await vi.advanceTimersByTimeAsync(1_000); // 2. čtení visí
      clock = 2_000;
      await vi.advanceTimersByTimeAsync(1_000); // 3. tik přeskočen (inFlight)
      expect(read).toHaveBeenCalledTimes(2);
      release!();
      await vi.advanceTimersByTimeAsync(0);
      expect(feed.current()).toEqual([{ symbol: 'MNQ1!', price: 102, at: 1_000, continuous: true }]);

      clock = 3_000;
      await vi.advanceTimersByTimeAsync(1_000); // prázdné čtení nezahodí poslední hodnotu…
      expect(feed.current()[0]?.price).toBe(102);
      clock = 6_500; // …ale stáří přes 5 s už se nehlásí
      expect(feed.current()).toEqual([]);

      feed.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read).toHaveBeenCalledTimes(3);
      expect(feed.current()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';

/**
 * 17. 9. 2026: REST volání brokeru neměla žádný deadline. Hung fetch visel
 * až 5 minut (undici default) a za ním čekal eventTail: risk poll,
 * post-reconnect recovery i nouzový Flatten.
 */
const idleSocket = (): WebSocketLike => ({
  readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null, send() {}, close() {},
});
const hangUntilAbort = (init?: RequestInit) => new Promise<never>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
});
const broker = (fetchImpl: typeof fetch) => createTradovateBroker({
  environment: 'demo', accessToken: 'token', accountSpec: 'DEMO123', restRequestTimeoutMs: 20,
  fetchImpl, webSocketFactory: idleSocket,
});

describe('Tradovate REST request deadline', () => {
  it('turns a hung request into a transport error instead of blocking forever', async () => {
    const started = Date.now();
    await expect(broker(((_url, init) => hangUntilAbort(init)) as typeof fetch).listPositions(200))
      .rejects.toThrow('request timeout (20 ms)');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('also bounds a response body that never finishes', async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => ({
      ok: true, status: 200, headers: { get: () => null },
      text: () => hangUntilAbort(init), json: () => hangUntilAbort(init),
    })) as unknown as typeof fetch;
    await expect(broker(fetchImpl).listPositions(200)).rejects.toThrow('request timeout (20 ms)');
  });

  it('leaves a prompt response untouched', async () => {
    await expect(broker((async () => Response.json([])) as typeof fetch).listPositions(200)).resolves.toEqual([]);
  });
});

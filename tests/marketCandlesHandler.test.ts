import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let source: string;
beforeAll(async () => {
  const bundled = await build({ entryPoints: ['supabase/functions/market-candles/index.ts'], bundle: true,
    write: false, format: 'cjs', platform: 'node', plugins: [{ name: 'test-edge-runtime', setup(builder) {
      builder.onResolve({ filter: /^jsr:/ }, args => ({ path: args.path, namespace: 'test-edge' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-edge' }, args => ({ contents: args.path.includes('supabase-js')
        ? 'export const createClient = () => ({ auth: { getUser: async () => ({ data: { user: { id: "test-user" } }, error: null }) } });'
        : '', loader: 'js' }));
    } }] });
  source = bundled.outputFiles[0].text;
});

function harness(upstreamStatus = 200) {
  let handle!: (request: Request) => Promise<Response>;
  const provider = vi.fn(async (input: string | URL) => String(input).includes('metadata.get_cost')
    ? new Response('0') : new Response(JSON.stringify({ hd: { ts_event: '2026-11-06T21:59:00Z' },
      open: 100, high: 101, low: 99, close: 100, volume: 1, symbol: 'MNQZ6' }), { status: upstreamStatus }));
  class Clock extends Date { static now() { return Date.parse('2026-11-09T20:00:00Z'); } }
  runInNewContext(source, { Deno: { env: { get: () => 'test-only' }, serve: (handler: typeof handle) => { handle = handler; } },
    fetch: provider, Date: Clock, Intl, URLSearchParams, Response, Request, btoa, console: { warn() {}, error() {} }, setTimeout });
  const send = (start: string, end: string, auth = true) => handle(new Request('https://example.test', { method: 'POST',
    headers: { ...(auth ? { Authorization: 'Bearer test-only' } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'MNQ.v.0', schema: 'ohlcv-1m', start, end }) }));
  return { provider, send };
}

describe('historical candle handler with closed weekend tail', () => {
  it('requests only trading coverage, declares the closed interval and preserves the requested end', async () => {
    const h = harness(); const end = '2026-11-08T19:15:00.000Z';
    const response = await h.send('2026-10-30T00:00:00Z', end);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ end, providerEnd: '2026-11-06T22:00:00.000Z',
      closedIntervals: [{ start: '2026-11-06T22:00:00.000Z', end, reason: 'regular-cme-weekend' }], candles: [{ close: 100 }] });
    expect(h.provider).toHaveBeenCalledTimes(2);
    expect(new URL(String(h.provider.mock.calls[0][0])).searchParams.get('end')).toBe('2026-11-06T22:00:00.000Z');
    expect(String(h.provider.mock.calls[1][0])).toContain('timeseries.get_range');
  });
  it('returns an explicitly closed empty interval without buying data, but still requires authentication', async () => {
    const h = harness();
    const response = await h.send('2026-11-07T00:00:00Z', '2026-11-08T19:15:00Z');
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ candles: [], estimatedCostUsd: 0 });
    expect(h.provider).not.toHaveBeenCalled();
    expect((await h.send('2026-11-07T00:00:00Z', '2026-11-08T19:15:00Z', false)).status).toBe(401);
  });
  it('continues to reject partial symbol coverage instead of painting it as complete', async () => {
    const h = harness(206); const response = await h.send('2026-10-30T00:00:00Z', '2026-11-08T19:15:00Z');
    expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ error: 'provider-partial' });
  });
});

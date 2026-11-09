import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createKeepAliveFetch } from '../server/tradovateKeepAliveFetch';

let server: Server | null = null;
let client: ReturnType<typeof createKeepAliveFetch> | null = null;
afterEach(async () => {
  client?.close(); client = null;
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server!.close(() => resolve(null))); server = null; }
});
async function listen(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<string> {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => handler(request, response, body));
  });
  server.keepAliveTimeout = 30_000;
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };

describe('keep-alive fetch for broker REST', () => {
  it('reuses one connection and returns status, headers and JSON body like fetch', async () => {
    const seen: Array<{ method?: string; auth?: string; body: string }> = [];
    const base = await listen((request, response, body) => { seen.push({ method: request.method, auth: request.headers.authorization, body }); json(response, { ok: seen.length }); });
    const uses: boolean[] = [];
    client = createKeepAliveFetch({ onRequest: info => uses.push(info.reused) });
    const first = await client(`${base}/order/modifyorder`, { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: 1 }) });
    expect(first.status).toBe(200); expect(first.headers.get('content-type')).toContain('json'); expect(await first.json()).toEqual({ ok: 1 });
    const second = await client(`${base}/position/list`, { headers: { Authorization: 'Bearer t' } });
    expect(await second.json()).toEqual({ ok: 2 });
    expect(seen).toEqual([{ method: 'POST', auth: 'Bearer t', body: '{"orderId":1}' }, { method: 'GET', auth: 'Bearer t', body: '' }]);
    expect(uses).toEqual([false, true]);
  });

  it('retries a GET once when the reused connection dies before any response byte', async () => {
    let requests = 0;
    const base = await listen((request, response) => {
      requests += 1;
      if (requests === 2) { request.socket.destroy(); return; }
      json(response, { n: requests });
    });
    const uses: Array<{ reused: boolean; retried: boolean }> = [];
    client = createKeepAliveFetch({ onRequest: info => uses.push({ reused: info.reused, retried: info.retried }) });
    expect(await (await client(`${base}/a`)).json()).toEqual({ n: 1 });
    expect(await (await client(`${base}/b`)).json()).toEqual({ n: 3 });
    expect(uses).toEqual([{ reused: false, retried: false }, { reused: true, retried: false }, { reused: false, retried: true }]);
  });

  it('never retries a write: a dead reused connection surfaces as a transport error after exactly one attempt', async () => {
    let posts = 0;
    const base = await listen((request, response) => {
      if (request.method === 'POST') { posts += 1; request.socket.destroy(); return; }
      json(response, {});
    });
    client = createKeepAliveFetch();
    await client(`${base}/warm`);
    await expect(client(`${base}/order/placeorder`, { method: 'POST', body: '{}' })).rejects.toThrow();
    expect(posts).toBe(1);
  });

  it('does not retry a GET that failed on a fresh connection', async () => {
    let requests = 0;
    const base = await listen(request => { requests += 1; request.socket.destroy(); });
    client = createKeepAliveFetch();
    await expect(client(`${base}/x`)).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it('honours AbortSignal with the caller reason and does not follow redirects', async () => {
    const base = await listen((request, response) => {
      if (request.url === '/slow') return;
      response.writeHead(302, { Location: '/elsewhere' }); response.end();
    });
    client = createKeepAliveFetch();
    const abort = new AbortController(); const reason = new Error('deadline');
    const pending = client(`${base}/slow`, { signal: abort.signal });
    setTimeout(() => abort.abort(reason), 20);
    await expect(pending).rejects.toBe(reason);
    const redirected = await client(`${base}/redirect`);
    expect(redirected.status).toBe(302); expect(redirected.headers.get('location')).toBe('/elsewhere');
    const already = new AbortController(); already.abort(reason);
    await expect(client(`${base}/slow`, { signal: already.signal })).rejects.toBe(reason);
  });

  it('asks for gzip and decodes a compressed JSON body', async () => {
    const { gzipSync } = await import('node:zlib');
    let asked: string | undefined;
    const base = await listen((request, response) => {
      asked = String(request.headers['accept-encoding']);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      response.end(gzipSync(JSON.stringify({ orders: [1, 2, 3] })));
    });
    client = createKeepAliveFetch();
    const response = await client(`${base}/order/list`);
    expect(asked).toBe('gzip'); expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.json()).toEqual({ orders: [1, 2, 3] });
  });

  it('resolves at the headers: a 429 with a stalled body is visible before the body arrives, and the body stream honours abort', async () => {
    const base = await listen((_request, response) => {
      response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      response.write('{"p-ti'); // tělo nikdy nedokončí
    });
    client = createKeepAliveFetch();
    const abort = new AbortController(); const reason = new Error('body deadline');
    const response = await client(`${base}/order/placeorder`, { method: 'POST', body: '{}', signal: abort.signal });
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('30');
    const reading = response.text();
    setTimeout(() => abort.abort(reason), 20);
    await expect(reading).rejects.toBe(reason);
  });

  it('drops an idle connection after idleMs so a stale socket is not reused', async () => {
    const base = await listen((_request, response) => json(response, {}));
    const uses: boolean[] = [];
    client = createKeepAliveFetch({ idleMs: 1_000, onRequest: info => uses.push(info.reused) });
    await client(`${base}/a`);
    await new Promise(resolve => setTimeout(resolve, 1_250));
    await client(`${base}/b`);
    expect(uses).toEqual([false, false]);
  });
});

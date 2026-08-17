import type { IncomingMessage, ServerResponse } from 'node:http';

const productionOrigin = 'https://alphatrade-mentor-15.vercel.app';

const allowedRequests = new Set([
  'GET /api/tradovate/oauth/status',
  'POST /api/tradovate/oauth/preflight',
  'POST /api/tradovate/oauth/live-pnl',
  'POST /api/tradovate/oauth/history',
  'GET /api/tradovate/oauth/history-sync',
  'POST /api/tradovate/oauth/history-sync',
  'GET /api/tradovate/account-profiles',
]);

export const isAllowedLocalTradovateRead = (method: string, pathname: string): boolean =>
  allowedRequests.has(`${method.toUpperCase()} ${pathname}`);

const readBody = async (request: IncomingMessage): Promise<Buffer | undefined> => {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const proxyHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || ['host', 'connection', 'content-length', 'accept-encoding'].includes(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
};

const jsonError = (response: ServerResponse, status: number, error: string): void => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify({ error }));
};

export const proxyLocalTradovateRead = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const requestUrl = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method?.toUpperCase() ?? 'GET';
  if (!isAllowedLocalTradovateRead(method, requestUrl.pathname)) {
    jsonError(response, 405, 'Localhost je pro Tradovate pouze read-only. Tato akce je dostupná jen na live.');
    return;
  }

  try {
    const upstream = await fetch(new URL(`${requestUrl.pathname}${requestUrl.search}`, productionOrigin), {
      method,
      headers: proxyHeaders(request),
      body: await readBody(request),
      redirect: 'manual',
    });
    response.statusCode = upstream.status;
    for (const name of ['content-type', 'cache-control', 'retry-after']) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (reason) {
    jsonError(
      response,
      502,
      reason instanceof Error ? `Produkční Tradovate API není dostupné: ${reason.message}` : 'Produkční Tradovate API není dostupné.',
    );
  }
};

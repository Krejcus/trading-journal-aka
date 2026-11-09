import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

/**
 * `fetch` pro REST brokera nad drženým spojením (9. 11. 2026).
 *
 * Vestavěný `fetch` Node zavírá nečinné spojení po ~4 s, takže skoro každý ruční
 * příkaz (posun SL, zavření) platil nový TCP + TLS handshake (~65–160 ms z Česka,
 * měřeno `latencyProbe`). Tady spojení přežije `idleMs` nečinnosti.
 *
 * Pravidla:
 * - Zápis (cokoli mimo GET/HEAD) se NIKDY neopakuje — chyba spojení je pro volajícího
 *   stejná „transport unknown“ jako u `fetch` (INV-OUTBOX-01, INV-TRAD-08).
 * - GET/HEAD se zopakuje jednou a jen tehdy, když selhal na znovupoužitém spojení
 *   dřív, než přišel jediný bajt odpovědi (protistrana ho mezitím zavřela).
 * - Přesměrování se nenásleduje (stejně jako `redirect: 'manual'` v adaptéru).
 * - `idleMs` musí být výrazně pod limitem protistrany (Google frontend 610 s).
 */
export interface KeepAliveFetchOptions {
  /** Jak dlouho smí volné spojení čekat na další požadavek. */
  idleMs?: number;
  maxSockets?: number;
  /** Diagnostika: nové vs. znovupoužité spojení. */
  onRequest?: (info: { reused: boolean; retried: boolean; method: string }) => void;
}

export function createKeepAliveFetch(options: KeepAliveFetchOptions = {}): typeof fetch & { close(): void } {
  const idleMs = Math.max(1_000, options.idleMs ?? 45_000);
  const agentOptions = { keepAlive: true, keepAliveMsecs: 10_000, maxSockets: options.maxSockets ?? 8, maxFreeSockets: 4, timeout: idleMs };
  const httpsAgent = new HttpsAgent(agentOptions);
  const httpAgent = new HttpAgent(agentOptions);

  const once = (url: URL, method: string, headers: Record<string, string>, body: string | Uint8Array | null, signal: AbortSignal | null | undefined, retried: boolean): Promise<Response> => (
    new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError')); return; }
      const secure = url.protocol === 'https:';
      let settled = false;
      let responseStarted = false;
      const request = (secure ? httpsRequest : httpRequest)(url, { method, headers, agent: secure ? httpsAgent : httpAgent });
      const onAbort = () => { request.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError')); };
      const finish = (run: () => void) => { if (settled) return; settled = true; signal?.removeEventListener('abort', onAbort); run(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      // Spojení bez jakéhokoli provozu po `idleMs` je mrtvé i uprostřed požadavku (např. tělo,
      // které nikdo nedočetl): zavřít, ať neblokuje místo v poolu.
      request.once('timeout', () => { request.destroy(new Error('keep-alive fetch: spojení bez provozu')); });
      request.once('socket', () => { options.onRequest?.({ reused: request.reusedSocket === true, retried, method }); });
      request.once('response', (message: IncomingMessage) => {
        responseStarted = true;
        const status = message.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(message.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value != null) responseHeaders.set(name, value);
        }
        // Tělo se předává už dekódované; délka a kódování přenosu by s ním nesouhlasily.
        responseHeaders.delete('content-length');
        responseHeaders.delete('transfer-encoding');
        const empty = status === 204 || status === 205 || status === 304 || method === 'HEAD';
        const gzip = !empty && String(message.headers['content-encoding'] ?? '').toLowerCase() === 'gzip';
        if (gzip) responseHeaders.delete('content-encoding');
        // Odpověď se vrací hned po hlavičkách se streamovaným tělem jako u vestavěného fetch:
        // volající zapisuje západku 429 z hlaviček dřív, než dorazí (případně váznoucí) tělo,
        // a své limity velikosti a času uplatňuje při čtení streamu.
        let source: Readable = message;
        if (gzip) {
          const gunzip = createGunzip();
          message.once('error', error => gunzip.destroy(error));
          source = message.pipe(gunzip);
        }
        // Přerušení volajícím během těla ukončí stream jeho důvodem; listener zmizí s koncem těla.
        const onBodyAbort = () => { const reason = signal?.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError'); message.destroy(reason); if (source !== message) source.destroy(reason); };
        signal?.addEventListener('abort', onBodyAbort, { once: true });
        source.once('close', () => signal?.removeEventListener('abort', onBodyAbort));
        if (empty) message.resume();
        finish(() => resolve(new Response(empty ? null : Readable.toWeb(source) as ReadableStream<Uint8Array>,
          { status, statusText: message.statusMessage ?? '', headers: responseHeaders })));
      });
      request.once('error', error => finish(() => {
        const idempotent = method === 'GET' || method === 'HEAD';
        if (idempotent && !retried && !responseStarted && request.reusedSocket === true && !signal?.aborted) {
          once(url, method, headers, body, signal, true).then(resolve, reject);
          return;
        }
        reject(signal?.aborted ? (signal.reason ?? error) : error);
      }));
      if (body != null) request.end(body); else request.end();
    })
  );

  const keepAliveFetch = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    if (typeof Request !== 'undefined' && input instanceof Request) throw new TypeError('keep-alive fetch: Request objekt není podporovaný');
    const url = new URL(String(input));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError(`keep-alive fetch: nepodporovaný protokol ${url.protocol}`);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    if (headers['accept-encoding'] == null) headers['accept-encoding'] = 'gzip';
    // Stejné výchozí hlavičky jako vestavěný fetch Node.
    if (headers['user-agent'] == null) headers['user-agent'] = 'node';
    if (headers['accept-language'] == null) headers['accept-language'] = '*';
    if (headers.accept == null) headers.accept = '*/*';
    let body: string | Uint8Array | null = null;
    if (init.body != null) {
      if (typeof init.body === 'string') body = init.body;
      else if (init.body instanceof Uint8Array) body = init.body;
      else throw new TypeError('keep-alive fetch: tělo musí být text nebo bajty');
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    return once(url, method, headers, body, init.signal, false);
  }) as typeof fetch & { close(): void };
  keepAliveFetch.close = () => { httpsAgent.destroy(); httpAgent.destroy(); };
  return keepAliveFetch;
}

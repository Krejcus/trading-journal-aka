const DEFAULT_CDP_ORIGIN = 'http://127.0.0.1:9222';
const DEFAULT_TIMEOUT_MS = 3_000;

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface WebSocketLike {
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: any) => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: any) => void): void;
  send(data: string): void;
  close(): void;
}

export interface CopierChartSnapshotOptions {
  cdpOrigin?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
}

const timeoutError = () => new Error('snapshot-cdp-timeout');

/**
 * Pasivně sejme aktuální TradingView chart target. Nikdy nenaviguje, nemění
 * symbol/timeframe ani do stránky neposílá jiný příkaz než screenshot.
 * Nedostupný CDP/TV nebo timeout jsou běžný stav a vracejí `null` bez hluku.
 */
export async function captureTradingViewChartSnapshot(
  options: CopierChartSnapshotOptions = {},
): Promise<Buffer | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const webSocketFactory = options.webSocketFactory
    ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());

  try {
    const response = await fetchImpl(`${options.cdpOrigin ?? DEFAULT_CDP_ORIGIN}/json/list`, {
      signal: AbortSignal.timeout(remaining()),
    });
    if (!response.ok) return null;
    const targets = await response.json() as CdpTarget[];
    const target = Array.isArray(targets) ? targets.find(candidate =>
      candidate.type === 'page'
      && typeof candidate.url === 'string'
      && candidate.url.includes('tradingview.com/chart')
      && typeof candidate.webSocketDebuggerUrl === 'string') : undefined;
    if (!target?.webSocketDebuggerUrl) return null;

    const socket = webSocketFactory(target.webSocketDebuggerUrl);
    const data = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(reject, timeoutError()), remaining());
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        try { socket.close(); } catch { /* best effort */ }
      };
      const finish = (callback: (value: any) => void, value: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onOpen = () => {
        try {
          socket.send(JSON.stringify({
            id: 1,
            method: 'Page.captureScreenshot',
            params: { format: 'png', fromSurface: false },
          }));
        } catch (error) {
          finish(reject, error);
        }
      };
      const onMessage = (event: { data?: unknown }) => {
        try {
          const message = JSON.parse(String(event.data ?? '')) as {
            id?: number;
            result?: { data?: unknown };
            error?: { message?: string };
          };
          if (message.id !== 1) return;
          if (message.error) return finish(reject, new Error(message.error.message ?? 'snapshot-cdp-error'));
          if (typeof message.result?.data !== 'string') return finish(reject, new Error('snapshot-cdp-invalid-response'));
          finish(resolve, message.result.data);
        } catch (error) {
          finish(reject, error);
        }
      };
      const onError = () => finish(reject, new Error('snapshot-cdp-websocket-error'));
      const onClose = () => finish(reject, new Error('snapshot-cdp-websocket-closed'));
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    });
    const png = Buffer.from(data, 'base64');
    return png.length > 0 ? png : null;
  } catch (error) {
    // Desktop/CDP neběží nebo nestihl třísekundový rozpočet: běžný tichý skip.
    if ((error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'
      || error.message.startsWith('snapshot-cdp-'))) || (error instanceof TypeError)) return null;
    throw error;
  }
}

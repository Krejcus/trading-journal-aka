/**
 * Aktuální cena z otevřených grafů TradingView Desktop přes lokální CDP
 * (stejný kanál jako snímky grafu). Čte jen poslední svíčku hlavní série a
 * `symbolExt()` každého chart targetu; nikdy nenaviguje, nemění symbol ani
 * timeframe. Nedostupné TradingView/CDP je běžný stav → prázdný seznam.
 *
 * Tradovate API kotace jsou pro prop OAuth tokeny zavřené (sonda 27. 8.),
 * takže tohle je jediný bezplatný zdroj ceny mimo otevřenou pozici.
 */

const DEFAULT_CDP_ORIGIN = 'http://127.0.0.1:9222';
const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_CHART_TARGETS = 4;

export interface TradingViewMarketPrice {
  /** Symbol bez burzovního prefixu, jak ho zná graf (`MNQ1!`, `MNQU6`). */
  symbol: string;
  price: number;
  /** Epoch ms čtení (hodiny workeru). */
  at: number;
  /** `1!`-style kontinuální kontrakt: v rollover týdnu se může lišit od obchodovaného. */
  continuous: boolean;
}

interface WebSocketLike {
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: any) => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: any) => void): void;
  send(data: string): void;
  close(): void;
}

interface CdpTarget {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface TradingViewMarketPriceOptions {
  cdpOrigin?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
  now?: () => number;
}

/** Read-only: žádné volání, které by měnilo stav grafu. */
export const MARKET_PRICE_EXPRESSION = `(() => {
  try {
    const root = window.TradingViewApi;
    const api = root && root._activeChartWidgetWV && root._activeChartWidgetWV.value();
    if (!api) return null;
    let ext = null;
    try { ext = api.symbolExt ? api.symbolExt() : null; } catch (e) { ext = null; }
    const bars = api._chartWidget.model().mainSeries().bars();
    if (!bars || typeof bars.lastIndex !== 'function') return null;
    const last = bars.valueAt(bars.lastIndex());
    if (!last) return null;
    let symbol = ext && (ext.full_name || ext.pro_name);
    if (!symbol) { try { symbol = api.symbol(); } catch (e) { symbol = null; } }
    return {
      symbol: symbol || null,
      price: last[4],
      typespecs: (ext && Array.isArray(ext.typespecs)) ? ext.typespecs : [],
    };
  } catch (e) {
    return null;
  }
})()`;

const timeoutError = () => new Error('market-price-cdp-timeout');

const normalizeSymbol = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  const symbol = trimmed.includes(':') ? trimmed.slice(trimmed.lastIndexOf(':') + 1) : trimmed;
  return symbol.length > 0 ? symbol : null;
};

async function evaluateOnTarget(
  target: CdpTarget,
  options: { timeoutMs: number; webSocketFactory: (url: string) => WebSocketLike },
): Promise<unknown> {
  const socket = options.webSocketFactory(target.webSocketDebuggerUrl!);
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(reject, timeoutError()), options.timeoutMs);
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
          method: 'Runtime.evaluate',
          params: { expression: MARKET_PRICE_EXPRESSION, returnByValue: true },
        }));
      } catch (error) {
        finish(reject, error);
      }
    };
    const onMessage = (event: { data?: unknown }) => {
      try {
        const message = JSON.parse(String(event.data ?? '')) as {
          id?: number;
          result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
          error?: { message?: string };
        };
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails) return finish(resolve, null);
        finish(resolve, message.result?.result?.value ?? null);
      } catch (error) {
        finish(reject, error);
      }
    };
    const onError = () => finish(reject, new Error('market-price-cdp-websocket-error'));
    const onClose = () => finish(reject, new Error('market-price-cdp-websocket-closed'));
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

/**
 * Jedno čtení přes všechny otevřené chart targety (obchodní graf i snímkový
 * layout). Vrací jen platné páry symbol + cena; chyby jednotlivých targetů
 * i nedostupný CDP končí tiše.
 */
export async function readTradingViewMarketPrices(
  options: TradingViewMarketPriceOptions = {},
): Promise<TradingViewMarketPrice[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const webSocketFactory = options.webSocketFactory
    ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const now = options.now ?? Date.now;
  let targets: CdpTarget[];
  try {
    const response = await fetchImpl(`${options.cdpOrigin ?? DEFAULT_CDP_ORIGIN}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return [];
    const payload = await response.json() as unknown;
    targets = Array.isArray(payload) ? (payload as CdpTarget[]) : [];
  } catch {
    return [];
  }
  const chartTargets = targets.filter(candidate =>
    candidate.type === 'page'
    && typeof candidate.url === 'string'
    && candidate.url.includes('tradingview.com/chart')
    && typeof candidate.webSocketDebuggerUrl === 'string').slice(0, MAX_CHART_TARGETS);
  const readings = await Promise.all(chartTargets.map(async target => {
    try {
      return await evaluateOnTarget(target, { timeoutMs, webSocketFactory });
    } catch {
      return null;
    }
  }));
  const at = now();
  const seen = new Set<string>();
  return readings.flatMap(reading => {
    if (!reading || typeof reading !== 'object') return [];
    const row = reading as { symbol?: unknown; price?: unknown; typespecs?: unknown };
    const symbol = normalizeSymbol(row.symbol);
    const price = typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0 ? row.price : null;
    if (!symbol || price == null || seen.has(symbol)) return [];
    seen.add(symbol);
    const typespecs = Array.isArray(row.typespecs) ? row.typespecs.map(String) : [];
    return [{ symbol, price, at, continuous: typespecs.includes('continuous') || /\d!$/.test(symbol) }];
  });
}

export interface TradingViewMarketPriceFeed {
  /** Poslední úspěšné čtení; prázdné, když TradingView neběží nebo je starší než `maxAgeMs`. */
  current(): TradingViewMarketPrice[];
  stop(): void;
}

/**
 * Periodické čtení pro heartbeat status. Nepřekrývá běhy, po výpadku CDP
 * se prostě zkouší dál; hodnoty starší než `maxAgeMs` už nehlásí.
 */
export function startTradingViewMarketPriceFeed(options: TradingViewMarketPriceOptions & {
  intervalMs?: number;
  maxAgeMs?: number;
  read?: (options: TradingViewMarketPriceOptions) => Promise<TradingViewMarketPrice[]>;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
} = {}): TradingViewMarketPriceFeed {
  const intervalMs = Math.max(250, options.intervalMs ?? 1_000);
  const maxAgeMs = Math.max(intervalMs, options.maxAgeMs ?? 5_000);
  const read = options.read ?? readTradingViewMarketPrices;
  const now = options.now ?? Date.now;
  let latest: TradingViewMarketPrice[] = [];
  let inFlight = false;
  let stopped = false;
  const tick = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const next = await read(options);
      if (!stopped && next.length > 0) latest = next;
    } catch {
      // Tichý skip: cena je jen doplněk zobrazení, nikdy neblokuje worker.
    } finally {
      inFlight = false;
    }
  };
  const timer = (options.setIntervalImpl ?? setInterval)(() => { void tick(); }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  void tick();
  return {
    current: () => latest.filter(entry => now() - entry.at <= maxAgeMs),
    stop: () => {
      stopped = true;
      (options.clearIntervalImpl ?? clearInterval)(timer);
      latest = [];
    },
  };
}

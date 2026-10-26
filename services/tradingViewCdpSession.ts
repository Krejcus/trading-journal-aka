/**
 * Trvalé read-only CDP spojení na graf TradingView Desktop (kanál ceny,
 * měřicí sonda). Posílá **výhradně** `Runtime.evaluate` s výrazy bez
 * vedlejších efektů — nic nepřepíná, nenaviguje, nemění symbol ani timeframe
 * a TV nikdy nespouští ani neukončuje (to dělá jen `tradingViewCdpLifecycle`).
 * Cena z TV je jen pro zobrazení (pravidlo v `lib/tradingViewBars.ts`).
 */

export const TV_CDP_ORIGIN = 'http://127.0.0.1:9222';
const MAX_CHART_TARGETS = 4;

/** Lehký výraz: poslední svíčka + kotace každého panelu v okně (pořadí = panel). */
export const TV_FAST_PRICE_EXPRESSION = `(() => {
  const started = performance.now();
  try {
    const collection = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
    if (!collection) return null;
    const charts = collection.getAll().map(widget => {
      try {
        const series = widget.model().mainSeries();
        const bars = series.bars();
        const bar = bars.valueAt(bars.lastIndex());
        let quote = null;
        try { quote = series.quotes(); } catch (e) { quote = null; }
        const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
        return {
          symbol: series.symbol(),
          interval: String(series.interval()),
          bar: bar ? [bar[0], bar[1], bar[2], bar[3], bar[4], bar[5] || 0] : null,
          last: quote ? number(quote.last_price) : null,
          lastTime: quote ? number(quote.lp_time) : null,
          bid: quote ? number(quote.bid) : null,
          ask: quote ? number(quote.ask) : null,
          mode: quote && typeof quote.update_mode === 'string' ? quote.update_mode : null,
        };
      } catch (e) { return null; }
    });
    return { now: Date.now(), evalMs: performance.now() - started, charts };
  } catch (e) { return null; }
})()`;

/** Metadata panelů (čte se zřídka): kontrakt, multiplikátor, režim dat. Pořadí = panel. */
export const TV_CHART_META_EXPRESSION = `(() => {
  try {
    const collection = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
    if (!collection) return [];
    const text = value => typeof value === 'string' ? value : null;
    const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    return collection.getAll().map(widget => {
      try {
        const series = widget.model().mainSeries();
        let info = null;
        try { info = series.symbolInfo(); } catch (e) { info = null; }
        let quote = null;
        try { quote = series.quotes(); } catch (e) { quote = null; }
        return {
          symbol: series.symbol(),
          interval: String(series.interval()),
          fullName: info ? text(info.full_name) : null,
          frontContract: info ? text(info.front_contract) : null,
          pointValue: info ? number(info.pointvalue) : null,
          minMov: info ? number(info.minmov) : null,
          priceScale: info ? number(info.pricescale) : null,
          typespecs: info && Array.isArray(info.typespecs) ? info.typespecs.map(String) : [],
          alternatives: info && Array.isArray(info.alternatives) ? info.alternatives.map(String) : [],
          updateMode: quote ? text(quote.update_mode) : null,
          currentSession: quote ? text(quote.current_session) : null,
          frontContractSwitchTime: quote ? number(quote['front-contract-switch-time']) : null,
        };
      } catch (e) { return null; }
    });
  } catch (e) { return []; }
})()`;

export interface TvChartTarget {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/** Otevřené grafy `tradingview.com/chart` (max 4). Chyba = výjimka volajícímu. */
export async function listTradingViewChartTargets(options: {
  origin?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<TvChartTarget[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(`${options.origin ?? TV_CDP_ORIGIN}/json/list`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
  });
  if (!response.ok) throw new Error(`cdp-list-http-${response.status}`);
  const payload = await response.json() as unknown;
  return (Array.isArray(payload) ? payload as TvChartTarget[] : [])
    .filter(target => target.type === 'page'
      && typeof target.url === 'string'
      && target.url.includes('tradingview.com/chart')
      && typeof target.webSocketDebuggerUrl === 'string')
    .slice(0, MAX_CHART_TARGETS);
}

interface Pending {
  resolve: (reply: { value: unknown; bytes: number }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SocketLike {
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
  send(data: string): void;
  close(): void;
}

/** Trvalé CDP spojení na jeden chart target; posílá jen `Runtime.evaluate`. */
export class TradingViewCdpSession {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private closedFlag = false;
  private readonly closeListeners = new Set<() => void>();

  private constructor(private readonly socket: SocketLike) {
    socket.addEventListener('message', event => {
      const raw = String(event.data ?? '');
      let message: { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown };
      try { message = JSON.parse(raw); } catch { return; }
      const entry = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!entry || typeof message.id !== 'number') return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error || message.result?.exceptionDetails) entry.reject(new Error('cdp-evaluate-failed'));
      else entry.resolve({ value: message.result?.result?.value ?? null, bytes: raw.length });
    });
    const failAll = (error: Error) => {
      this.closedFlag = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      for (const listener of this.closeListeners) {
        try { listener(); } catch { /* posluchač nesmí shodit spojení */ }
      }
      this.closeListeners.clear();
    };
    socket.addEventListener('close', () => failAll(new Error('cdp-closed')));
    socket.addEventListener('error', () => failAll(new Error('cdp-error')));
  }

  static open(url: string, timeoutMs: number, socketFactory: (url: string) => SocketLike = value => new WebSocket(value) as unknown as SocketLike): Promise<TradingViewCdpSession> {
    return new Promise((resolve, reject) => {
      const socket = socketFactory(url);
      const timer = setTimeout(() => { socket.close(); reject(new Error('cdp-open-timeout')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new TradingViewCdpSession(socket)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp-open-failed')); }, { once: true });
    });
  }

  get closed(): boolean { return this.closedFlag; }

  onClose(listener: () => void): void {
    if (this.closedFlag) listener();
    else this.closeListeners.add(listener);
  }

  evaluate(expression: string, timeoutMs: number): Promise<{ value: unknown; bytes: number }> {
    if (this.closedFlag) return Promise.reject(new Error('cdp-closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('cdp-evaluate-timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('cdp-send-failed'));
      }
    });
  }

  close(): void {
    try { this.socket.close(); } catch { /* best effort */ }
  }
}

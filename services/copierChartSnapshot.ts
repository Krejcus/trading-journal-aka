const DEFAULT_CDP_ORIGIN = 'http://127.0.0.1:9222';
const DEFAULT_TIMEOUT_MS = 3_000;

interface CdpTarget {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface TradingViewDedicatedChartRef {
  chartId?: string;
  targetId?: string;
}

export interface TradingViewSnapshotProbe {
  cdpReachable: boolean;
  targetFound: boolean;
  resolved?: TradingViewDedicatedChartRef;
}

export interface TradingViewAlertSnapshotOptions extends CopierChartSnapshotOptions {
  symbol: string;
  timeframe?: string | null;
  dedicated?: TradingViewDedicatedChartRef | null;
  onDedicatedResolved?: (value: TradingViewDedicatedChartRef) => Promise<void> | void;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface TradingViewCopierSnapshotOptions extends CopierChartSnapshotOptions {
  dedicated?: TradingViewDedicatedChartRef | null;
  onDedicatedResolved?: (value: TradingViewDedicatedChartRef) => Promise<void> | void;
  sleepImpl?: (ms: number) => Promise<void>;
}

const chartBoundsExpression = `(() => {
  const el = document.querySelector('.chart-container.active')
    || document.querySelector('.layout__area--center')
    || document.querySelector('.chart-container');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 200 && r.height > 150 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
})()`;

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

const chartIdFromUrl = (url: string | undefined): string | undefined => {
  const match = /tradingview\.com\/chart\/([^/?#]+)\/?/i.exec(url ?? '');
  return match?.[1];
};

const dedicatedTarget = (
  targets: CdpTarget[],
  ref: TradingViewDedicatedChartRef,
): CdpTarget | undefined => targets.find(candidate => (
  candidate.type === 'page'
  && typeof candidate.webSocketDebuggerUrl === 'string'
  && ((ref.targetId && candidate.id === ref.targetId)
    || (ref.chartId && chartIdFromUrl(candidate.url) === ref.chartId))
));

/** Lehký health probe; nic v TradingView nemění a neposílá žádný CDP příkaz. */
export async function probeTradingViewSnapshotTarget(
  options: CopierChartSnapshotOptions & { dedicated?: TradingViewDedicatedChartRef | null } = {},
): Promise<TradingViewSnapshotProbe> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? 1_500));
  try {
    const response = await fetchImpl(`${options.cdpOrigin ?? DEFAULT_CDP_ORIGIN}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { cdpReachable: false, targetFound: false };
    const targets = await response.json() as CdpTarget[];
    const target = Array.isArray(targets)
      ? dedicatedTarget(targets, options.dedicated ?? {})
      : undefined;
    return {
      cdpReachable: true,
      targetFound: Boolean(target),
      ...(target ? { resolved: { targetId: target.id, chartId: chartIdFromUrl(target.url) } } : {}),
    };
  } catch {
    return { cdpReachable: false, targetFound: false };
  }
}

/**
 * Dvojnásobné rozlišení na širokém panelu by přerostlo 2MB limit úložiště
 * snímků, takže se měřítko dopočítá na cílovou šířku ~3200 px.
 */
export function captureScale(cssWidth: number): number {
  if (!Number.isFinite(cssWidth) || cssWidth <= 0) return 2;
  return Math.min(2, Math.max(1, Math.round((3200 / cssWidth) * 100) / 100));
}

/**
 * Počká, až se plátno grafu roztáhne do plné šířky panelu. Po `setLayout('s')`
 * se panel zvětší okamžitě, ale TradingView překresluje asynchronně — capture
 * hned po navigaci proto vyfotí zpola bílou plochu.
 */
function renderReadyExpression(budgetMs: number): string {
  return `(async () => {
    const deadline = Date.now() + ${Math.max(200, Math.round(budgetMs))};
    const painted = () => {
      const el = document.querySelector('.chart-container.active')
        || document.querySelector('.chart-container');
      if (!el) return false;
      const box = el.getBoundingClientRect();
      if (box.width < 200) return false;
      const canvases = Array.from(el.querySelectorAll('canvas'));
      if (canvases.length === 0) return false;
      const dpr = window.devicePixelRatio || 1;
      // Element se roztáhne okamžitě, ale dokud TradingView nerealokuje
      // bitmapu plátna, je nová plocha prázdná — proto se porovnává
      // canvas.width (skutečná bitmapa), ne jen CSS rozměr.
      return canvases.some(c => {
        const css = c.getBoundingClientRect().width;
        return css >= box.width * 0.9 && (c.width / dpr) >= box.width * 0.9;
      });
    };
    while (Date.now() < deadline) {
      if (painted()) {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return true;
      }
      await new Promise(r => setTimeout(r, 80));
    }
    return false;
  })()`;
}

function evaluateExpression(symbol?: string, timeframe?: string): string {
  const navigation = symbol && timeframe
    ? `if (typeof chart.setSymbol !== 'function' || typeof chart.setResolution !== 'function') return false;
    chart.setSymbol(${JSON.stringify(symbol)});
    chart.setResolution(${JSON.stringify(timeframe)});`
    : '';
  return `(() => {
    const api = globalThis.TradingViewApi;
    if (!api) return false;
    // Notifikace na telefonu je malá: jeden graf přes celou šířku má
    // dvojnásobné rozlišení oproti dvěma vedle sebe. Vyhrazený layout
    // existuje jen kvůli snímkům, takže ho srovnáme na jeden panel.
    if (typeof api.setLayout === 'function') {
      try {
        if (api.layout() !== 's') {
          api.setLayout('s');
          // Kompozitor po zvětšení panelu překreslí jen tu část, kde graf
          // byl; bez vynuceného resize zůstane zbytek snímku bílý.
          window.dispatchEvent(new Event('resize'));
        }
      } catch (layoutError) {}
    }
    // Konkrétní panel, ne „ten aktivní" — jinak snímek závisí na tom,
    // kam uživatel naposledy klikl.
    const chart = typeof api.chart === 'function' ? api.chart(0)
      : typeof api.activeChart === 'function' ? api.activeChart() : api;
    if (!chart) return false;
    ${navigation}
    // Reset view: vrátí odscrollovaný/odzoomovaný graf na výchozí pohled
    // (čas i cena, auto-scale); náš offset a bar spacing se nastaví až po něm.
    if (typeof chart.executeActionById === 'function') {
      try { chart.executeActionById('chartReset'); } catch (resetError) {}
    }
    // Hustota svíček se počítá ze šířky panelu, ne natvrdo: 3 px platilo pro
    // poloviční panel a na roztaženém by se načtená historie (~550 svíček)
    // rozprostřela jen do půlky plochy a zbytek zůstal prázdný.
    const pane = document.querySelector('.chart-container.active') || document.querySelector('.chart-container');
    const paneWidth = pane ? pane.getBoundingClientRect().width : 1675;
    const barSpacing = Math.min(40, Math.max(8, Math.round(paneWidth / 140)));
    // Plovoucí lišta kreslení se propisuje doprostřed snímku. Styl se po půl
    // minutě odstraní sám, aby v grafu nezůstal viset ani při pádu capture.
    const hideId = 'alphatrade-snapshot-hide';
    let hide = document.getElementById(hideId);
    if (!hide) {
      hide = document.createElement('style');
      hide.id = hideId;
      hide.textContent = '.tv-floating-toolbar,.floating-toolbar-react-widgets{display:none !important;}';
      document.head.appendChild(hide);
    }
    clearTimeout(window.__alphatradeSnapshotHideTimer);
    window.__alphatradeSnapshotHideTimer = setTimeout(() => { const el = document.getElementById(hideId); if (el) el.remove(); }, 30000);
    // Desktopový build vystavuje časovou osu jako getTimeScale(); timeScale()
    // na chart objektu není, takže se offset i hustota dřív tiše zahazovaly.
    const scale = typeof chart.getTimeScale === 'function' ? chart.getTimeScale()
      : typeof chart.timeScale === 'function' ? chart.timeScale() : null;
    if (typeof chart.setBarSpacing === 'function') chart.setBarSpacing(barSpacing);
    if (scale && typeof scale.setBarSpacing === 'function') scale.setBarSpacing(barSpacing);
    // Volné místo vpravo, kam se vejde vykreslená pozice (entry, SL, TP
    // i s popisky) — počítá se z počtu viditelných svíček, ne natvrdo.
    const visibleBars = Math.max(20, Math.round(paneWidth / barSpacing));
    const rightOffset = Math.min(60, Math.max(12, Math.round(visibleBars * 0.28)));
    if (typeof chart.setRightOffset === 'function') chart.setRightOffset(rightOffset);
    if (scale && typeof scale.setRightOffset === 'function') scale.setRightOffset(rightOffset);
    // Úspěch = graf se přepnul na požadovaný symbol a timeframe. Offset ani
    // hustota svíček nejsou podmínkou: desktopový build TradingView nemá na
    // chart objektu timeScale() ani setRightOffset(), takže dřívější kontrola
    // vracela vždy false a celý snímek padal na nouzovou fotku bez ořezu.
    return true;
  })()`;
}

async function cdpRequest(options: {
  target: CdpTarget;
  commands: Array<{ id: number; method: string; params?: Record<string, unknown> }>;
  timeoutMs: number;
  webSocketFactory: (url: string) => WebSocketLike;
  onCommandResult?: (id: number, result: Record<string, unknown>) => Promise<void> | void;
  /** Chyby těchto příkazů se tolerují (best-effort warm-up na starších Electronech). */
  optionalCommandIds?: readonly number[];
}): Promise<Map<number, Record<string, unknown>>> {
  if (!options.target.webSocketDebuggerUrl) throw new Error('snapshot-cdp-missing-websocket');
  const socket = options.webSocketFactory(options.target.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    const results = new Map<number, Record<string, unknown>>();
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
    const send = (command: { id: number; method: string; params?: Record<string, unknown> }) => socket.send(JSON.stringify(command));
    const onOpen = () => {
      try { send(options.commands[0]); } catch (error) { finish(reject, error); }
    };
    const onMessage = (event: { data?: unknown }) => {
      void (async () => {
        try {
          const message = JSON.parse(String(event.data ?? '')) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
          if (!message.id || !options.commands.some(command => command.id === message.id)) return;
          if (message.error && !options.optionalCommandIds?.includes(message.id)) {
            throw new Error(message.error.message ?? 'snapshot-cdp-error');
          }
          const result = message.error ? {} : (message.result ?? {});
          results.set(message.id, result);
          await options.onCommandResult?.(message.id, result);
          const index = options.commands.findIndex(command => command.id === message.id);
          const next = options.commands[index + 1];
          if (next) send(next);
          else finish(resolve, results);
        } catch (error) { finish(reject, error); }
      })();
    };
    const onError = () => finish(reject, new Error('snapshot-cdp-websocket-error'));
    const onClose = () => finish(reject, new Error('snapshot-cdp-websocket-closed'));
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

/**
 * Navigační capture používá výhradně dříve uložený nebo právě vytvořený CDP
 * target. Jakýkoli problém se do společného šestisekundového budgetu degraduje
 * na původní pasivní F1b screenshot; nikdy nepropadne do trading cesty.
 */
export async function captureTradingViewAlertSnapshot(
  options: TradingViewAlertSnapshotOptions,
): Promise<Buffer | null> {
  return captureTradingViewDedicatedSnapshot(options, true);
}

/**
 * Připraví vyhrazenou kartu jako „horkou kameru" ještě před obchodem. Tady
 * probíhá reset, layout a čekání na plný render; při samotném ENTRY/EXIT už
 * se nic z toho nesmí opakovat. Symbol ani timeframe neměníme — synchronizuje
 * je TradingView z pracovní karty včetně kreseb a position boxu.
 */
export async function prepareTradingViewCopierSnapshot(
  options: TradingViewCopierSnapshotOptions,
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const webSocketFactory = options.webSocketFactory
    ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const sleepImpl = options.sleepImpl ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const totalMs = Math.min(12_000, Math.max(1, options.timeoutMs ?? 6_000));
  const started = Date.now();
  const remaining = () => Math.max(1, totalMs - (Date.now() - started));
  const cdpOrigin = options.cdpOrigin ?? DEFAULT_CDP_ORIGIN;
  try {
    const listResponse = await fetchImpl(`${cdpOrigin}/json/list`, { signal: AbortSignal.timeout(remaining()) });
    if (!listResponse.ok) throw new Error('snapshot-cdp-list-failed');
    const targets = await listResponse.json() as CdpTarget[];
    const target = Array.isArray(targets) ? dedicatedTarget(targets, options.dedicated ?? {}) : undefined;
    if (!target?.webSocketDebuggerUrl || target.type !== 'page' || !target.url?.includes('tradingview.com/chart')) {
      throw new Error('snapshot-cdp-dedicated-tab-missing');
    }
    await options.onDedicatedResolved?.({ targetId: target.id, chartId: chartIdFromUrl(target.url) });
    const waitAfterReset = Math.min(4_500, Math.max(200, remaining() - 500));
    await cdpRequest({
      target,
      timeoutMs: remaining(),
      webSocketFactory,
      optionalCommandIds: [10, 11, 12],
      commands: [
        { id: 10, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
        { id: 11, method: 'Page.enable' },
        { id: 12, method: 'Page.setWebLifecycleState', params: { state: 'active' } },
        { id: 1, method: 'Runtime.evaluate', params: { expression: evaluateExpression(), returnByValue: true } },
        {
          id: 4,
          method: 'Runtime.evaluate',
          params: { expression: renderReadyExpression(waitAfterReset), returnByValue: true, awaitPromise: true },
        },
      ],
      onCommandResult: async (id, result) => {
        if (id === 1) {
          const evaluation = result.result as { value?: unknown } | undefined;
          if (evaluation?.value !== true) throw new Error('snapshot-tv-render-navigation-failed');
        }
        if (id === 4) await sleepImpl(Math.min(250, Math.max(0, remaining() - 50)));
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * ENTRY/EXIT hot capture: karta už je připravená, takže pouze vynutíme aktivní
 * lifecycle, necháme doběhnout dva paint framy a sejmeme oříznutý graf v 1×.
 * Neexistuje fallback na pracovní kartu a žádný příkaz nemění viewport.
 */
export async function captureTradingViewCopierSnapshot(
  options: TradingViewCopierSnapshotOptions,
): Promise<Buffer | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const webSocketFactory = options.webSocketFactory
    ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const totalMs = Math.min(3_000, Math.max(1, options.timeoutMs ?? 1_500));
  const started = Date.now();
  const remaining = () => Math.max(1, totalMs - (Date.now() - started));
  const cdpOrigin = options.cdpOrigin ?? DEFAULT_CDP_ORIGIN;
  try {
    const listResponse = await fetchImpl(`${cdpOrigin}/json/list`, { signal: AbortSignal.timeout(remaining()) });
    if (!listResponse.ok) throw new Error('snapshot-cdp-list-failed');
    const targets = await listResponse.json() as CdpTarget[];
    const target = Array.isArray(targets) ? dedicatedTarget(targets, options.dedicated ?? {}) : undefined;
    if (!target?.webSocketDebuggerUrl || target.type !== 'page' || !target.url?.includes('tradingview.com/chart')) {
      throw new Error('snapshot-cdp-dedicated-tab-missing');
    }
    await options.onDedicatedResolved?.({ targetId: target.id, chartId: chartIdFromUrl(target.url) });
    const captureCommand: { id: number; method: string; params: Record<string, unknown> } = {
      id: 3, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: false },
    };
    const results = await cdpRequest({
      target,
      timeoutMs: remaining(),
      webSocketFactory,
      optionalCommandIds: [10, 11, 12],
      commands: [
        { id: 10, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
        { id: 11, method: 'Page.enable' },
        { id: 12, method: 'Page.setWebLifecycleState', params: { state: 'active' } },
        {
          id: 2,
          method: 'Runtime.evaluate',
          params: {
            expression: `(async () => {
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              return ${chartBoundsExpression};
            })()`,
            returnByValue: true,
            awaitPromise: true,
          },
        },
        captureCommand,
      ],
      onCommandResult: (id, result) => {
        if (id !== 2) return;
        const bounds = (result.result as { value?: unknown } | undefined)?.value as
          { x: number; y: number; width: number; height: number } | null | undefined;
        if (bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
          captureCommand.params = {
            format: 'png', fromSurface: true,
            clip: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 },
          };
        }
      },
    });
    const encoded = results.get(3)?.data;
    if (typeof encoded !== 'string') throw new Error('snapshot-cdp-invalid-response');
    const png = Buffer.from(encoded, 'base64');
    return png.length > 0 ? png : null;
  } catch {
    return null;
  }
}

async function captureTradingViewDedicatedSnapshot(
  options: TradingViewAlertSnapshotOptions | TradingViewCopierSnapshotOptions,
  fallbackToPassive: boolean,
): Promise<Buffer | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const webSocketFactory = options.webSocketFactory
    ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const sleepImpl = options.sleepImpl ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const totalMs = Math.min(12_000, Math.max(1, options.timeoutMs ?? 12_000));
  const started = Date.now();
  const remaining = () => Math.max(1, totalMs - (Date.now() - started));
  const cdpOrigin = options.cdpOrigin ?? DEFAULT_CDP_ORIGIN;
  try {
    const listResponse = await fetchImpl(`${cdpOrigin}/json/list`, { signal: AbortSignal.timeout(remaining()) });
    if (!listResponse.ok) throw new Error('snapshot-cdp-list-failed');
    const targets = await listResponse.json() as CdpTarget[];
    const ref = options.dedicated ?? {};
    // Cílení: targetId (per session) → chartId z konfigurace. ChartId je
    // bezpečné JEN proto, že konfiguraci plní vyhrazený layout „AlphaTrade
    // Snapshoty" s unikátním ID — nikdy layout, který používá uživatel.
    // Electron CDP neumí /json/new, takže bez nalezené záložky se capture
    // vzdá (fallback pasivního snímku řeší catch níže).
    const target = Array.isArray(targets) ? dedicatedTarget(targets, ref) : undefined;
    if (!target) throw new Error('snapshot-cdp-dedicated-tab-missing');
    if (!target?.webSocketDebuggerUrl || target.type !== 'page' || !target.url?.includes('tradingview.com/chart')) {
      throw new Error('snapshot-cdp-invalid-dedicated-target');
    }
    const resolved = { targetId: target.id, chartId: chartIdFromUrl(target.url) };
    await options.onDedicatedResolved?.(resolved);
    const waitAfterNavigation = Math.min(6_000, Math.max(0, remaining() - 1_200));
    // Ořez na plochu grafu: bounds se měří až po navigaci a příkazy jdou
    // sekvenčně, takže clip parametry doplníme dynamicky mezi kroky. Bez
    // nalezených bounds se vyfotí celá stránka (fallback beze změny chování).
    const captureCommand: { id: number; method: string; params?: Record<string, unknown> } = {
      id: 3, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: false },
    };
    const results = await cdpRequest({
      target,
      timeoutMs: remaining(),
      webSocketFactory,
      optionalCommandIds: [10, 11, 12],
      commands: [
        // Pozadí Electron throttluje a graf by zůstal prázdný — emulace fokusu
        // a lifecycle 'active' ho probudí bez krádeže skutečného fokusu.
        { id: 10, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
        { id: 11, method: 'Page.enable' },
        { id: 12, method: 'Page.setWebLifecycleState', params: { state: 'active' } },
        {
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: 'symbol' in options
              ? evaluateExpression(options.symbol, options.timeframe || '1')
              : evaluateExpression(),
            returnByValue: true,
          },
        },
        // Přepnutí na jeden panel je velký reflow; bez čekání na dokreslení
        // by polovina snímku zůstala bílá.
        {
          id: 4,
          method: 'Runtime.evaluate',
          params: { expression: renderReadyExpression(waitAfterNavigation), returnByValue: true, awaitPromise: true },
        },
        { id: 2, method: 'Runtime.evaluate', params: { expression: chartBoundsExpression, returnByValue: true } },
        captureCommand,
      ],
      onCommandResult: async (id, result) => {
        if (id === 1) {
          const evaluation = result.result as { value?: unknown } | undefined;
          if (evaluation?.value !== true) throw new Error('snapshot-tv-render-navigation-failed');
          return;
        }
        if (id === 4) {
          // Doběhlo čekání na dokreslení; ještě chvilka na poslední paint.
          await sleepImpl(Math.min(700, Math.max(0, remaining() - 400)));
          return;
        }
        if (id !== 2) return;
        const bounds = (result.result as { value?: unknown } | undefined)?.value as
          { x: number; y: number; width: number; height: number } | null | undefined;
        if (bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
          // clip funguje jen s fromSurface: true (bez surface ho CDP ignoruje).
          captureCommand.params = {
            format: 'png', fromSurface: true,
            clip: {
              x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
              scale: captureScale(bounds.width),
            },
          };
        }
      },
    });
    const encoded = results.get(3)?.data;
    if (typeof encoded !== 'string') throw new Error('snapshot-cdp-invalid-response');
    const png = Buffer.from(encoded, 'base64');
    if (png.length === 0) throw new Error('snapshot-cdp-invalid-response');
    return png;
  } catch {
    if (!fallbackToPassive) return null;
    return captureTradingViewChartSnapshot({
      cdpOrigin,
      timeoutMs: Math.min(3_000, remaining()),
      fetchImpl,
      webSocketFactory,
    });
  }
}

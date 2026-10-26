import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { TV_BARS_EXPRESSION } from '../../lib/tradingViewBars';
import { evaluateTradingViewChartTargets } from '../../services/tradingViewMarketPrice';

/**
 * Měřicí sonda rychlého kanálu ceny z TradingView Desktop (krok 1 předávky
 * `docs/reviews/candles-realtime-pnl-20261026.md`). Jen čtení: na chart
 * targety posílá výhradně `Runtime.evaluate` s výrazy bez vedlejších efektů —
 * nic nepřepíná, nenaviguje, nemění symbol ani timeframe a nic neposílá ven.
 * Nepoužívá nic z kopírky; worker si dál čte TradingView po svém.
 *
 * Měří latenci čtení poslední svíčky (trvalé spojení i „studené“ jako dnešní
 * worker), jak často se cena mění, zda graf běží realtime (ne zpoždění)
 * a jaký kontrakt je za symbolem grafu.
 *
 *   npx tsx scripts/market-data/tvPriceFeedProbe.ts [--duration 60] [--interval 100] [--cold 20] [--json report.json]
 */

const CDP_ORIGIN = 'http://127.0.0.1:9222';
const READ_TIMEOUT_MS = 1_000;
const MAX_CHART_TARGETS = 4;
/** Intervaly, které návrh kanálu A zvažuje (250–500 ms) + dnešní 1 s. */
const SIMULATED_INTERVALS_MS = [250, 500, 1_000] as const;

/** Lehký výraz rychlého kanálu: poslední svíčka + kotace každého grafu v okně. */
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

/** Statická metadata grafu (čte se jednou): kontrakt, multiplikátor, režim dat. */
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
    }).filter(Boolean);
  } catch (e) { return []; }
})()`;

export interface FastChart {
  symbol: string;
  interval: string;
  bar: [number, number, number, number, number, number] | null;
  last: number | null;
  /** `lp_time` kotace — jen minuta posledního obchodu, ne přesný čas. */
  lastTime: number | null;
  bid: number | null;
  ask: number | null;
  mode: string | null;
}

export interface ChartMeta {
  symbol: string;
  interval: string;
  fullName: string | null;
  frontContract: string | null;
  pointValue: number | null;
  minMov: number | null;
  priceScale: number | null;
  typespecs: string[];
  alternatives: string[];
  updateMode: string | null;
  currentSession: string | null;
  frontContractSwitchTime: number | null;
}

export interface LatencySummary {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

export interface PricePoint {
  /** Epoch ms, kdy sonda hodnotu dostala. */
  at: number;
  price: number;
}

const round = (value: number | null, digits = 1): number | null =>
  value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/** Percentil metodou nejbližšího pořadí. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function summarizeLatency(values: readonly number[]): LatencySummary {
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    n: values.length,
    p50: round(percentile(values, 50), 2),
    p95: round(percentile(values, 95), 2),
    p99: round(percentile(values, 99), 2),
    max: round(values.length ? Math.max(...values) : null, 2),
    mean: round(mean, 2),
  };
}

/** Časy, kdy se cena změnila proti předchozímu vzorku (první vzorek se nepočítá). */
export function changeTimes(points: readonly PricePoint[]): number[] {
  const out: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].price !== points[index - 1].price) out.push(points[index].at);
  }
  return out;
}

export interface SamplingSimulation {
  intervalMs: number;
  /** Kolik zpráv by kanál poslal („posílat jen při změně“). */
  updates: number;
  updatesPerSec: number;
  /** Totéž přepočtené na hodinu stejně živého trhu (odhad kvót Realtime). */
  updatesPerHour: number;
  /** Zpoždění zobrazení proti jemnému vzorkování (čekání na další čtení). */
  meanLagMs: number | null;
  p95LagMs: number | null;
  /** Mezikroky, které hrubší čtení sloučí (pro zobrazení P&L nevadí). */
  collapsed: number;
}

/**
 * Co by ukázalo hrubší čtení (každých `intervalMs`) nad jemně navzorkovanou
 * řadou: počet odeslaných změn a o kolik později by se změna objevila.
 */
export function simulateSampling(points: readonly PricePoint[], intervalMs: number): SamplingSimulation {
  const empty = { intervalMs, updates: 0, updatesPerSec: 0, updatesPerHour: 0, meanLagMs: null, p95LagMs: null, collapsed: 0 };
  if (points.length < 2 || intervalMs <= 0) return empty;
  const start = points[0].at;
  const end = points[points.length - 1].at;
  if (end <= start) return empty;
  let index = 0;
  let observed = points[0].price;
  let updates = 0;
  for (let at = start + intervalMs; at <= end; at += intervalMs) {
    while (index + 1 < points.length && points[index + 1].at <= at) index += 1;
    if (points[index].price !== observed) {
      updates += 1;
      observed = points[index].price;
    }
  }
  const lags: number[] = [];
  const changes = changeTimes(points);
  for (const changedAt of changes) {
    const seenAt = start + Math.ceil((changedAt - start) / intervalMs) * intervalMs;
    if (seenAt <= end) lags.push(seenAt - changedAt);
  }
  const mean = lags.length ? lags.reduce((sum, value) => sum + value, 0) / lags.length : null;
  const perSec = updates / ((end - start) / 1_000);
  return {
    intervalMs,
    updates,
    updatesPerSec: round(perSec, 2) ?? 0,
    updatesPerHour: Math.round(perSec * 3_600),
    meanLagMs: round(mean),
    p95LagMs: round(percentile(lags, 95)),
    collapsed: Math.max(0, changes.length - updates),
  };
}

export interface ChangeSummary {
  samples: number;
  durationSec: number;
  changes: number;
  changesPerSec: number;
  /** Nejvíc změn v jedné vteřině. */
  busiestSecond: number;
  /** Podíl vteřin, ve kterých se cena aspoň jednou změnila. */
  activeSecondsShare: number;
  gapP50Ms: number | null;
  gapP95Ms: number | null;
  /** Nejdelší ticho beze změny — klient nesmí „stojí“ odvozovat jen z ceny. */
  gapMaxMs: number | null;
  simulations: SamplingSimulation[];
}

export function analyzeChanges(
  points: readonly PricePoint[],
  intervals: readonly number[] = SIMULATED_INTERVALS_MS,
): ChangeSummary {
  const changes = changeTimes(points);
  const durationMs = points.length > 1 ? points[points.length - 1].at - points[0].at : 0;
  const durationSec = durationMs / 1_000;
  const perSecond = new Map<number, number>();
  for (const at of changes) {
    const second = Math.floor((at - points[0].at) / 1_000);
    perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
  }
  const gaps = changes.slice(1).map((at, index) => at - changes[index]);
  return {
    samples: points.length,
    durationSec: round(durationSec) ?? 0,
    changes: changes.length,
    changesPerSec: durationSec > 0 ? round(changes.length / durationSec, 2) ?? 0 : 0,
    busiestSecond: perSecond.size ? Math.max(...perSecond.values()) : 0,
    activeSecondsShare: durationSec >= 1 ? round(perSecond.size / Math.ceil(durationSec), 2) ?? 0 : 0,
    gapP50Ms: round(percentile(gaps, 50)),
    gapP95Ms: round(percentile(gaps, 95)),
    gapMaxMs: gaps.length ? round(Math.max(...gaps)) : null,
    simulations: intervals.map(intervalMs => simulateSampling(points, intervalMs)),
  };
}

export type FeedVerdict = 'realtime' | 'delayed' | 'stale' | 'market-closed' | 'unknown';

export interface FeedClassification {
  verdict: FeedVerdict;
  /** Zpoždění dat v s podle `update_mode` (`delayed_streaming_600` → 600). */
  delaySec: number | null;
  /** O kolik období zaostává poslední svíčka za aktuálním obdobím grafu. */
  barLagPeriods: number | null;
  reasons: string[];
}

const intervalSeconds = (interval: string): number | null => {
  if (/^\d+$/.test(interval)) return Number(interval) * 60;
  const match = /^(\d*)([SDWM])$/i.exec(interval);
  if (!match) return null;
  const count = match[1] ? Number(match[1]) : 1;
  const unit = match[2].toUpperCase();
  return unit === 'S' ? count : unit === 'D' ? count * 86_400 : null;
};

/**
 * Realtime, nebo zpoždění? Nejsilnější signál je `update_mode` kotace
 * (`streaming` vs `delayed_streaming_<s>`) a `_DL:` v symbolu; poslední
 * svíčka proti hodinám to ověří nezávisle (10min zpoždění = 10 minutových
 * období pozadu).
 */
export function classifyFeed(input: {
  updateMode: string | null;
  fullName: string | null;
  currentSession: string | null;
  interval: string;
  barTimeSec: number | null;
  nowMs: number;
}): FeedClassification {
  const reasons: string[] = [];
  const nowSec = input.nowMs / 1_000;
  const periodSec = intervalSeconds(input.interval);
  const barLagPeriods = periodSec && input.barTimeSec != null
    ? Math.max(0, Math.floor(nowSec / periodSec) - Math.floor(input.barTimeSec / periodSec))
    : null;
  const mode = input.updateMode ?? '';
  const delayMatch = /delayed[^0-9]*(\d+)/i.exec(mode);
  const delaySec = delayMatch ? Number(delayMatch[1]) : null;
  if (/delayed|endofday/i.test(mode)) reasons.push(`update_mode=${mode}`);
  if (input.fullName?.includes('_DL:')) reasons.push(`symbol=${input.fullName}`);
  if (reasons.length) return { verdict: 'delayed', delaySec, barLagPeriods, reasons };
  if (input.currentSession && input.currentSession !== 'market') {
    return { verdict: 'market-closed', delaySec, barLagPeriods, reasons: [`session=${input.currentSession}`] };
  }
  if (mode !== 'streaming') {
    return { verdict: 'unknown', delaySec, barLagPeriods, reasons: [`update_mode=${mode || 'none'}`] };
  }
  reasons.push('update_mode=streaming');
  // Za klidné noci může minuta bez obchodu chybět; 2+ období už je podezřelé.
  if (barLagPeriods != null && barLagPeriods >= 2) {
    reasons.push(`bar ${barLagPeriods} periods behind clock`);
    return { verdict: 'stale', delaySec, barLagPeriods, reasons };
  }
  return { verdict: 'realtime', delaySec, barLagPeriods, reasons };
}

/** `MNQZ2026` → `MNQZ6` (tvar symbolu pozice v Tradovate). */
export function tradovateContractSymbol(frontContract: string | null): string | null {
  const match = frontContract ? /^([A-Z0-9]{1,6}?)([FGHJKMNQUVXZ])(\d{4})$/.exec(frontContract.toUpperCase()) : null;
  return match ? `${match[1]}${match[2]}${match[3].slice(-1)}` : null;
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface Pending {
  resolve: (reply: { value: unknown; bytes: number }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Trvalé CDP spojení na jeden chart target; posílá jen `Runtime.evaluate`. */
class CdpSession {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly socket: WebSocket) {
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
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
    };
    socket.addEventListener('close', () => failAll(new Error('cdp-closed')));
    socket.addEventListener('error', () => failAll(new Error('cdp-error')));
  }

  static open(url: string, timeoutMs: number): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.close(); reject(new Error('cdp-open-timeout')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpSession(socket)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp-open-failed')); }, { once: true });
    });
  }

  evaluate(expression: string, timeoutMs: number): Promise<{ value: unknown; bytes: number }> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('cdp-evaluate-timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  }

  close(): void {
    try { this.socket.close(); } catch { /* best effort */ }
  }
}

interface FastSample {
  target: number;
  at: number;
  rttMs: number;
  evalMs: number | null;
  pageClockOffsetMs: number | null;
  bytes: number;
  charts: FastChart[];
}

const parseArgs = (argv: readonly string[]) => {
  const value = (name: string, fallback: number) => {
    const index = argv.indexOf(`--${name}`);
    const parsed = index >= 0 ? Number(argv[index + 1]) : fallback;
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid --${name}`);
    return parsed;
  };
  const jsonIndex = argv.indexOf('--json');
  return {
    durationMs: Math.min(30 * 60, Math.max(5, value('duration', 60))) * 1_000,
    intervalMs: Math.min(5_000, Math.max(50, value('interval', 100))),
    coldReads: Math.min(200, Math.floor(value('cold', 20))),
    jsonPath: jsonIndex >= 0 ? argv[jsonIndex + 1] ?? null : null,
    raw: argv.includes('--raw'),
  };
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const isFastChart = (value: unknown): value is FastChart =>
  !!value && typeof value === 'object' && typeof (value as FastChart).symbol === 'string';

async function listChartTargets(): Promise<CdpTarget[]> {
  const response = await fetch(`${CDP_ORIGIN}/json/list`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`cdp-list-http-${response.status}`);
  const payload = await response.json() as unknown;
  return (Array.isArray(payload) ? payload as CdpTarget[] : [])
    .filter(target => target.type === 'page'
      && typeof target.url === 'string'
      && target.url.includes('tradingview.com/chart')
      && typeof target.webSocketDebuggerUrl === 'string')
    .slice(0, MAX_CHART_TARGETS);
}

/** Studené čtení přesně jako dnešní worker: /json/list + nové spojení na každý target. */
async function measureColdReads(count: number, expression: string): Promise<{ latency: LatencySummary; failures: number }> {
  const durations: number[] = [];
  let failures = 0;
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    const readings = await evaluateTradingViewChartTargets(expression, { timeoutMs: 3_000 });
    if (readings.length === 0 || readings.every(reading => reading == null)) failures += 1;
    else durations.push(performance.now() - started);
    await sleep(100);
  }
  return { latency: summarizeLatency(durations), failures };
}

const describeTarget = (target: CdpTarget) => {
  const match = /\/chart\/([^/?#]+)/.exec(target.url ?? '');
  return match ? `chart/${match[1]}` : 'chart';
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let targets: CdpTarget[];
  try {
    targets = await listChartTargets();
  } catch {
    throw new Error(`TradingView CDP na ${CDP_ORIGIN} neodpovídá — běží TradingView Desktop s --remote-debugging-port=9222?`);
  }
  if (targets.length === 0) throw new Error('CDP běží, ale žádný otevřený graf tradingview.com/chart');
  console.log(`TV price probe: targets=${targets.map(describeTarget).join(', ')} duration=${options.durationMs / 1_000}s interval=${options.intervalMs}ms cold=${options.coldReads}`);

  const sessions = await Promise.all(targets.map(target => CdpSession.open(target.webSocketDebuggerUrl!, 2_000)));
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  try {
    const metaBefore = await Promise.all(sessions.map(async session =>
      ((await session.evaluate(TV_CHART_META_EXPRESSION, 3_000)).value as ChartMeta[] | null) ?? []));

    // Plné okno svíček (dnešní worker 1×/min) pro srovnání ceny čtení.
    const fullWindow: { rttMs: number; bytes: number }[] = [];
    for (let index = 0; index < 3; index += 1) {
      const started = performance.now();
      const reply = await sessions[0].evaluate(TV_BARS_EXPRESSION, 5_000);
      fullWindow.push({ rttMs: performance.now() - started, bytes: reply.bytes });
    }

    const samples: FastSample[] = [];
    let errors = 0;
    let overruns = 0;
    const deadline = Date.now() + options.durationMs;
    while (!stopped && Date.now() < deadline) {
      const tickStarted = performance.now();
      await Promise.all(sessions.map(async (session, target) => {
        const sentAt = Date.now();
        const started = performance.now();
        try {
          const reply = await session.evaluate(TV_FAST_PRICE_EXPRESSION, READ_TIMEOUT_MS);
          const rttMs = performance.now() - started;
          const value = reply.value as { now?: unknown; evalMs?: unknown; charts?: unknown } | null;
          if (!value || !Array.isArray(value.charts)) { errors += 1; return; }
          const pageNow = typeof value.now === 'number' ? value.now : null;
          samples.push({
            target,
            at: Date.now(),
            rttMs,
            evalMs: typeof value.evalMs === 'number' ? value.evalMs : null,
            pageClockOffsetMs: pageNow == null ? null : pageNow - (sentAt + rttMs / 2),
            bytes: reply.bytes,
            charts: value.charts.filter(isFastChart),
          });
        } catch {
          errors += 1;
        }
      }));
      const elapsed = performance.now() - tickStarted;
      if (elapsed > options.intervalMs) overruns += 1;
      await sleep(Math.max(0, options.intervalMs - elapsed));
    }

    const cold = options.coldReads > 0 ? await measureColdReads(options.coldReads, TV_FAST_PRICE_EXPRESSION) : null;
    const metaAfter = await Promise.all(sessions.map(async session =>
      ((await session.evaluate(TV_CHART_META_EXPRESSION, 3_000)).value as ChartMeta[] | null) ?? []));
    const nowMs = Date.now();

    // Jedna řada na graf: target × symbol × interval (pořadí grafu v okně).
    const streams = new Map<string, { target: number; chart: number; bar: PricePoint[]; last: PricePoint[]; latest: FastChart }>();
    for (const sample of samples) {
      sample.charts.forEach((chart, chartIndex) => {
        const key = `${sample.target}:${chartIndex}:${chart.symbol}:${chart.interval}`;
        const stream = streams.get(key) ?? { target: sample.target, chart: chartIndex, bar: [], last: [], latest: chart };
        if (chart.bar) stream.bar.push({ at: sample.at, price: chart.bar[4] });
        if (chart.last != null) stream.last.push({ at: sample.at, price: chart.last });
        stream.latest = chart;
        streams.set(key, stream);
      });
    }

    const charts = [...streams.values()].map(stream => {
      const meta = metaAfter[stream.target]?.[stream.chart] ?? metaBefore[stream.target]?.[stream.chart] ?? null;
      const before = metaBefore[stream.target]?.[stream.chart] ?? null;
      const switchTime = meta?.frontContractSwitchTime ?? null;
      return {
        target: describeTarget(targets[stream.target]),
        symbol: stream.latest.symbol,
        interval: stream.latest.interval,
        frontContract: meta?.frontContract ?? null,
        tradovateContract: tradovateContractSymbol(meta?.frontContract ?? null),
        frontContractChangedDuringProbe: !!before && !!meta && before.frontContract !== meta.frontContract,
        rollSwitchAt: switchTime ? new Date(switchTime * 1_000).toISOString() : null,
        rollSwitchInDays: switchTime ? round((switchTime * 1_000 - nowMs) / 86_400_000) : null,
        pointValue: meta?.pointValue ?? null,
        tick: meta?.minMov != null && meta.priceScale ? meta.minMov / meta.priceScale : null,
        typespecs: meta?.typespecs ?? [],
        feed: classifyFeed({
          updateMode: meta?.updateMode ?? stream.latest.mode,
          fullName: meta?.fullName ?? stream.latest.symbol,
          currentSession: meta?.currentSession ?? null,
          interval: stream.latest.interval,
          barTimeSec: stream.latest.bar?.[0] ?? null,
          nowMs,
        }),
        barClose: analyzeChanges(stream.bar),
        quoteLast: analyzeChanges(stream.last),
        lastSample: stream.latest,
      };
    });

    // Stejný symbol a interval ve dvou oknech: shoduje se cena ve stejném čtení?
    const consistency: { pair: string; compared: number; equalShare: number | null; maxDiff: number | null }[] = [];
    const bySeries = new Map<string, FastSample[][]>();
    for (let target = 0; target < sessions.length; target += 1) {
      const own = samples.filter(sample => sample.target === target);
      for (const [index, chart] of (own[0]?.charts ?? []).entries()) {
        const key = `${chart.symbol}:${chart.interval}`;
        if (index > 0 && own[0].charts.slice(0, index).some(other => `${other.symbol}:${other.interval}` === key)) continue;
        bySeries.set(key, [...(bySeries.get(key) ?? []), own]);
      }
    }
    for (const [key, perTarget] of bySeries) {
      if (perTarget.length < 2) continue;
      const [left, right] = perTarget;
      const pick = (sample: FastSample) => sample.charts.find(chart => `${chart.symbol}:${chart.interval}` === key)?.bar?.[4] ?? null;
      const diffs: number[] = [];
      for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        const a = pick(left[index]);
        const b = pick(right[index]);
        if (a != null && b != null) diffs.push(Math.abs(a - b));
      }
      consistency.push({
        pair: key,
        compared: diffs.length,
        equalShare: diffs.length ? round(diffs.filter(diff => diff === 0).length / diffs.length, 3) : null,
        maxDiff: diffs.length ? Math.max(...diffs) : null,
      });
    }

    const report = {
      measuredAt: new Date(nowMs).toISOString(),
      options: { durationSec: options.durationMs / 1_000, intervalMs: options.intervalMs, coldReads: options.coldReads },
      reads: { samples: samples.length, errors, overruns },
      latency: {
        persistentRttMs: summarizeLatency(samples.map(sample => sample.rttMs)),
        inPageEvalMs: summarizeLatency(samples.flatMap(sample => sample.evalMs == null ? [] : [sample.evalMs])),
        coldReadMs: cold?.latency ?? null,
        coldFailures: cold?.failures ?? null,
        fastPayloadBytes: summarizeLatency(samples.map(sample => sample.bytes)),
        fullWindowRttMs: summarizeLatency(fullWindow.map(entry => entry.rttMs)),
        fullWindowPayloadBytes: fullWindow[0]?.bytes ?? null,
        pageClockOffsetMs: summarizeLatency(samples.flatMap(sample => sample.pageClockOffsetMs == null ? [] : [sample.pageClockOffsetMs])),
      },
      charts,
      consistency,
      ...(options.raw ? { samples } : {}),
    };

    printReport(report);
    if (options.jsonPath) {
      await writeFile(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`report: ${options.jsonPath}`);
    }
  } finally {
    for (const session of sessions) session.close();
  }
}

type ProbeReport = {
  measuredAt: string;
  reads: { samples: number; errors: number; overruns: number };
  latency: Record<string, LatencySummary | number | null>;
  charts: Array<{
    target: string; symbol: string; interval: string; frontContract: string | null; tradovateContract: string | null;
    frontContractChangedDuringProbe: boolean; rollSwitchAt: string | null; rollSwitchInDays: number | null;
    pointValue: number | null; tick: number | null; feed: FeedClassification; barClose: ChangeSummary; quoteLast: ChangeSummary;
  }>;
  consistency: { pair: string; compared: number; equalShare: number | null; maxDiff: number | null }[];
};

const fmt = (summary: LatencySummary | number | null | undefined) => {
  if (summary == null || typeof summary === 'number') return String(summary ?? '–');
  return `p50=${summary.p50} p95=${summary.p95} p99=${summary.p99} max=${summary.max} (n=${summary.n})`;
};

function printReport(report: ProbeReport): void {
  const { latency } = report;
  console.log(`\nreads: samples=${report.reads.samples} errors=${report.reads.errors} overruns=${report.reads.overruns}`);
  console.log(`latency persistent RTT ms: ${fmt(latency.persistentRttMs)}`);
  console.log(`latency in-page eval ms:   ${fmt(latency.inPageEvalMs)}`);
  console.log(`latency cold read ms (worker path, all targets): ${fmt(latency.coldReadMs)} failures=${latency.coldFailures ?? '–'}`);
  console.log(`payload fast bytes: ${fmt(latency.fastPayloadBytes)}`);
  console.log(`full 1m window (TV_BARS_EXPRESSION): rtt ms ${fmt(latency.fullWindowRttMs)} bytes=${latency.fullWindowPayloadBytes}`);
  console.log(`page clock offset ms: ${fmt(latency.pageClockOffsetMs)}`);
  for (const chart of report.charts) {
    console.log(`\n${chart.target} ${chart.symbol} ${chart.interval}: front=${chart.frontContract} (Tradovate ${chart.tradovateContract}) pointValue=${chart.pointValue} tick=${chart.tick}`);
    console.log(`  roll: switch=${chart.rollSwitchAt} in ${chart.rollSwitchInDays} d${chart.frontContractChangedDuringProbe ? ' — FRONT CONTRACT CHANGED DURING PROBE' : ''}`);
    console.log(`  feed: ${chart.feed.verdict} (${chart.feed.reasons.join('; ')}) barLagPeriods=${chart.feed.barLagPeriods}`);
    for (const [label, summary] of [['bar close', chart.barClose], ['quote last', chart.quoteLast]] as const) {
      console.log(`  ${label}: changes=${summary.changes}/${summary.durationSec}s (${summary.changesPerSec}/s, busiest ${summary.busiestSecond}/s, active ${Math.round(summary.activeSecondsShare * 100)} % s) gap p50=${summary.gapP50Ms} p95=${summary.gapP95Ms} max=${summary.gapMaxMs} ms`);
      for (const sim of summary.simulations) {
        console.log(`    every ${sim.intervalMs} ms → ${sim.updates} msgs (${sim.updatesPerSec}/s ≈ ${sim.updatesPerHour}/h), lag mean=${sim.meanLagMs} p95=${sim.p95LagMs} ms, collapsed=${sim.collapsed}`);
      }
    }
  }
  for (const entry of report.consistency) {
    console.log(`\nconsistency ${entry.pair} across windows: compared=${entry.compared} equal=${entry.equalShare} maxDiff=${entry.maxDiff}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : 'probe-failed');
    process.exitCode = 1;
  });
}

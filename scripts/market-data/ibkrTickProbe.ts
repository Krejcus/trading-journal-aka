import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { type Contract, type ContractDetails, ErrorCode, MarketDataType, SecType } from '@stoqey/ib';
import {
  assertGatewayEndpoint,
  createReadOnlyIbClient,
  IB_GATEWAY_HOST,
  IB_ALLOWED_PORTS,
  nextTradesRequestAt,
  pickFrontContract,
  redactAccountIds,
  toFrontCandidate,
  type FrontContractCandidate,
  type IbMinuteBar,
  type IbTrade,
} from '../../services/ibkrMarketData';

export {
  assertGatewayEndpoint,
  createReadOnlyIbClient,
  IB_ALLOWED_PORTS,
  IB_GATEWAY_HOST,
  nextTradesRequestAt,
  parseIbDate,
  pickFrontContract,
  redactAccountIds,
  TICK_BY_TICK_REQUEST_GAP_MS,
  toFrontCandidate,
  type FrontContractCandidate,
  type ReadOnlyIbClient,
  type ReadOnlyIbHandlers,
} from '../../services/ibkrMarketData';

export type ProbeTick = IbTrade;
export type ProbeBar = IbMinuteBar;

/**
 * Měřicí sonda živých dat z Interactive Brokers (fáze 1 předávky
 * `docs/reviews/ibkr-live-data-handoff-20261027.md`). Jen čtení:
 *
 * - připojuje se výhradně na IB Gateway na 127.0.0.1 (Gateway má mít zapnuté
 *   „Read-Only API“, takže ani spojení samo příkaz neprovede);
 * - z knihovny pouští jen čtecí volání přes `createReadOnlyIbClient` — žádné
 *   příkazy, účty, pozice ani exekuce (`services/ibkrMarketData.ts`, hlídá
 *   `tests/ibkrMarketData.test.ts`);
 * - nic z kopírky ani workeru neimportuje a nic neposílá ven;
 * - čísla účtů, která Gateway pošle po připojení, neposlouchá, a z textů chyb
 *   je vymaže.
 *
 * Měří tok obchodů (`reqTickByTickData` AllLast), úplnost proti dennímu objemu
 * IBKR a proti jejich 1m svíčkám (objem i počet obchodů za minutu), zpoždění
 * (čas obchodu má jen sekundy) a stabilitu spojení. `--raw-ticks` uloží
 * jednotlivé obchody pro pozdější porovnání s Databentem.
 *
 *   npx tsx scripts/market-data/ibkrTickProbe.ts [--duration 600] [--port 4001] [--client-id 91]
 *     [--symbol MNQ] [--local-symbol MNQZ6] [--roll-days 8] [--json report.json] [--raw-ticks ticks.ndjson]
 */

const CONNECT_TIMEOUT_MS = 10_000;
const CONTRACT_TIMEOUT_MS = 10_000;
const HISTORY_TIMEOUT_MS = 20_000;
const RECONNECT_DELAY_MS = 20_000;
const PROGRESS_EVERY_MS = 30_000;
const SECONDS_PER_MINUTE = 60;

// ---------------------------------------------------------------------------
// Výpočty (čisté funkce)
// ---------------------------------------------------------------------------

/** Percentil metodou nejbližšího pořadí. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const round = (value: number | null, digits = 2): number | null =>
  value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;


export interface TickFlowSummary {
  ticks: number;
  contracts: number;
  durationSec: number;
  ticksPerSec: number | null;
  perSecond: { p50: number | null; p95: number | null; max: number | null };
  max100ms: number;
  gapMs: { p50: number | null; p95: number | null; max: number | null };
  /** Podíl obchodů, které přišly ve stejné ms jako předchozí (dávky z Gateway). */
  sameMsShare: number | null;
  pastLimit: number;
  unreported: number;
  priceMin: number | null;
  priceMax: number | null;
}

export function summarizeTickFlow(ticks: readonly ProbeTick[]): TickFlowSummary {
  const received = ticks.map(tick => tick.receivedAt);
  const first = received.length > 0 ? Math.min(...received) : 0;
  const last = received.length > 0 ? Math.max(...received) : 0;
  const durationSec = received.length > 1 ? (last - first) / 1_000 : 0;
  const seconds = new Map<number, number>();
  const windows100 = new Map<number, number>();
  for (const at of received) {
    const second = Math.floor((at - first) / 1_000);
    seconds.set(second, (seconds.get(second) ?? 0) + 1);
    const window = Math.floor(at / 100);
    windows100.set(window, (windows100.get(window) ?? 0) + 1);
  }
  const perSecond: number[] = [];
  const secondCount = Math.floor(durationSec) + (received.length > 0 ? 1 : 0);
  for (let second = 0; second < secondCount; second += 1) perSecond.push(seconds.get(second) ?? 0);
  const gaps: number[] = [];
  let sameMs = 0;
  for (let index = 1; index < received.length; index += 1) {
    const gap = received[index] - received[index - 1];
    gaps.push(gap);
    if (gap === 0) sameMs += 1;
  }
  const prices = ticks.map(tick => tick.price);
  return {
    ticks: ticks.length,
    contracts: ticks.reduce((sum, tick) => sum + tick.size, 0),
    durationSec: round(durationSec, 1) ?? 0,
    ticksPerSec: durationSec > 0 ? round(ticks.length / durationSec, 1) : null,
    perSecond: { p50: percentile(perSecond, 50), p95: percentile(perSecond, 95), max: perSecond.length ? Math.max(...perSecond) : null },
    max100ms: windows100.size ? Math.max(...windows100.values()) : 0,
    gapMs: { p50: percentile(gaps, 50), p95: percentile(gaps, 95), max: gaps.length ? Math.max(...gaps) : null },
    sameMsShare: gaps.length ? round(sameMs / gaps.length, 3) : null,
    pastLimit: ticks.filter(tick => tick.pastLimit).length,
    unreported: ticks.filter(tick => tick.unreported).length,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
  };
}

export interface LagSummary {
  /** Doručení − začátek sekundy obchodu; obsahuje až 1 000 ms zaokrouhlení. */
  lagMs: { p50: number | null; p95: number | null; max: number | null };
  /** Podíl obchodů doručených prokazatelně o víc než 1 s později (zpožděná data, fronta). */
  provablyLateShare: number | null;
}

export function summarizeLag(ticks: readonly ProbeTick[]): LagSummary {
  const lags = ticks.map(tick => tick.receivedAt - tick.time * 1_000);
  const late = ticks.filter(tick => tick.receivedAt - (tick.time + 1) * 1_000 > 1_000).length;
  return {
    lagMs: { p50: percentile(lags, 50), p95: percentile(lags, 95), max: lags.length ? Math.max(...lags) : null },
    provablyLateShare: ticks.length ? round(late / ticks.length, 4) : null,
  };
}

export function aggregateTicksToMinutes(ticks: readonly ProbeTick[]): Map<number, ProbeBar> {
  const bars = new Map<number, ProbeBar>();
  const ordered = [...ticks].sort((a, b) => a.time - b.time || a.receivedAt - b.receivedAt);
  for (const tick of ordered) {
    const minute = Math.floor(tick.time / SECONDS_PER_MINUTE) * SECONDS_PER_MINUTE;
    const bar = bars.get(minute);
    if (!bar) {
      bars.set(minute, { time: minute, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: tick.size, count: 1 });
      continue;
    }
    bar.high = Math.max(bar.high, tick.price);
    bar.low = Math.min(bar.low, tick.price);
    bar.close = tick.price;
    bar.volume += tick.size;
    bar.count = (bar.count ?? 0) + 1;
  }
  return bars;
}

export interface MinuteComparisonRow {
  time: number;
  tickVolume: number;
  ibVolume: number;
  tickCount: number;
  ibCount: number | null;
  ohlcMatch: boolean;
  diff: { open: number; high: number; low: number; close: number };
}

export interface MinuteComparison {
  compared: number;
  ohlcMatches: number;
  /** Medián objemu z ticků / objem svíčky IBKR. */
  volumeRatioMedian: number | null;
  volumeRatioMin: number | null;
  countRatioMedian: number | null;
  missingInTicks: number;
  rows: MinuteComparisonRow[];
}

/**
 * Porovná jen celé minuty uvnitř měření (první a poslední minuta jsou neúplné).
 * Ceny stejné, když se liší méně než o půl ticku.
 */
export function compareMinuteBars(
  tickBars: ReadonlyMap<number, ProbeBar>,
  ibBars: ReadonlyMap<number, ProbeBar>,
  window: { fromSec: number; toSec: number },
  tickSize: number,
): MinuteComparison {
  const firstFull = Math.ceil(window.fromSec / SECONDS_PER_MINUTE) * SECONDS_PER_MINUTE;
  const lastFullStart = Math.floor(window.toSec / SECONDS_PER_MINUTE) * SECONDS_PER_MINUTE - SECONDS_PER_MINUTE;
  const rows: MinuteComparisonRow[] = [];
  let missingInTicks = 0;
  for (let minute = firstFull; minute <= lastFullStart; minute += SECONDS_PER_MINUTE) {
    const ib = ibBars.get(minute);
    if (!ib || ib.volume <= 0) continue;
    const mine = tickBars.get(minute);
    if (!mine) {
      missingInTicks += 1;
      continue;
    }
    const diff = {
      open: mine.open - ib.open,
      high: mine.high - ib.high,
      low: mine.low - ib.low,
      close: mine.close - ib.close,
    };
    rows.push({
      time: minute,
      tickVolume: mine.volume,
      ibVolume: ib.volume,
      tickCount: mine.count ?? 0,
      ibCount: ib.count,
      ohlcMatch: Object.values(diff).every(value => Math.abs(value) < tickSize / 2),
      diff,
    });
  }
  const volumeRatios = rows.map(row => row.tickVolume / row.ibVolume);
  const countRatios = rows.filter(row => row.ibCount).map(row => row.tickCount / (row.ibCount as number));
  return {
    compared: rows.length,
    ohlcMatches: rows.filter(row => row.ohlcMatch).length,
    volumeRatioMedian: round(percentile(volumeRatios, 50), 4),
    volumeRatioMin: volumeRatios.length ? round(Math.min(...volumeRatios), 4) : null,
    countRatioMedian: round(percentile(countRatios, 50), 4),
    missingInTicks,
    rows,
  };
}

export interface VolumeSample {
  receivedAt: number;
  volume: number;
}

export interface VolumeCompleteness {
  ibDelta: number | null;
  tickSum: number | null;
  ratio: number | null;
}

/** Součet velikostí obchodů mezi prvním a posledním denním objemem IBKR vs. jeho přírůstek. */
export function volumeCompleteness(samples: readonly VolumeSample[], ticks: readonly ProbeTick[]): VolumeCompleteness {
  if (samples.length < 2) return { ibDelta: null, tickSum: null, ratio: null };
  const first = samples[0];
  const last = samples[samples.length - 1];
  const ibDelta = last.volume - first.volume;
  const tickSum = ticks
    .filter(tick => tick.receivedAt > first.receivedAt && tick.receivedAt <= last.receivedAt)
    .reduce((sum, tick) => sum + tick.size, 0);
  return { ibDelta, tickSum, ratio: ibDelta > 0 ? round(tickSum / ibDelta, 4) : null };
}

export interface ConnectionEvent {
  at: number;
  kind: 'connected' | 'disconnected' | 'error' | 'info';
  code?: number;
  reqId?: number;
  message?: string;
}

export interface VerdictCheck {
  name: string;
  ok: boolean | null;
  detail: string;
}

export function buildVerdict(input: {
  marketDataType: number | null;
  flow: TickFlowSummary;
  lag: LagSummary;
  volume: VolumeCompleteness;
  minutes: MinuteComparison;
  events: readonly ConnectionEvent[];
}): VerdictCheck[] {
  const codes = new Set(input.events.filter(event => event.code != null).map(event => event.code));
  const ohlcShare = input.minutes.compared ? input.minutes.ohlcMatches / input.minutes.compared : null;
  return [
    {
      name: 'živá data (ne zpožděná)',
      ok: input.marketDataType == null ? null : input.marketDataType === MarketDataType.REALTIME,
      detail: `marketDataType=${input.marketDataType ?? 'nepřišel'}`,
    },
    { name: 'obchody chodí', ok: input.flow.ticks > 0, detail: `${input.flow.ticks} obchodů, ${input.flow.contracts} kontraktů` },
    {
      name: 'objem obchodů = denní objem IBKR (±2 %)',
      ok: input.volume.ratio == null ? null : Math.abs(input.volume.ratio - 1) <= 0.02,
      detail: `ticky ${input.volume.tickSum ?? '–'} / IBKR ${input.volume.ibDelta ?? '–'} = ${input.volume.ratio ?? '–'}`,
    },
    {
      name: 'minuty z ticků = 1m svíčky IBKR (OHLC ≥ 95 %)',
      ok: ohlcShare == null ? null : ohlcShare >= 0.95,
      detail: `${input.minutes.ohlcMatches}/${input.minutes.compared} minut, objem medián ${input.minutes.volumeRatioMedian ?? '–'}, min ${input.minutes.volumeRatioMin ?? '–'}, počet obchodů medián ${input.minutes.countRatioMedian ?? '–'}`,
    },
    {
      name: 'bez zpoždění > 1 s (< 1 % obchodů)',
      ok: input.lag.provablyLateShare == null ? null : input.lag.provablyLateShare < 0.01,
      detail: `podíl ${input.lag.provablyLateShare ?? '–'}`,
    },
    {
      name: 'bez souběžného přihlášení a výpadku spojení',
      ok: ![10197, ErrorCode.FAIL_CONNECTION_LOST_BETWEEN_SERVER_AND_TWS, ErrorCode.NOT_CONNECTED].some(code => codes.has(code)),
      detail: `kódy: ${[...codes].sort((a, b) => (a ?? 0) - (b ?? 0)).join(', ') || 'žádné'}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Běh
// ---------------------------------------------------------------------------

interface ProbeOptions {
  durationMs: number;
  port: number;
  clientId: number;
  symbol: string;
  localSymbol: string | null;
  rollDays: number;
  jsonPath: string | null;
  rawTicksPath: string | null;
}

export function parseProbeArgs(argv: readonly string[]): ProbeOptions {
  const text = (name: string): string | null => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] ?? null : null;
  };
  const number = (name: string, fallback: number) => {
    const raw = text(name);
    const parsed = raw == null ? fallback : Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid --${name}`);
    return parsed;
  };
  const port = number('port', 4001);
  assertGatewayEndpoint(IB_GATEWAY_HOST, port);
  const symbol = (text('symbol') ?? 'MNQ').toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(symbol)) throw new Error('invalid --symbol');
  return {
    durationMs: Math.min(6 * 3_600, Math.max(30, number('duration', 600))) * 1_000,
    port,
    clientId: Math.floor(number('client-id', 91)),
    symbol,
    localSymbol: text('local-symbol'),
    rollDays: Math.min(30, number('roll-days', 8)),
    jsonPath: text('json'),
    rawTicksPath: text('raw-ticks'),
  };
}

const REQ = { contract: 1, trades: 2, volume: 3, sessionBars: 4, finalBars: 5 } as const;
const MAX_STORED_TICKS = 2_000_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs: number, stop?: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    if (stop?.()) return false;
    await sleep(50);
  }
  return predicate();
};

const isoSec = (sec: number | null) => (sec == null ? null : new Date(sec * 1_000).toISOString());

async function main(): Promise<void> {
  const options = parseProbeArgs(process.argv.slice(2));
  const library = (createRequire(import.meta.url)('@stoqey/ib/package.json') as { version: string }).version;
  const startedAt = Date.now();
  const events: ConnectionEvent[] = [];
  const ticks: ProbeTick[] = [];
  const volumeSamples: VolumeSample[] = [];
  const contractDetails: ContractDetails[] = [];
  const sessionBars = new Map<number, ProbeBar>();
  const finalBars = new Map<number, ProbeBar>();
  let connected = false;
  let contractsDone = false;
  let sessionBarsDone = false;
  let finalBarsDone = false;
  let marketDataType: number | null = null;
  let droppedTicks = 0;
  let stopRequested = false;
  let lastTradesRequestAt: number | null = null;
  let resubscribeAt: number | null = null;

  const client = createReadOnlyIbClient(
    { port: options.port, clientId: options.clientId },
    {
      onConnected: () => {
        connected = true;
        events.push({ at: Date.now(), kind: 'connected' });
      },
      onDisconnected: () => {
        connected = false;
        events.push({ at: Date.now(), kind: 'disconnected' });
      },
      onError: (code, reqId, message) => {
        events.push({ at: Date.now(), kind: 'error', code, reqId, message: message.slice(0, 300) });
        // 1101 = spojení obnoveno, ale odběry ztraceny → znovu, nejdřív za 15 s.
        if (code === ErrorCode.CONNECTIVITY_RESTORED_DATA_LOST) resubscribeAt = nextTradesRequestAt(lastTradesRequestAt);
        if (reqId === REQ.contract) contractsDone = true;
        if (reqId === REQ.sessionBars) sessionBarsDone = true;
        if (reqId === REQ.finalBars) finalBarsDone = true;
      },
      onInfo: (code, message) => events.push({ at: Date.now(), kind: 'info', code, message: message.slice(0, 300) }),
      onMarketDataType: (_reqId, type) => {
        marketDataType = type;
      },
      onContractDetails: (reqId, details) => {
        if (reqId === REQ.contract) contractDetails.push(details);
      },
      onContractDetailsEnd: reqId => {
        if (reqId === REQ.contract) contractsDone = true;
      },
      onTick: (reqId, tick) => {
        if (reqId !== REQ.trades) return;
        if (ticks.length < MAX_STORED_TICKS) ticks.push(tick);
        else droppedTicks += 1;
      },
      onVolume: (reqId, volume, receivedAt) => {
        if (reqId === REQ.volume) volumeSamples.push({ receivedAt, volume });
      },
      onBar: (reqId, bar) => {
        if (reqId === REQ.sessionBars) sessionBars.set(bar.time, bar);
        if (reqId === REQ.finalBars) finalBars.set(bar.time, bar);
      },
      onBarsEnd: reqId => {
        if (reqId === REQ.sessionBars) sessionBarsDone = true;
        if (reqId === REQ.finalBars) finalBarsDone = true;
      },
    },
  );

  process.once('SIGINT', () => {
    stopRequested = true;
    console.log('\nkonec na Ctrl+C — skládám report…');
  });

  client.connect();
  if (!(await waitFor(() => connected, CONNECT_TIMEOUT_MS))) {
    client.disconnect();
    throw new Error(
      `IB Gateway na ${IB_GATEWAY_HOST}:${options.port} neodpovídá — běží Gateway, je přihlášený a má zapnuté API (port ${options.port})?`,
    );
  }
  client.requestRealtimeData();
  client.requestContractDetails(REQ.contract, {
    symbol: options.symbol,
    secType: SecType.FUT,
    exchange: 'CME',
    currency: 'USD',
  });
  await waitFor(() => contractsDone, CONTRACT_TIMEOUT_MS);
  const candidates = contractDetails.map(toFrontCandidate).filter((value): value is FrontContractCandidate => value != null);
  const front = pickFrontContract(candidates, Date.now(), options.rollDays, options.localSymbol);
  if (!front) {
    client.disconnect();
    throw new Error(`kontrakt ${options.localSymbol ?? options.symbol} na CME nenalezen (${candidates.length} kandidátů)`);
  }
  const tickSize = contractDetails.find(details => details.contract?.conId === front.conId)?.minTick ?? 0.25;
  const contract: Contract = { conId: front.conId, exchange: 'CME' };
  console.log(`kontrakt ${front.localSymbol} (conId ${front.conId}, expirace ${front.lastTradeDate}, tick ${tickSize}) — měřím ${options.durationMs / 1_000} s…`);

  const subscribe = () => {
    lastTradesRequestAt = Date.now();
    client.subscribeTrades(REQ.trades, contract);
    client.subscribeVolume(REQ.volume, contract);
  };
  subscribe();
  // Celá dnešní session: od kdy IBKR 1m svíčky dá (VWAP od 18:00 ET).
  client.requestMinuteBars(REQ.sessionBars, contract, '1 D');

  const measureStart = Date.now();
  const measureEnd = measureStart + options.durationMs;
  let nextProgress = measureStart + PROGRESS_EVERY_MS;
  let nextReconnect: number | null = null;
  while (Date.now() < measureEnd && !stopRequested) {
    const now = Date.now();
    if (!connected) {
      nextReconnect ??= now + RECONNECT_DELAY_MS;
      if (now >= nextReconnect) {
        nextReconnect = null;
        client.connect();
        if (await waitFor(() => connected, CONNECT_TIMEOUT_MS, () => stopRequested)) {
          resubscribeAt = nextTradesRequestAt(lastTradesRequestAt);
        }
      }
    } else if (resubscribeAt != null && now >= resubscribeAt) {
      resubscribeAt = null;
      subscribe();
    }
    if (now >= nextProgress) {
      nextProgress += PROGRESS_EVERY_MS;
      const last = ticks[ticks.length - 1];
      console.log(`  ${Math.round((now - measureStart) / 1_000)} s: ${ticks.length} obchodů, poslední ${last?.price ?? '–'}${connected ? '' : ' — ODPOJENO'}`);
    }
    await sleep(200);
  }
  const measuredUntil = Date.now();

  if (connected) {
    client.cancelTrades(REQ.trades);
    client.cancelVolume(REQ.volume);
    await waitFor(() => sessionBarsDone, HISTORY_TIMEOUT_MS);
    // Konečné 1m svíčky měřeného okna (po skončení minut, ne rozpracované).
    await sleep(2_000);
    const spanSec = Math.min(86_400, Math.ceil((measuredUntil - measureStart) / 1_000) + 180);
    client.requestMinuteBars(REQ.finalBars, contract, `${spanSec} S`);
    await waitFor(() => finalBarsDone, HISTORY_TIMEOUT_MS);
    client.disconnect();
  }

  const flow = summarizeTickFlow(ticks);
  const lag = summarizeLag(ticks);
  const volume = volumeCompleteness(volumeSamples, ticks);
  const minutes = compareMinuteBars(
    aggregateTicksToMinutes(ticks),
    finalBars,
    { fromSec: measureStart / 1_000, toSec: measuredUntil / 1_000 },
    tickSize,
  );
  const sessionTimes = [...sessionBars.keys()].sort((a, b) => a - b);
  const verdict = buildVerdict({ marketDataType, flow, lag, volume, minutes, events });
  const report = {
    probe: 'ibkr-tick-probe',
    library: `@stoqey/ib ${library}`,
    startedAt: new Date(startedAt).toISOString(),
    measured: { from: new Date(measureStart).toISOString(), to: new Date(measuredUntil).toISOString() },
    gateway: { host: IB_GATEWAY_HOST, port: options.port, clientId: options.clientId },
    contract: { ...front, tickSize },
    marketDataType,
    flow,
    lag,
    volume,
    minutes,
    session: {
      bars: sessionTimes.length,
      firstBar: isoSec(sessionTimes[0] ?? null),
      lastBar: isoSec(sessionTimes[sessionTimes.length - 1] ?? null),
    },
    droppedTicks,
    events: events.map(event => ({ ...event, at: new Date(event.at).toISOString() })),
    verdict,
  };

  printReport(report);
  if (options.jsonPath) {
    await writeFile(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nreport: ${options.jsonPath}`);
  }
  if (options.rawTicksPath) {
    await writeFile(options.rawTicksPath, ticks.map(tick => JSON.stringify(tick)).join('\n') + '\n', 'utf8');
    console.log(`ticky: ${options.rawTicksPath} (${ticks.length})`);
  }
  if (flow.ticks === 0) process.exitCode = 1;
}

const fmtRange = (summary: { p50: number | null; p95: number | null; max: number | null }) =>
  `p50=${summary.p50 ?? '–'} p95=${summary.p95 ?? '–'} max=${summary.max ?? '–'}`;

function printReport(report: {
  contract: FrontContractCandidate & { tickSize: number };
  marketDataType: number | null;
  flow: TickFlowSummary;
  lag: LagSummary;
  volume: VolumeCompleteness;
  minutes: MinuteComparison;
  session: { bars: number; firstBar: string | null; lastBar: string | null };
  events: Array<{ kind: string; code?: number; message?: string }>;
  verdict: VerdictCheck[];
}): void {
  const { flow, lag, minutes } = report;
  console.log(`\n${report.contract.localSymbol}: marketDataType=${report.marketDataType ?? '–'}`);
  console.log(`obchody: ${flow.ticks} (${flow.contracts} kontraktů) za ${flow.durationSec} s = ${flow.ticksPerSec ?? '–'}/s`);
  console.log(`  za sekundu ${fmtRange(flow.perSecond)}, nejvíc za 100 ms ${flow.max100ms}`);
  console.log(`  mezery ms ${fmtRange(flow.gapMs)}, ve stejné ms ${flow.sameMsShare ?? '–'}, pastLimit ${flow.pastLimit}, unreported ${flow.unreported}`);
  console.log(`  cena ${flow.priceMin ?? '–'} – ${flow.priceMax ?? '–'}`);
  console.log(`zpoždění ms (vč. až 1 s zaokrouhlení) ${fmtRange(lag.lagMs)}, prokazatelně > 1 s: ${lag.provablyLateShare ?? '–'}`);
  console.log(`objem: ticky ${report.volume.tickSum ?? '–'} / IBKR ${report.volume.ibDelta ?? '–'} = ${report.volume.ratio ?? '–'}`);
  console.log(`minuty: ${minutes.ohlcMatches}/${minutes.compared} OHLC shoda, objem medián ${minutes.volumeRatioMedian ?? '–'} min ${minutes.volumeRatioMin ?? '–'}, počet obchodů medián ${minutes.countRatioMedian ?? '–'}, chybí v ticcích ${minutes.missingInTicks}`);
  for (const row of minutes.rows.filter(row => !row.ohlcMatch).slice(0, 10)) {
    console.log(`  ${isoSec(row.time)} rozdíl O/H/L/C ${row.diff.open}/${row.diff.high}/${row.diff.low}/${row.diff.close}, objem ${row.tickVolume}/${row.ibVolume}`);
  }
  console.log(`dnešní 1m svíčky z IBKR: ${report.session.bars} (${report.session.firstBar ?? '–'} → ${report.session.lastBar ?? '–'})`);
  const codes = report.events.filter(event => event.code != null);
  if (codes.length) {
    console.log('hlášky Gateway:');
    for (const event of codes.slice(0, 30)) console.log(`  ${event.kind} ${event.code}: ${event.message ?? ''}`);
  }
  console.log('\nverdikt:');
  for (const check of report.verdict) {
    console.log(`  ${check.ok == null ? '?' : check.ok ? '✓' : '✗'} ${check.name} — ${check.detail}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error instanceof Error ? redactAccountIds(error.message) : 'probe-failed');
    process.exitCode = 1;
  });
}

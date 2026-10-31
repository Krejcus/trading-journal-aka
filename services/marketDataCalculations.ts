/** Pure market calculations shared by charts and analytics workers. No transport, auth or storage. */
/** Pevné timeframy (tabulky kontextu a okna grafu jsou laděné na ně). */
export type BuiltinMarketTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
/**
 * Timeframe grafu: pevný, vlastní počet minut (`7m`) nebo hodin (`2h`),
 * týden (`W`) a měsíc (`M`). Vlastní se skládá z 1m (nebo 1h) stejně jako pevný.
 */
export type MarketTimeframe = BuiltinMarketTimeframe | `${number}m` | `${number}h` | 'W' | 'M';
export type MarketDataSchema = 'ohlcv-1m' | 'ohlcv-1h';

export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketCandleResponse {
  /** `tradingview` = předběžné svíčky z workeru, jen pro graf hodnocení do příchodu Databenta. */
  provider: 'databento' | 'tradingview';
  dataset: 'GLBX.MDP3' | 'tradingview';
  schema: MarketDataSchema;
  symbol: string;
  sourceSymbol?: string;
  start: string;
  end: string;
  estimatedCostUsd?: number;
  candles: MarketCandle[];
}

export interface IndicatorPoint {
  time: number;
  value: number;
}

export interface MarketIndicators {
  vwap: IndicatorPoint[];
  upperDeviation: IndicatorPoint[];
  lowerDeviation: IndicatorPoint[];
  dayOpen: IndicatorPoint[];
  weekOpen: IndicatorPoint[];
  sessionHigh: IndicatorPoint[];
  sessionLow: IndicatorPoint[];
  pdh: IndicatorPoint[];
  pdl: IndicatorPoint[];
  pwh: IndicatorPoint[];
  pwl: IndicatorPoint[];
}

export interface FairValueGap {
  direction: 'bullish' | 'bearish';
  startTime: number;
  endTime: number;
  top: number;
  bottom: number;
  mitigated: boolean;
  touched: boolean;
  mitigationSteps: FairValueGapMitigationStep[];
}

export interface FairValueGapMitigationStep {
  time: number;
  remainingTop: number;
  remainingBottom: number;
  filledTop: number;
  filledBottom: number;
}

export interface MarketStructureEvent {
  type: 'CHoCH' | 'BOS';
  direction: 'bullish' | 'bearish';
  pivotTime: number;
  breakTime: number;
  price: number;
  labelPrice: number;
  /** Chraneny protilehly pivot znamy v okamziku zlomu. */
  protectedPrice?: number | null;
  protectedTime?: number | null;
}

export function findEntryFairValueGap(
  gaps: FairValueGap[],
  entryTime: number,
  entryPrice: number,
  direction: 'long' | 'short',
  maxDistance = 1,
): FairValueGap | null {
  if (!Number.isFinite(entryTime) || !Number.isFinite(entryPrice)) return null;
  const expectedDirection = direction === 'long' ? 'bullish' : 'bearish';
  const candidates = gaps
    .filter(gap => gap.direction === expectedDirection && gap.startTime <= entryTime && gap.endTime >= entryTime)
    .map(gap => ({
      gap,
      distance: entryPrice < gap.bottom
        ? gap.bottom - entryPrice
        : entryPrice > gap.top
          ? entryPrice - gap.top
          : 0,
    }))
    .filter(candidate => candidate.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || b.gap.startTime - a.gap.startTime);
  return candidates[0]?.gap ?? null;
}

/**
 * FVG, na jehož hraně obchod vstoupil — automaticky, bez ručního tagu.
 * Bere jen FVG vzniklé před vstupem (nejvýš `lookbackSeconds` zpět), které
 * do vstupu nebyly vyplněné. Hrana = aktuální zbývající hrana (po částečném
 * vyplnění), vstup musí ležet do `tolerance` od ní. Víc kandidátů → nejbližší,
 * při shodě novější.
 */
export function findEntryEdgeFairValueGap(
  candles: MarketCandle[],
  entryTime: number,
  entryPrice: number,
  direction: 'long' | 'short',
  options: { lookbackSeconds?: number; tolerance?: number } = {},
): FairValueGap | null {
  if (!Number.isFinite(entryTime) || !Number.isFinite(entryPrice)) return null;
  const lookback = options.lookbackSeconds ?? 26 * 3600;
  const tolerance = options.tolerance ?? 0.25;
  const entryMinute = Math.floor(entryTime / 60) * 60;
  const before = candles.filter(candle => candle.time >= entryTime - lookback && candle.time < entryMinute);
  const expected = direction === 'long' ? 'bullish' : 'bearish';
  const candidates = findFairValueGaps(before)
    .filter(gap => gap.direction === expected && !gap.mitigated)
    .map(gap => {
      const last = gap.mitigationSteps.at(-1);
      const edges = [last?.remainingTop ?? gap.top, last?.remainingBottom ?? gap.bottom];
      return { gap, distance: Math.min(...edges.map(edge => Math.abs(entryPrice - edge))) };
    })
    .filter(candidate => candidate.distance <= tolerance + 1e-9)
    .sort((a, b) => a.distance - b.distance || b.gap.startTime - a.gap.startTime);
  return candidates[0]?.gap ?? null;
}

export function findEntryStructureEvent(
  events: MarketStructureEvent[],
  entryTime: number,
  direction: 'long' | 'short',
  desiredType?: 'CHoCH' | 'BOS' | null,
): MarketStructureEvent | null {
  const expectedDirection = direction === 'long' ? 'bullish' : 'bearish';
  const eligible = events
    .filter(event => event.direction === expectedDirection && event.breakTime <= entryTime)
    .sort((a, b) => b.breakTime - a.breakTime);
  if (!desiredType) return eligible[0] ?? null;
  return eligible.find(event => event.type === desiredType) ?? eligible[0] ?? null;
}

export const MARKET_TIMEFRAME_MINUTES: Record<BuiltinMarketTimeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1_440,
};

/** Vlastní minuty 1–720 (12 h), hodiny 1–23; svíčky se počítají od otevření CME session. */
export const CUSTOM_TIMEFRAME_LIMITS = { m: { min: 1, max: 720 }, h: { min: 1, max: 23 } } as const;
const WEEK_MINUTES = 7 * 1_440;
/** Měsíc jen pro rozestupy a mezery (svíčky se skládají podle kalendáře). */
const MONTH_MINUTES = 30 * 1_440;

/** `'7m'` / `'2h'` / `'W'` / `'M'` / pevný → platný timeframe, jinak `null`. */
export function parseMarketTimeframe(value: unknown): { unit: 'm' | 'h' | 'd' | 'W' | 'M'; count: number } | null {
  if (value === 'W' || value === 'M') return { unit: value, count: 1 };
  if (value === '1d') return { unit: 'd', count: 1 };
  if (typeof value !== 'string') return null;
  const match = /^([1-9]\d{0,3})(m|h)$/.exec(value);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2] as 'm' | 'h';
  const limits = CUSTOM_TIMEFRAME_LIMITS[unit];
  return count >= limits.min && count <= limits.max ? { unit, count } : null;
}

export const isMarketTimeframe = (value: unknown): value is MarketTimeframe => parseMarketTimeframe(value) !== null;

/** Délka timeframe v minutách (týden 7 dní, měsíc ~30 dní); neplatný = NaN. */
export function timeframeMinutes(timeframe: MarketTimeframe): number {
  const parsed = parseMarketTimeframe(timeframe);
  if (!parsed) return Number.NaN;
  if (parsed.unit === 'm') return parsed.count;
  if (parsed.unit === 'h') return parsed.count * 60;
  if (parsed.unit === 'd') return 1_440;
  return parsed.unit === 'W' ? WEEK_MINUTES : MONTH_MINUTES;
}

const BUILTIN_TIMEFRAMES = Object.keys(MARKET_TIMEFRAME_MINUTES) as BuiltinMarketTimeframe[];

/** Nejbližší pevný timeframe (pro tabulky kontextu a velikosti okna grafu). */
export function nearestBuiltinTimeframe(timeframe: MarketTimeframe): BuiltinMarketTimeframe {
  if ((BUILTIN_TIMEFRAMES as string[]).includes(timeframe)) return timeframe as BuiltinMarketTimeframe;
  const minutes = timeframeMinutes(timeframe);
  if (!Number.isFinite(minutes)) return '1m';
  return BUILTIN_TIMEFRAMES.reduce((best, candidate) =>
    Math.abs(Math.log(MARKET_TIMEFRAME_MINUTES[candidate] / minutes)) < Math.abs(Math.log(MARKET_TIMEFRAME_MINUTES[best] / minutes)) ? candidate : best);
}

/** 1h zdroj jen když se z hodin dá timeframe přesně složit (ne 90m). */
export const marketDataSchemaForTimeframe = (timeframe: MarketTimeframe): MarketDataSchema => {
  const minutes = timeframeMinutes(timeframe);
  return minutes >= 60 && minutes % 60 === 0 ? 'ohlcv-1h' : 'ohlcv-1m';
};

export function completedHistoricalCandles(params: {
  candles: MarketCandle[];
  schema: MarketDataSchema;
  endMs: number;
  replayStartMs: number;
}): MarketCandle[] {
  const candleDurationSeconds = params.schema === 'ohlcv-1h' ? 60 * 60 : 60;
  const boundarySeconds = Math.floor(Math.min(params.endMs, params.replayStartMs) / 1_000);
  return params.candles.filter(candle => candle.time + candleDurationSeconds <= boundarySeconds);
}

/**
 * Combines completed 1h context from before the replay boundary with candles
 * derived from revealed 1m data after it. Provider HTF bars at or after the
 * boundary are deliberately discarded so replay can never see a completed
 * future hour/day.
 */
export function composeReplayTimeframeCandles(params: {
  historicalHourly: MarketCandle[];
  revealedMinute: MarketCandle[];
  /** Hodinové a vyšší (skládá se z hotových 1h svíček a odkrytých 1m). */
  timeframe: MarketTimeframe;
  replayStartSeconds: number;
}): MarketCandle[] {
  const completedHistoricalHours = params.historicalHourly.filter(
    candle => candle.time + 60 * 60 <= params.replayStartSeconds,
  );
  const revealedReplayMinutes = params.revealedMinute.filter(
    candle => candle.time >= params.replayStartSeconds,
  );
  return aggregateCandles(
    [...completedHistoricalHours, ...revealedReplayMinutes]
      .sort((left, right) => left.time - right.time),
    params.timeframe,
  );
}

/**
 * Builds a replay chart from two deliberately separate timelines:
 * - historical 1m candles before the session start are view-only context;
 * - session candles are included only after the replay has revealed them.
 *
 * Keeping the boundary here prevents analytical history from becoming
 * tradable data or leaking future session candles into indicators.
 */
export function composeReplayAnalysisCandles(params: {
  historicalMinute: MarketCandle[];
  revealedMinute: MarketCandle[];
  timeframe: MarketTimeframe;
  replayStartSeconds: number;
}): MarketCandle[] {
  const historical = params.historicalMinute.filter(candle => candle.time < params.replayStartSeconds);
  const revealed = params.revealedMinute.filter(candle => candle.time >= params.replayStartSeconds);
  return aggregateCandles(
    [...historical, ...revealed],
    params.timeframe,
  );
}

export interface ReplayAnalysisAccumulator {
  historicalMinute: MarketCandle[];
  sessionMinute: MarketCandle[];
  timeframe: MarketTimeframe;
  replayStartSeconds: number;
  revealedCount: number;
  candles: MarketCandle[];
}

const appendAggregatedCandle = (
  target: MarketCandle[],
  candle: MarketCandle,
  timeframe: MarketTimeframe,
) => {
  const minutes = timeframeMinutes(timeframe);
  if (minutes === 1) {
    target.push({ ...candle });
    return;
  }
  const time = timeframeBucketStart(candle.time, timeframe);
  const current = target[target.length - 1];
  if (!current || current.time !== time) {
    target.push({ ...candle, time });
    return;
  }
  // Replace the open HTF bucket instead of mutating it. The replay
  // accumulator keeps the previous array alive long enough for React and the
  // chart updater to compare it with the next one.
  target[target.length - 1] = {
    ...current,
    high: Math.max(current.high, candle.high),
    low: Math.min(current.low, candle.low),
    close: candle.close,
    volume: current.volume + candle.volume,
  };
};

/**
 * Incrementally advances the replay analysis series. A normal one-candle step
 * only aggregates the newly revealed source candle instead of rebuilding and
 * sorting weeks of minute history. Backward seeks and source prepends rebuild
 * once, which keeps deterministic replay semantics.
 */
export function updateReplayAnalysisAccumulator(
  previous: ReplayAnalysisAccumulator | null,
  params: {
    historicalMinute: MarketCandle[];
    sessionMinute: MarketCandle[];
    timeframe: MarketTimeframe;
    replayStartSeconds: number;
    revealedCount: number;
  },
): ReplayAnalysisAccumulator {
  const revealedCount = Math.max(0, Math.min(params.sessionMinute.length, params.revealedCount));
  const canAppend = previous !== null
    && previous.historicalMinute === params.historicalMinute
    && previous.sessionMinute === params.sessionMinute
    && previous.timeframe === params.timeframe
    && previous.replayStartSeconds === params.replayStartSeconds
    && revealedCount >= previous.revealedCount;

  if (canAppend && revealedCount === previous.revealedCount) return previous;

  const previousHistoryFirst = previous?.historicalMinute[0]?.time;
  const prependedHistoryBoundary = previousHistoryFirst === undefined
    ? -1
    : params.historicalMinute.findIndex(candle => candle.time >= previousHistoryFirst);
  const canPrependHistory = previous !== null
    && previous.sessionMinute === params.sessionMinute
    && previous.timeframe === params.timeframe
    && previous.replayStartSeconds === params.replayStartSeconds
    && revealedCount === previous.revealedCount
    && prependedHistoryBoundary > 0
    && params.historicalMinute.length - prependedHistoryBoundary === previous.historicalMinute.length
    && previous.historicalMinute.every((candle, index) => (
      params.historicalMinute[prependedHistoryBoundary + index]?.time === candle.time
    ));

  if (canPrependHistory) {
    // Lazy history arrives strictly before the already analysed source. Do not
    // rebuild every revealed 1m bar merely because another context segment was
    // prepended. Aggregate only the new prefix and retain all existing candle
    // objects. The shared boundary bucket is merged for HTF timeframes.
    const prefix: MarketCandle[] = [];
    for (let index = 0; index < prependedHistoryBoundary; index += 1) {
      const candle = params.historicalMinute[index];
      if (candle.time < params.replayStartSeconds) appendAggregatedCandle(prefix, candle, params.timeframe);
    }
    const previousCandles = previous.candles;
    const prefixLast = prefix.at(-1);
    const previousFirst = previousCandles[0];
    if (prefixLast && previousFirst && prefixLast.time === previousFirst.time) {
      prefix[prefix.length - 1] = {
        ...prefixLast,
        high: Math.max(prefixLast.high, previousFirst.high),
        low: Math.min(prefixLast.low, previousFirst.low),
        close: previousFirst.close,
        volume: prefixLast.volume + previousFirst.volume,
      };
      return {
        ...previous,
        historicalMinute: params.historicalMinute,
        candles: [...prefix, ...previousCandles.slice(1)],
      };
    }
    return {
      ...previous,
      historicalMinute: params.historicalMinute,
      candles: [...prefix, ...previousCandles],
    };
  }

  if (canAppend) {
    // A replay step must not clone weeks of OHLC objects. The existing bars
    // are immutable; only a newly appended bar (or the current HTF bucket)
    // receives a fresh object in appendAggregatedCandle.
    const candles = previous.candles.slice();
    for (let index = previous.revealedCount; index < revealedCount; index += 1) {
      const candle = params.sessionMinute[index];
      if (candle.time >= params.replayStartSeconds) appendAggregatedCandle(candles, candle, params.timeframe);
    }
    return { ...previous, revealedCount, candles };
  }

  const candles: MarketCandle[] = [];
  params.historicalMinute.forEach(candle => {
    if (candle.time < params.replayStartSeconds) appendAggregatedCandle(candles, candle, params.timeframe);
  });
  for (let index = 0; index < revealedCount; index += 1) {
    const candle = params.sessionMinute[index];
    if (candle.time >= params.replayStartSeconds) appendAggregatedCandle(candles, candle, params.timeframe);
  }
  return { ...params, revealedCount, candles };
}

export interface MarketDataWindow {
  start: Date;
  end: Date;
}

const pragueDateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

const pragueMidnightUtc = (year: number, month: number, day: number): Date => {
  const targetAsUtc = Date.UTC(year, month - 1, day);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      pragueDateParts.formatToParts(new Date(candidate)).map(part => [part.type, part.value]),
    );
    const representedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    candidate += targetAsUtc - representedAsUtc;
    const hourInPrague = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Prague', hour: '2-digit', hourCycle: 'h23',
    }).format(new Date(candidate)));
    candidate -= hourInPrague * 60 * 60 * 1000;
  }
  return new Date(candidate);
};

/**
 * All trades opened on the same Prague calendar date share one paid request.
 * Fourteen prior days cover previous CME context; forward data stops exactly
 * at the end of the trade's Prague day because intraday futures are not held
 * overnight in this workflow.
 */
export function marketDataWindowForEntry(entryMs: number): MarketDataWindow {
  const entryParts = Object.fromEntries(
    pragueDateParts.formatToParts(new Date(entryMs)).map(part => [part.type, part.value]),
  );
  const year = Number(entryParts.year);
  const month = Number(entryParts.month);
  const day = Number(entryParts.day);
  const priorDate = new Date(Date.UTC(year, month - 1, day - 14));
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    start: pragueMidnightUtc(priorDate.getUTCFullYear(), priorDate.getUTCMonth() + 1, priorDate.getUTCDate()),
    end: pragueMidnightUtc(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate()),
  };
}

/** Keep the existing shared daily context, including the actual exit day when
 * an execution crosses midnight. Subminute execution times remain unchanged. */
export function marketDataWindowForTrade(entryMs: number, exitMs: number): MarketDataWindow {
  if (![entryMs, exitMs].every(value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime())) || exitMs < entryMs) {
    throw new Error('Obchod nemá platné pořadí času vstupu a výstupu.');
  }
  const entryWindow = marketDataWindowForEntry(entryMs);
  const exitWindow = marketDataWindowForEntry(exitMs);
  return { start: entryWindow.start, end: exitWindow.end };
}

/**
 * Jen seance obchodu — pro rychlé první načtení detailu (1 dotaz místo 16 dní).
 * Začíná půlnocí (Praha) dne, ve kterém leží vstup minus rezerva: aspoň 2 h,
 * u delšího obchodu jeho délka (ať je vycentrovaný obchod celý v datech).
 * Konec je stejný jako u plného okna.
 */
export function marketDataSessionWindowForTrade(entryMs: number, exitMs: number): MarketDataWindow {
  const full = marketDataWindowForTrade(entryMs, exitMs);
  const lead = Math.max(2 * 60 * 60 * 1000, exitMs - entryMs);
  const parts = Object.fromEntries(pragueDateParts.formatToParts(new Date(entryMs - lead)).map(part => [part.type, part.value]));
  return { start: pragueMidnightUtc(Number(parts.year), Number(parts.month), Number(parts.day)), end: full.end };
}

export function resolveMarketSymbol(root: 'MNQ' | 'NQ', tradeSymbol?: string): string {
  const normalized = String(tradeSymbol || '').trim().toUpperCase();
  const contract = normalized.match(/^(MNQ|NQ)([HMUZ]\d{1,2})$/);
  if (contract) return `${root}${contract[2]}`;
  return `${root}.v.0`;
}

const QUARTER_CODES: Record<number, string> = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' };

/** Expirace čtvrtletního kontraktu: třetí pátek měsíce (konec dne UTC). */
function quarterlyExpiryMs(year: number, month: number): number {
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstFriday = 1 + ((5 - firstDay + 7) % 7);
  return Date.UTC(year, month - 1, firstFriday + 14, 23, 59, 59);
}

/**
 * Aktuální a příští čtvrtletní kontrakt k okamžiku `atMs` (např. MNQU6, MNQZ6).
 * V týdnech rolloveru obchoduje trh oba a kontinuální `.v.0` může ukazovat
 * jiný, než na kterém obchod proběhl.
 */
export function quarterlyContractsAround(root: 'MNQ' | 'NQ', atMs: number): string[] {
  const at = new Date(atMs);
  const contracts: string[] = [];
  let year = at.getUTCFullYear();
  let month = Math.ceil((at.getUTCMonth() + 1) / 3) * 3;
  if (quarterlyExpiryMs(year, month) < atMs) { month += 3; if (month > 12) { month = 3; year += 1; } }
  for (let index = 0; index < 2; index++) {
    contracts.push(`${root}${QUARTER_CODES[month]}${year % 10}`);
    month += 3; if (month > 12) { month = 3; year += 1; }
  }
  return contracts;
}

/**
 * Jak daleko (v bodech) je cena plnění od rozpětí svíčky, ve které proběhlo.
 * 0 = cena leží ve svíčce; null = svíčka pro ten okamžik chybí.
 */
export function priceDistanceFromCandle(candles: readonly MarketCandle[], atMs: number, price: number): number | null {
  const minute = Math.floor(atMs / 60_000) * 60;
  const candle = candles.find(item => item.time === minute);
  if (!candle || !Number.isFinite(price)) return null;
  return price < candle.low ? candle.low - price : price > candle.high ? price - candle.high : 0;
}

export function aggregateCandles(candles: MarketCandle[], timeframe: MarketTimeframe): MarketCandle[] {
  const minutes = timeframeMinutes(timeframe);
  if (minutes === 1) return candles.slice();
  if (!Number.isFinite(minutes)) return [];
  const result: MarketCandle[] = [];

  for (const candle of candles) {
    const time = timeframeBucketStart(candle.time, timeframe);
    const current = result[result.length - 1];
    if (!current || current.time !== time) {
      result.push({ ...candle, time });
      continue;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }
  return result;
}

const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Začátek svíčky timeframe pro čas v sekundách. Minuty, hodiny a den od otevření
 * CME session (18:00 New York); týden a měsíc podle obchodního dne (session od
 * neděle 18:00 patří k pondělí) — čas svíčky je pevný bod týdne/měsíce (UTC
 * půlnoc pondělí / 1. dne − 6 h), stejný pro všechny jeho svíčky.
 */
export function timeframeBucketStart(unixSeconds: number, timeframe: MarketTimeframe): number {
  const parsed = parseMarketTimeframe(timeframe);
  if (!parsed) return unixSeconds;
  if (parsed.unit === 'W' || parsed.unit === 'M') {
    const day = tradingDayKey(unixSeconds);
    const anchor = parsed.unit === 'W' ? weekKey(day) : `${day.slice(0, 7)}-01`;
    return Date.parse(`${anchor}T00:00:00Z`) / 1_000 - 6 * 60 * 60;
  }
  return cmeBucketStart(unixSeconds, timeframeMinutes(timeframe));
}

/** Align intraday and daily bars to the CME equity-index session opening at 18:00 New York. */
const cmeClockCache = new Map<number, readonly [number, number, number]>();
const CME_CLOCK_CACHE_LIMIT = 32_768;
function cmeBucketStart(unixSeconds: number, minutes: number): number {
  // Only immutable timestamp -> NY clock conversion is reused. OHLCV is always
  // recomputed from the supplied rows, including corrections to old candles.
  // Exact timestamps retain Intl's DST behavior; no assumed/fixed UTC offset.
  let clock = cmeClockCache.get(unixSeconds);
  if (!clock) {
    const parts = Object.fromEntries(nyParts.formatToParts(new Date(unixSeconds * 1000)).map(part => [part.type, part.value]));
    clock = [Number(parts.hour), Number(parts.minute), Number(parts.second)];
    if (cmeClockCache.size >= CME_CLOCK_CACHE_LIMIT) cmeClockCache.delete(cmeClockCache.keys().next().value!);
    cmeClockCache.set(unixSeconds, clock);
  }
  const [hour, minute, second] = clock;
  const minutesSinceSessionOpen = ((hour - 18 + 24) % 24) * 60 + minute;
  const secondsIntoBucket = (minutesSinceSessionOpen % minutes) * 60 + second;
  return unixSeconds - secondsIntoBucket;
}

const tradingDayKey = (unixSeconds: number): string => {
  const parts = Object.fromEntries(nyParts.formatToParts(new Date(unixSeconds * 1000)).map(p => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const shifted = new Date(Date.UTC(year, month - 1, day + (hour >= 18 ? 1 : 0)));
  return shifted.toISOString().slice(0, 10);
};

const weekKey = (dayKey: string): string => {
  const date = new Date(`${dayKey}T00:00:00Z`);
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return date.toISOString().slice(0, 10);
};

type PeriodStats = { open: number; high: number; low: number };

const point = (time: number, value: number | undefined): IndicatorPoint | null =>
  value === undefined || !Number.isFinite(value) ? null : { time, value };

export function calculateIndicators(candles: MarketCandle[]): MarketIndicators {
  const output: MarketIndicators = {
    vwap: [], upperDeviation: [], lowerDeviation: [], dayOpen: [], weekOpen: [],
    sessionHigh: [], sessionLow: [], pdh: [], pdl: [], pwh: [], pwl: [],
  };
  const completedDays = new Map<string, PeriodStats>();
  const completedWeeks = new Map<string, PeriodStats>();
  let currentDay = '';
  let currentWeek = '';
  let dayStats: PeriodStats | null = null;
  let weekStats: PeriodStats | null = null;
  let previousDay: PeriodStats | undefined;
  let previousWeek: PeriodStats | undefined;
  let weightedPrice = 0;
  let weightedPriceSquared = 0;
  let volume = 0;

  for (const candle of candles) {
    const day = tradingDayKey(candle.time);
    const week = weekKey(day);
    if (day !== currentDay) {
      if (dayStats && currentDay) completedDays.set(currentDay, dayStats);
      previousDay = completedDays.get(Array.from(completedDays.keys()).at(-1) || '');
      currentDay = day;
      dayStats = { open: candle.open, high: candle.high, low: candle.low };
      weightedPrice = 0;
      weightedPriceSquared = 0;
      volume = 0;
    }
    if (week !== currentWeek) {
      if (weekStats && currentWeek) completedWeeks.set(currentWeek, weekStats);
      previousWeek = completedWeeks.get(Array.from(completedWeeks.keys()).at(-1) || '');
      currentWeek = week;
      weekStats = { open: candle.open, high: candle.high, low: candle.low };
    }

    dayStats!.high = Math.max(dayStats!.high, candle.high);
    dayStats!.low = Math.min(dayStats!.low, candle.low);
    weekStats!.high = Math.max(weekStats!.high, candle.high);
    weekStats!.low = Math.min(weekStats!.low, candle.low);

    const typical = (candle.high + candle.low + candle.close) / 3;
    const barVolume = Math.max(0, candle.volume);
    weightedPrice += typical * barVolume;
    weightedPriceSquared += typical * typical * barVolume;
    volume += barVolume;
    const vwap = volume > 0 ? weightedPrice / volume : typical;
    const variance = volume > 0 ? Math.max(0, weightedPriceSquared / volume - vwap * vwap) : 0;
    const deviation = Math.sqrt(variance);

    output.vwap.push({ time: candle.time, value: vwap });
    output.upperDeviation.push({ time: candle.time, value: vwap + deviation });
    output.lowerDeviation.push({ time: candle.time, value: vwap - deviation });
    output.dayOpen.push({ time: candle.time, value: dayStats!.open });
    output.weekOpen.push({ time: candle.time, value: weekStats!.open });
    output.sessionHigh.push({ time: candle.time, value: dayStats!.high });
    output.sessionLow.push({ time: candle.time, value: dayStats!.low });
    const priorPoints: Array<[keyof MarketIndicators, IndicatorPoint | null]> = [
      ['pdh', point(candle.time, previousDay?.high)],
      ['pdl', point(candle.time, previousDay?.low)],
      ['pwh', point(candle.time, previousWeek?.high)],
      ['pwl', point(candle.time, previousWeek?.low)],
    ];
    for (const [key, value] of priorPoints) if (value) output[key].push(value);
  }
  return output;
}

export function findFairValueGaps(candles: MarketCandle[]): FairValueGap[] {
  return updateFairValueGapAccumulator(null, candles).gaps;
}

export interface FairValueGapAccumulator {
  firstTime: number | null;
  lastTime: number | null;
  lastSignature: string;
  candleCount: number;
  gaps: FairValueGap[];
  active: Array<{ gapIndex: number; top: number; bottom: number }>;
  /** State before the open final bar, without recursive checkpoint chains. */
  tailCheckpoint?: Pick<FairValueGapAccumulator, 'candleCount' | 'gaps' | 'active'>;
}

const candleSignature = (candle: MarketCandle | undefined) => candle
  ? `${candle.time}:${candle.open}:${candle.high}:${candle.low}:${candle.close}:${candle.volume}`
  : '';

const appendFairValueGapCandle = (
  state: FairValueGapAccumulator,
  candles: MarketCandle[],
  index: number,
) => {
  const candidate = candles[index];
  for (let activeIndex = state.active.length - 1; activeIndex >= 0; activeIndex -= 1) {
    const active = state.active[activeIndex];
    const gap = state.gaps[active.gapIndex];
    gap.endTime = candidate.time;
    const wickTouch = candidate.high >= active.bottom && candidate.low <= active.top;
    if (wickTouch) gap.touched = true;
    const nextTop = gap.direction === 'bullish' ? Math.min(active.top, candidate.low) : active.top;
    const nextBottom = gap.direction === 'bearish' ? Math.max(active.bottom, candidate.high) : active.bottom;
    const fullyFilled = gap.direction === 'bullish' ? nextTop <= gap.bottom : nextBottom >= gap.top;
    const closeInvalidated = gap.direction === 'bullish' ? candidate.close < gap.bottom : candidate.close > gap.top;
    if (fullyFilled || closeInvalidated) {
      gap.mitigated = true;
      state.active.splice(activeIndex, 1);
      continue;
    }
    if (nextTop === active.top && nextBottom === active.bottom) continue;
    gap.mitigationSteps.push({
      time: candidate.time,
      remainingTop: nextTop,
      remainingBottom: nextBottom,
      filledTop: gap.direction === 'bullish' ? active.top : nextBottom,
      filledBottom: gap.direction === 'bullish' ? nextTop : active.bottom,
    });
    active.top = nextTop;
    active.bottom = nextBottom;
  }

  if (index < 2) return;
  const first = candles[index - 2];
  let gap: FairValueGap | null = null;
  if (candidate.low > first.high) {
    gap = {
      direction: 'bullish', startTime: candidate.time, endTime: candidate.time,
      top: candidate.low, bottom: first.high, mitigated: false, touched: false, mitigationSteps: [],
    };
  } else if (candidate.high < first.low) {
    gap = {
      direction: 'bearish', startTime: candidate.time, endTime: candidate.time,
      top: first.low, bottom: candidate.high, mitigated: false, touched: false, mitigationSteps: [],
    };
  }
  if (!gap) return;
  state.gaps.push(gap);
  state.active.push({ gapIndex: state.gaps.length - 1, top: gap.top, bottom: gap.bottom });
};

/** Only open gaps can change. Finished gaps and their mitigation histories stay immutable. */
const forkFairValueGapState = (source: Pick<FairValueGapAccumulator, 'gaps' | 'active'>) => {
  const gaps = source.gaps.slice();
  source.active.forEach(({ gapIndex }) => {
    const gap = gaps[gapIndex];
    gaps[gapIndex] = { ...gap, mitigationSteps: gap.mitigationSteps.slice() };
  });
  return { gaps, active: source.active.map(active => ({ ...active })) };
};

/**
 * Append-only replay evaluates new bars. Replacing the open HTF bar replays
 * only that bar from its pre-bar checkpoint, so temporary touches/mitigations
 * can disappear correctly when the replacement no longer contains them.
 * A back-seek, prepend or incompatible series still rebuilds deterministically.
 */
export function updateFairValueGapAccumulator(
  previous: FairValueGapAccumulator | null,
  candles: MarketCandle[],
): FairValueGapAccumulator {
  const firstTime = candles[0]?.time ?? null;
  const lastTime = candles.at(-1)?.time ?? null;
  const lastSignature = candleSignature(candles.at(-1));
  if (previous
    && previous.firstTime === firstTime
    && previous.candleCount === candles.length
    && previous.lastSignature === lastSignature) return previous;

  const canAppend = previous !== null
    && previous.firstTime === firstTime
    && candles.length > previous.candleCount
    && previous.lastTime === candles[previous.candleCount - 1]?.time
    && previous.lastSignature === candleSignature(candles[previous.candleCount - 1]);
  const canReplaceTail = previous !== null
    && previous.firstTime === firstTime
    && previous.lastTime === lastTime
    && previous.candleCount === candles.length
    && previous.tailCheckpoint?.candleCount === candles.length - 1;
  const base = canAppend ? previous : canReplaceTail ? previous.tailCheckpoint! : null;
  let state: FairValueGapAccumulator = {
    firstTime, lastTime, lastSignature,
    candleCount: base?.candleCount ?? 0,
    ...(base ? forkFairValueGapState(base) : { gaps: [], active: [] }),
  };
  // Keep the checkpoint only for the final bar, even when a large step reveals
  // many bars at once. No candle after this input's horizon is ever consulted.
  for (let index = state.candleCount; index < candles.length - 1; index += 1) {
    appendFairValueGapCandle(state, candles, index);
  }
  if (candles.length > 0) {
    const tailCheckpoint = {
      candleCount: candles.length - 1,
      gaps: state.gaps,
      active: state.active,
    };
    state = { ...state, ...forkFairValueGapState(state), tailCheckpoint };
    appendFairValueGapCandle(state, candles, candles.length - 1);
  }
  state.candleCount = candles.length;
  return state;
}

/**
 * FVG s rozpracovanou (živou nebo přehrávanou) svíčkou na konci, jako
 * TradingView, který indikátor přepočítává s každým tickem: zaplnění se
 * projeví hned, jak se ho cena dotkne, a nové FVG vzniká a zmenšuje se už
 * během tvořící se svíčky. `base` je akumulátor nad `input` (dokončená data),
 * `tail` konec řady grafu od posledního baru dat: přepsaný poslední bar
 * a/nebo připsané bary (na přelomu minuty graf drží dokončenou živou svíčku,
 * kterou data ještě neznají). Přepočítá se jen od posledního baru dat.
 * Jen pro kreslení — nikdy do dat, hodnocení ani úložiště.
 */
export function fairValueGapsWithFormingBars(
  base: FairValueGapAccumulator | null,
  input: MarketCandle[],
  tail: readonly MarketCandle[],
): FairValueGap[] {
  if (!base) return [];
  const last = input.at(-1);
  if (!last) return base.gaps;
  const bars = tail.filter(bar => bar.time >= last.time);
  const replaced = bars[0]?.time === last.time ? bars.shift()! : null;
  const replacesLast = replaced !== null
    && (replaced.open !== last.open || replaced.high !== last.high || replaced.low !== last.low || replaced.close !== last.close);
  if (!replacesLast) return bars.length ? updateFairValueGapAccumulator(base, [...input, ...bars]).gaps : base.gaps;
  const candles = [...input.slice(0, -1), { ...replaced, volume: last.volume }, ...bars];
  const checkpoint = base.tailCheckpoint;
  if (!checkpoint || checkpoint.candleCount !== input.length - 1) return updateFairValueGapAccumulator(null, candles).gaps;
  // Stav před posledním barem dat platí dál (předchozí bary se nemění).
  const beforeLast = input[input.length - 2];
  return updateFairValueGapAccumulator({
    firstTime: base.firstTime,
    lastTime: beforeLast?.time ?? null,
    lastSignature: candleSignature(beforeLast),
    candleCount: checkpoint.candleCount,
    gaps: checkpoint.gaps,
    active: checkpoint.active,
  }, candles).gaps;
}

/**
 * Historical equivalent of tradingview/alphatrade-bos-choch-cz.pine defaults:
 * pivot 1/1, close confirmation, first break against/without trend = CHoCH,
 * subsequent break in the same direction = BOS.
 */
export function calculateMarketStructure(candles: MarketCandle[]): MarketStructureEvent[] {
  const events: MarketStructureEvent[] = [];
  if (candles.length < 3) return events;

  let lastPivotHigh: { time: number; price: number } | null = null;
  let lastPivotLow: { time: number; price: number } | null = null;
  let trend: 'bullish' | 'bearish' | null = null;
  let previousAtr: number | null = null;
  const trueRanges: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    const trueRange = previous
      ? Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close))
      : current.high - current.low;
    trueRanges.push(trueRange);
    if (i === 13) {
      previousAtr = trueRanges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
    } else if (i > 13 && previousAtr !== null) {
      previousAtr = ((previousAtr * 13) + trueRange) / 14;
    }

    if (i < 2) continue;
    const candidate = candles[i - 1];
    const left = candles[i - 2];
    if (candidate.high > left.high && candidate.high > current.high) {
      lastPivotHigh = { time: candidate.time, price: candidate.high };
    }
    if (candidate.low < left.low && candidate.low < current.low) {
      lastPivotLow = { time: candidate.time, price: candidate.low };
    }

    const offset = previousAtr && previousAtr > 0
      ? previousAtr * 0.08
      : Math.max((current.high - current.low) * 0.1, 0.25 * 5);

    if (lastPivotHigh && current.close > lastPivotHigh.price) {
      events.push({
        type: trend === 'bullish' ? 'BOS' : 'CHoCH',
        direction: 'bullish',
        pivotTime: lastPivotHigh.time,
        breakTime: current.time,
        price: lastPivotHigh.price,
        labelPrice: lastPivotHigh.price + offset,
        protectedPrice: lastPivotLow?.price ?? null,
        protectedTime: lastPivotLow?.time ?? null,
      });
      trend = 'bullish';
      lastPivotHigh = null;
    }

    if (lastPivotLow && current.close < lastPivotLow.price) {
      events.push({
        type: trend === 'bearish' ? 'BOS' : 'CHoCH',
        direction: 'bearish',
        pivotTime: lastPivotLow.time,
        breakTime: current.time,
        price: lastPivotLow.price,
        labelPrice: lastPivotLow.price + offset,
        protectedPrice: lastPivotHigh?.price ?? null,
        protectedTime: lastPivotHigh?.time ?? null,
      });
      trend = 'bearish';
      lastPivotLow = null;
    }
  }

  return events;
}

export interface MarketStructureAccumulator {
  firstTime: number | null;
  lastTime: number | null;
  lastSignature: string;
  candleCount: number;
  events: MarketStructureEvent[];
  lastPivotHigh: { time: number; price: number } | null;
  lastPivotLow: { time: number; price: number } | null;
  trend: 'bullish' | 'bearish' | null;
  previousAtr: number | null;
  initialTrueRanges: number[];
  /** Stav před posledním barem — z něj se přepočítá tvořící se svíčka (jen kreslení). */
  tailCheckpoint?: MarketStructureCheckpoint | null;
}

interface MarketStructureCheckpoint {
  candleCount: number;
  eventCount: number;
  lastPivotHigh: MarketStructureAccumulator['lastPivotHigh'];
  lastPivotLow: MarketStructureAccumulator['lastPivotLow'];
  trend: MarketStructureAccumulator['trend'];
  previousAtr: number | null;
  initialTrueRangeCount: number;
}

const appendMarketStructureCandle = (
  state: MarketStructureAccumulator,
  candles: MarketCandle[],
  index: number,
) => {
  const current = candles[index];
  const previous = candles[index - 1];
  const trueRange = previous
    ? Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close))
    : current.high - current.low;
  if (index <= 13) state.initialTrueRanges.push(trueRange);
  if (index === 13) {
    state.previousAtr = state.initialTrueRanges.reduce((sum, value) => sum + value, 0) / 14;
  } else if (index > 13 && state.previousAtr !== null) {
    state.previousAtr = ((state.previousAtr * 13) + trueRange) / 14;
  }
  if (index < 2) return;

  const candidate = candles[index - 1];
  const left = candles[index - 2];
  if (candidate.high > left.high && candidate.high > current.high) {
    state.lastPivotHigh = { time: candidate.time, price: candidate.high };
  }
  if (candidate.low < left.low && candidate.low < current.low) {
    state.lastPivotLow = { time: candidate.time, price: candidate.low };
  }
  const offset = state.previousAtr && state.previousAtr > 0
    ? state.previousAtr * 0.08
    : Math.max((current.high - current.low) * 0.1, 0.25 * 5);
  if (state.lastPivotHigh && current.close > state.lastPivotHigh.price) {
    state.events.push({
      type: state.trend === 'bullish' ? 'BOS' : 'CHoCH', direction: 'bullish',
      pivotTime: state.lastPivotHigh.time, breakTime: current.time,
      price: state.lastPivotHigh.price, labelPrice: state.lastPivotHigh.price + offset,
      protectedPrice: state.lastPivotLow?.price ?? null,
      protectedTime: state.lastPivotLow?.time ?? null,
    });
    state.trend = 'bullish';
    state.lastPivotHigh = null;
  }
  if (state.lastPivotLow && current.close < state.lastPivotLow.price) {
    state.events.push({
      type: state.trend === 'bearish' ? 'BOS' : 'CHoCH', direction: 'bearish',
      pivotTime: state.lastPivotLow.time, breakTime: current.time,
      price: state.lastPivotLow.price, labelPrice: state.lastPivotLow.price + offset,
      protectedPrice: state.lastPivotHigh?.price ?? null,
      protectedTime: state.lastPivotHigh?.time ?? null,
    });
    state.trend = 'bearish';
    state.lastPivotLow = null;
  }
};

export function updateMarketStructureAccumulator(
  previous: MarketStructureAccumulator | null,
  candles: MarketCandle[],
): MarketStructureAccumulator {
  const firstTime = candles[0]?.time ?? null;
  const lastTime = candles.at(-1)?.time ?? null;
  const lastSignature = candleSignature(candles.at(-1));
  const canAppend = previous
    && previous.firstTime === firstTime
    && candles.length > previous.candleCount
    && previous.lastTime === candles[previous.candleCount - 1]?.time
    // Vyšší timeframe: dřív poslední (rozpracovaný) bar se mezitím mohl
    // změnit — pak se navazovat nesmí, jinak by struktura stála na staré svíčce.
    && previous.lastSignature === candleSignature(candles[previous.candleCount - 1]);
  if (previous
    && previous.firstTime === firstTime
    && previous.candleCount === candles.length
    && previous.lastSignature === lastSignature) return previous;

  const state: MarketStructureAccumulator = canAppend ? {
    ...previous,
    firstTime,
    lastTime,
    lastSignature,
    events: [...previous.events],
    initialTrueRanges: [...previous.initialTrueRanges],
  } : {
    firstTime,
    lastTime,
    lastSignature,
    candleCount: 0,
    events: [],
    lastPivotHigh: null,
    lastPivotLow: null,
    trend: null,
    previousAtr: null,
    initialTrueRanges: [],
    tailCheckpoint: null,
  };
  const start = canAppend ? previous.candleCount : 0;
  for (let index = start; index < candles.length - 1; index += 1) {
    appendMarketStructureCandle(state, candles, index);
  }
  if (candles.length > 0) {
    // Pivoty i zlomy jsou neměnné objekty — stačí si pamatovat počty.
    state.tailCheckpoint = {
      candleCount: candles.length - 1,
      eventCount: state.events.length,
      lastPivotHigh: state.lastPivotHigh,
      lastPivotLow: state.lastPivotLow,
      trend: state.trend,
      previousAtr: state.previousAtr,
      initialTrueRangeCount: state.initialTrueRanges.length,
    };
    appendMarketStructureCandle(state, candles, candles.length - 1);
  }
  state.candleCount = candles.length;
  state.lastTime = lastTime;
  state.lastSignature = lastSignature;
  return state;
}

/**
 * BOS/CHoCH s rozpracovanou (živou nebo přehrávanou) svíčkou na konci, jako
 * TradingView s potvrzením zavřením na živém baru: zlom se ukáže, jakmile je
 * cena (zavření tvořící se svíčky) za pivotem, a zmizí, když se cena vrátí.
 * `base` je akumulátor nad `input` (data grafu), `tail` konec řady grafu od
 * posledního baru dat (přepsaný poslední bar a/nebo připsané bary). Jen pro
 * kreslení — nikdy do dat, hodnocení, mapy vstupu ani úložiště.
 */
export function marketStructureWithFormingBars(
  base: MarketStructureAccumulator | null,
  input: MarketCandle[],
  tail: readonly MarketCandle[],
): MarketStructureEvent[] {
  if (!base) return [];
  const last = input.at(-1);
  if (!last) return base.events;
  const bars = tail.filter(bar => bar.time >= last.time);
  const replaced = bars[0]?.time === last.time ? bars.shift()! : null;
  const replacesLast = replaced !== null
    && (replaced.open !== last.open || replaced.high !== last.high || replaced.low !== last.low || replaced.close !== last.close);
  if (!replacesLast) return bars.length ? updateMarketStructureAccumulator(base, [...input, ...bars]).events : base.events;
  const candles = [...input.slice(0, -1), { ...replaced, volume: last.volume }, ...bars];
  const checkpoint = base.tailCheckpoint;
  if (!checkpoint || base.candleCount !== input.length || checkpoint.candleCount !== input.length - 1) {
    return updateMarketStructureAccumulator(null, candles).events;
  }
  // Stav před posledním barem dat platí dál (předchozí bary se nemění).
  const beforeLast = input[input.length - 2];
  return updateMarketStructureAccumulator({
    ...base,
    lastTime: beforeLast?.time ?? null,
    lastSignature: candleSignature(beforeLast),
    candleCount: checkpoint.candleCount,
    events: base.events.slice(0, checkpoint.eventCount),
    lastPivotHigh: checkpoint.lastPivotHigh,
    lastPivotLow: checkpoint.lastPivotLow,
    trend: checkpoint.trend,
    previousAtr: checkpoint.previousAtr,
    initialTrueRanges: base.initialTrueRanges.slice(0, checkpoint.initialTrueRangeCount),
    tailCheckpoint: null,
  }, candles).events;
}

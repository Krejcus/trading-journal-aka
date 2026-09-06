import type { MarketCandle, MarketCandleResponse, MarketDataSchema } from './marketData';
import { canonicalBacktestEvidence, hashBacktestEvidence } from './backtestEvidenceIdentity';

export interface BacktestDataRange { startMs: number; endMs: number }
export interface BacktestDataCalendar {
  id: string;
  version: string;
  source: string;
  /** Outside this range the calendar makes no claim. Empty openIntervals means closed. */
  evaluatedRange: BacktestDataRange;
  openIntervals: readonly BacktestDataRange[];
}
export interface BacktestDataSource {
  provider: MarketCandleResponse['provider'];
  dataset: MarketCandleResponse['dataset'];
  symbol: string;
  sourceSymbol?: string;
  /** Current candle store discards response metadata; configured-loader is weaker evidence. */
  basis: 'response' | 'configured-loader';
  revision?: string;
}
export interface BacktestDataManifestInput {
  source: BacktestDataSource;
  schema: MarketDataSchema;
  range: BacktestDataRange;
  candles: readonly MarketCandle[];
  /** Only ranges whose requests completed successfully; never infer this from first/last bar. */
  fetchedRanges?: readonly BacktestDataRange[];
  /** Explicit versioned calendar evidence; no implicit holiday or trading-hours assumptions. */
  calendar?: BacktestDataCalendar;
}
export interface BacktestDataGap extends BacktestDataRange {
  slots: number;
  kind: 'calendar-closed' | 'expected-open-without-bar' | 'fetch-unverified' | 'unknown-schedule';
  fetchVerified: boolean;
  calendarStatus: 'open' | 'closed' | 'mixed' | 'unknown';
}
const validRange = (range: BacktestDataRange) => Number.isSafeInteger(range.startMs) && Number.isSafeInteger(range.endMs) && range.endMs > range.startMs;
const normalizeRanges = (ranges: readonly BacktestDataRange[]): BacktestDataRange[] => {
  if (!ranges.every(validRange)) throw new Error('Invalid evidence coverage range.');
  const sorted = ranges.map(range => ({ ...range })).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const output: BacktestDataRange[] = [];
  for (const range of sorted) {
    const previous = output.at(-1);
    if (previous && range.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, range.endMs);
    else output.push(range);
  }
  return output;
};
const covers = (ranges: readonly BacktestDataRange[], startMs: number, endMs: number): boolean => {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, range = ranges[mid];
    if (range.startMs > startMs) hi = mid - 1;
    else if (range.endMs < endMs) lo = mid + 1;
    else return true;
  }
  return false;
};
const fields = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;
const encodedValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : { invalidType: typeof value, invalidValue: String(value) };

/**
 * Pure snapshot of supplied evidence. range bounds BAR OPEN timestamps, [startMs,endMs).
 * The caller must bound it to revealed data; the helper does not infer a replay horizon.
 * A price-series gap is not proof of vendor corruption: OHLCV may omit no-trade bars.
 */
export const buildBacktestDataManifest = async (input: BacktestDataManifestInput) => {
  if (!validRange(input.range) || !['ohlcv-1m', 'ohlcv-1h'].includes(input.schema)) throw new Error('Invalid manifest range or schema.');
  if (input.source.provider !== 'databento' || input.source.dataset !== 'GLBX.MDP3' || typeof input.source.symbol !== 'string' || !input.source.symbol.trim() || !['response', 'configured-loader'].includes(input.source.basis)) throw new Error('Unsupported source metadata.');
  if ([input.source.sourceSymbol, input.source.revision].some(value => value !== undefined && (typeof value !== 'string' || !value.trim()))) throw new Error('Invalid source metadata identity.');
  const durationMs = input.schema === 'ohlcv-1h' ? 3_600_000 : 60_000;
  const fetchedRanges = normalizeRanges(input.fetchedRanges ?? []);
  if (input.calendar && (!input.calendar.id || !input.calendar.version || !input.calendar.source || !validRange(input.calendar.evaluatedRange))) throw new Error('Calendar evidence needs identity, version, source and evaluated range.');
  const openIntervals = normalizeRanges(input.calendar?.openIntervals ?? []);
  const calendar = input.calendar ? { ...input.calendar, evaluatedRange: { ...input.calendar.evaluatedRange }, openIntervals } : null;
  const rows: unknown[][] = [];
  const timestamps = new Map<number, Set<string>>();
  const observed = new Set<number>();
  let invalidRows = 0, duplicateRows = 0, outOfOrderTransitions = 0, priorTime = -Infinity;
  for (const candle of input.candles) {
    if (Number.isFinite(candle.time) && (candle.time * 1000 < input.range.startMs || candle.time * 1000 >= input.range.endMs)) continue;
    const row = fields.map(field => encodedValue(candle[field]));
    rows.push(row);
    const finite = fields.every(field => Number.isFinite(candle[field]));
    const aligned = Number.isSafeInteger(candle.time * 1000) && (candle.time * 1000) % durationMs === 0;
    const valid = finite && aligned && candle.volume >= 0 && candle.high >= Math.max(candle.open, candle.close, candle.low) && candle.low <= Math.min(candle.open, candle.close);
    if (!valid) invalidRows++;
    if (Number.isFinite(candle.time)) {
      if (candle.time < priorTime) outOfOrderTransitions++;
      priorTime = candle.time;
      const existing = timestamps.get(candle.time);
      if (existing) { duplicateRows++; existing.add(canonicalBacktestEvidence(row)); }
      else timestamps.set(candle.time, new Set([canonicalBacktestEvidence(row)]));
    }
    if (valid) observed.add(candle.time * 1000);
  }
  rows.sort((a, b) => { const left = canonicalBacktestEvidence(a), right = canonicalBacktestEvidence(b); return left < right ? -1 : left > right ? 1 : 0; });
  const gaps: BacktestDataGap[] = [];
  let expectedGridSlots = 0, fetchedGridSlots = 0, calendarOpenSlots = 0, observedCalendarClosedSlots = 0;
  for (let at = Math.ceil(input.range.startMs / durationMs) * durationMs; at < input.range.endMs; at += durationMs) {
    expectedGridSlots++;
    const end = Math.min(at + durationMs, input.range.endMs);
    const fetchVerified = covers(fetchedRanges, at, end);
    if (fetchVerified) fetchedGridSlots++;
    const calendarKnown = calendar && covers([calendar.evaluatedRange], at, end);
    const calendarStatus = calendarKnown ? covers(openIntervals, at, end) ? 'open' : openIntervals.some(range => range.startMs < end && range.endMs > at) ? 'mixed' : 'closed' : 'unknown';
    if (calendarStatus === 'open') calendarOpenSlots++;
    if (observed.has(at)) { if (calendarStatus === 'closed') observedCalendarClosedSlots++; continue; }
    const kind = calendarStatus === 'closed' ? 'calendar-closed' : !fetchVerified ? 'fetch-unverified' : calendarStatus === 'open' ? 'expected-open-without-bar' : 'unknown-schedule';
    const previous = gaps.at(-1);
    if (previous && previous.endMs === at && previous.kind === kind && previous.fetchVerified === fetchVerified && previous.calendarStatus === calendarStatus) { previous.endMs = end; previous.slots++; }
    else gaps.push({ startMs: at, endMs: end, slots: 1, kind, fetchVerified, calendarStatus });
  }
  const body = {
    format: 'alphatrade-backtest-data-manifest' as const, version: 1 as const,
    source: { ...input.source, sourceSymbol: input.source.sourceSymbol ?? null, revision: input.source.revision ?? null },
    schema: input.schema, timeframe: input.schema === 'ohlcv-1h' ? '1h' as const : '1m' as const,
    range: { ...input.range }, timeConvention: 'UTC epoch seconds; bar-open timestamps in [startMs,endMs)' as const,
    contentHash: await hashBacktestEvidence(rows), contentHashCanonicalization: 'sorted OHLCV row multiset; duplicate rows retained; outside-range rows excluded' as const,
    coverage: { expectedGridSlots, observedGridSlots: observed.size, fetchedGridSlots, calendarOpenSlots, observedCalendarClosedSlots, fetchedRanges, calendar, gaps },
    quality: { inputRowsInRange: rows.length, invalidRows, duplicateRows, conflictingDuplicateTimestamps: [...timestamps.values()].filter(values => values.size > 1).length, outOfOrderTransitions },
    limitations: [
      'Successful fetch coverage does not establish a complete price path.',
      'Mixed open/closed slots are unresolved; an hourly bar can straddle a session boundary.',
      'Calendar closures are claims of the supplied calendar, not independently verified exchange facts; missing calendar means unknown schedule.',
      'An absent expected-open OHLCV bar can reflect no trades, a holiday/calendar error or missing data; cause is not inferred.',
      'OHLCV does not establish intrabar order, ticks, queue position or liquidity.',
      'Hash identifies supplied evidence; it does not authenticate the provider or reconstruct revisions missing from cache metadata.',
    ],
  };
  return { ...body, manifestHash: await hashBacktestEvidence(body) };
};
export type BacktestDataManifest = Awaited<ReturnType<typeof buildBacktestDataManifest>>;

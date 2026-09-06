import { backtestChangeHash as changeHash, createBacktestAnalyticsSourceCache, stableBacktestJson } from './backtestAnalyticsSourceCache';
import type { Trade } from '../types';
import type { MarketCandle } from './marketData';
import type { BacktestClosedTrade, BacktestInstrument } from './backtestTypes';
import { BACKTEST_TRADE_SCHEMA_VERSION, backtestClosedTradeToTrade, createBacktestTradeMapper, type BacktestTradeMappingOptions } from './backtestIntel';
import { buildBacktestTradeRecalculationUpdates } from './backtestTradeRecalculation';

export interface BacktestAnalyticsRefreshStamp {
  version: 1;
  schemaVersion: number;
  /** UTC seconds: all inputs were bounded to this revealed horizon. */
  horizonTime: number;
  /** Deterministic change token, not a cryptographic provenance signature. */
  sourceHash: string;
  lastCandleTime: number | null;
  complete: boolean;
}
export type BacktestRefreshTrade = Trade & { backtestAnalyticsRefresh?: BacktestAnalyticsRefreshStamp };
export interface BacktestAnalyticsRefreshInput {
  trades: readonly BacktestRefreshTrade[];
  closedTrades: readonly BacktestClosedTrade[];
  candlesByInstrument: Partial<Record<BacktestInstrument, readonly MarketCandle[]>>;
  htfCandlesByInstrument?: Partial<Record<BacktestInstrument, readonly MarketCandle[]>>;
  slippageTicks?: Partial<Record<BacktestInstrument, number>>;
  /** Required even for end-session refresh: caller explicitly supplies the revealed end. */
  replayHorizonTime: number;
  mappingOptions: Omit<BacktestTradeMappingOptions, 'candles' | 'htfCandles' | 'replayHorizonTime' | 'contextSource' | 'slippageTicks'>;
  /** Optional scheduling budget. Committed stamps make the next batch advance. */
  maxTrades?: number;
}
export interface BacktestAnalyticsRefreshCandidate {
  tradeId: string;
  expectedSourceHash?: string;
  runId: string;
  instrument: BacktestInstrument;
  stamp: BacktestAnalyticsRefreshStamp;
  recalculated: Trade;
  /** Derived fields only; rebuild against latest review at commit time. */
  updates: Partial<Trade>;
}

const pendingObject = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(pendingObject);
  const data = value as Record<string, unknown>;
  // Permanently unavailable risk/placement is not a request for future data.
  if (data.reason === 'no-initial-stop' || data.valid === false || data.ok === false) return false;
  if (data.complete === false || data.hasGaps === true || data.stopReason === 'end'
    || data.reason === 'no-bars-after-entry' || data.reason === 'missing-initial-bars') return true;
  return Object.values(data).some(pendingObject);
};
export const backtestAnalyticsArePending = (trade: Trade): boolean =>
  pendingObject(trade.excursion) || pendingObject(trade.executionPath) || pendingObject(trade.counterfactual);

/** Pure planning only. Caller persists updates + stamp atomically in its durable
 * queue, after checking account/run/horizon generation and merging latest review.
 * Unrevealed bars never participate in the hash, mapping, or completion decision.
 */
const planRefresh = (input: BacktestAnalyticsRefreshInput, cache?: ReturnType<typeof refreshCache>): BacktestAnalyticsRefreshCandidate[] => {
  if (!Number.isFinite(input.replayHorizonTime)) return [];
  const limit = input.maxTrades === undefined ? Infinity : Math.max(0, Math.floor(input.maxTrades));
  const trades = new Map(input.trades.filter(trade => trade.accountId === input.mappingOptions.accountId).map(trade => [trade.id, trade]));
  const sources = new Map<string, { candles: readonly MarketCandle[]; htfCandles?: readonly MarketCandle[]; hash: string }>();
  const candidates: BacktestAnalyticsRefreshCandidate[] = [];
  const orderedClosed = cache ? [...input.closedTrades].sort((left, right) => {
    const a = trades.get(left.id)?.backtestAnalyticsRefresh?.horizonTime ?? -Infinity;
    const b = trades.get(right.id)?.backtestAnalyticsRefresh?.horizonTime ?? -Infinity;
    return a === b ? 0 : a - b;
  }) : input.closedTrades;
  for (const closed of orderedClosed) {
    if (candidates.length >= limit) break;
    const current = trades.get(closed.id);
    if (!current || current.backtestRunId !== closed.runId || closed.exitTime > input.replayHorizonTime) continue;
    const prior = current.backtestAnalyticsRefresh;
    const compatible = prior?.version === 1 && prior.schemaVersion === BACKTEST_TRADE_SCHEMA_VERSION
      && Number.isFinite(prior.horizonTime) && typeof prior.sourceHash === 'string' && typeof prior.complete === 'boolean';
    // Once every variant is terminal, later market data cannot improve it.
    // Corrections to its already-consumed data still change its source hash.
    const horizon = compatible && prior.complete
      ? Math.min(input.replayHorizonTime, prior.horizonTime) : input.replayHorizonTime;
    const sourceKey = `${closed.instrument}:${horizon}`;
    let source = sources.get(sourceKey);
    if (!source) {
      if (cache) source = cache.sources.get(input.candlesByInstrument[closed.instrument] ?? EMPTY_CANDLES, input.htfCandlesByInstrument?.[closed.instrument], horizon);
      else {
        const candles = (input.candlesByInstrument[closed.instrument] ?? []).filter(candle => candle.time <= horizon);
        const htfCandles = input.htfCandlesByInstrument?.[closed.instrument]?.filter(candle => candle.time <= horizon);
        source = { candles, htfCandles, hash: changeHash({ candles, htfCandles }) };
      }
      sources.set(sourceKey, source);
    }
    const { orderEvents, sourceHash } = cache ? cache.fingerprint(input, closed, source.hash, horizon) : fingerprint(input, closed, source.hash, horizon);
    if (compatible && prior.sourceHash === sourceHash) continue;
    const recalculated = (cache?.mapper.map ?? backtestClosedTradeToTrade)(closed, { ...input.mappingOptions,
      candles: source.candles, htfCandles: source.htfCandles, orderEvents,
      replayHorizonTime: horizon, slippageTicks: input.slippageTicks?.[closed.instrument] });
    candidates.push({ tradeId: closed.id, expectedSourceHash: prior?.sourceHash, runId: closed.runId, instrument: closed.instrument, recalculated,
      updates: buildBacktestTradeRecalculationUpdates(current, recalculated),
      stamp: { version: 1, schemaVersion: BACKTEST_TRADE_SCHEMA_VERSION, horizonTime: horizon, sourceHash,
        lastCandleTime: source.candles.at(-1)?.time ?? null, complete: !backtestAnalyticsArePending(recalculated) },
    });
  }
  return candidates;
};

const EMPTY_CANDLES: readonly MarketCandle[] = Object.freeze([]);
const fingerprint = (input: BacktestAnalyticsRefreshInput, closed: BacktestClosedTrade, source: string, horizon: number) => {
  const orderEvents = input.mappingOptions.orderEvents.filter(event => event.runId === closed.runId
    && event.instrument === closed.instrument && event.marketTime <= Math.min(closed.exitTime, horizon));
  const sourceHash = changeHash({ schemaVersion: BACKTEST_TRADE_SCHEMA_VERSION, source, closed, orderEvents,
    timeZone: input.mappingOptions.timeZone, flatTimeZone: input.mappingOptions.flatTimeZone,
    flatByMinute: input.mappingOptions.flatByMinute, slippageTicks: input.slippageTicks?.[closed.instrument] ?? 0 });
  return { orderEvents, sourceHash };
};
const refreshCache = (mapper = createBacktestTradeMapper()) => {
  const sources = createBacktestAnalyticsSourceCache();
  type Entry = { events: BacktestAnalyticsRefreshInput['mappingOptions']['orderEvents']; key: string; value: ReturnType<typeof fingerprint> };
  let entries = new WeakMap<BacktestClosedTrade, Entry[]>();
  const diagnostics = { tradeHashes: 0, sources: sources.diagnostics, mapper: mapper.diagnostics };
  return {
    sources, mapper, diagnostics,
    clear() { sources.clear(); mapper.clear(); entries = new WeakMap(); },
    fingerprint(input: BacktestAnalyticsRefreshInput, closed: BacktestClosedTrade, source: string, horizon: number) {
      const key = stableBacktestJson([source, Math.min(closed.exitTime, horizon), input.mappingOptions.timeZone,
        input.mappingOptions.flatTimeZone, input.mappingOptions.flatByMinute, input.slippageTicks?.[closed.instrument] ?? 0]);
      const prior = entries.get(closed) ?? [];
      const hit = prior.find(entry => entry.events === input.mappingOptions.orderEvents && entry.key === key);
      if (hit) return hit.value;
      const value = fingerprint(input, closed, source, horizon);
      entries.set(closed, [...prior.slice(-3), { events: input.mappingOptions.orderEvents, key, value }]);
      diagnostics.tradeHashes++;
      return value;
    },
  };
};

/** Stateless oracle remains available for arbitrary caller-owned mutable arrays. */
export const planBacktestAnalyticsRefresh = (input: BacktestAnalyticsRefreshInput): BacktestAnalyticsRefreshCandidate[] => planRefresh(input);

/** One instance per owner/session. Cached mode requires immutable snapshots;
 * worker transport establishes that boundary by owning its structured clones. */
export const createBacktestAnalyticsPlanner = (options: { mapper?: ReturnType<typeof createBacktestTradeMapper> } = {}) => {
  const cache = refreshCache(options.mapper);
  return { plan: (input: BacktestAnalyticsRefreshInput) => planRefresh(input, cache), clear: cache.clear, diagnostics: cache.diagnostics };
};

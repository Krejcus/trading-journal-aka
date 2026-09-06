import type { Trade } from '../types';
import type { MarketCandle } from './marketData';
import type { BacktestClosedTrade, BacktestInstrument } from './backtestTypes';
import { BACKTEST_TRADE_SCHEMA_VERSION, backtestClosedTradeToTrade, type BacktestTradeMappingOptions } from './backtestIntel';
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

const stableJson = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const changeHash = (value: unknown): string => {
  const text = stableJson(value);
  let left = 0x811c9dc5; let right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    left = Math.imul(left ^ text.charCodeAt(index), 0x01000193);
    right = Math.imul(right ^ text.charCodeAt(index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
};
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
export const planBacktestAnalyticsRefresh = (input: BacktestAnalyticsRefreshInput): BacktestAnalyticsRefreshCandidate[] => {
  if (!Number.isFinite(input.replayHorizonTime)) return [];
  const limit = input.maxTrades === undefined ? Infinity : Math.max(0, Math.floor(input.maxTrades));
  const trades = new Map(input.trades.filter(trade => trade.accountId === input.mappingOptions.accountId).map(trade => [trade.id, trade]));
  const sources = new Map<string, { candles: readonly MarketCandle[]; htfCandles?: readonly MarketCandle[]; hash: string }>();
  const candidates: BacktestAnalyticsRefreshCandidate[] = [];
  for (const closed of input.closedTrades) {
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
      const candles = (input.candlesByInstrument[closed.instrument] ?? []).filter(candle => candle.time <= horizon);
      const htfCandles = input.htfCandlesByInstrument?.[closed.instrument]?.filter(candle => candle.time <= horizon);
      source = { candles, htfCandles, hash: changeHash({ candles, htfCandles }) };
      sources.set(sourceKey, source);
    }
    const orderEvents = input.mappingOptions.orderEvents.filter(event => event.runId === closed.runId
      && event.instrument === closed.instrument && event.marketTime <= Math.min(closed.exitTime, horizon));
    const sourceHash = changeHash({ schemaVersion: BACKTEST_TRADE_SCHEMA_VERSION, source: source.hash, closed, orderEvents,
      timeZone: input.mappingOptions.timeZone, flatTimeZone: input.mappingOptions.flatTimeZone,
      flatByMinute: input.mappingOptions.flatByMinute, slippageTicks: input.slippageTicks?.[closed.instrument] ?? 0 });
    if (compatible && prior.sourceHash === sourceHash) continue;
    const recalculated = backtestClosedTradeToTrade(closed, { ...input.mappingOptions,
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

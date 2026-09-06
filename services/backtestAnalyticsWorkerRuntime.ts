import { createBacktestAnalyticsPlanner } from './backtestAnalyticsRefresh';
import { createBacktestTradeMapper } from './backtestIntel';
import type { BacktestAnalyticsWorkerRequest, BacktestAnalyticsWorkerResponse, BacktestWorkerSources } from './backtestAnalyticsWorkerProtocol';
import type { BacktestClosedTrade, BacktestOrderEvent } from './backtestTypes';

/** Pure worker state machine, also exercised directly in deterministic tests. */
export const createBacktestAnalyticsWorkerRuntime = () => {
  const mapper = createBacktestTradeMapper();
  const planner = createBacktestAnalyticsPlanner({ mapper });
  let scopeKey: string | undefined;
  let sourceVersion = -1;
  const candles: BacktestWorkerSources['candlesByInstrument'] = {};
  const htfCandles: NonNullable<BacktestWorkerSources['htfCandlesByInstrument']> = {};
  let orderEvents: readonly BacktestOrderEvent[] = [];
  let closedTrades: readonly BacktestClosedTrade[] = [];
  const scope = (key: string) => {
    if (!key || (scopeKey !== undefined && scopeKey !== key)) throw new Error('Analytics worker scope changed.');
    scopeKey = key;
  };
  return {
    diagnostics: planner.diagnostics,
    handle(message: BacktestAnalyticsWorkerRequest): BacktestAnalyticsWorkerResponse | undefined {
      try {
        scope(message.scopeKey);
        if (message.type === 'sources') {
          if (!Number.isSafeInteger(message.sourceVersion) || message.sourceVersion < sourceVersion) throw new Error('Stale analytics sources.');
          for (const root of ['MNQ', 'NQ'] as const) {
            if (Object.prototype.hasOwnProperty.call(message.candles, root)) {
              if (message.candles[root] === null) delete candles[root]; else candles[root] = message.candles[root]!;
            }
            if (Object.prototype.hasOwnProperty.call(message.htfCandles, root)) {
              if (message.htfCandles[root] === null) delete htfCandles[root]; else htfCandles[root] = message.htfCandles[root]!;
            }
          }
          sourceVersion = message.sourceVersion;
          return;
        }
        if (message.type === 'ledger') {
          if (message.orderEvents) orderEvents = message.orderEvents;
          if (message.closedTrades) closedTrades = message.closedTrades;
          return;
        }
        if (sourceVersion < 0 || message.sourceVersion !== sourceVersion) throw new Error('Analytics source generation changed.');
        const horizon = message.type === 'plan' ? message.input.replayHorizonTime : message.options.replayHorizonTime;
        if (!Number.isFinite(horizon)) throw new Error('Invalid replay analytics horizon.');
        const envelope = { scopeKey: message.scopeKey, id: message.id, sourceVersion };
        if (message.type === 'plan') {
          return { ...envelope, type: 'planned', candidates: planner.plan({ ...message.input,
            closedTrades, candlesByInstrument: candles, htfCandlesByInstrument: htfCandles,
            mappingOptions: { ...message.input.mappingOptions, orderEvents },
          }) };
        }
        if (message.closed.exitTime > horizon) throw new Error('Trade has not closed at the revealed horizon.');
        return { ...envelope, type: 'mapped', trade: mapper.map(message.closed, { ...message.options,
          candles: candles[message.closed.instrument] ?? [], htfCandles: htfCandles[message.closed.instrument], orderEvents,
        }) };
      } catch (reason) {
        if (message.type === 'map' || message.type === 'plan') return { type: 'error', scopeKey: message.scopeKey,
          id: message.id, sourceVersion: message.sourceVersion, error: reason instanceof Error ? reason.message : String(reason) };
        throw reason;
      }
    },
  };
};

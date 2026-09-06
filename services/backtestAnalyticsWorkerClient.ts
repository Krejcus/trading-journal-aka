import type { Trade } from '../types';
import type { MarketCandle } from './marketDataCalculations';
import type { BacktestClosedTrade, BacktestOrderEvent } from './backtestTypes';
import type { BacktestAnalyticsRefreshCandidate, BacktestRefreshTrade } from './backtestAnalyticsRefresh';
import type { BacktestAnalyticsWorkerRequest, BacktestAnalyticsWorkerResponse, BacktestWorkerSources, BacktestWorkerPlanInput, BacktestWorkerMappingOptions } from './backtestAnalyticsWorkerProtocol';
export type { BacktestWorkerSources, BacktestWorkerPlanInput, BacktestWorkerMappingOptions } from './backtestAnalyticsWorkerProtocol';

export interface BacktestAnalyticsWorkerPort {
  postMessage(message: BacktestAnalyticsWorkerRequest): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void;
}
const abortError = () => new DOMException('Analytics request superseded or cancelled.', 'AbortError');
const closedFields = ['id', 'runId', 'positionId', 'exitOrderId', 'instrument', 'direction', 'quantity', 'entryPrice', 'exitPrice', 'entryTime', 'exitTime', 'grossPnl', 'commission', 'pnl', 'reason', 'stopLoss', 'takeProfit', 'initialStopLoss', 'initialTakeProfit', 'riskAmount', 'mfeAmount', 'maeAmount', 'mfePoints', 'maePoints', 'mfeR', 'maeR', 'outcomeAmbiguous', 'excursionAmbiguous', 'actualExcursionQuality'] as const;
const eventFields = ['id', 'runId', 'orderId', 'kind', 'instrument', 'marketTime', 'recordedAt', 'side', 'quantity', 'price', 'previousPrice', 'closedQuantity', 'positionQuantityAfter', 'positionId', 'closedPositionId'] as const;
const pick = <T extends object>(value: T, fields: readonly string[]) => Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(value, key)).map(key => [key, (value as Record<string, unknown>)[key]]));
const trimClosed = (value: BacktestClosedTrade) => pick(value, closedFields) as unknown as BacktestClosedTrade;
const trimEvents = (values: readonly BacktestOrderEvent[]) => values.map(value => pick(value, eventFields) as unknown as BacktestOrderEvent);
const trimCandles = (values: readonly MarketCandle[]) => values.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }));
const strings = (values?: readonly string[]) => values?.map(String);
/** Review text, attachments and unrelated trade fields never cross this boundary. */
export const trimBacktestWorkerTrade = (trade: BacktestRefreshTrade): BacktestRefreshTrade => ({
  id: trade.id, accountId: trade.accountId, backtestRunId: trade.backtestRunId,
  htfConfluence: strings(trade.htfConfluence), ltfConfluence: strings(trade.ltfConfluence),
  autoConfluence: trade.autoConfluence ? { htf: strings(trade.autoConfluence.htf) ?? [], ltf: strings(trade.autoConfluence.ltf) ?? [] } : undefined,
  backtestAnalyticsRefresh: trade.backtestAnalyticsRefresh ? pick(trade.backtestAnalyticsRefresh,
    ['version', 'schemaVersion', 'horizonTime', 'sourceHash', 'lastCandleTime', 'complete']) as unknown as BacktestRefreshTrade['backtestAnalyticsRefresh'] : undefined,
} as BacktestRefreshTrade);
const trimOptions = (options: BacktestWorkerMappingOptions | BacktestWorkerPlanInput['mappingOptions']) => {
  const fields = pick(options, ['accountId', 'timeZone', 'flatTimeZone', 'flatByMinute', 'strategy', 'sessionBias', 'replayHorizonTime', 'slippageTicks']);
  // The mapper reads only these reference fields, never the private rule text.
  if (options.researchBinding) fields.researchBinding = pick(options.researchBinding, ['id', 'experimentId', 'revisionId', 'revisionHash', 'role']);
  return fields;
};

/** One lazily started worker per owner/run. One calculation is in flight;
 * repeated refreshes and requests for the same trade coalesce to the latest.
 * Sources/ledger cross the boundary only after their immutable references change.
 */
export const createBacktestAnalyticsWorkerClient = (options: {
  scopeKey: string; workerFactory?: () => BacktestAnalyticsWorkerPort; maxPending?: number;
}) => {
  if (!options.scopeKey) throw new Error('Analytics worker requires an owner/session scope.');
  const factory = options.workerFactory ?? (() => new Worker(new URL('./backtestAnalytics.worker.ts', import.meta.url), { type: 'module' }) as unknown as BacktestAnalyticsWorkerPort);
  type Request = Extract<BacktestAnalyticsWorkerRequest, { type: 'map' | 'plan' }>;
  type Job = { key: string; request: Request; events: readonly BacktestOrderEvent[]; closed?: readonly BacktestClosedTrade[];
    settled: boolean; resolve(value: Trade | BacktestAnalyticsRefreshCandidate[]): void; reject(error: unknown): void; cleanup?: () => void };
  let worker: BacktestAnalyticsWorkerPort | undefined;
  let sources: BacktestWorkerSources = { candlesByInstrument: {}, htfCandlesByInstrument: {} };
  let sentSources: BacktestWorkerSources | undefined;
  let sentEvents: readonly BacktestOrderEvent[] | undefined;
  let sentClosed: readonly BacktestClosedTrade[] | undefined;
  let sourceVersion = 0; let sentVersion = -1; let sequence = 0; let disposed = false;
  let active: Job | undefined;
  const pending = new Map<string, Job>();
  const settle = (job: Job, error?: unknown, value?: Trade | BacktestAnalyticsRefreshCandidate[]) => {
    if (job.settled) return;
    job.settled = true; job.cleanup?.();
    if (error) job.reject(error); else job.resolve(value!);
  };
  const fail = (error: unknown) => {
    if (active) settle(active, error);
    for (const job of pending.values()) settle(job, error);
    active = undefined; pending.clear();
    if (worker) {
      worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); worker.removeEventListener('messageerror', onError);
      worker.terminate(); worker = undefined;
    }
    sentSources = undefined; sentEvents = undefined; sentClosed = undefined; sentVersion = -1;
  };
  const onError: EventListener = event => fail(new Error((event as ErrorEvent).message || 'Analytics worker could not run.'));
  const onMessage: EventListener = event => {
    const response = (event as MessageEvent<BacktestAnalyticsWorkerResponse>).data;
    if (!active || response.id !== active.request.id) return;
    const job = active; active = undefined;
    if (disposed || response.scopeKey !== options.scopeKey || response.sourceVersion !== sourceVersion || response.sourceVersion !== job.request.sourceVersion) settle(job, abortError());
    else if (response.type === 'error') settle(job, new Error(response.error));
    else if (job.request.type === 'plan' && response.type === 'planned') settle(job, undefined, response.candidates);
    else if (job.request.type === 'map' && response.type === 'mapped') settle(job, undefined, response.trade);
    else settle(job, new Error('Invalid analytics worker response.'));
    pump();
  };
  const pump = () => {
    if (active || disposed || !pending.size) return;
    const [key, job] = pending.entries().next().value!; pending.delete(key);
    if (job.settled || job.request.sourceVersion !== sourceVersion) { settle(job, abortError()); pump(); return; }
    active = job;
    try {
      if (!worker) {
        worker = factory(); worker.addEventListener('message', onMessage); worker.addEventListener('error', onError); worker.addEventListener('messageerror', onError);
      }
      if (sentVersion !== sourceVersion) {
        const candles: Extract<BacktestAnalyticsWorkerRequest, { type: 'sources' }>['candles'] = {};
        const htfCandles: typeof candles = {};
        for (const root of ['MNQ', 'NQ'] as const) {
          if (!sentSources || sentSources.candlesByInstrument[root] !== sources.candlesByInstrument[root]) candles[root] = sources.candlesByInstrument[root] ? trimCandles(sources.candlesByInstrument[root]!) : null;
          if (!sentSources || sentSources.htfCandlesByInstrument?.[root] !== sources.htfCandlesByInstrument?.[root]) htfCandles[root] = sources.htfCandlesByInstrument?.[root] ? trimCandles(sources.htfCandlesByInstrument[root]!) : null;
        }
        worker.postMessage({ type: 'sources', scopeKey: options.scopeKey, sourceVersion, candles, htfCandles });
        sentSources = sources; sentVersion = sourceVersion;
      }
      if (sentEvents !== job.events || (job.closed && sentClosed !== job.closed)) {
        worker.postMessage({ type: 'ledger', scopeKey: options.scopeKey,
          ...(sentEvents !== job.events ? { orderEvents: trimEvents(job.events) } : {}),
          ...(job.closed && sentClosed !== job.closed ? { closedTrades: job.closed.map(trimClosed) } : {}),
        });
        sentEvents = job.events; if (job.closed) sentClosed = job.closed;
      }
      worker.postMessage(job.request);
    } catch (error) { fail(error); }
  };
  const request = (key: string, message: Request, events: readonly BacktestOrderEvent[], closed?: readonly BacktestClosedTrade[], signal?: AbortSignal): Promise<Trade | BacktestAnalyticsRefreshCandidate[]> => {
    if (disposed || signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      if (active?.key === key) settle(active, abortError());
      const previous = pending.get(key); if (previous) { settle(previous, abortError()); pending.delete(key); }
      if (pending.size >= Math.max(1, options.maxPending ?? 128)) { reject(new Error('Analytics queue is full. Retry after pending work completes.')); return; }
      const job: Job = { key, request: message, events, closed, settled: false, resolve, reject };
      if (signal) {
        const cancel = () => { settle(job, abortError()); if (pending.get(key) === job) pending.delete(key); };
        signal.addEventListener('abort', cancel, { once: true }); job.cleanup = () => signal.removeEventListener('abort', cancel);
      }
      pending.set(key, job); pump();
    });
  };
  return {
    setSources(next: BacktestWorkerSources) {
      if (disposed) return;
      const changed = (['MNQ', 'NQ'] as const).some(root => sources.candlesByInstrument[root] !== next.candlesByInstrument[root]
        || sources.htfCandlesByInstrument?.[root] !== next.htfCandlesByInstrument?.[root]);
      if (!changed) return;
      sources = { candlesByInstrument: { ...next.candlesByInstrument }, htfCandlesByInstrument: { ...next.htfCandlesByInstrument } }; sourceVersion++;
      if (active) settle(active, abortError());
      for (const job of pending.values()) settle(job, abortError()); pending.clear();
    },
    plan(input: BacktestWorkerPlanInput, requestOptions?: { signal?: AbortSignal }): Promise<BacktestAnalyticsRefreshCandidate[]> {
      const message: Request = { type: 'plan', scopeKey: options.scopeKey, id: ++sequence, sourceVersion,
        input: { trades: input.trades.map(trimBacktestWorkerTrade), replayHorizonTime: input.replayHorizonTime,
          maxTrades: input.maxTrades, slippageTicks: input.slippageTicks,
          mappingOptions: trimOptions(input.mappingOptions) as Omit<BacktestWorkerPlanInput['mappingOptions'], 'orderEvents'> } };
      return request('plan', message, input.mappingOptions.orderEvents, input.closedTrades, requestOptions?.signal) as Promise<BacktestAnalyticsRefreshCandidate[]>;
    },
    mapClosedTrade(closed: BacktestClosedTrade, mapping: BacktestWorkerMappingOptions, requestOptions?: { signal?: AbortSignal }): Promise<Trade> {
      const message: Request = { type: 'map', scopeKey: options.scopeKey, id: ++sequence, sourceVersion, closed: trimClosed(closed),
        options: trimOptions(mapping) as Omit<BacktestWorkerMappingOptions, 'orderEvents'> };
      return request(`map:${closed.id}`, message, mapping.orderEvents, undefined, requestOptions?.signal) as Promise<Trade>;
    },
    stop() { sourceVersion++; fail(abortError()); },
    dispose() { disposed = true; fail(abortError()); sources = { candlesByInstrument: {} }; },
  };
};
export type BacktestAnalyticsWorkerClient = ReturnType<typeof createBacktestAnalyticsWorkerClient>;

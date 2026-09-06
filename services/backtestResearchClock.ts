import type { BacktestClosedTrade, BacktestOrderEvent } from './backtestTypes';

/** Wall-clock intent from the opening order, never the historical market time.
 * Position identity is essential: timestamp/symbol matching confuses partials,
 * reversals and repeat sessions. Missing or conflicting evidence stays unknown.
 */
export const backtestResearchRecordedAt = (
  closed: Pick<BacktestClosedTrade, 'positionId' | 'runId' | 'instrument' | 'entryTime'>,
  events: readonly BacktestOrderEvent[],
): number | undefined => {
  if (!closed.positionId) return undefined;
  const timestamps = new Set(events.filter(event => event.kind === 'created'
    && event.orderId === closed.positionId && event.runId === closed.runId
    && event.instrument === closed.instrument && event.marketTime <= closed.entryTime)
    .map(event => event.recordedAt)
    .filter((value): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 8.64e15));
  return timestamps.size === 1 ? timestamps.values().next().value : undefined;
};

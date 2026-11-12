import type { TradovateWorkerAccountCoverage } from './tradovateRequestControl';
import { hasCompleteTradovateRead } from './tradovateLiveReadState.js';
import type { TradovateAccountDataResult } from './tradovateAccountDataTypes';

export const WORKER_COVERAGE_MAX_AGE_MS = 8_000;
export interface WorkerCoverageOwner { connectionId: string; environment: 'demo' | 'live' }
export interface WorkerCoverageStatus { controller?: { connected?: boolean; exposure?: { streamCoverage?: readonly TradovateWorkerAccountCoverage[] } | null } }
export interface WorkerCoverageReceipt { status: WorkerCoverageStatus | null | undefined; observedAt: number | null | undefined }
export type WorkerConnectionDataset = TradovateAccountDataResult & WorkerCoverageOwner;
const finiteTime = (value: number) => Number.isFinite(value) && value > 0;

/** A current continuity assertion is distinct from the historical data timestamp it protects. */
export function workerAccountCoverageUsable(row: TradovateWorkerAccountCoverage, owner: WorkerCoverageOwner,
  accountId: number, now: number): boolean {
  return row.accountId === accountId && row.connectionId === owner.connectionId && row.environment === owner.environment
    && Number.isSafeInteger(row.routeEpoch) && row.routeEpoch >= 0 && row.routeEpoch === row.currentRouteEpoch
    && typeof row.sessionId === 'string' && row.sessionId.length > 0 && row.sessionId === row.currentSessionId
    && row.socketLive === true && row.synchronized === true && row.gap === false && row.backlog === false && row.mergeInProgress === false
    && finiteTime(row.baselineAt) && finiteTime(row.lastDataAt) && finiteTime(row.observedAt)
    && row.baselineAt <= row.lastDataAt && row.lastDataAt <= row.observedAt
    && row.observedAt <= now + 1_000 && now - row.observedAt <= WORKER_COVERAGE_MAX_AGE_MS;
}

export function coveredWorkerAccounts(receipt: WorkerCoverageReceipt | null | undefined, owner: WorkerCoverageOwner,
  accountIds: readonly number[], now = Date.now()): Map<number, TradovateWorkerAccountCoverage> {
  const result = new Map<number, TradovateWorkerAccountCoverage>();
  const at = receipt?.observedAt;
  if (!receipt?.status?.controller?.connected || at == null || !Number.isFinite(at)
    || at > now + 1_000 || now - at > WORKER_COVERAGE_MAX_AGE_MS) return result;
  const rows = receipt.status.controller.exposure?.streamCoverage ?? [];
  for (const accountId of accountIds) {
    const matching = rows.filter(row => row.accountId === accountId && row.connectionId === owner.connectionId && row.environment === owner.environment);
    if (matching.length === 1 && workerAccountCoverageUsable(matching[0], owner, accountId, now)) result.set(accountId, matching[0]);
  }
  return result;
}

/** Full connection ticks are bulk wire reads. Partial coverage keeps that governed fallback. */
export function workerConnectionReadPlan(dataset: WorkerConnectionDataset | null | undefined,
  receipt: WorkerCoverageReceipt | null | undefined, now = Date.now()) {
  const ids = dataset?.accounts.map(account => account.id) ?? [];
  const baselineComplete = !!dataset && hasCompleteTradovateRead(dataset.coverage.accounts) && dataset.coverage.accounts.count === ids.length && ids.length > 0;
  const covered = baselineComplete ? coveredWorkerAccounts(receipt, dataset!, ids, now) : new Map<number, TradovateWorkerAccountCoverage>();
  return { suppressFullTick: baselineComplete && covered.size === ids.length, covered,
    uncoveredAccountIds: ids.filter(id => !covered.has(id)) };
}

/** Duplicated account ownership is ambiguous; one OAuth connection must not cover another. */
export function workerCoverageOwners(datasets: Readonly<Record<string, WorkerConnectionDataset>>): Map<number, WorkerCoverageOwner> {
  const owners = new Map<number, WorkerCoverageOwner>();
  const ambiguous = new Set<number>();
  for (const [connectionId, data] of Object.entries(datasets)) for (const account of data.accounts) {
    if (owners.has(account.id)) ambiguous.add(account.id);
    else owners.set(account.id, { connectionId, environment: data.environment });
  }
  for (const id of ambiguous) owners.delete(id);
  return owners;
}

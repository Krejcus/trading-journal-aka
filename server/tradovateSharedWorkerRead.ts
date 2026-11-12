import type { TradovateAccountDisplaySnapshot } from '../lib/tradovateAccountDisplayTypes.js';
import { tradovateDisplayTradeDate } from '../lib/tradovateDisplayDay.js';
import { TradovateSharedReadDeferred } from './tradovateSharedRead.js';
import type { TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes.js';
import type { TradovateLivePnlTick } from '../lib/tradovateLivePnlTypes.js';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol.js';
import { workerConnectionReadPlan } from '../lib/tradovateWorkerCoverage.js';
import { overlayWorkerExposure } from '../lib/tradovateWorkerExposureOverlay.js';
import type { TradovateSharedReadContext } from './tradovateSharedRead.js';

/** Pure projection of an existing broker proof. Continuity alone never qualifies. */
export function workerSharedTick(context: Pick<TradovateSharedReadContext, 'connectionId' | 'environment'>,
  baseline: TradovateAccountDataResult, status: LocalCopierAgentStatus, receivedAt: number, now = Date.now(), authorizationAt = 0): TradovateLivePnlTick | null {
  if (status?.environment !== context.environment || !status.controller?.exposure?.orders) return null;
  const builtAt = status.displayBuiltAt;
  if (typeof builtAt !== 'number' || !Number.isFinite(builtAt) || builtAt > receivedAt + 1_000 || now - builtAt > 8_000) return null;
  const plan = workerConnectionReadPlan({ ...baseline, ...context }, { status, observedAt: receivedAt }, now);
  if (!plan.suppressFullTick || [...plan.covered.values()].some(row => row.baselineAt < authorizationAt)) return null;
  const symbols = new Set(baseline.contracts.map(contract => contract.name));
  const exposure = status.controller.exposure;
  const ids = new Set(baseline.accounts.map(account => account.id));
  // Unknown contract metadata is not permission to drop an open position or order.
  if ([...exposure.positions, ...exposure.orders].some(row => ids.has(row.accountId) && !symbols.has(row.symbol))) return null;
  const data = overlayWorkerExposure(baseline, status, receivedAt, now,
    new Map(baseline.accounts.map(account => [account.id, context])))!;
  const observedAt = Math.min(receivedAt, builtAt, ...[...plan.covered.values()].map(row => row.observedAt));
  const at = new Date(observedAt).toISOString();
  return { ...context, requestedAt: at, capturedAt: at, anchor: null,
    positions: data.accounts.flatMap(account => account.positions.map(position => ({ id: position.id,
      accountId: account.id, contractId: position.contractId, netPosition: position.netPosition,
      averagePrice: position.averagePrice, timestamp: position.timestamp }))),
    orders: data.accounts.flatMap(account => account.orders.map(order => ({ ...order, accountId: account.id }))),
    activeContractCount: new Set(data.accounts.flatMap(account => account.positions.map(position => position.contractId))).size,
    nextContractCursor: 0, brokerCalls: 0,
  };
}

async function sharedWorkerRuntime(context: TradovateSharedReadContext): Promise<{ status: LocalCopierAgentStatus; receivedAt: number; authorizationAt: number } | null> {
  const [authorization, devices] = await Promise.all([
    context.db.from('tradovate_oauth_connections').select('connected_at,connection_status')
      .eq('user_id', context.userId).eq('id', context.connectionId).eq('environment', context.environment).maybeSingle(),
    context.db.from('tradovate_copier_devices')
    .select('id,runtime:tradovate_copier_device_runtime!inner(status,last_seen_at)')
    .eq('user_id', context.userId).is('revoked_at', null),
  ]);
  const { data, error } = devices;
  if (authorization.error) throw new Error('tradovate-shared-authorization-unavailable');
  if (authorization.data?.connection_status !== 'connected') throw new Error('tradovate-not-connected');
  // Routine token renewal preserves an existing authorized WebSocket session.
  // A new OAuth grant does not: its connected_at must precede the proof baseline.
  const authorizationAt = Date.parse(authorization.data.connected_at) || 0;
  if (!authorizationAt) return null;
  if (error) throw new Error('tradovate-shared-worker-read-unavailable');
  const now = Date.now();
  // Multiple fresh workers are ambiguous. Do not pick whichever happens to look healthy.
  const runtimes = (data ?? []).flatMap(device => Array.isArray(device.runtime) ? device.runtime : device.runtime ? [device.runtime] : [])
    .filter(row => Number.isFinite(Date.parse(row.last_seen_at)) && now - Date.parse(row.last_seen_at) <= 8_000
      && Date.parse(row.last_seen_at) <= now + 1_000)
    .filter(row => row.status?.connectionDiscovery?.connectionAccounts?.some(item => item.connectionId === context.connectionId));
  // One physical worker publishes the same status through several OAuth devices.
  // Deduplicate only when both the primary device and process start identify it.
  const instances = new Map<string, typeof runtimes[number]>();
  for (const candidate of runtimes) {
    const primary = candidate.status?.device?.deviceId;
    const started = candidate.status?.startedAt;
    const key = typeof primary === 'string' && primary && Number.isFinite(Date.parse(started ?? ''))
      ? `${primary}:${started}` : `unidentified:${instances.size}`;
    const previous = instances.get(key);
    const sequence = (value: typeof candidate) => typeof value.status?.displaySeq === 'number' && Number.isFinite(value.status.displaySeq) ? value.status.displaySeq : -1;
    if (!previous || sequence(candidate) > sequence(previous)
      || (sequence(candidate) === sequence(previous) && candidate.status.displayBuiltAt > previous.status.displayBuiltAt)) instances.set(key, candidate);
  }
  if (instances.size !== 1) return null;
  const row = [...instances.values()][0];
  if (row.status?.environment !== context.environment || !row.status.controller?.connected
    || !Number.isFinite(row.status.displayBuiltAt) || now - row.status.displayBuiltAt > 8_000
    || row.status.displayBuiltAt > now + 1_000) return null;
  return { status: row.status, receivedAt: Date.parse(row.last_seen_at), authorizationAt };
}

export async function readWorkerSharedTick(context: TradovateSharedReadContext, baseline: TradovateAccountDataResult): Promise<TradovateLivePnlTick | null> {
  const runtime = await sharedWorkerRuntime(context);
  return runtime ? workerSharedTick(context, baseline, runtime.status, runtime.receivedAt, Date.now(), runtime.authorizationAt) : null;
}

/** Cash is display-only and keeps its broker confirmation time, even when unchanged. */
export async function readWorkerSharedCash(context: TradovateSharedReadContext, accountId: number): Promise<TradovateAccountDisplaySnapshot | null> {
  const runtime = await sharedWorkerRuntime(context);
  if (!runtime) return null;
  const membership = runtime.status.connectionDiscovery?.connectionAccounts?.find(row => row.connectionId === context.connectionId);
  if (!membership?.accountIds.includes(accountId)) return null;
  const feeds = runtime.status.accountDisplay?.filter(feed => feed.connectionId === context.connectionId && feed.environment === context.environment) ?? [];
  if (feeds.length !== 1 || feeds[0].streamConnected !== true) return null;
  const feed = feeds[0];
  if (feed.captchaRequired || feed.lastErrorAt || feed.retryAt || feed.pendingAccountIds.includes(accountId)) {
    // This collector already owns the pending cash read. A second device must not duplicate it.
    throw new TradovateSharedReadDeferred(Math.max(1_000, (Date.parse(feed.retryAt ?? '') || Date.now() + 5_000) - Date.now()));
  }
  const snapshots = feed.snapshots.filter(row => row.accountId === accountId && row.connectionId === context.connectionId && row.environment === context.environment);
  if (snapshots.length !== 1) return null;
  const snapshot = snapshots[0];
  const requested = Date.parse(snapshot.requestedAt), confirmed = Date.parse(snapshot.confirmedAt);
  const now = Date.now();
  if (requested < runtime.authorizationAt || !Number.isFinite(requested) || !Number.isFinite(confirmed) || requested > confirmed || confirmed > now + 1_000
    || now - confirmed > 11 * 60_000 || tradovateDisplayTradeDate(confirmed) !== tradovateDisplayTradeDate(now)) return null;
  return snapshot;
}

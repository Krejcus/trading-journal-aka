import type { SupabaseClient } from '@supabase/supabase-js';
import type { NativeLiveActivityBrokerAccount } from './nativeLiveActivityBrokerSnapshot.js';
import type {
  NativeBrokerSnapshotLoader,
  NativeLiveActivityRuntimeRow,
} from './nativeLiveActivityUpdater.js';

export const ACCOUNT_SNAPSHOT_INTERVAL_MS = 15 * 60_000;

interface ConnectedOAuthRow {
  id: string;
  user_id: string;
}

const recentAccountCache = new Map<string, number>();
const cacheKey = (userId: string, connectionId: string, accountId: number) =>
  `${userId}:${connectionId}:${accountId}`;

export function resetAccountSnapshotThrottleCacheForTests(): void {
  recentAccountCache.clear();
}

export async function persistAccountSnapshots(options: {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  accounts: readonly NativeLiveActivityBrokerAccount[];
  capturedAt: number;
}): Promise<number> {
  const persistableAccounts = options.accounts.filter(account => account.balanceAvailable !== false);
  const accountIds = [...new Set(persistableAccounts.map(account => account.accountId).filter(Number.isSafeInteger))];
  if (accountIds.length === 0) return 0;
  const cutoffMs = options.capturedAt - ACCOUNT_SNAPSHOT_INTERVAL_MS;
  const uncachedIds = accountIds.filter(accountId =>
    (recentAccountCache.get(cacheKey(options.userId, options.connectionId, accountId)) ?? -Infinity) <= cutoffMs);
  if (uncachedIds.length === 0) return 0;

  // Cache je jen levný fast-path v teplé serverless instanci. DB kontrola je
  // autoritativní po cold startu i při souběžných instancích cronu.
  const { data: recentRows, error: recentError } = await options.db.from('copier_account_snapshots')
    .select('external_account_id,captured_at')
    .eq('user_id', options.userId)
    .eq('connection_id', options.connectionId)
    .gt('captured_at', new Date(cutoffMs).toISOString())
    .in('external_account_id', uncachedIds.map(String));
  if (recentError) throw new Error(`snapshot-account-throttle-query-failed: ${recentError.message}`);
  const recentIds = new Set((recentRows ?? []).map(row => String(row.external_account_id)));
  const timestamp = new Date(options.capturedAt).toISOString();
  const rows = persistableAccounts.flatMap(account => {
    if (!uncachedIds.includes(account.accountId) || recentIds.has(String(account.accountId))) return [];
    return [{
      user_id: options.userId,
      connection_id: options.connectionId,
      external_account_id: String(account.accountId),
      captured_at: timestamp,
      balance: account.balance,
      realized_pnl_day: account.realizedPnl,
      open_pnl: account.openPnlAvailable === false ? null : account.openPnl,
    }];
  });
  if (rows.length === 0) return 0;
  const { error } = await options.db.from('copier_account_snapshots').insert(rows);
  if (error) throw new Error(`snapshot-insert-failed: ${error.message}`);
  rows.forEach(row => recentAccountCache.set(
    cacheKey(options.userId, options.connectionId, Number(row.external_account_id)),
    options.capturedAt,
  ));
  return rows.length;
}

/**
 * Best-effort 15min sběr všech připojených OAuth spojení. Každé selhání končí
 * varováním; alerty, Live Activity ani WidgetKit se kvůli snapshotům nezastaví.
 */
export async function collectConnectedAccountSnapshots(options: {
  db: SupabaseClient;
  environment: 'demo' | 'live';
  runtimes: readonly NativeLiveActivityRuntimeRow[];
  brokerSnapshot: NativeBrokerSnapshotLoader;
  now: number;
}): Promise<{ connections: number; inserted: number; failed: number }> {
  const { data, error } = await options.db.from('tradovate_oauth_connections')
    .select('id,user_id')
    .eq('environment', options.environment)
    .eq('connection_status', 'connected');
  if (error) {
    console.warn('[Cron] Account snapshot connections query failed:', error.message);
    return { connections: 0, inserted: 0, failed: 1 };
  }
  const connected = (data ?? []) as ConnectedOAuthRow[];
  if (connected.length === 0) return { connections: 0, inserted: 0, failed: 0 };
  const cutoff = new Date(options.now - ACCOUNT_SNAPSHOT_INTERVAL_MS).toISOString();
  const { data: recentRows, error: recentError } = await options.db.from('copier_account_snapshots')
    .select('connection_id')
    .in('connection_id', connected.map(connection => connection.id))
    .gt('captured_at', cutoff);
  if (recentError) {
    console.warn('[Cron] Account snapshot throttle query failed:', recentError.message);
    return { connections: connected.length, inserted: 0, failed: 1 };
  }
  const recentConnectionIds = new Set((recentRows ?? []).map(row => String(row.connection_id)));
  let inserted = 0;
  let failed = 0;
  for (const connection of connected) {
    try {
      if (recentConnectionIds.has(connection.id)) continue;
      const runtime = [...options.runtimes]
        .filter(candidate => candidate.user_id === connection.user_id && candidate.connection_id === connection.id)
        .sort((left, right) => Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at))[0]
        ?? {
          device_id: `snapshot:${connection.id}`,
          user_id: connection.user_id,
          connection_id: connection.id,
          status: {},
          last_seen_at: new Date(options.now).toISOString(),
          started_at: new Date(options.now).toISOString(),
        };
      const broker = await options.brokerSnapshot(runtime, { allAccounts: true });
      if (!broker) continue;
      inserted += await persistAccountSnapshots({
        db: options.db,
        userId: connection.user_id,
        connectionId: connection.id,
        accounts: broker.accounts,
        capturedAt: broker.capturedAt,
      });
    } catch (snapshotError) {
      failed += 1;
      console.warn('[Cron] Account snapshot skipped:', snapshotError instanceof Error
        ? snapshotError.message : String(snapshotError));
    }
  }
  return { connections: connected.length, inserted, failed };
}

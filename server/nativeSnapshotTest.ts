import type { SupabaseClient } from '@supabase/supabase-js';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol.js';
import { enqueueTradovateCopierCommand } from './tradovateCopierCommandRelay.js';

export interface SnapshotTestRuntimeRow {
  device_id: string;
  connection_id: string;
  status: LocalCopierAgentStatus;
  last_seen_at: string;
}

export function selectReadySnapshotTestRuntime(
  rows: readonly SnapshotTestRuntimeRow[],
  now = Date.now(),
): SnapshotTestRuntimeRow | null {
  return rows.find(row => {
    const health = row.status?.snapshotHealth;
    return row.status?.environment === 'demo'
      && Number.isFinite(Date.parse(row.last_seen_at))
      && now - Date.parse(row.last_seen_at) < 10_000
      && health?.enabled === true
      && health.state === 'ready'
      && health.cdpReachable === true
      && health.targetFound === true;
  }) ?? null;
}

export async function enqueueNativeSnapshotTest(options: {
  db: SupabaseClient;
  userId: string;
  idempotencyKey: string;
  now?: number;
}) {
  const now = options.now ?? Date.now();
  const { data, error } = await options.db
    .from('tradovate_copier_device_runtime')
    .select('device_id,connection_id,status,last_seen_at')
    .eq('user_id', options.userId)
    .gte('last_seen_at', new Date(now - 10_000).toISOString())
    .order('last_seen_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(`snapshot-test-runtime-query-failed: ${error.message}`);
  const runtime = selectReadySnapshotTestRuntime((data ?? []) as SnapshotTestRuntimeRow[], now);
  if (!runtime) {
    throw new Error((data ?? []).length > 0
      ? 'snapshot-test-camera-not-ready'
      : 'snapshot-test-worker-unavailable');
  }
  const { data: recent, error: recentError } = await options.db
    .from('tradovate_copier_commands')
    .select('id')
    .eq('user_id', options.userId)
    .eq('device_id', runtime.device_id)
    .eq('command_type', 'snapshot-test')
    .gte('created_at', new Date(now - 30_000).toISOString())
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (recentError) throw new Error(`snapshot-test-throttle-query-failed: ${recentError.message}`);
  if (recent) throw new Error('snapshot-test-rate-limit');
  return enqueueTradovateCopierCommand({
    db: options.db,
    userId: options.userId,
    connectionId: runtime.connection_id,
    deviceId: runtime.device_id,
    command: { type: 'snapshot-test' },
    idempotencyKey: options.idempotencyKey,
    now,
  });
}

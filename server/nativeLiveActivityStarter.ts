import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendApnsLiveActivityStart,
  type ApnsDevice,
  type ApnsLiveActivityStart,
  type ApnsResult,
} from './apns.js';
import {
  latestNativeRuntimeByUser,
  planNativeLiveActivityUpdate,
  type NativeBrokerSnapshotLoader,
  type NativeLiveActivityRuntimeRow,
} from './nativeLiveActivityUpdater.js';

export interface NativeLiveActivityStartSubscriptionRow {
  id: string;
  user_id: string;
  installation_id: string;
  push_token: string;
  environment: 'development' | 'production';
  bundle_id: string;
  last_start_trigger: string | null;
  last_started_at: string | null;
}

export interface NativeLiveActivityStartPlan {
  trigger: string | null;
  reason: 'armed' | 'position' | 'inactive' | 'stale';
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const controllerOf = (runtime: NativeLiveActivityRuntimeRow): Record<string, unknown> => {
  const root = object(runtime.status);
  return Object.keys(object(root.controller)).length > 0 ? object(root.controller) : root;
};
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

/** Stable session identity prevents an activity dismissed by the user from reappearing. */
export function planNativeLiveActivityStart(options: {
  runtime: NativeLiveActivityRuntimeRow;
  broker: Awaited<ReturnType<NativeBrokerSnapshotLoader>>;
  now: number;
}): NativeLiveActivityStartPlan {
  const lastSeen = Date.parse(options.runtime.last_seen_at);
  if (!Number.isFinite(lastSeen) || options.now - lastSeen > 90_000) {
    return { trigger: null, reason: 'stale' };
  }
  const controller = controllerOf(options.runtime);
  if (controller.armed === true) {
    const startedAt = finite(controller.armedAt)
      || finite(controller.armExpiresAt)
      || Date.parse(options.runtime.started_at);
    return { trigger: `arm:${options.runtime.device_id}:${startedAt}`, reason: 'armed' };
  }
  if (!options.broker || options.broker.positions.length === 0) {
    return { trigger: null, reason: 'inactive' };
  }
  const events = Array.isArray(controller.recentCopyEvents) ? controller.recentCopyEvents.map(object) : [];
  const entry = [...events].reverse().find(event =>
    event.kind === 'entry' || event.kind === 'flip' || event.kind === 'scale-in');
  const stablePosition = [...options.broker.positions]
    .map(position => ({
      accountId: position.accountId,
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
    }))
    .sort((a, b) => a.accountId - b.accountId || String(a.symbol).localeCompare(String(b.symbol)));
  const identity = typeof entry?.id === 'string' && entry.id
    ? entry.id.slice(0, 120)
    : hash({ startedAt: options.runtime.started_at, positions: stablePosition });
  return { trigger: `position:${options.runtime.device_id}:${identity}`, reason: 'position' };
}

export async function startNativeLiveActivities(options: {
  db: SupabaseClient;
  runtimes: readonly NativeLiveActivityRuntimeRow[];
  brokerSnapshot: NativeBrokerSnapshotLoader;
  now?: number;
  send?: (device: ApnsDevice, start: ApnsLiveActivityStart) => Promise<ApnsResult>;
}): Promise<{ registered: number; sent: number; skipped: number; failed: number; expired: number }> {
  const now = options.now ?? Date.now();
  const [{ data, error }, { data: activeData, error: activeError }] = await Promise.all([
    options.db.from('native_live_activity_start_subscriptions')
      .select('id,user_id,installation_id,push_token,environment,bundle_id,last_start_trigger,last_started_at')
      .is('expires_at', null),
    options.db.from('native_live_activity_subscriptions')
      .select('user_id')
      .is('expires_at', null),
  ]);
  if (error) throw new Error(`native-live-activity-start-query-failed: ${error.message}`);
  if (activeError) throw new Error(`native-live-activity-active-query-failed: ${activeError.message}`);
  const subscriptions = (data ?? []) as NativeLiveActivityStartSubscriptionRow[];
  const activeUsers = new Set((activeData ?? []).map(row => String(row.user_id)));
  const runtimes = latestNativeRuntimeByUser(options.runtimes);
  const send = options.send ?? sendApnsLiveActivityStart;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let expired = 0;

  for (const subscription of subscriptions) {
    const runtime = runtimes.get(subscription.user_id);
    if (!runtime) { skipped++; continue; }
    const broker = await options.brokerSnapshot(runtime);
    const startPlan = planNativeLiveActivityStart({ runtime, broker, now });
    if (!startPlan.trigger || subscription.last_start_trigger === startPlan.trigger) {
      skipped++;
      continue;
    }
    const nowIso = new Date(now).toISOString();
    // An existing activity already covers this session. Recording its trigger
    // also preserves a user's explicit dismissal for the rest of the session.
    if (activeUsers.has(subscription.user_id)) {
      await options.db.from('native_live_activity_start_subscriptions').update({
        last_start_trigger: startPlan.trigger,
        last_error: null,
        updated_at: nowIso,
      }).eq('id', subscription.id);
      skipped++;
      continue;
    }
    const live = planNativeLiveActivityUpdate({ runtime, broker, now });
    const result = await send({
      id: subscription.installation_id,
      deviceToken: subscription.push_token,
      environment: subscription.environment,
      bundleId: subscription.bundle_id,
    }, {
      attributes: {
        sessionID: `remote-${subscription.id.slice(0, 8)}-${Math.floor(now / 1_000)}`,
        symbol: live.symbol,
      },
      state: live.update.state,
      alert: {
        title: startPlan.reason === 'armed' ? 'Copier je ARM' : 'Otevřená kopie',
        body: live.update.state.headline,
      },
      staleAt: now / 1_000 + 180,
    });
    if (result.status === 'sent') {
      sent++;
      await options.db.from('native_live_activity_start_subscriptions').update({
        last_start_trigger: startPlan.trigger,
        last_started_at: nowIso,
        last_error: null,
        updated_at: nowIso,
      }).eq('id', subscription.id);
    } else {
      failed++;
      if (result.status === 'expired') expired++;
      await options.db.from('native_live_activity_start_subscriptions').update({
        last_error: result.error ?? `APNs HTTP ${result.statusCode ?? 0}`,
        updated_at: nowIso,
        ...(result.status === 'expired' ? { expires_at: nowIso } : {}),
      }).eq('id', subscription.id);
    }
  }
  return { registered: subscriptions.length, sent, skipped, failed, expired };
}

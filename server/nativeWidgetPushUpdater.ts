import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { sendApnsWidgetUpdate, type ApnsDevice } from './apns.js';
import {
  latestNativeRuntimeByUser,
  planNativeLiveActivityUpdate,
  type NativeBrokerSnapshotLoader,
  type NativeLiveActivityRuntimeRow,
} from './nativeLiveActivityUpdater.js';

export interface NativeWidgetPushDeviceRow {
  id: string;
  user_id: string;
  widget_push_token: string;
  widget_push_environment: 'development' | 'production';
  widget_push_bundle_id: string;
  widget_push_last_sent_at: string | null;
  widget_push_last_payload_hash: string | null;
  widget_push_last_urgent_hash: string | null;
}

export interface NativeWidgetPushPlan {
  payloadHash: string;
  urgentHash: string;
  shouldSend: boolean;
  reason: 'initial' | 'urgent-change' | 'pnl-refresh' | 'unchanged' | 'throttled';
}

const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Widget pushes are budgeted by iOS. Structural safety/position changes bypass
 * our throttle, while changing open P&L is capped to one request per 5 minutes.
 * User-visible urgent alerts and ActivityKit remain separate instant channels.
 */
export function planNativeWidgetPush(options: {
  payloadHash: string;
  urgentState: unknown;
  lastPayloadHash: string | null;
  lastUrgentHash: string | null;
  lastSentAt: string | null;
  now: number;
}): NativeWidgetPushPlan {
  const urgentHash = sha256(options.urgentState);
  if (!options.lastPayloadHash || !options.lastUrgentHash) {
    return { payloadHash: options.payloadHash, urgentHash, shouldSend: true, reason: 'initial' };
  }
  if (urgentHash !== options.lastUrgentHash) {
    return { payloadHash: options.payloadHash, urgentHash, shouldSend: true, reason: 'urgent-change' };
  }
  if (options.payloadHash === options.lastPayloadHash) {
    return { payloadHash: options.payloadHash, urgentHash, shouldSend: false, reason: 'unchanged' };
  }
  const lastSent = Date.parse(options.lastSentAt ?? '');
  if (!Number.isFinite(lastSent) || options.now - lastSent >= 5 * 60_000) {
    return { payloadHash: options.payloadHash, urgentHash, shouldSend: true, reason: 'pnl-refresh' };
  }
  return { payloadHash: options.payloadHash, urgentHash, shouldSend: false, reason: 'throttled' };
}

export async function updateNativeWidgetPushes(options: {
  db: SupabaseClient;
  runtimes: readonly NativeLiveActivityRuntimeRow[];
  brokerSnapshot: NativeBrokerSnapshotLoader;
  now?: number;
}): Promise<{ registered: number; sent: number; skipped: number; failed: number; expired: number }> {
  const now = options.now ?? Date.now();
  const { data, error } = await options.db.from('native_widget_devices')
    .select('id,user_id,widget_push_token,widget_push_environment,widget_push_bundle_id,widget_push_last_sent_at,widget_push_last_payload_hash,widget_push_last_urgent_hash')
    .is('expired_at', null)
    .is('widget_push_expired_at', null)
    .eq('widget_push_enabled', true)
    .not('widget_push_token', 'is', null);
  if (error) throw new Error(`native-widget-push-query-failed: ${error.message}`);
  const devices = (data ?? []) as NativeWidgetPushDeviceRow[];
  const runtimes = latestNativeRuntimeByUser(options.runtimes);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let expired = 0;

  for (const device of devices) {
    const runtime = runtimes.get(device.user_id);
    if (!runtime) {
      skipped++;
      continue;
    }
    const broker = await options.brokerSnapshot(runtime);
    const live = planNativeLiveActivityUpdate({ runtime, broker, now });
    const plan = planNativeWidgetPush({
      payloadHash: live.payloadHash,
      urgentState: {
        event: live.shouldEnd ? 'end' : 'update',
        status: live.update.state.status,
        headline: live.update.state.headline,
        detail: live.update.state.detail,
      },
      lastPayloadHash: device.widget_push_last_payload_hash,
      lastUrgentHash: device.widget_push_last_urgent_hash,
      lastSentAt: device.widget_push_last_sent_at,
      now,
    });
    if (!plan.shouldSend) {
      skipped++;
      continue;
    }
    const result = await sendApnsWidgetUpdate({
      id: device.id,
      deviceToken: device.widget_push_token,
      environment: device.widget_push_environment,
      bundleId: device.widget_push_bundle_id,
    } as ApnsDevice, {
      // ARM/DISARM a změny stavu musí widget překreslit hned (priorita 10);
      // pouhé osvěžení P&L zůstává úsporné (5) kvůli iOS budgetu.
      urgent: plan.reason === 'initial' || plan.reason === 'urgent-change',
    });
    const nowIso = new Date(now).toISOString();
    if (result.status === 'sent') {
      sent++;
      await options.db.from('native_widget_devices').update({
        widget_push_last_sent_at: nowIso,
        widget_push_last_payload_hash: plan.payloadHash,
        widget_push_last_urgent_hash: plan.urgentHash,
        widget_push_last_error: null,
      }).eq('id', device.id);
      continue;
    }
    failed++;
    if (result.status === 'expired') expired++;
    await options.db.from('native_widget_devices').update({
      widget_push_last_error: result.error ?? `APNs HTTP ${result.statusCode ?? 0}`,
      ...(result.status === 'expired' ? { widget_push_expired_at: nowIso, widget_push_enabled: false } : {}),
    }).eq('id', device.id);
  }

  return { registered: devices.length, sent, skipped, failed, expired };
}

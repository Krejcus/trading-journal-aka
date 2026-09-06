import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendApnsNotification, type ApnsNotification, type ApnsResult } from './apns.js';
import { COPY_EVENTS_MARKER_KEY, type AlertStateUpsert, type CopierAlertStateRow } from './copierIncidentWatchdog.js';

export const NOTIFICATION_DELIVERY_TABLE = 'notification_delivery_outbox';
const LEASE_MS = 60_000; // Longer than a single bounded APNs/Web Push request.
const PREPARATION_TIMEOUT_MS = 10_000;

/** A late read/signing response must not resume an expired sender. */
async function boundedPreparation<T>(operation: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('notification-preparation-timeout')), PREPARATION_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
export type NotificationChannel = 'apns' | 'web';
export type NotificationPayload = ApnsNotification & { imageStoragePath?: string; imageDeadlineAt?: number };
export type VersionedAlertState = CopierAlertStateRow & { updated_at?: string; notification_version?: string };
export type WebPushSender = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, title: string, body: string, type: string) => Promise<ApnsResult>;

export const notificationEventKey = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export function copierEventDeliveryKey(input: { deviceId: string; eventId?: string; episodeId?: string; kind: string; at: number }): string {
  // The worker uploads ENTRY/EXIT with the exact event.at (not capture time).
  // Other events have a sequence-bearing ID: two modifies/scale-ins in the same
  // millisecond must remain distinct even when APNs groups their presentation.
  const identity = input.episodeId && (input.kind === 'entry' || input.kind === 'exit')
    ? `${input.episodeId.toLowerCase()}:${input.kind}:${input.at}`
    : `${input.eventId ?? input.episodeId ?? 'unknown'}:${input.at}:${input.kind}`;
  return notificationEventKey('copier-event', input.deviceId, identity);
}

export function markerForIncident(key: string): string {
  if (key === 'arm-started' || key === 'arm-ended') return 'state:armed';
  if (key === 'cooldown-ended') return 'state:cooldown';
  if (['day-lock', 'cooldown', 'auto-close', 'resume-offer'].includes(key)) return `state:${key}`;
  return key;
}
export function incidentDeliveryKey(input: { deviceId: string; key: string; kind: string }, previous?: VersionedAlertState): string {
  return notificationEventKey('copier-incident', input.deviceId, input.key, input.kind, previous?.notification_version ?? previous?.updated_at ?? 'initial');
}

/** Insert-before-send. Conflicts preserve the first payload and its delivery state. */
export async function enqueueNotificationDelivery(options: {
  db: SupabaseClient; userId: string; eventKey: string; channel: NotificationChannel;
  subscriptionId: string; payload: NotificationPayload; now?: number;
}): Promise<void> {
  const now = options.now ?? Date.now();
  const { error } = await options.db.from(NOTIFICATION_DELIVERY_TABLE).upsert({
    user_id: options.userId, event_key: options.eventKey, channel: options.channel,
    subscription_id: options.subscriptionId,
    // Presentation grouping must use the same identity as durable deduplication.
    payload: { ...options.payload, collapseId: `at-${options.eventKey.slice(0, 48)}` },
    next_attempt_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60 * 60_000).toISOString(),
  }, { onConflict: 'user_id,event_key,channel,subscription_id', ignoreDuplicates: true });
  if (error) throw new Error(`notification-enqueue-failed: ${error.message}`);
}

/** Cursor tracks durable discovery, never successful delivery. Retry lives in the outbox. */
export async function advanceCopyEventCursor(db: SupabaseClient, userId: string, deviceId: string, at: number, silentBaseline = false): Promise<void> {
  if (!Number.isFinite(at) || at < 0) throw new Error('invalid-copy-event-cursor');
  const { error } = await db.rpc('advance_copier_notification_cursor', {
    p_user_id: userId, p_device_id: deviceId, p_at: Math.floor(at), p_silent_baseline: silentBaseline,
  });
  if (error) throw new Error(`copy-event-cursor-failed: ${error.message}`);
}

/** CAS prevents a slower cron/immediate writer from restoring an older marker. */
export async function persistNotificationMarkers(db: SupabaseClient, markers: readonly AlertStateUpsert[], previous: readonly VersionedAlertState[]): Promise<void> {
  for (const marker of markers) {
    if (marker.incidentKey === COPY_EVENTS_MARKER_KEY) {
      await advanceCopyEventCursor(db, marker.userId, marker.deviceId, Number(marker.detail ?? 0), marker.active);
      continue;
    }
    const old = previous.find(row => row.user_id === marker.userId && row.device_id === marker.deviceId && row.incident_key === marker.incidentKey);
    const nowIso = new Date().toISOString();
    const value = {
      user_id: marker.userId, device_id: marker.deviceId, incident_key: marker.incidentKey,
      active: marker.active, detail: marker.detail, updated_at: nowIso, notification_version: randomUUID(),
      ...(marker.active ? { detected_at: nowIso, resolved_at: null } : { resolved_at: nowIso }),
      // notified_at is intentionally not written: durable enqueue is not APNs acceptance.
    };
    const result = old?.notification_version || old?.updated_at
      ? await db.from('copier_alert_state').update(value).eq('user_id', marker.userId)
        .eq('device_id', marker.deviceId).eq('incident_key', marker.incidentKey).eq(old.notification_version ? 'notification_version' : 'updated_at', old.notification_version ?? old.updated_at)
      : await db.from('copier_alert_state').upsert(value, { onConflict: 'user_id,device_id,incident_key', ignoreDuplicates: true });
    if (result.error) throw new Error(`notification-marker-failed: ${result.error.message}`);
  }
}

interface DeliveryRow {
  id: string; user_id: string; event_key: string; channel: NotificationChannel;
  subscription_id: string; payload: NotificationPayload; attempt_count: number;
}

/**
 * A lease + generation CAS allows concurrent cron/relay/image drains safely.
 * Unknown APNs acceptance after a crash is at-least-once, using a stable collapse ID;
 * APNs has no transactional exactly-once acknowledgement with our database.
 */
export async function drainNotificationDeliveries(options: {
  db: SupabaseClient; userId?: string; eventKey?: string; channel?: NotificationChannel;
  sendWebPush?: WebPushSender; limit?: number; now?: number;
}): Promise<{ sent: number; failed: number; expired: number; skipped: number }> {
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  let query = options.db.from(NOTIFICATION_DELIVERY_TABLE).select('*')
    .in('status', ['pending', 'retry', 'sending']).lte('next_attempt_at', nowIso).gt('expires_at', nowIso)
    .order('created_at', { ascending: true }).limit(options.limit ?? 100);
  if (options.userId) query = query.eq('user_id', options.userId);
  if (options.eventKey) query = query.eq('event_key', options.eventKey);
  if (options.channel) query = query.eq('channel', options.channel);
  const { data, error } = await query;
  if (error) throw new Error(`notification-drain-query-failed: ${error.message}`);
  const totals = { sent: 0, failed: 0, expired: 0, skipped: 0 };
  // Small parallel batches bound total cron time, and claims happen only when a slot runs.
  const rows = (data ?? []) as DeliveryRow[];
  for (let offset = 0; offset < rows.length; offset += 10) {
    await Promise.all(rows.slice(offset, offset + 10).map(async row => {
      if (row.channel === 'web' && !options.sendWebPush) { totals.skipped++; return; }
      const claimAt = options.now ?? Date.now();
      const leaseToken = randomUUID();
      const claim = await boundedPreparation(options.db.from(NOTIFICATION_DELIVERY_TABLE).update({
        status: 'sending', lease_token: leaseToken, attempt_count: row.attempt_count + 1,
        next_attempt_at: new Date(claimAt + LEASE_MS).toISOString(), updated_at: new Date(claimAt).toISOString(),
      }).eq('id', row.id).eq('attempt_count', row.attempt_count)
        .in('status', ['pending', 'retry', 'sending']).lte('next_attempt_at', new Date(claimAt).toISOString())
        .gt('expires_at', new Date(claimAt).toISOString()).select('id').maybeSingle());
      if (claim.error) throw new Error(`notification-claim-failed: ${claim.error.message}`);
      if (!claim.data) { totals.skipped++; return; }

      let result: ApnsResult;
      try {
        const table = row.channel === 'apns' ? 'native_push_subscriptions' : 'push_subscriptions';
        const { imageStoragePath, imageDeadlineAt, ...payload } = row.payload;
        const imageBudget = () => imageDeadlineAt == null ? Infinity : Number.isFinite(imageDeadlineAt) ? imageDeadlineAt - (options.now ?? Date.now()) : 0;
        if (row.channel === 'apns' && imageStoragePath && imageBudget() >= 100) {
          const signed = await boundedPreparation(options.db.storage.from('copier-snapshots').createSignedUrl(imageStoragePath, 3600));
          if (!signed.error && signed.data?.signedUrl) { payload.imageUrl = signed.data.signedUrl; payload.mutableContent = true; }
          // An unavailable image must never prevent the underlying text alert.
        }
        // Recheck ownership at send time: logout/reassignment must not leak queued data.
        const device = await boundedPreparation(options.db.from(table).select('*').eq('id', row.subscription_id)
          .eq('user_id', row.user_id).is('expired_at', null).maybeSingle());
        if (device.error) throw new Error(device.error.message);
        // Preparation can cross a lease deadline (or pause while another drain
        // reclaims). Only its current owner may start a provider request.
        const sendAt = options.now ?? Date.now();
        const renewed = await boundedPreparation(options.db.from(NOTIFICATION_DELIVERY_TABLE).update({
          next_attempt_at: new Date(sendAt + LEASE_MS).toISOString(), updated_at: new Date(sendAt).toISOString(),
        }).eq('id', row.id).eq('lease_token', leaseToken).eq('status', 'sending')
          .gt('next_attempt_at', new Date(sendAt).toISOString()).gt('expires_at', new Date(sendAt).toISOString())
          .select('id').maybeSingle());
        if (renewed.error) throw new Error(`notification-renew-failed: ${renewed.error.message}`);
        if (!renewed.data) { totals.skipped++; return; }
        if (!device.data) result = { status: 'expired', error: 'subscription-removed-or-reassigned' };
        else if (row.channel === 'apns') {
          // Preserve the worker's image deadline across queued retries and slow
          // signing/device reads. The same durable alert may still send as text.
          if (imageBudget() < 100) { delete payload.imageUrl; delete payload.mutableContent; }
          else if (payload.imageUrl && Number.isFinite(imageBudget())) payload.timeoutMs = Math.min(payload.timeoutMs ?? 7_000, imageBudget());
          result = await sendApnsNotification({ id: device.data.id, deviceToken: device.data.device_token,
            environment: device.data.environment, bundleId: device.data.bundle_id }, payload);
        } else result = await options.sendWebPush!({ endpoint: device.data.endpoint,
          keys: { p256dh: device.data.p256dh, auth: device.data.auth } }, row.payload.title, row.payload.body, row.payload.collapseId!);
        if (result.status === 'expired' && device.data) {
          const expired = await options.db.from(table).update({ expired_at: new Date().toISOString(), last_error: result.error ?? null })
            .eq('id', row.subscription_id).eq('user_id', row.user_id);
          if (expired.error) throw new Error(expired.error.message);
        }
      } catch (reason) { result = { status: 'failed', error: reason instanceof Error ? reason.message : String(reason) }; }
      const completedAt = options.now ?? Date.now();
      const finish = await options.db.from(NOTIFICATION_DELIVERY_TABLE).update({
        status: result.status === 'failed' ? 'retry' : result.status,
        lease_token: null, last_error: result.error?.slice(0, 500) ?? null,
        next_attempt_at: new Date(completedAt + Math.min(300_000, 15_000 * 2 ** Math.min(row.attempt_count, 4))).toISOString(),
        updated_at: new Date(completedAt).toISOString(),
        ...(result.status === 'sent' ? { sent_at: new Date(completedAt).toISOString() } : {}),
      }).eq('id', row.id).eq('lease_token', leaseToken);
      if (finish.error) throw new Error(`notification-finish-failed: ${finish.error.message}`);
      totals[result.status]++;
    }));
  }
  return totals;
}

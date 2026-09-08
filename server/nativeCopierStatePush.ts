import type { SupabaseClient } from '@supabase/supabase-js';
import { copierArmNotification, type CopierArmTransition } from './copierArmNotification.js';
import { sendApnsWidgetUpdate, type ApnsDevice } from './apns.js';
import {
  COPY_EVENTS_MARKER_KEY,
  planCopyEventNotifications,
  type CopierRuntimeRow,
} from './copierIncidentWatchdog.js';
import { copierEventDeliveryKey, drainNotificationDeliveries, enqueueNotificationDelivery, incidentDeliveryKey, persistNotificationMarkers, type VersionedAlertState } from './notificationDelivery.js';

/** Persist every target before moving discovery; cron retries independently of the runtime ring buffer. */
export async function sendImmediateCopyEventPushes(options: {
  db: SupabaseClient; userId: string; deviceId: string; status: Record<string, unknown>;
}): Promise<{ notifications: number; sent: number }> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const markerResult = await options.db.from('copier_alert_state')
    .select('device_id,user_id,incident_key,active,detail,updated_at,notification_version')
    .eq('user_id', options.userId).eq('device_id', options.deviceId).eq('incident_key', COPY_EVENTS_MARKER_KEY);
  if (markerResult.error) throw new Error(`copy-events-marker-query-failed: ${markerResult.error.message}`);
  const runtime: CopierRuntimeRow = { device_id: options.deviceId, user_id: options.userId,
    status: options.status, last_seen_at: nowIso, started_at: nowIso };
  const previous = (markerResult.data ?? []) as VersionedAlertState[];
  const evaluation = planCopyEventNotifications({ runtimes: [runtime], alertStates: previous, now, replayBoundary: true });
  if (evaluation.notifications.length > 0) {
    for (const channel of ['apns', 'web'] as const) {
      const targets = await options.db.from(channel === 'apns' ? 'native_push_subscriptions' : 'push_subscriptions')
        .select('id').eq('user_id', options.userId).is('expired_at', null);
      if (targets.error) throw new Error(`copy-events-devices-query-failed: ${targets.error.message}`);
      for (const notification of evaluation.notifications) {
        const eventKey = copierEventDeliveryKey(notification);
        for (const device of targets.data ?? []) {
          await enqueueNotificationDelivery({ db: options.db, userId: options.userId, eventKey, channel,
            subscriptionId: device.id, payload: { title: notification.title, body: notification.body,
              route: 'live', threadId: 'alphatrade-copier-trades', category: 'ALPHATRADE_TRADE',
              interruptionLevel: 'time-sensitive', collapseId: notification.collapseId }, now });
        }
      }
    }
  }
  await persistNotificationMarkers(options.db, evaluation.markers, previous);
  // Also retries previously queued events when this heartbeat contains no new ones.
  const result = await drainNotificationDeliveries({ db: options.db, userId: options.userId, channel: 'apns' });
  return { notifications: evaluation.notifications.length, sent: result.sent };
}

export {
  copierArmNotification,
  copierSnapshotArmWarning,
  type CopierArmTransition,
} from './copierArmNotification.js';

/**
 * Okamžitý APNs fan-out po autoritativním potvrzení workeru. Minutový
 * watchdog zůstává záloha pro expiraci, fail-closed a výpadek workeru.
 */
export async function sendImmediateCopierArmPush(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: string;
  transition: CopierArmTransition;
  /** `snapshotHealth` z workerova ACK statusu; chybí u starších workerů. */
  snapshotHealth?: unknown;
}): Promise<{ devices: number; sent: number }> {
  const { data, error } = await options.db.from('native_push_subscriptions')
    .select('id,device_token,environment,bundle_id')
    .eq('user_id', options.userId)
    .is('expired_at', null);
  if (error) throw new Error(`native-arm-devices-query-failed: ${error.message}`);

  const devices = (data ?? []).map(row => ({
    id: row.id,
    deviceToken: row.device_token,
    environment: row.environment,
    bundleId: row.bundle_id,
  } as ApnsDevice));
  const previousResult = await options.db.from('copier_alert_state')
    .select('device_id,user_id,incident_key,active,detail,updated_at,notification_version')
    .eq('user_id', options.userId).eq('device_id', options.deviceId).eq('incident_key', 'state:armed');
  if (previousResult.error) throw new Error(`native-arm-marker-query-failed: ${previousResult.error.message}`);
  const previous = (previousResult.data ?? []) as VersionedAlertState[];
  const old = previous[0];
  const armed = options.transition === 'arm-started';
  const eventKey = incidentDeliveryKey({ deviceId: options.deviceId, key: options.transition, kind: 'opened' }, old);
  if (!old || old.active !== armed) {
    for (const device of devices) {
      await enqueueNotificationDelivery({ db: options.db, userId: options.userId, eventKey, channel: 'apns',
        subscriptionId: device.id, payload: { ...copierArmNotification(options.transition, options.snapshotHealth), route: 'live',
          threadId: 'alphatrade-copier', category: 'ALPHATRADE_RISK', interruptionLevel: 'time-sensitive',
          badge: armed ? 1 : 0 } });
    }
    const webTargets = await options.db.from('push_subscriptions').select('id').eq('user_id', options.userId).is('expired_at', null);
    if (webTargets.error) throw new Error(`native-arm-web-devices-query-failed: ${webTargets.error.message}`);
    for (const target of webTargets.data ?? []) {
      await enqueueNotificationDelivery({ db: options.db, userId: options.userId, eventKey, channel: 'web',
        subscriptionId: target.id, payload: { ...copierArmNotification(options.transition, options.snapshotHealth), route: 'live' } });
    }
    await persistNotificationMarkers(options.db, [{ userId: options.userId, deviceId: options.deviceId,
      incidentKey: 'state:armed', active: armed, detail: null, notified: false }], previous);
  }
  const result = await drainNotificationDeliveries({ db: options.db, userId: options.userId, channel: 'apns', eventKey });
  const sent = result.sent;

  // Okamžitý nudge i pro Home/Lock Screen widgety: minutový cron znamenal
  // ~35 s starý ARM stav na ploše, zatímco notifikace chodila hned. Payload
  // je jen content-changed — widget si čerstvý snapshot stáhne sám; hash
  // dedup cronu se neposouvá, případný duplicitní reload slije collapse-id.
  try {
    const { data: widgetRows } = await options.db.from('native_widget_devices')
      .select('id,widget_push_token,widget_push_environment,widget_push_bundle_id')
      .eq('user_id', options.userId)
      .eq('widget_push_enabled', true)
      .is('expired_at', null)
      .is('widget_push_expired_at', null)
      .not('widget_push_token', 'is', null);
    await Promise.all((widgetRows ?? []).map(row => sendApnsWidgetUpdate({
      id: row.id,
      deviceToken: row.widget_push_token,
      environment: row.widget_push_environment,
      bundleId: row.widget_push_bundle_id,
    } as ApnsDevice, { urgent: true })));
  } catch (reason) {
    // Widget nudge je optimalizace — selhání kryje minutový cron.
    console.warn('[copier-arm-push] widget nudge failed', reason instanceof Error ? reason.message : String(reason));
  }
  return { devices: devices.length, sent };
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendApnsNotification, sendApnsWidgetUpdate, type ApnsDevice } from './apns.js';
import {
  COPY_EVENTS_MARKER_KEY,
  planCopyEventNotifications,
  type CopierAlertStateRow,
  type CopierRuntimeRow,
} from './copierIncidentWatchdog.js';

/**
 * Okamžitý fan-out trade eventů (obchod zadán, SL/TP, exit s P&L) hned po
 * worker heartbeatu s příznakem `copyEvents` — bez čekání na minutový cron.
 * Dedup přes stejný marker (`state:copy-events`), takže cron zůstává čistá
 * záloha: kdo doběhne první, posune hranici, druhý už nic neposílá.
 */
export async function sendImmediateCopyEventPushes(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: string;
  status: Record<string, unknown>;
}): Promise<{ notifications: number; sent: number }> {
  const nowIso = new Date().toISOString();
  const { data: markerRows, error: markerError } = await options.db.from('copier_alert_state')
    .select('device_id,user_id,incident_key,active,detail')
    .eq('user_id', options.userId)
    .eq('device_id', options.deviceId)
    .eq('incident_key', COPY_EVENTS_MARKER_KEY);
  if (markerError) throw new Error(`copy-events-marker-query-failed: ${markerError.message}`);

  const runtime: CopierRuntimeRow = {
    device_id: options.deviceId,
    user_id: options.userId,
    status: options.status,
    last_seen_at: nowIso,
    started_at: nowIso,
  };
  const evaluation = planCopyEventNotifications({
    runtimes: [runtime],
    alertStates: (markerRows ?? []) as CopierAlertStateRow[],
    now: Date.now(),
  });
  if (evaluation.notifications.length === 0 && evaluation.markers.length === 0) {
    return { notifications: 0, sent: 0 };
  }

  let sent = 0;
  if (evaluation.notifications.length > 0) {
    const { data: subs, error: subsError } = await options.db.from('native_push_subscriptions')
      .select('id,device_token,environment,bundle_id')
      .eq('user_id', options.userId)
      .is('expired_at', null);
    if (subsError) throw new Error(`copy-events-devices-query-failed: ${subsError.message}`);
    const devices = (subs ?? []).map(row => ({
      id: row.id,
      deviceToken: row.device_token,
      environment: row.environment,
      bundleId: row.bundle_id,
    } as ApnsDevice));
    for (const notification of evaluation.notifications) {
      const results = await Promise.all(devices.map(device => sendApnsNotification(device, {
        title: notification.title,
        body: notification.body,
        route: 'live',
        threadId: 'alphatrade-copier-trades',
        category: 'ALPHATRADE_TRADE',
        interruptionLevel: 'time-sensitive',
        collapseId: notification.collapseId,
      })));
      sent += results.filter(result => result.status === 'sent').length;
      for (let index = 0; index < results.length; index++) {
        if (results[index].status !== 'expired') continue;
        await options.db.from('native_push_subscriptions').update({
          expired_at: nowIso,
          last_error: results[index].error ?? null,
        }).eq('id', devices[index].id);
      }
    }
  }

  for (const marker of evaluation.markers) {
    const { error: upsertError } = await options.db.from('copier_alert_state').upsert({
      user_id: marker.userId,
      device_id: marker.deviceId,
      incident_key: marker.incidentKey,
      active: marker.active,
      detail: marker.detail,
      updated_at: nowIso,
      ...(marker.notified ? { notified_at: nowIso } : {}),
    }, { onConflict: 'user_id,device_id,incident_key' });
    if (upsertError) throw new Error(`copy-events-marker-upsert-failed: ${upsertError.message}`);
  }
  return { notifications: evaluation.notifications.length, sent };
}

export type CopierArmTransition = 'arm-started' | 'arm-ended';

export function copierArmNotification(transition: CopierArmTransition): { title: string; body: string } {
  return transition === 'arm-started'
    ? {
      title: 'Copier: ARM aktivní',
      body: 'Ostrý ARM je aktivní. Kopírování je povolené do expirace session nebo ručního DISARM.',
    }
    : {
      title: 'Copier: ARM skončil',
      body: 'Ostrý ARM už neplatí. Kopírování stojí.',
    };
}

/**
 * Okamžitý APNs fan-out po autoritativním potvrzení workeru. Minutový
 * watchdog zůstává záloha pro expiraci, fail-closed a výpadek workeru.
 */
export async function sendImmediateCopierArmPush(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: string;
  transition: CopierArmTransition;
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
  const content = copierArmNotification(options.transition);
  const results = await Promise.all(devices.map(device => sendApnsNotification(device, {
    ...content,
    route: 'live',
    threadId: 'alphatrade-copier',
    category: 'ALPHATRADE_RISK',
    interruptionLevel: 'time-sensitive',
    // Explicitní změny se nesmějí sloučit s minutovým watchdogem.
    badge: options.transition === 'arm-started' ? 1 : undefined,
  })));

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status !== 'expired') continue;
    await options.db.from('native_push_subscriptions').update({
      expired_at: new Date().toISOString(),
      last_error: result.error ?? null,
    }).eq('id', devices[index].id);
  }

  const sent = results.filter(result => result.status === 'sent').length;

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
  console.log('[copier-arm-push]', JSON.stringify({
    transition: options.transition,
    devices: devices.length,
    sent,
    results: results.map(result => ({
      status: result.status,
      statusCode: result.statusCode ?? null,
      apnsId: result.apnsId ?? null,
      error: result.error ?? null,
    })),
  }));
  // Úspěšný okamžitý push posune stejný marker jako watchdog, takže příští
  // minutový tick zprávu neduplikuje. Při APNs chybě marker neposuneme a
  // watchdog dostane šanci na retry.
  if (sent > 0 || devices.length === 0) {
    const nowIso = new Date().toISOString();
    const armed = options.transition === 'arm-started';
    const { error: markerError } = await options.db.from('copier_alert_state').upsert({
      user_id: options.userId,
      device_id: options.deviceId,
      incident_key: 'state:armed',
      active: armed,
      detail: null,
      updated_at: nowIso,
      notified_at: sent > 0 ? nowIso : null,
      ...(armed
        ? { detected_at: nowIso, resolved_at: null }
        : { resolved_at: nowIso }),
    }, { onConflict: 'user_id,device_id,incident_key' });
    if (markerError) throw new Error(`native-arm-marker-upsert-failed: ${markerError.message}`);
  }
  return { devices: devices.length, sent };
}

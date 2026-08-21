import type { SupabaseClient } from '@supabase/supabase-js';
import { sendApnsNotification, sendApnsWidgetUpdate, type ApnsDevice } from './apns.js';

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

import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendApnsNotification, type ApnsNotification, type ApnsResult } from './apns.js';
import { alertToneApnsSound } from '../lib/priceAlertTones.js';

/**
 * Doručení upozornění na cenu do iPhonu (2. 11. 2026; od 24. 11. spouští služba Rithmic). Vlastní fronta
 * `price_alert_outbox`, kterou plní `trigger_price_alert` v téže transakci jako spuštění. Doručení je „aspoň
 * jednou“ s `apns-collapse-id` podle upozornění; nic odsud nečte risk ani příkazy. Text nese jen úroveň
 * uživatele, nikdy cenu trhu (INV-UI-04). Webový push zmizel s jeho serverovou částí: takové řádky se uzavřou.
 */
export const PRICE_ALERT_OUTBOX_TABLE = 'price_alert_outbox';
const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 5;

interface OutboxRow {
  id: string;
  user_id: string;
  event_id: string;
  channel: 'apns' | 'web';
  subscription_id: string;
  attempt_count: number;
}

interface EventRow { id: string; alert_id: string; symbol: string; level: number | string; condition: string }

const levelText = (level: number) => new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(level);

/** Kategorie iOS s tlačítky Otevřít graf a Zapnout znovu (`services/nativeNotifications.ts`). */
export const PRICE_ALERT_APNS_CATEGORY = 'ALPHATRADE_PRICE_ALERT';

/** „🚨 MNQ 21 480,00“, pod tím směr a zpráva: úroveň uživatele a podmínka, žádná cena trhu. */
export function priceAlertNotificationText(input: { symbol: string; condition: string; level: number; note?: string | null }): { title: string; body: string } {
  const verb = input.condition === 'up' ? 'Nahoru přes' : input.condition === 'down' ? 'Dolů přes' : 'Překročí';
  const note = (input.note ?? '').trim().slice(0, 80);
  return { title: `🚨 ${input.symbol} ${levelText(input.level)}`, body: note ? `${verb}\n${note}` : verb };
}

/** Sbalení v iOS/prohlížeči podle upozornění (APNs collapse-id ≤ 64 B). */
export const priceAlertCollapseId = (alertId: string) => `price-alert:${createHash('sha256').update(alertId).digest('base64url').slice(0, 32)}`;

export interface PriceAlertDrainDeps {
  sendApns?: (device: Parameters<typeof sendApnsNotification>[0], notification: ApnsNotification) => Promise<ApnsResult>;
}

export async function drainPriceAlertOutbox(options: {
  db: SupabaseClient;
  eventIds?: readonly string[];
  limit?: number;
  now?: () => number;
  /** Rozpočet požadavku k providerovi (endpoint spuštění čeká jen krátce). */
  timeoutMs?: number;
} & PriceAlertDrainDeps): Promise<{ sent: number; failed: number; expired: number; skipped: number }> {
  const now = options.now ?? Date.now;
  const sendApns = options.sendApns ?? sendApnsNotification;
  const totals = { sent: 0, failed: 0, expired: 0, skipped: 0 };
  const startedIso = new Date(now()).toISOString();
  let query = options.db.from(PRICE_ALERT_OUTBOX_TABLE).select('id,user_id,event_id,channel,subscription_id,attempt_count')
    .in('status', ['pending', 'retry', 'sending']).lte('next_attempt_at', startedIso).gt('expires_at', startedIso)
    .order('created_at', { ascending: true }).limit(options.limit ?? 50);
  if (options.eventIds) {
    if (options.eventIds.length === 0) return totals;
    query = query.in('event_id', [...options.eventIds]);
  }
  const { data, error } = await query;
  if (error) throw new Error(`price-alert-outbox-query-failed: ${error.message}`);
  const rows = (data ?? []) as OutboxRow[];
  for (let offset = 0; offset < rows.length; offset += 10) {
    await Promise.all(rows.slice(offset, offset + 10).map(async row => {
      const claimAt = now();
      const leaseToken = randomUUID();
      const claim = await options.db.from(PRICE_ALERT_OUTBOX_TABLE).update({
        status: 'sending', lease_token: leaseToken, attempt_count: row.attempt_count + 1,
        next_attempt_at: new Date(claimAt + LEASE_MS).toISOString(), updated_at: new Date(claimAt).toISOString(),
      }).eq('id', row.id).eq('attempt_count', row.attempt_count).in('status', ['pending', 'retry', 'sending'])
        .lte('next_attempt_at', new Date(claimAt).toISOString()).gt('expires_at', new Date(claimAt).toISOString())
        .select('id').maybeSingle();
      if (claim.error || !claim.data) { totals.skipped++; return; }
      let result: ApnsResult;
      try {
        // Vlastnictví zařízení až v okamžiku odeslání: odhlášení nesmí poslat cizí upozornění.
        const table = row.channel === 'apns' ? 'native_push_subscriptions' : 'push_subscriptions';
        // Událost a zařízení na sobě nezávisí: čtou se souběžně (jedna cesta do databáze místo dvou).
        const [event, device] = await Promise.all([
          options.db.from('price_alert_events').select('id,alert_id,symbol,level,condition')
            .eq('id', row.event_id).eq('user_id', row.user_id).maybeSingle<EventRow>(),
          options.db.from(table).select('*').eq('id', row.subscription_id)
            .eq('user_id', row.user_id).is('expired_at', null).maybeSingle(),
        ]);
        if (event.error) throw new Error(event.error.message);
        if (!event.data) throw new Error('price-alert-event-missing');
        const alert = await options.db.from('price_alerts').select('note,channels')
          .eq('user_id', row.user_id).eq('id', event.data.alert_id).maybeSingle<{ note: string | null; channels: Record<string, unknown> | null }>();
        if (alert.error) throw new Error(alert.error.message);
        const content = priceAlertNotificationText({ symbol: event.data.symbol, condition: event.data.condition,
          level: Number(event.data.level), note: alert.data?.note });
        const collapseId = priceAlertCollapseId(event.data.alert_id);
        if (device.error) throw new Error(device.error.message);
        if (!device.data) result = { status: 'expired', error: 'subscription-removed-or-reassigned' };
        else if (row.channel === 'apns') {
          const apnsStartedAt = Date.now();
          result = await sendApns({ id: device.data.id, deviceToken: device.data.device_token,
            environment: device.data.environment, bundleId: device.data.bundle_id }, {
            ...content, route: 'live', threadId: 'alphatrade-price-alerts', interruptionLevel: 'time-sensitive',
            category: PRICE_ALERT_APNS_CATEGORY, data: { alertId: event.data.alert_id },
            sound: alertToneApnsSound(typeof alert.data?.channels?.tone === 'string' ? alert.data.channels.tone : null),
            collapseId, silent: alert.data?.channels?.sound === false, timeoutMs: options.timeoutMs ?? 7_000,
            // Neukládat u Applu: nevytlačí rizikovou notifikaci kopírky a nepřijde pozdě (INV-WATCH-01).
            expirationSeconds: 0,
            // Spojení k Applu se drží mezi upozorněními a předehřívá se už při zápisu spuštění.
            keepSession: true,
          });
          // Měření zpoždění (25. 11.): kolik z cesty do iPhonu stojí server Applu (sandbox bývá o řád pomalejší).
          console.log(`[price-alerts] apns ${device.data.environment} ${result.status} ${Date.now() - apnsStartedAt} ms (fronta ${apnsStartedAt - claimAt} ms)`);
        } else {
          // Webový push se už neposílá: řádek uzavřít, ať se neopakuje.
          result = { status: 'expired', error: 'web-push-removed' };
        }
        if (result.status === 'expired' && device.data && row.channel === 'apns') {
          await options.db.from(table).update({ expired_at: new Date(now()).toISOString(), last_error: result.error ?? null })
            .eq('id', row.subscription_id).eq('user_id', row.user_id);
        }
      } catch (reason) {
        result = { status: 'failed', error: reason instanceof Error ? reason.message : String(reason) };
      }
      const doneAt = now();
      const exhausted = result.status === 'failed' && row.attempt_count + 1 >= MAX_ATTEMPTS;
      await options.db.from(PRICE_ALERT_OUTBOX_TABLE).update({
        status: result.status === 'failed' ? (exhausted ? 'failed' : 'retry') : result.status,
        lease_token: null, last_error: result.error?.slice(0, 500) ?? null,
        next_attempt_at: new Date(doneAt + Math.min(120_000, 10_000 * 2 ** Math.min(row.attempt_count, 3))).toISOString(),
        updated_at: new Date(doneAt).toISOString(),
        ...(result.status === 'sent' ? { sent_at: new Date(doneAt).toISOString() } : {}),
      }).eq('id', row.id).eq('lease_token', leaseToken);
      totals[result.status]++;
    }));
  }
  return totals;
}

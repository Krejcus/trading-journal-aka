import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import {
  isInsideQuietHours,
  isTradecopiaNotificationEnabled,
  mergeTradecopiaNotificationPreferences,
} from '../services/tradecopiaNotificationPreferences';
import { formatTradecopiaNotification, type TradecopiaFastEvent } from '../services/tradecopiaNotificationFormatter';

const PUBLIC_VAPID_KEY = 'BCwmYrmEguddSKE2FKQX0dv1gPwEDbwmuSXhN7wiNJ8tH0Aw2wHTVHpblm8_bDMUkgVqkvPSLJ32aqY84t_tOO4';
const ALLOWED_TYPES = new Set(['order_submitted', 'trade_opened', 'trade_closed', 'copy_partial', 'order_rejected', 'connection_changed', 'position_mismatch', 'risk_alert']);
const ALLOWED_SEVERITIES = new Set(['info', 'warning', 'critical']);

const clean = (value: unknown, max = 160): string => typeof value === 'string' ? value.trim().slice(0, max) : '';
const finite = (value: unknown): number | undefined =>
  value == null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value);

export function normalizeTradecopiaFastEvent(value: unknown): TradecopiaFastEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const type = clean(row.type, 40);
  const severity = clean(row.severity, 20);
  const key = clean(row.key, 300);
  const occurredAt = clean(row.occurredAt, 80);
  if (!key || !ALLOWED_TYPES.has(type) || !ALLOWED_SEVERITIES.has(severity) || !Number.isFinite(Date.parse(occurredAt))) return null;
  const names = Array.isArray(row.accountNames) ? row.accountNames.map(name => clean(name, 80)).filter(Boolean).slice(0, 30) : undefined;
  const reasons = Array.isArray(row.reasons) ? row.reasons.map(reason => clean(reason, 120)).filter(Boolean).slice(0, 5) : undefined;
  return {
    key,
    type: type as TradecopiaFastEvent['type'],
    severity: severity as TradecopiaFastEvent['severity'],
    occurredAt,
    symbol: clean(row.symbol, 30) || undefined,
    side: clean(row.side, 20) || undefined,
    orderType: clean(row.orderType, 40) || undefined,
    firm: clean(row.firm, 80) || undefined,
    reason: clean(row.reason, 160) || undefined,
    groupName: clean(row.groupName, 80) || undefined,
    leaderName: clean(row.leaderName, 80) || undefined,
    connected: typeof row.connected === 'boolean' ? row.connected : undefined,
    quantity: finite(row.quantity), price: finite(row.price), pnl: finite(row.pnl),
    copiedAccountCount: finite(row.copiedAccountCount), expectedAccountCount: finite(row.expectedAccountCount), failedAccountCount: finite(row.failedAccountCount),
    cushion: finite(row.cushion), drawdownFloor: finite(row.drawdownFloor), balance: finite(row.balance),
    accountNames: names, reasons,
  };
}

const pragueParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
  if (!supabaseUrl || !serviceRoleKey || !privateVapidKey) return res.status(500).json({ ok: false, error: 'server-not-configured' });

  const token = req.headers['x-import-token'];
  if (typeof token !== 'string' || token.length < 32 || token.length > 500) return res.status(401).json({ ok: false, error: 'missing-token' });
  const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [];
  if (rawEvents.length === 0 || rawEvents.length > 50) return res.status(400).json({ ok: false, error: 'invalid-events' });
  const events = rawEvents.map(normalizeTradecopiaFastEvent).filter((event): event is TradecopiaFastEvent => event != null);
  if (events.length !== rawEvents.length) return res.status(400).json({ ok: false, error: 'invalid-event' });

  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const { data: tokenRow, error: tokenError } = await db.from('import_tokens').select('user_id').eq('token_hash', tokenHash).maybeSingle();
  if (tokenError || !tokenRow) return res.status(401).json({ ok: false, error: 'invalid-token' });
  const userId = String(tokenRow.user_id);

  const [{ data: profile, error: profileError }, { data: devices, error: devicesError }] = await Promise.all([
    db.from('profiles').select('preferences').eq('id', userId).single(),
    db.from('push_subscriptions').select('id,endpoint,p256dh,auth').eq('user_id', userId).is('expired_at', null),
  ]);
  if (profileError || devicesError) return res.status(500).json({ ok: false, error: 'notification-state-failed' });

  const stored = (profile?.preferences as any)?.systemSettings?.tradecopiaNotifications
    ?? (profile?.preferences as any)?.tradecopiaNotifications;
  const preferences = mergeTradecopiaNotificationPreferences(stored);
  const time = pragueParts();
  webpush.setVapidDetails('mailto:info@alphatrade.cz', PUBLIC_VAPID_KEY, privateVapidKey);

  let sent = 0;
  let deduped = 0;
  let skipped = 0;
  let transientFailures = 0;
  for (const event of events) {
    if (!isTradecopiaNotificationEnabled(preferences, event.type)) { skipped++; continue; }
    const quiet = isInsideQuietHours(preferences, time.hour, time.minute);
    if (quiet && !(event.severity === 'critical' && preferences.criticalBypassQuietHours)) { skipped++; continue; }
    const formatted = formatTradecopiaNotification(event, preferences);
    const alertType = `tradecopia-${event.type}-${createHash('sha256').update(event.key).digest('hex').slice(0, 24)}`;

    for (const device of devices || []) {
      const claim = await db.from('alert_deliveries').upsert({
        user_id: userId, alert_type: alertType, alert_date: time.date, subscription_id: device.id,
        status: 'sent', title: formatted.title, body: formatted.body,
      }, { onConflict: 'user_id,alert_type,alert_date,subscription_id', ignoreDuplicates: true }).select('id');
      if (claim.error) { transientFailures++; continue; }
      if (!claim.data?.length) { deduped++; continue; }
      const deliveryId = claim.data[0].id;
      const payload = JSON.stringify({ title: formatted.title, body: formatted.body, url: formatted.url, tag: alertType });
      try {
        await webpush.sendNotification({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, payload, {
          timeout: 5000, TTL: event.severity === 'critical' ? 3600 : 900,
          headers: { Topic: alertType.slice(0, 32), Urgency: event.severity === 'critical' ? 'high' : 'normal' },
        });
        sent++;
      } catch (error: any) {
        const statusCode = error?.statusCode || error?.status;
        const message = String(error?.body || error?.message || error).slice(0, 500);
        if (statusCode === 404 || statusCode === 410) {
          await Promise.all([
            db.from('alert_deliveries').update({ status: 'expired', status_code: statusCode, error: message }).eq('id', deliveryId),
            db.from('push_subscriptions').update({ expired_at: new Date().toISOString(), last_error: message }).eq('id', device.id),
          ]);
        } else {
          transientFailures++;
          await db.from('alert_deliveries').delete().eq('id', deliveryId);
        }
      }
    }
  }

  if (transientFailures > 0) return res.status(503).json({ ok: false, error: 'transient-push-failure', sent, deduped, skipped });
  return res.status(200).json({ ok: true, sent, deduped, skipped, events: events.length, devices: devices?.length || 0 });
}

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleNativeCors } from '../../server/nativeCors.js';
import {
  sendTvAlertTextPush,
  TvAlertRateLimiter,
  validateTradingViewAlertPayload,
} from '../../server/tvAlertNotifications.js';

/**
 * TradingView alert message template:
 * {"symbol":"{{ticker}}","price":"{{close}}","tf":"{{interval}}","name":"<název alertu>"}
 *
 * Public ingestion URL: POST /api/tradingview/alert-webhook?token=<64 hex chars>.
 * Authenticated GET/POST without `token` reads/creates the per-user secret.
 */

const localRateLimiter = new TvAlertRateLimiter();
const TOKEN = /^[0-9a-f]{64}$/;

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing-server-env-${name.toLowerCase()}`);
  return value;
};

function clients() {
  const url = requiredEnv('SUPABASE_URL');
  const anonKey = requiredEnv('SUPABASE_ANON_KEY');
  const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  return {
    url,
    anonKey,
    serviceKey,
    db: createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }),
  };
}

async function authenticatedUserId(req: VercelRequest, url: string, anonKey: string): Promise<string> {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) throw new Error('missing-auth-token');
  const auth = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) throw new Error('invalid-auth-token');
  return data.user.id;
}

const webhookUrl = (req: VercelRequest, token: string): string => {
  const configured = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const host = configured || (typeof req.headers.host === 'string' ? req.headers.host : 'alphatrade-mentor-15.vercel.app');
  const origin = host.startsWith('http') ? host : `https://${host}`;
  return `${origin}/api/tradingview/alert-webhook?token=${token}`;
};

interface WebhookConfigRow {
  token: string;
  created_at: string;
  last_alert_at: string | null;
  // Sloupce existují až po F2 settings migraci; do té doby platí default true.
  alerts_enabled?: boolean;
  images_enabled?: boolean;
}

async function webhookConfig(req: VercelRequest, res: VercelResponse, db: SupabaseClient, url: string, anonKey: string) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  const userId = await authenticatedUserId(req, url, anonKey);
  let { data, error } = await db.from('tv_alert_webhooks')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle<WebhookConfigRow>();
  if (error) throw new Error(`tv-alert-webhook-query-failed: ${error.message}`);
  if (!data && req.method === 'POST') {
    const token = randomBytes(32).toString('hex');
    const created = await db.from('tv_alert_webhooks').insert({ user_id: userId, token })
      .select('*')
      .single<WebhookConfigRow>();
    if (created.error) {
      // Concurrent ensure: the unique user_id row is authoritative.
      const existing = await db.from('tv_alert_webhooks')
        .select('*').eq('user_id', userId)
        .single<WebhookConfigRow>();
      if (existing.error) throw new Error(`tv-alert-webhook-create-failed: ${created.error.message}`);
      data = existing.data;
    } else data = created.data;
  }
  if (!data) return res.status(404).json({ error: 'tv-alert-webhook-not-found' });
  return res.status(200).json({
    token: data.token,
    webhookUrl: webhookUrl(req, data.token),
    createdAt: data.created_at,
    lastAlertAt: data.last_alert_at,
    alertsEnabled: data.alerts_enabled !== false,
    imagesEnabled: data.images_enabled !== false,
  });
}

async function broadcastSnapshotKick(options: {
  db: SupabaseClient;
  userId: string;
  supabaseUrl: string;
  serviceKey: string;
}) {
  const { data, error } = await options.db.from('tradovate_copier_devices')
    .select('id').eq('user_id', options.userId).is('revoked_at', null);
  if (error) throw new Error(`tv-alert-device-query-failed: ${error.message}`);
  await Promise.allSettled((data ?? []).map(row => fetch(`${options.supabaseUrl}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: options.serviceKey,
      Authorization: `Bearer ${options.serviceKey}`,
    },
    body: JSON.stringify({ messages: [{ topic: `copier-kick-${row.id}`, event: 'kick', payload: {} }] }),
    signal: AbortSignal.timeout(1_500),
  })));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['GET', 'POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { url, anonKey, serviceKey, db } = clients();
    const queryToken = typeof req.query.token === 'string' ? req.query.token.trim().toLowerCase() : '';
    if (!queryToken) return await webhookConfig(req, res, db, url, anonKey);
    if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
    if (!TOKEN.test(queryToken)) return res.status(401).json({ error: 'invalid-webhook-token' });

    const { data: webhook, error: webhookError } = await db.from('tv_alert_webhooks')
      .select('*').eq('token', queryToken)
      .maybeSingle<{ id: string; user_id: string; alerts_enabled?: boolean; images_enabled?: boolean }>();
    if (webhookError) throw new Error(`tv-alert-webhook-lookup-failed: ${webhookError.message}`);
    if (!webhook) return res.status(401).json({ error: 'invalid-webhook-token' });
    if (webhook.alerts_enabled === false) {
      return res.status(200).json({ accepted: false, reason: 'alerts-disabled' });
    }
    if (!localRateLimiter.consume(queryToken)) return res.status(429).json({ error: 'tv-alert-rate-limit' });
    const consumed = await db.rpc('consume_tv_alert_webhook_rate_limit', { target_webhook_id: webhook.id });
    if (consumed.error) throw new Error(`tv-alert-rate-limit-failed: ${consumed.error.message}`);
    if (consumed.data !== true) return res.status(429).json({ error: 'tv-alert-rate-limit' });

    const input = validateTradingViewAlertPayload(req.body);
    const alertId = randomUUID();
    const nowIso = new Date().toISOString();
    const imagesEnabled = webhook.images_enabled !== false;
    const { error: insertError } = await db.from('tv_alerts').insert({
      id: alertId,
      user_id: webhook.user_id,
      symbol: input.symbol,
      name: input.name,
      price: input.price,
      timeframe: input.timeframe,
      created_at: nowIso,
      // Prázdný řetězec je trvalý sentinel: alert vytvořený bez obrázků se
      // nesmí při pozdějším znovuzapnutí dostat do pending fronty.
      snapshot_path: imagesEnabled ? null : '',
    });
    if (insertError) throw new Error(`tv-alert-insert-failed: ${insertError.message}`);
    const touched = await db.from('tv_alert_webhooks').update({ last_alert_at: nowIso }).eq('id', webhook.id);
    if (touched.error) console.warn('[tv-alert] last_alert_at update failed', touched.error.message);

    // Železné pravidlo: text jde hned a nikdy nečeká na screenshot.
    try {
      await sendTvAlertTextPush({ db, userId: webhook.user_id, alertId, input });
    } catch (reason) {
      console.warn('[tv-alert] text push failed', reason instanceof Error ? reason.message : String(reason));
    }
    // Teprve po dokončení textové cesty budíme worker pro best-effort obraz.
    if (imagesEnabled) {
      try {
        await broadcastSnapshotKick({ db, userId: webhook.user_id, supabaseUrl: url, serviceKey });
      } catch (reason) {
        console.warn('[tv-alert] snapshot kick failed', reason instanceof Error ? reason.message : String(reason));
      }
    }
    return res.status(202).json({ accepted: true, id: alertId, snapshotPending: imagesEnabled });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') return res.status(401).json({ error: message });
    if (message === 'invalid-tv-alert-payload') return res.status(400).json({ error: message });
    console.error('[tv-alert-webhook]', message);
    return res.status(500).json({ error: 'tv-alert-webhook-failed' });
  }
}

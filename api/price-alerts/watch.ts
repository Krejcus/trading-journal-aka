import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PRICE_ALERT_WATCH_HEADER, verifyPriceAlertWatchRequest, type PriceAlertWatchAction } from '../../server/priceAlertWatchKey.js';
import { drainPriceAlertOutbox } from '../../server/priceAlertOutbox.js';

/**
 * Hlídač upozornění na cenu v Mac workeru (2. 11. 2026, docs/reviews/price-alerts-contract-20261102.md).
 * Autentizace podpisem klíčem odvozeným ze zařízení (ne tokenem zařízení — ten autorizuje
 * příkazy). `list` = aktivní upozornění uživatele, `trigger` = hlášení křížení; „jednou“
 * rozhoduje DB pod zámkem řádku. Endpoint nikdy nevrací cenu trhu a nic z něj nečte
 * kopírka (INV-WATCH-01). Chyba doručení nikdy neshodí odpověď (doručí cron).
 *
 * Tělo: `{ payload: "<JSON>" }`, podpis přes přesný řetězec `payload` (Vercel tělo parsuje sám).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALERT_ID = /^pa-[0-9a-z-]{1,61}$/;
const FRONT = /^(MNQ|NQ)[FGHJKMNQUVXZ][0-9]{1,4}$/;
const RUNTIME_MAX_AGE_MS = 30_000;
const MAX_TRIGGERS = 10;

interface WatchTrigger { alertId: string; version: number; triggerId: string; observedAt: number; front: string | null }

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing-server-env-${name.toLowerCase()}`);
  return value;
};

function parseTriggers(value: unknown): WatchTrigger[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRIGGERS) return null;
  const out: WatchTrigger[] = [];
  for (const item of value) {
    const row = item as Record<string, unknown> | null;
    if (!row || typeof row.alertId !== 'string' || !ALERT_ID.test(row.alertId)
      || !Number.isSafeInteger(row.version) || (row.version as number) < 1
      || typeof row.triggerId !== 'string' || !UUID.test(row.triggerId)
      || typeof row.observedAt !== 'number' || !Number.isFinite(row.observedAt)
      // `new Date()` s obřím číslem hodí RangeError a shodilo by celou dávku; server stejně ořízne na ±5 min.
      || Math.abs(row.observedAt - Date.now()) > 86_400_000) return null;
    out.push({ alertId: row.alertId, version: row.version as number, triggerId: row.triggerId, observedAt: row.observedAt,
      front: typeof row.front === 'string' && FRONT.test(row.front) ? row.front : null });
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  const payloadText = typeof req.body?.payload === 'string' && req.body.payload.length <= 8_192 ? req.body.payload as string : null;
  if (!payloadText) return res.status(400).json({ error: 'invalid-payload' });
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadText) as Record<string, unknown>;
  } catch {
    return res.status(400).json({ error: 'invalid-payload' });
  }
  const action = payload?.action;
  if (action !== 'list' && action !== 'trigger') return res.status(400).json({ error: 'invalid-action' });
  const now = Date.now();
  const auth = verifyPriceAlertWatchRequest(req.headers[PRICE_ALERT_WATCH_HEADER], action as PriceAlertWatchAction, payloadText, now);
  if (!auth) return res.status(401).json({ error: 'invalid-alert-auth' });
  try {
    const db = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Odvolané zařízení ani worker bez živého heartbeatu upozornění nehlídá.
    const device = await db.from('tradovate_copier_devices').select('id,user_id,revoked_at')
      .eq('id', auth.deviceId).maybeSingle<{ id: string; user_id: string; revoked_at: string | null }>();
    if (device.error) throw new Error(device.error.message);
    if (!device.data || device.data.revoked_at) return res.status(401).json({ error: 'invalid-alert-auth' });
    const userId = device.data.user_id;
    const runtime = await db.from('tradovate_copier_device_runtime').select('last_seen_at')
      .eq('device_id', auth.deviceId).order('last_seen_at', { ascending: false }).limit(1).maybeSingle<{ last_seen_at: string }>();
    if (runtime.error) throw new Error(runtime.error.message);
    const seenAt = runtime.data ? Date.parse(runtime.data.last_seen_at) : Number.NaN;
    if (!Number.isFinite(seenAt) || now - seenAt > RUNTIME_MAX_AGE_MS) return res.status(409).json({ error: 'runtime-not-live' });

    if (action === 'list') {
      await db.rpc('expire_price_alerts', { p_user: userId });
      const { data, error } = await db.from('price_alerts')
        .select('id,symbol,price,condition,condition_auto,frequency,version,expires_at')
        .eq('user_id', userId).eq('status', 'active').is('deleted_at', null).limit(50);
      if (error) throw new Error(error.message);
      const alerts = (data ?? []).filter(row => !row.expires_at || Date.parse(row.expires_at) > now).map(row => ({
        id: row.id, symbol: row.symbol, price: Number(row.price), condition: row.condition, conditionAuto: row.condition_auto === true,
        frequency: row.frequency, version: Number(row.version), expiresAt: row.expires_at ? Date.parse(row.expires_at) : null,
      }));
      return res.status(200).json({ alerts, serverNow: now });
    }

    const triggers = parseTriggers(payload.triggers);
    if (!triggers) return res.status(400).json({ error: 'invalid-triggers' });
    const results: { triggerId: string; status: string }[] = [];
    const eventIds: string[] = [];
    for (const trigger of triggers) {
      const { data, error } = await db.rpc('trigger_price_alert', {
        p_user: userId, p_alert: trigger.alertId, p_version: trigger.version, p_trigger: trigger.triggerId,
        p_observed_at: new Date(trigger.observedAt).toISOString(), p_front: trigger.front,
      });
      if (error) {
        results.push({ triggerId: trigger.triggerId, status: 'error' });
        continue;
      }
      const row = (Array.isArray(data) ? data[0] : data) as { event_id: string | null; status: string; suppressed: boolean } | null;
      results.push({ triggerId: trigger.triggerId, status: row?.status ?? 'error' });
      if (row?.event_id && (row.status === 'triggered' || row.status === 'duplicate') && !row.suppressed) eventIds.push(row.event_id);
    }
    // Doručení hned (kratší rozpočet); co nestihne, doručí cron každou minutu.
    try {
      if (eventIds.length) await drainPriceAlertOutbox({ db, eventIds, timeoutMs: 3_000 });
    } catch (error) {
      console.warn('[price-alerts] immediate delivery failed', error instanceof Error ? error.message : String(error));
    }
    return res.status(200).json({ results, serverNow: now });
  } catch (error) {
    console.error('[price-alerts] watch failed', error instanceof Error ? error.message : String(error));
    return res.status(500).json({ error: 'price-alert-watch-failed' });
  }
}

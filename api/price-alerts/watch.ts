import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PRICE_ALERT_WATCH_HEADER, priceAlertWatchGrant, verifyPriceAlertWatchRequest } from '../../server/priceAlertWatchKey.js';
import { drainPriceAlertOutbox } from '../../server/priceAlertOutbox.js';
import { prewarmApns } from '../../server/apns.js';
import { handleNativeCors } from '../../server/nativeCors.js';

/**
 * Hlídání upozornění na cenu službou Rithmic na Macu (24. 11. 2026).
 *
 *  - `grant`   přihlášená appka (Bearer) dostane klíč hlídače pro svého uživatele a předá ho službě;
 *  - `trigger` služba podpisem tím klíčem ohlásí křížení; „jednou“, odstup i strop rozhoduje databáze pod zámkem
 *              řádku (`trigger_price_alert`), událost dorazí appkám přes Realtime a do iPhonu oznámením.
 *
 * Endpoint nikdy nevrací cenu trhu ani seznam upozornění a nic z něj nesouvisí s příkazy (INV-UI-01).
 * Tělo: `{ payload: "<JSON>" }`, podpis přes přesný řetězec `payload` (Vercel tělo parsuje sám).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALERT_ID = /^pa-[0-9a-z-]{1,61}$/;
const FRONT = /^(MNQ|NQ)[FGHJKMNQUVXZ][0-9]{1,4}$/;
const MAX_TRIGGERS = 10;

interface WatchTrigger { alertId: string; version: number; triggerId: string; observedAt: number; front: string | null }

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing-server-env-${name.toLowerCase()}`);
  return value;
};

const supabaseUrl = (): string => process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim() || requiredEnv('SUPABASE_URL');

export function parsePriceAlertTriggers(value: unknown, now: number): WatchTrigger[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRIGGERS) return null;
  const out: WatchTrigger[] = [];
  for (const item of value) {
    const row = item as Record<string, unknown> | null;
    if (!row || typeof row.alertId !== 'string' || !ALERT_ID.test(row.alertId)
      || !Number.isSafeInteger(row.version) || (row.version as number) < 1
      || typeof row.triggerId !== 'string' || !UUID.test(row.triggerId)
      || typeof row.observedAt !== 'number' || !Number.isFinite(row.observedAt)
      // `new Date()` s obřím číslem hodí RangeError a shodilo by celou dávku; databáze stejně ořízne na ±5 min.
      || Math.abs(row.observedAt - now) > 86_400_000) return null;
    out.push({ alertId: row.alertId, version: row.version as number, triggerId: row.triggerId, observedAt: row.observedAt,
      front: typeof row.front === 'string' && FRONT.test(row.front) ? row.front : null });
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  const now = Date.now();
  try {
    // Klíč pro službu: jen přihlášený uživatel, jen pro sebe.
    if (req.body?.action === 'grant') {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'missing-token' });
      const authClient = createClient(supabaseUrl(), process.env.SUPABASE_ANON_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim() || requiredEnv('SUPABASE_ANON_KEY'), {
        global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await authClient.auth.getUser();
      if (error || !data.user) return res.status(401).json({ error: 'invalid-token' });
      const grant = priceAlertWatchGrant(data.user.id);
      if (!grant) return res.status(500).json({ error: 'price-alert-grant-unavailable' });
      return res.status(200).json({ userId: grant.userId, key: grant.key });
    }

    const payloadText = typeof req.body?.payload === 'string' && req.body.payload.length <= 8_192 ? req.body.payload as string : null;
    if (!payloadText) return res.status(400).json({ error: 'invalid-payload' });
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(payloadText) as Record<string, unknown>; } catch { return res.status(400).json({ error: 'invalid-payload' }); }
    if (payload?.action !== 'trigger' && payload?.action !== 'warm') return res.status(400).json({ error: 'invalid-action' });
    const auth = verifyPriceAlertWatchRequest(req.headers[PRICE_ALERT_WATCH_HEADER], payloadText, now);
    if (!auth) return res.status(401).json({ error: 'invalid-alert-auth' });
    // `warm`: služba hlásí, že cena je blízko úrovně — jen probudit funkci a udržet spojení ze služby. Nic nečte,
    // nezapisuje a k Applu se nepřipojuje.
    if (payload.action === 'warm') return res.status(200).json({ warm: true, serverNow: now });
    const triggers = parsePriceAlertTriggers(payload.triggers, now);
    if (!triggers) return res.status(400).json({ error: 'invalid-triggers' });

    // Spojení k Applu se navazuje hned (souběžně se zápisem), ať odeslání nečeká na jeho ustavení; na konci
    // požadavku se zavře — mezi požadavky se nedrží.
    const apns = prewarmApns();
    try {
    const db = createClient(supabaseUrl(), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const results: { triggerId: string; status: string }[] = [];
    const eventIds: string[] = [];
    const startedAt = Date.now();
    for (const trigger of triggers) {
      const { data, error } = await db.rpc('trigger_price_alert', {
        p_user: auth.userId, p_alert: trigger.alertId, p_version: trigger.version, p_trigger: trigger.triggerId,
        p_observed_at: new Date(trigger.observedAt).toISOString(), p_front: trigger.front,
      });
      if (error) { results.push({ triggerId: trigger.triggerId, status: 'error' }); continue; }
      const row = (Array.isArray(data) ? data[0] : data) as { event_id: string | null; status: string; suppressed: boolean } | null;
      results.push({ triggerId: trigger.triggerId, status: row?.status ?? 'error' });
      if (row?.event_id && (row.status === 'triggered' || row.status === 'duplicate') && !row.suppressed) eventIds.push(row.event_id);
    }
    const rpcDoneAt = Date.now();
    // Doručení do iPhonu hned (krátký rozpočet). Chyba doručení nikdy neshodí odpověď: událost už je zapsaná.
    try {
      // Bez výběru událostí: dožene i řádky, které se dřív nepodařilo doručit (mají vlastní vypršení).
      if (eventIds.length) await drainPriceAlertOutbox({ db, limit: 20, timeoutMs: 3_000 });
    } catch (error) {
      console.warn('[price-alerts] immediate delivery failed', error instanceof Error ? error.message : String(error));
    }
    if (eventIds.length) console.log(`[price-alerts] spuštění ${eventIds.length}: zápis ${rpcDoneAt - startedAt} ms, doručení ${Date.now() - rpcDoneAt} ms`);
    return res.status(200).json({ results, serverNow: now });
    } finally { apns.release(); }
  } catch (error) {
    console.error('[price-alerts] watch failed', error instanceof Error ? error.message : String(error));
    return res.status(500).json({ error: 'price-alert-watch-failed' });
  }
}

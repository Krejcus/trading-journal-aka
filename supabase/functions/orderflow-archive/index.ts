// Archiv order flow po obchodních dnech — nahrávání z Macu a vydání klíče vlastníkovi.
//  - `key`     (přihlášený vlastník, JWT): vrátí účelový klíč pro nahrávač na Macu;
//  - `prepare` (podpis klíčem): ověří den a vrátí podepsanou adresu pro nahrání přímo do Storage;
//  - `commit`  (podpis klíčem): stáhne nahraný soubor, ověří sha/velikost/obsah a zapíše řádek tabulky.
// Klíč neumí nic jiného než nahrát den order flow vlastníka. JEN ZOBRAZENÍ (INV-UI-04).
// Nasazení: npx supabase functions deploy orderflow-archive --no-verify-jwt (Mac nemá JWT; `key` ověřuje JWT sám).

import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  ORDERFLOW_ARCHIVE_BUCKET,
  ORDERFLOW_ARCHIVE_DAILY_QUOTA,
  ORDERFLOW_ARCHIVE_HEADER,
  ORDERFLOW_ARCHIVE_MAX_UNPACKED,
  archiveObjectPath,
  deriveArchiveKey,
  mayReplaceArchiveDay,
  sha256Hex,
  summarizeArchiveDay,
  validateArchiveRequest,
  verifyArchiveRequest,
  type OrderFlowArchiveSource,
} from './shared.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
// Jen vlastník (stejný člověk, který vlastní sklad svíček a Mac se službou).
const OWNER_ID = (Deno.env.get('ORDERFLOW_ARCHIVE_OWNER_USER_ID') || Deno.env.get('CANDLE_STORE_OWNER_USER_ID') || '').trim().toLowerCase();

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': `authorization, x-client-info, apikey, content-type, ${ORDERFLOW_ARCHIVE_HEADER}`,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
});
const admin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

/** Rozbalení po kouscích se stropem — „gzip bomba“ skončí dřív, než zaplní paměť funkce. */
async function gunzipJson(bytes: Uint8Array): Promise<unknown> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > ORDERFLOW_ARCHIVE_MAX_UNPACKED) { await reader.cancel(); throw new Error('too-large'); }
    chunks.push(value);
  }
  const all = new Uint8Array(total); let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return JSON.parse(new TextDecoder().decode(all));
}

/** Smaže v složce dne všechno kromě `keep` (nedokončená nahrání, předchozí verze). */
async function cleanDayFolder(db: ReturnType<typeof admin>, folder: string, keep: readonly string[]): Promise<void> {
  const { data } = await db.storage.from(ORDERFLOW_ARCHIVE_BUCKET).list(folder, { limit: 100 });
  const stale = (data ?? []).map((o) => `${folder}/${o.name}`).filter((p) => !keep.includes(p));
  if (stale.length) {
    const { error } = await db.storage.from(ORDERFLOW_ARCHIVE_BUCKET).remove(stale);
    if (error) console.log(`[orderflow-archive] úklid ${folder} selhal: ${error.message}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !OWNER_ID) return json({ error: 'not-configured' }, 503);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid-json' }, 400); }

  // ── Klíč pro Mac: jen přihlášený vlastník ──
  if (body.action === 'key') {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'missing-auth' }, 401);
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data, error } = await user.auth.getUser();
    if (error || !data.user) return json({ error: 'auth-failed' }, 401);
    if (data.user.id.toLowerCase() !== OWNER_ID) return json({ error: 'forbidden' }, 403);
    const key = await deriveArchiveKey(SERVICE_KEY, OWNER_ID);
    return key ? json({ key }) : json({ error: 'not-configured' }, 503);
  }

  // ── Nahrávání z Macu: podpis účelovým klíčem ──
  const now = Date.now();
  const r = validateArchiveRequest(body, now);
  if ('error' in r) return json({ error: r.error }, 400);
  if (!(await verifyArchiveRequest(req.headers.get(ORDERFLOW_ARCHIVE_HEADER), r, SERVICE_KEY, OWNER_ID, now))) return json({ error: 'bad-signature' }, 401);

  const db = admin();
  const path = archiveObjectPath(OWNER_ID, r);
  const { data: existing, error: readError } = await db.from('orderflow_archive_days')
    .select('source, sha256, object_path').eq('user_id', OWNER_ID).eq('contract', r.contract).eq('trade_date', r.tradeDate).maybeSingle();
  if (readError) return json({ error: 'db-read' }, 503);
  if (existing?.sha256 === r.sha256) return json({ ok: true, unchanged: true });
  if (!mayReplaceArchiveDay((existing?.source as OrderFlowArchiveSource | undefined) ?? null, r.source)) return json({ error: 'would-downgrade', existing: existing?.source }, 409);

  if (r.action === 'prepare') {
    const since = new Date(now - 86_400_000).toISOString();
    const { count, error: countError } = await db.from('orderflow_archive_days').select('trade_date', { count: 'exact', head: true })
      .eq('user_id', OWNER_ID).gte('uploaded_at', since);
    if (countError) return json({ error: 'db-read' }, 503);
    if ((count ?? 0) >= ORDERFLOW_ARCHIVE_DAILY_QUOTA) return json({ error: 'quota' }, 429);
    // Ve složce dne smí ležet jen platná verze a tohle nahrání — nedokončené pokusy se tu uklidí,
    // takže bucket neroste ani opakovaným prepare bez commitu (dnů a kontraktů je omezeně, viz validace).
    await cleanDayFolder(db, path.slice(0, path.lastIndexOf('/')), [path, ...(existing?.object_path ? [existing.object_path] : [])]);
    const { data, error } = await db.storage.from(ORDERFLOW_ARCHIVE_BUCKET).createSignedUploadUrl(path);
    if (error || !data) {
      // Stejný obsah už leží v bucketu (předchozí pokus spadl před commitem) — stačí commit.
      if (/exist|duplicate|already/i.test(error?.message ?? '')) return json({ ok: true, path, uploaded: true });
      return json({ error: 'storage-sign' }, 503);
    }
    return json({ ok: true, path, signedUrl: data.signedUrl, token: data.token });
  }

  // commit: ověřit, co v bucketu skutečně leží
  const { data: blob, error: downloadError } = await db.storage.from(ORDERFLOW_ARCHIVE_BUCKET).download(path);
  if (downloadError || !blob) return json({ error: 'not-uploaded' }, 409);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const reject = async (error: string) => { await db.storage.from(ORDERFLOW_ARCHIVE_BUCKET).remove([path]); return json({ error }, 422); };
  if (bytes.length !== r.bytes) return reject('size-mismatch');
  if ((await sha256Hex(bytes)) !== r.sha256) return reject('sha-mismatch');
  let summary;
  try { summary = summarizeArchiveDay(await gunzipJson(bytes), r); } catch { return reject('invalid-gzip-json'); }
  if ('error' in summary) return reject(summary.error);

  const row = {
    user_id: OWNER_ID, root: 'NQ', contract: r.contract, trade_date: r.tradeDate, source: r.source, object_path: path,
    bytes: r.bytes, sha256: r.sha256, minutes: summary.minutes, trades: summary.trades, exact_minutes: summary.exactMinutes,
    flow_volume: summary.flowVolume, candle_volume: summary.candleVolume, uploaded_at: new Date(now).toISOString(),
  };
  // Zápis jen nad tím stavem, který jsme na začátku přečetli (souběh dvou nahrání téhož dne: druhé neprojde).
  let written = false;
  if (existing) {
    const { data: updated, error } = await db.from('orderflow_archive_days').update(row)
      .eq('user_id', OWNER_ID).eq('contract', r.contract).eq('trade_date', r.tradeDate).eq('sha256', existing.sha256).select('sha256');
    if (error) return json({ error: 'db-write' }, 503);
    written = (updated ?? []).length === 1;
  } else {
    const { error } = await db.from('orderflow_archive_days').insert(row);
    if (error && error.code !== '23505') return json({ error: 'db-write' }, 503);
    written = !error;
  }
  if (!written) { await db.storage.from(ORDERFLOW_ARCHIVE_BUCKET).remove([path]); return json({ error: 'conflict' }, 409); }
  // Předchozí verze dne už nikdo nečte.
  if (existing?.object_path && existing.object_path !== path) {
    const { error } = await db.storage.from(ORDERFLOW_ARCHIVE_BUCKET).remove([existing.object_path]);
    if (error) console.log(`[orderflow-archive] starou verzi ${existing.object_path} nejde smazat: ${error.message}`);
  }
  return json({ ok: true, path, ...summary });
});

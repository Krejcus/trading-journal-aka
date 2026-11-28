/**
 * Nahrání archivu order flow z Macu do Supabase (Edge Function `orderflow-archive`, účelový klíč).
 * Nepřipojuje se k Rithmicu a nic nemění na obchodní službě.
 *
 *   1× na začátku: v appce Nastavení indikátoru Volume profil → „Zkopírovat klíč pro Mac“, pak
 *      npx tsx scripts/rithmic/orderFlowArchiveUpload.ts --set-key        (vezme klíč ze schránky do Klíčenky)
 *   nahrání:
 *      npx tsx scripts/rithmic/orderFlowArchiveUpload.ts [--contract NQZ6] [--from 2026-09-08] [--to 2026-11-27]
 *
 * Nahrává soubory z ~/Library/Application Support/AlphaTrade/rithmic/orderflow-archive/<kontrakt>/<den>.json.gz
 * (sestavuje je orderFlowArchiveBuild.ts). Co už nahrané je (stejný sha), přeskočí.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ORDERFLOW_ARCHIVE_HEADER, signArchiveRequest, type OrderFlowArchiveRequest, type OrderFlowArchiveSource } from '../../supabase/functions/orderflow-archive/shared';

const KEYCHAIN = 'alphatrade-orderflow-archive';
const arg = (name: string, fallback?: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };

if (process.argv.includes('--set-key')) {
  const key = execFileSync('pbpaste', { encoding: 'utf8' }).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) { console.error('Ve schránce není klíč archivu (zkopíruj ho v appce: nastavení Volume profilu).'); process.exit(2); }
  execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN, '-a', 'orderflow', '-w', key], { stdio: 'ignore' });
  execFileSync('pbcopy', { input: '' }); // klíč ve schránce nenechávat
  console.log('Klíč uložen do Klíčenky (služba „alphatrade-orderflow-archive“), schránka vyčištěna.');
  process.exit(0);
}

const BASE = join(homedir(), 'Library', 'Application Support', 'AlphaTrade', 'rithmic', 'orderflow-archive');
const STATE = join(BASE, 'uploaded.json');
const CONTRACT = arg('contract');
const FROM = arg('from', '0000-00-00')!; const TO = arg('to', '9999-99-99')!;

let key: string;
try { key = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
catch { console.error('V Klíčence není klíč archivu — nejdřív --set-key.'); process.exit(2); }

const env = (() => {
  // Vedle skriptu (Documents), jinak hlavní checkout (worktree .env.local mít nemusí).
  if (process.env.ORDERFLOW_SUPABASE_URL) return {} as Record<string, string>;
  const file = [join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.local'), join(homedir(), 'Documents', 'trading-journal-aka', '.env.local')].find((f) => existsSync(f));
  const out: Record<string, string> = {};
  if (file) for (const line of readFileSync(file, 'utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(line.trim()); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  return out;
})();
// Automatická synchronizace (launchd) nesmí číst ~/Documents — adresu dostane v proměnných prostředí.
const SUPABASE_URL = process.env.ORDERFLOW_SUPABASE_URL || env.VITE_SUPABASE_URL; const ANON = process.env.ORDERFLOW_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !ANON) { console.error('Chybí VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY v .env.local.'); process.exit(2); }
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/orderflow-archive`;

const state: Record<string, string> = (() => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } })();
const saveState = () => { writeFileSync(`${STATE}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${STATE}.tmp`, STATE); };

async function call(r: OrderFlowArchiveRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  const ts = Date.now();
  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}`, [ORDERFLOW_ARCHIVE_HEADER]: await signArchiveRequest(key, ts, r) },
    body: JSON.stringify(r),
  });
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { /* prázdná odpověď */ }
  return { status: response.status, body };
}

(async () => {
  const contracts = existsSync(BASE) ? readdirSync(BASE).filter((n) => /^NQ[HMUZ]\d$/.test(n) && (!CONTRACT || n === CONTRACT)) : [];
  let uploaded = 0; let skipped = 0; let failed = 0;
  for (const contract of contracts) {
    const dates = readdirSync(join(BASE, contract)).map((n) => /^(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(n)?.[1]).filter((d): d is string => !!d && d >= FROM && d <= TO).sort();
    for (const tradeDate of dates) {
      const id = `${contract}/${tradeDate}`;
      const bytes = readFileSync(join(BASE, contract, `${tradeDate}.json.gz`));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (state[id] === sha256) { skipped += 1; continue; }
      const source = (JSON.parse(gunzipSync(bytes).toString('utf8')) as { source: OrderFlowArchiveSource }).source;
      const base = { contract, tradeDate, sha256, bytes: bytes.length, source };
      const prepared = await call({ action: 'prepare', ...base });
      if (prepared.status === 200 && prepared.body.unchanged) { state[id] = sha256; saveState(); skipped += 1; continue; }
      // Lepší verze dne už v archivu je (např. se živými bublinami) — tenhle soubor nikdy neprojde, nezkoušet znovu.
      if (prepared.status === 409 && prepared.body.error === 'would-downgrade') { state[id] = sha256; saveState(); skipped += 1; console.log(`${id}: v archivu je lepší verze (${String(prepared.body.existing)}), přeskočeno`); continue; }
      if (prepared.status !== 200) { failed += 1; console.log(`${id}: příprava odmítnuta ${prepared.status} ${String(prepared.body.error ?? '')}${prepared.body.existing ? ` (uloženo: ${String(prepared.body.existing)})` : ''}`); if (prepared.status === 401 || prepared.status === 429 || prepared.status === 503) break; continue; }
      if (typeof prepared.body.signedUrl === 'string') {
        const put = await fetch(prepared.body.signedUrl, { method: 'PUT', headers: { 'Content-Type': 'application/gzip', 'x-upsert': 'false' }, body: bytes });
        if (!put.ok) { failed += 1; console.log(`${id}: nahrání selhalo ${put.status} ${(await put.text()).slice(0, 120)}`); continue; }
      }
      const committed = await call({ action: 'commit', ...base });
      if (committed.status !== 200) { failed += 1; console.log(`${id}: potvrzení odmítnuto ${committed.status} ${String(committed.body.error ?? '')}`); continue; }
      state[id] = sha256; saveState(); uploaded += 1;
      console.log(`${id}: nahráno ${(bytes.length / 1e6).toFixed(2)} MB · ${source} · minut ${String(committed.body.minutes)} · bublin ${String(committed.body.trades)} · přesných minut ${String(committed.body.exactMinutes)}`);
    }
  }
  console.log(`\nnahráno ${uploaded} · beze změny ${skipped} · chyb ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => { console.error('SELHALO', error instanceof Error ? error.message : error); process.exit(1); });

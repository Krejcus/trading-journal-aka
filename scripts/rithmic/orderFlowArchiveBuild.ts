/**
 * Sestavení archivu order flow po obchodních dnech ze syrové historie (orderFlowBackfill.ts) a souborů živé
 * služby. Jen čte a zapisuje soubory na Macu; k Rithmicu ani do Supabase se nepřipojuje.
 *
 *   npx tsx scripts/rithmic/orderFlowArchiveBuild.ts --contract NQZ6 [--from 2026-09-08] [--to 2026-11-27]
 *     [--live-dir ~/alphatrade-worktrees/rithmic/scripts/rithmic/results] [--verify]
 *
 * Dny: všechny se staženou historií + dny, které zná jen služba (bubliny přesné, objem jen kde běžela).
 * Rozpracovaný den (méně než 10 min po konci seance) se nesestavuje.
 * Výstup: ~/Library/Application Support/AlphaTrade/rithmic/orderflow-archive/<kontrakt>/<den>.json.gz
 * `--verify` porovná u dnů, kdy běžela služba, objem v jejích pokrytých minutách se syrovou historií.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildOrderFlowDay, decodeOrderFlowRaw, orderFlowFromRaw, parseServiceOrderFlow, tradingSession, type OrderFlowRaw } from '../../services/orderFlowArchive';

const arg = (name: string, fallback?: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const CONTRACT = arg('contract')!;
if (!CONTRACT || !/^NQ[HMUZ]\d$/.test(CONTRACT)) { console.error('--contract NQ kontrakt, např. NQZ6'); process.exit(2); }
const BASE = join(homedir(), 'Library', 'Application Support', 'AlphaTrade', 'rithmic');
const RAW_DIR = join(BASE, 'orderflow-raw', CONTRACT);
const OUT_DIR = join(BASE, 'orderflow-archive', CONTRACT);
const LIVE_DIR = arg('live-dir', join(homedir(), 'alphatrade-worktrees', 'rithmic', 'scripts', 'rithmic', 'results'))!;
const FROM = arg('from', '0000-00-00')!; const TO = arg('to', '9999-99-99')!;
const VERIFY = process.argv.includes('--verify');
const SETTLE_MS = 10 * 60_000;
mkdirSync(OUT_DIR, { recursive: true });

const rawDates = existsSync(RAW_DIR) ? readdirSync(RAW_DIR).map((n) => /^(\d{4}-\d{2}-\d{2})\.ofr\.gz$/.exec(n)?.[1]).filter((d): d is string => !!d) : [];
const liveFiles = existsSync(LIVE_DIR) ? readdirSync(LIVE_DIR).filter((n) => n.startsWith('orderflow-') && n.endsWith(`-${CONTRACT}-${n.slice(-16, -6)}.jsonl`)) : [];
/** Soubory služby pro kontrakt a UTC den (služba ukládá po UTC dnech, obchodní den zasahuje do dvou). */
const liveFor = (utcDate: string): string[] => liveFiles.filter((n) => n.endsWith(`-${CONTRACT}-${utcDate}.jsonl`)).map((n) => join(LIVE_DIR, n));
const utcDay = (sec: number) => new Date(sec * 1_000).toISOString().slice(0, 10);
/** Obchodní dny, do kterých může UTC den souboru služby zasahovat (ten den a následující pracovní). */
const liveTradeDates = new Set<string>();
for (const name of liveFiles) {
  const u = name.slice(-16, -6);
  for (let k = 0; k <= 3; k += 1) {
    const d = new Date(Date.parse(`${u}T12:00:00Z`) + k * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    liveTradeDates.add(d.toISOString().slice(0, 10));
    if (k >= 1) break;
  }
}
const now = Date.now();
const dates = [...new Set([...rawDates, ...liveTradeDates])]
  .filter((d) => d >= FROM && d <= TO && tradingSession(d)[1] * 1_000 + SETTLE_MS < now)
  .sort();

let totalBytes = 0; let built = 0;
for (const date of dates) {
  const raw: OrderFlowRaw | null = rawDates.includes(date) ? decodeOrderFlowRaw(gunzipSync(readFileSync(join(RAW_DIR, `${date}.ofr.gz`)))) : null;
  const session: [number, number] = raw ? [raw.header.session.start, raw.header.session.end] : tradingSession(date);
  const paths = [...new Set([...liveFor(utcDay(session[0])), ...liveFor(utcDay(session[1] - 1))])];
  const service = paths.length ? parseServiceOrderFlow(paths.map((p) => readFileSync(p, 'utf8'))) : null;
  // Den bez historie a bez jediné minuty služby v seanci: nic k archivaci.
  if (!raw && (!service || ![...service.minutes.keys()].some((m) => m >= session[0] && m < session[1]))) continue;
  const day = buildOrderFlowDay({ contract: CONTRACT, tradeDate: date, tickSize: raw?.header.tickSize ?? 0.25, session, raw, service });
  if (day.minutes.length === 0) continue;
  const gz = gzipSync(Buffer.from(JSON.stringify(day)), { level: 9 });
  const file = join(OUT_DIR, `${date}.json.gz`);
  // Beze změny obsahu se soubor nepřepisuje (nahrávač by ho jinak bral jako nový).
  const previous = existsSync(file) ? (() => { try { return gunzipSync(readFileSync(file)).toString('utf8'); } catch { return null; } })() : null;
  if (previous === JSON.stringify(day)) continue;
  writeFileSync(`${file}.tmp`, gz, { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  totalBytes += gz.length; built += 1;
  const exactMin = day.exactBubbles.reduce((s, [a, b]) => s + (b - a) / 60_000, 0);
  console.log(`${date}: ${day.source} · minut ${day.minutes.length} · bublin ≥5: ${day.trades.length} (přesně ${exactMin} min) · objem ${day.check.flowVolume}/${day.check.candleVolume ?? '—'} = ${day.check.ratio ?? '—'} % · ${(gz.length / 1e6).toFixed(2)} MB`);

  if (VERIFY && service && raw) {
    // Objem v minutách, které služba pokryla celé, musí sedět se syrovou historií (stejný zdroj, jiná cesta).
    const fromRaw = orderFlowFromRaw(raw);
    let same = 0; let differ = 0; const examples: string[] = [];
    for (const m of service.covered) {
      if (m < session[0] || m >= session[1]) continue;
      const a = JSON.stringify(service.minutes.get(m)); const b = JSON.stringify(fromRaw.minutes.get(m));
      if (a === b) same += 1; else { differ += 1; if (examples.length < 3) examples.push(`${new Date(m * 1000).toISOString().slice(11, 16)}`); }
    }
    console.log(`   ověření: pokrytých minut služby ${same + differ}, buňky shodné ${same}, rozdílné ${differ}${examples.length ? ` (např. ${examples.join(', ')} UTC)` : ''}`);
  }
}
console.log(`sestaveno ${built} z ${dates.length} dní · ${(totalBytes / 1e6).toFixed(1)} MB · ${OUT_DIR}`);

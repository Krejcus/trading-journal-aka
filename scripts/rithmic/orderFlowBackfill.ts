/**
 * Stažení syrových obchodů NQ z historie Rithmicu na disk Macu (jen čtení, jen history plant).
 * Návrh: docs/reviews/orderflow-history-archive-design-20261127.md, část A. Data běžícího kontraktu po jeho
 * expiraci zmizí (sonda 27. 11.), proto se ukládají syrová: ze syrových jde order flow kdykoli přepočítat.
 *
 * JEN PŘI VYPNUTÉ SLUŽBĚ: bere si zámek služby (stejný soubor, `wx`), takže služba se během stahování nespustí
 * a stahování se nespustí vedle služby. Druhé přihlášení stejným uživatelem by službu odhlásilo a ta se
 * po vynuceném odhlášení sama nepřipojí (devTradeServer.ts).
 *
 *   npx tsx scripts/rithmic/orderFlowBackfill.ts --system LucidTrading --user "<jméno>" --contract NQZ6 \
 *     --from 2026-11-25 --to 2026-11-27 [--max-requests 300] [--force]
 *
 * Obchodní den = `tradingDayKey` appky: od 18:00 New York předchozího dne do 17:00 New York.
 * Stahuje se po hodinách (paměť), každý den se kontroluje minutu po minutě proti minutovým svíčkám Rithmicu.
 * Výstup: ~/Library/Application Support/AlphaTrade/rithmic/orderflow-raw/<kontrakt>/<den>.ofr.gz + manifest.json
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { RithmicClient } from '../../services/rithmic/rithmicClient';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';
import { readOnlyViolation } from '../../services/rithmic/readOnlyGuard';

const arg = (name: string, fallback?: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const SYSTEM = arg('system')!;
const USER = arg('user') ?? process.env.RITHMIC_USER;
const CONTRACT = arg('contract')!;
const FROM = arg('from')!; const TO = arg('to', FROM)!;
const TEST = SYSTEM === 'Rithmic Test';
const GATEWAY = arg('gateway', 'rprotocol-de.rithmic.com')!;
const KEYCHAIN = arg('keychain', TEST ? 'alphatrade-rithmic-test' : 'alphatrade-rithmic-prop')!;
const MAX_REQUESTS = Math.min(2_000, Math.max(5, Number(arg('max-requests', '300')) || 300));
const FORCE = process.argv.includes('--force');
const TICK = 0.25;
if (!SYSTEM || !USER || !CONTRACT || !FROM) { console.error('Chybí --system, --user, --contract nebo --from.'); process.exit(2); }
if (!/^NQ[HMUZ]\d$/.test(CONTRACT)) { console.error('--contract musí být NQ kontrakt, např. NQZ6.'); process.exit(2); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO) || TO < FROM) { console.error('--from/--to ve tvaru RRRR-MM-DD.'); process.exit(2); }
if (!TEST && !/^rprotocol(-[a-z0-9]+)?\.rithmic\.com$/.test(GATEWAY)) { console.error('Neznámá brána.'); process.exit(2); }

// ── Zámek služby (stejný soubor jako devTradeServer.ts) ──
const STATE_DIR = join(homedir(), 'Library', 'Application Support', 'AlphaTrade', 'rithmic');
mkdirSync(STATE_DIR, { recursive: true });
const lockFile = join(STATE_DIR, `service-${Buffer.from(JSON.stringify([SYSTEM, USER])).toString('base64url')}.lock`);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
{
  let heldBy: number | null = null;
  try { const pid = Number(readFileSync(lockFile, 'utf8').trim()); heldBy = Number.isInteger(pid) && pid > 0 ? pid : null; } catch { heldBy = null; }
  if (heldBy !== null && alive(heldBy)) { console.error(`Služba (nebo jiné stahování) pro ${SYSTEM} běží (proces ${heldBy}) — nestahuji. Nejdřív ji zastav.`); process.exit(2); }
  if (heldBy !== null) rmSync(lockFile, { force: true });
  try { writeFileSync(lockFile, String(process.pid), { mode: 0o600, flag: 'wx' }); }
  catch { console.error('Zámek služby právě bere jiný proces — nestahuji.'); process.exit(2); }
  process.on('exit', () => { try { if (readFileSync(lockFile, 'utf8').trim() === String(process.pid)) rmSync(lockFile, { force: true }); } catch { /* zámek už není */ } });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { console.log(`\nPřerušeno (${signal}) — hotové dny zůstávají, příště se pokračuje.`); process.exit(130); });
}

// ── Disk ──
const OUT_DIR = join(STATE_DIR, 'orderflow-raw', CONTRACT);
mkdirSync(OUT_DIR, { recursive: true });
const freeGb = (): number => { const s = statfsSync(OUT_DIR); return (s.bavail * s.bsize) / 1e9; };
if (freeGb() < 10) { console.error(`Na disku je jen ${freeGb().toFixed(1)} GB volna (< 10 GB) — nestahuji.`); process.exit(2); }
const MANIFEST = join(STATE_DIR, 'orderflow-raw', 'manifest.json');
type DayReport = Record<string, unknown> & { complete: boolean };
const manifest: Record<string, DayReport> = (() => { try { return JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch { return {}; } })();
const saveManifest = () => { const tmp = `${MANIFEST}.tmp`; writeFileSync(tmp, JSON.stringify(manifest, null, 2)); renameSync(tmp, MANIFEST); };

// ── Čas New York ──
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const nyOffsetMin = (ms: number): number => {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60_000) * 60_000) / 60_000;
};
/** UTC sekundy pro místní čas New York. */
const nyToSec = (y: number, m: number, d: number, h: number): number => {
  const guess = Date.UTC(y, m - 1, d, h);
  let ms = guess - nyOffsetMin(guess) * 60_000;
  ms = guess - nyOffsetMin(ms) * 60_000;
  return Math.floor(ms / 1000);
};
/** Obchodní den D: 18:00 NY dne D−1 → 17:00 NY dne D (jako tradingDayKey v services/liquidityLevels.ts). */
const sessionOf = (date: string): { start: number; end: number } => {
  const [y, m, d] = date.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return { start: nyToSec(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 18), end: nyToSec(y, m, d, 17) };
};
const tradeDates = (): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${FROM}T12:00:00Z`); t <= Date.parse(`${TO}T12:00:00Z`); t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};
const hhmm = (sec: number) => new Date(sec * 1000).toISOString().slice(11, 16);

// ── Rithmic ──
const password = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
const client = new RithmicClient({
  url: TEST ? 'wss://rituz00100.rithmic.com:443' : `wss://${GATEWAY}:443`,
  credentials: { user: USER, password, systemName: SYSTEM, appName: 'fikr:AlphaTrade', appVersion: '0.1.0' },
  requestTimeoutMs: 120_000,
  socketFactory: (url) => {
    const socket = new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike;
    const raw = socket.send.bind(socket);
    socket.send = (data: Uint8Array) => { const bad = readOnlyViolation(data); if (bad !== null) throw new Error(`jen čtení: šablona ${bad}`); raw(data); };
    return socket;
  },
});
let requests = 0;
let stopped: string | null = null;
const fatal = (message: string) => /permission|limit|denied|exceed|too many|forced/i.test(message);
const spend = (): boolean => {
  if (stopped) return false;
  if (requests >= MAX_REQUESTS) { stopped = `vyčerpán rozpočet ${MAX_REQUESTS} žádostí`; return false; }
  requests += 1; return true;
};

type Row = { sec: number; usecs: number; seq: number | null; price: number; volume: number; bidVolume: number; askVolume: number };

/** Jedna hodina obchodů; při stropu 10 000 bez navázání stránkuje novými žádostmi od posledního času. */
async function hour(from: number, to: number): Promise<{ rows: Row[]; requests: number; ms: number; paged: boolean } | null> {
  const t0 = Date.now(); let used = 0;
  if (!spend()) return null;
  used += 1;
  let result;
  try { result = await client.tickBarReplay({ symbol: CONTRACT, exchange: 'CME', fromSec: from, toSec: to, resume: true, timeoutMs: 120_000 }); }
  catch (error) { const message = (error as Error).message; if (fatal(message)) stopped = `Rithmic: ${message}`; throw error; }
  let rows: Row[] = result.rows.filter((r) => r.sec >= from && r.sec < to);
  let paged = false;
  // Pojistka: kdyby navázání nevrátilo celé okno, dostránkovat po 10 000.
  while (!stopped && result.rows.length >= 10_000 && rows.length > 0 && rows[rows.length - 1].sec < to - 1) {
    paged = true;
    if (!spend()) return null;
    used += 1;
    const last = rows[rows.length - 1].sec;
    const seen = new Set(rows.filter((r) => r.sec === last).map((r) => `${r.usecs}.${r.seq}.${r.price}.${r.volume}`));
    try { result = await client.tickBarReplay({ symbol: CONTRACT, exchange: 'CME', fromSec: last, toSec: to, timeoutMs: 120_000 }); }
    catch (error) { const message = (error as Error).message; if (fatal(message)) stopped = `Rithmic: ${message}`; throw error; }
    const next = result.rows.filter((r) => r.sec >= last && r.sec < to && !(r.sec === last && seen.has(`${r.usecs}.${r.seq}.${r.price}.${r.volume}`)));
    if (next.length === 0) break;
    rows = rows.concat(next);
  }
  return { rows, requests: used, ms: Date.now() - t0, paged };
}

/** Syrový soubor: „OFR1“, délka hlavičky, hlavička JSON, sloupce Int32 (Δsec, µs, cena v ticích, velikost, strana). */
function encode(header: Record<string, unknown>, rows: Row[], startSec: number): Buffer {
  const n = rows.length;
  const cols = [new Int32Array(n), new Int32Array(n), new Int32Array(n), new Int32Array(n), new Int32Array(n)];
  for (let i = 0; i < n; i += 1) {
    const r = rows[i];
    cols[0][i] = r.sec - startSec; cols[1][i] = r.usecs; cols[2][i] = Math.round(r.price / TICK); cols[3][i] = r.volume;
    // Ověřeno 28. 11. proti živým bublinám: u Rithmicu `bid_volume` = agresivní KUPUJÍCÍ (průjezd cenami nahoru).
    cols[4][i] = r.bidVolume > 0 && r.askVolume === 0 ? 1 : r.askVolume > 0 && r.bidVolume === 0 ? -1 : 0;
  }
  const head = Buffer.from(JSON.stringify({ ...header, count: n, startSec, columns: ['dsec', 'usecs', 'priceTicks', 'size', 'side'] }));
  const len = Buffer.alloc(4); len.writeUInt32LE(head.length);
  return gzipSync(Buffer.concat([Buffer.from('OFR1'), len, head, ...cols.map((c) => Buffer.from(c.buffer))]), { level: 6 });
}

(async () => {
  await client.connect(['history']);
  const dates = tradeDates();
  console.log(`Stahování ${CONTRACT} · ${dates.length} obchodních dní ${FROM} … ${TO} · rozpočet ${MAX_REQUESTS} žádostí · ${freeGb().toFixed(1)} GB volna\n`);
  for (const date of dates) {
    if (stopped) break;
    const key = `${CONTRACT}/${date}`;
    if (!FORCE && manifest[key]?.complete) { console.log(`${date}: už staženo (${manifest[key].rows} obchodů), přeskakuji`); continue; }
    if (freeGb() < 10) { stopped = 'méně než 10 GB volna'; break; }
    const { start, end } = sessionOf(date);
    const dayStarted = Date.now();
    const all: Row[] = []; const hours: unknown[] = []; let failed: string | null = null; let maxRss = 0; let used = 0;
    for (let from = start; from < end && !stopped; from += 3_600) {
      const to = Math.min(end, from + 3_600);
      try {
        const res = await hour(from, to);
        if (!res) break;
        used += res.requests;
        for (const r of res.rows) all.push(r);
        const rss = process.memoryUsage().rss / 1e6; if (rss > maxRss) maxRss = rss;
        hours.push({ from: hhmm(from), rows: res.rows.length, ms: res.ms, requests: res.requests, paged: res.paged, rssMb: Math.round(rss) });
        process.stdout.write(`\r${date} ${hhmm(from)} UTC: ${res.rows.length} obchodů za ${res.ms} ms${res.paged ? ' (stránkováno)' : ''} · celkem ${all.length} · RSS ${Math.round(rss)} MB      `);
      } catch (error) { failed = `${hhmm(from)}: ${(error as Error).message}`; break; }
    }
    process.stdout.write('\n');
    if (stopped && !failed && all.length === 0) break;
    // Kontrola minutu po minutě proti svíčkám (jedna žádost na den).
    let check: Record<string, unknown> = { skipped: true };
    if (!failed && spend()) {
      used += 1;
      try {
        const bars = await client.timeBarReplay({ symbol: CONTRACT, exchange: 'CME', barType: 'MINUTE_BAR', period: 1, fromSec: start, toSec: end, timeoutMs: 60_000 });
        const flow = new Map<number, number>();
        for (const r of all) { const m = Math.floor(r.sec / 60) * 60; flow.set(m, (flow.get(m) ?? 0) + r.volume); }
        let candleVolume = 0; let flowVolume = 0; let exact = 0; const off: Array<[string, number, number]> = [];
        const minutes = new Set<number>([...flow.keys(), ...bars.filter((b) => b.time >= start && b.time < end).map((b) => b.time)]);
        const barVol = new Map(bars.map((b) => [b.time, b.volume]));
        for (const m of [...minutes].sort((a, b) => a - b)) {
          const c = barVol.get(m) ?? 0; const f = flow.get(m) ?? 0;
          candleVolume += c; flowVolume += f;
          if (c === f) exact += 1; else if (off.length < 30) off.push([hhmm(m), f, c]);
        }
        check = { candleVolume, flowVolume, ratio: candleVolume ? Math.round((flowVolume / candleVolume) * 10_000) / 100 : null, minutes: minutes.size, exactMinutes: exact, off };
      } catch (error) { check = { error: (error as Error).message }; if (fatal((error as Error).message)) stopped = `Rithmic: ${(error as Error).message}`; }
    }
    const ratio = typeof check.ratio === 'number' ? check.ratio : null;
    const complete = !failed && !stopped && ratio !== null && ratio >= 99.5;
    const sides = { buy: 0, sell: 0, none: 0 };
    for (const r of all) { if (r.bidVolume > 0 && r.askVolume === 0) sides.buy += 1; else if (r.askVolume > 0 && r.bidVolume === 0) sides.sell += 1; else sides.none += 1; }
    let bytes = 0;
    if (all.length > 0) {
      const gz = encode({ v: 2, contract: CONTRACT, tradeDate: date, tickSize: TICK, session: { start, end }, check, complete }, all, start);
      const file = join(OUT_DIR, `${date}.ofr.gz`);
      writeFileSync(`${file}.tmp`, gz, { mode: 0o600 }); renameSync(`${file}.tmp`, file);
      bytes = gz.length;
    }
    manifest[key] = { complete, rows: all.length, bytes, sides, check, failed, requests: used, ms: Date.now() - dayStarted, maxRssMb: Math.round(maxRss), hours, at: new Date().toISOString() };
    saveManifest();
    const c = check as { ratio?: number; exactMinutes?: number; minutes?: number; flowVolume?: number; candleVolume?: number; error?: string };
    console.log(`${date}: ${complete ? 'OK' : 'NEÚPLNÉ'} · ${all.length} obchodů · ${(bytes / 1e6).toFixed(1)} MB · ${Math.round((Date.now() - dayStarted) / 1000)} s · ${used} žádostí · objem ${c.flowVolume ?? '—'}/${c.candleVolume ?? '—'} = ${c.ratio ?? '—'} % · minut přesně ${c.exactMinutes ?? '—'}/${c.minutes ?? '—'} · strana bez určení ${sides.none}${failed ? ` · CHYBA ${failed}` : ''}${c.error ? ` · svíčky: ${c.error}` : ''}`);
  }
  console.log(`\nžádostí: ${requests}${stopped ? ` · zastaveno: ${stopped}` : ''} · manifest: ${MANIFEST}`);
  client.close();
  setTimeout(() => process.exit(stopped && stopped.startsWith('Rithmic') ? 1 : 0), 300);
})().catch((error) => { console.error('\nSELHALO', error instanceof Error ? error.message : error); client.close(); setTimeout(() => process.exit(1), 300); });

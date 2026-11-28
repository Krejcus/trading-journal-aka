/**
 * Sonda historie jednotlivých obchodů u Rithmicu (jen čtení, jen history plant — nepřihlašuje se
 * k příkazům ani k cenám). Zjišťuje, jestli jde order flow (bubliny, profil, delta) dopočítat zpětně:
 *   1. jak daleko zpět Rithmic obchody po jednom vrátí (pětiminutová okna před 2 dny … rokem),
 *   2. jestli sedí s minutovými svíčkami (objem a počet obchodů) a jestli jde poznat stranu agresora,
 *   3. kolik obchodů vrátí na jednu žádost, jestli funguje navázání a kolik žádostí by stál celý den.
 *
 * Spouští Filip při VYPNUTÉ službě (stejné přihlášení jako služba):
 *   npx tsx scripts/rithmic/measureTickHistory.ts --system "LucidTrading" --user "<jméno>"
 * Volby: --gateway rprotocol-de.rithmic.com · --symbol NQZ6 (jinak se kontrakt volí podle data) · --max-requests 30
 * Výsledek: výpis + scripts/rithmic/results/tick-history-probe-<čas>.json (jen souhrny, bez surových dat).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { RithmicClient } from '../../services/rithmic/rithmicClient';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';
import { readOnlyViolation } from '../../services/rithmic/readOnlyGuard';

const arg = (name: string, fallback?: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const SYSTEM = arg('system')!;
const USER = arg('user') ?? process.env.RITHMIC_USER;
const SYMBOL_OVERRIDE = arg('symbol');
const TEST = SYSTEM === 'Rithmic Test';
const GATEWAY = arg('gateway', 'rprotocol-de.rithmic.com')!;
const KEYCHAIN = arg('keychain', TEST ? 'alphatrade-rithmic-test' : 'alphatrade-rithmic-prop')!;
const MAX_REQUESTS = Math.min(40, Math.max(5, Number(arg('max-requests', '30')) || 30));
if (!SYSTEM || !USER) { console.error('Chybí --system nebo --user.'); process.exit(2); }
if (!TEST && !/^rprotocol(-[a-z0-9]+)?\.rithmic\.com$/.test(GATEWAY)) { console.error('Neznámá brána.'); process.exit(2); }
// Pojistka: stejné přihlášení jako služba — když pro stejný systém běží, sonda se vůbec nepřipojí.
try {
  const running = execFileSync('pgrep', ['-fl', 'devTradeServer'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (running.split('\n').some((line) => line.includes(`--system ${SYSTEM}`))) {
    console.error(`Pro systém "${SYSTEM}" běží služba — sonda se nepřipojí. Nejdřív službu zastav.`);
    process.exit(2);
  }
} catch { /* pgrep nic nenašel */ }

// ── Kontrakt NQ podle data (čtvrtletní H/M/U/Z, přechod 8 dní před expirací = 3. pátek) ──
const MONTH_CODES: Record<number, string> = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' };
const thirdFriday = (year: number, month: number): Date => {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (5 - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + offset + 14));
};
const frontNq = (date: Date): string => {
  for (let k = 0; k < 8; k += 1) {
    const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + k; // měsíce od roku 0, 0 = leden
    const year = Math.floor(total / 12); const month = (total % 12) + 1;
    if (!MONTH_CODES[month]) continue;
    const roll = thirdFriday(year, month).getTime() - 8 * 86_400_000;
    if (date.getTime() < roll) return `NQ${MONTH_CODES[month]}${year % 10}`;
  }
  throw new Error('kontrakt nenalezen');
};

/** Den o `days` zpět; sobota a neděle se posunou na pátek. */
const tradingDayBack = (now: Date, days: number): Date => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
};
const at = (day: Date, hh: number, mm: number): number => Math.floor(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm) / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');

type TickRow = Awaited<ReturnType<RithmicClient['tickBarReplay']>>['rows'][number];
const BUCKETS = [1, 2, 5, 10, 20, 50, 100];
const bucketOf = (size: number) => { let b = 0; for (let i = 0; i < BUCKETS.length; i += 1) if (size >= BUCKETS[i]) b = i; return b; };

/** Strana agresora: u Rithmicu `bid_volume` = agresivní kupující (ověřeno 28. 11. proti živým bublinám). */
const sideOf = (row: TickRow): 'buy' | 'sell' | 'both' | 'none' =>
  row.bidVolume > 0 && row.askVolume === 0 ? 'buy' : row.askVolume > 0 && row.bidVolume === 0 ? 'sell' : row.askVolume > 0 && row.bidVolume > 0 ? 'both' : 'none';

function analyse(rows: TickRow[]) {
  const sides = { buy: 0, sell: 0, both: 0, none: 0 };
  let volume = 0; let buyVol = 0; let sellVol = 0; let volumeMismatch = 0;
  // Přibližné bubliny: po sobě jdoucí obchody se stejným časem (na µs) a stranou = jeden agresivní příkaz.
  const groups: number[] = [];
  let key = ''; let size = 0;
  for (const row of rows) {
    const side = sideOf(row);
    sides[side] += 1; volume += row.volume;
    if (side === 'buy') buyVol += row.volume; else if (side === 'sell') sellVol += row.volume;
    if (row.bidVolume + row.askVolume !== row.volume) volumeMismatch += 1;
    const k = `${row.sec}.${row.usecs}.${side}`;
    if (k === key) size += row.volume; else { if (size > 0) groups.push(size); key = k; size = row.volume; }
  }
  if (size > 0) groups.push(size);
  const histogram = BUCKETS.map(() => 0);
  for (const g of groups) histogram[bucketOf(g)] += 1;
  const distinctUsecs = new Set(rows.map((r) => `${r.sec}.${r.usecs}`)).size;
  const usecsZero = rows.filter((r) => r.usecs === 0).length;
  const multiStamp = rows.filter((r) => r.stamps > 1).length;
  return { multiStamp, rows: rows.length, volume, buyVol, sellVol, delta: buyVol - sellVol, sides, volumeMismatch, groups: groups.length, maxGroup: Math.max(0, ...groups), histogram, distinctUsecs, usecsZero };
}

const password = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
const client = new RithmicClient({
  url: TEST ? 'wss://rituz00100.rithmic.com:443' : `wss://${GATEWAY}:443`,
  credentials: { user: USER, password, systemName: SYSTEM, appName: 'fikr:AlphaTrade', appVersion: '0.1.0' },
  requestTimeoutMs: 60_000,
  socketFactory: (url) => {
    const socket = new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike;
    const raw = socket.send.bind(socket);
    socket.send = (data: Uint8Array) => { const bad = readOnlyViolation(data); if (bad !== null) throw new Error(`jen čtení: šablona ${bad}`); raw(data); };
    return socket;
  },
});

let requests = 0;
let stopped: string | null = null;
const budget = (): boolean => {
  if (stopped) return false;
  if (requests >= MAX_REQUESTS) { stopped = `vyčerpán rozpočet ${MAX_REQUESTS} žádostí`; console.log(`STOP: ${stopped}`); return false; }
  requests += 1;
  return true;
};
const fatal = (message: string) => /permission|limit|denied|exceed|too many/i.test(message);

async function ticks(symbol: string, fromSec: number, toSec: number, resume = false) {
  if (!budget()) return null;
  const t0 = Date.now();
  try {
    const result = await client.tickBarReplay({ symbol, exchange: 'CME', fromSec, toSec, resume });
    return { ...result, ms: Date.now() - t0, error: null as string | null };
  } catch (error) {
    const message = (error as Error).message;
    if (fatal(message)) { stopped = `Rithmic: ${message}`; console.log(`STOP: ${stopped}`); }
    return { rows: [] as TickRow[], terminal: null, sentAt: t0, completedAt: Date.now(), ms: Date.now() - t0, error: message };
  }
}
async function minutes(symbol: string, fromSec: number, toSec: number) {
  if (!budget()) return null;
  try { return await client.timeBarReplay({ symbol, exchange: 'CME', barType: 'MINUTE_BAR', period: 1, fromSec, toSec, timeoutMs: 30_000 }); }
  catch (error) { const message = (error as Error).message; if (fatal(message)) stopped = `Rithmic: ${message}`; return null; }
}

(async () => {
  const report: Record<string, unknown> = { at: new Date().toISOString(), system: SYSTEM };
  await client.connect(['history']);
  const now = new Date();
  console.log(`Sonda historie obchodů · ${SYSTEM} · ${iso(Math.floor(now.getTime() / 1000))} UTC · rozpočet ${MAX_REQUESTS} žádostí\n`);

  // ── 1+2. Hloubka a úplnost: 5 minut v obchodní seanci (15:30–15:35 UTC) ──
  const depth: unknown[] = [];
  let printedRaw = false;
  for (const days of [2, 7, 30, 60, 120, 180, 365]) {
    if (stopped) break;
    const day = tradingDayBack(now, days);
    const symbol = SYMBOL_OVERRIDE ?? frontNq(day);
    const from = at(day, 15, 30); const to = at(day, 15, 35);
    const tick = await ticks(symbol, from, to);
    if (!tick) break;
    const bars = (await minutes(symbol, from, to)) ?? [];
    const a = analyse(tick.rows);
    const barVolume = bars.reduce((s, b) => s + b.volume, 0);
    const barTrades = bars.reduce((s, b) => s + b.trades, 0);
    const line = {
      days, date: day.toISOString().slice(0, 10), symbol, ms: tick.ms, error: tick.error,
      terminal: tick.terminal ? { rp: tick.terminal.rpCode, requestKey: tick.terminal.requestKey || null } : null,
      first: tick.rows[0] ? iso(tick.rows[0].sec) : null, last: tick.rows.at(-1) ? iso(tick.rows.at(-1)!.sec) : null,
      ...a, barVolume, barTrades,
    };
    depth.push(line);
    console.log(`před ${String(days).padStart(3)} dny ${line.date} ${symbol}: ${tick.error ? `CHYBA ${tick.error}` : `${a.rows} obchodů za ${tick.ms} ms`}`);
    if (!tick.error && a.rows > 0) {
      const cover = barVolume > 0 ? Math.round((a.volume / barVolume) * 1000) / 10 : null;
      console.log(`   objem ${a.volume} vs svíčky ${barVolume} (${cover ?? '—'} %) · obchodů ${a.rows} vs svíčky ${barTrades} · strana: nákup ${a.sides.buy}, prodej ${a.sides.sell}, obě ${a.sides.both}, žádná ${a.sides.none} · delta ${a.delta >= 0 ? '+' : ''}${a.delta}`);
      console.log(`   čas na µs: ${a.distinctUsecs} různých, ${a.usecsZero} s nulou, ${a.multiStamp} řádků s více časy · přibližné bubliny ${a.groups} (max ${a.maxGroup}) · rozdělení [1 2–4 5–9 10–19 20–49 50–99 100+] = [${a.histogram.join(' ')}]`);
      console.log(`   konečná odpověď: ${line.terminal ? `rp ${line.terminal.rp.join(',')}${line.terminal.requestKey ? ` · request_key ${line.terminal.requestKey}` : ''}` : 'žádná (ukončeno tichem)'}`);
      if (!printedRaw) {
        printedRaw = true;
        console.log(`   první 3 řádky: ${JSON.stringify(tick.rows.slice(0, 3))}`);
      }
    }
  }
  report.depth = depth;

  // ── 3. Strop na žádost, navázání a cena celého dne ──
  if (!stopped) {
    const day = tradingDayBack(now, 2);
    const symbol = SYMBOL_OVERRIDE ?? frontNq(day);
    const from = at(day, 14, 30); const to = at(day, 16, 30); // 2 h kolem otevření RTH
    console.log(`\nPropustnost: ${symbol} ${iso(from)} – ${iso(to)} UTC`);
    const first = await ticks(symbol, from, to);
    const chunks: Array<{ how: string; rows: number; ms: number; first: string | null; last: string | null; rp: string[] | null; error: string | null }> = [];
    const all: TickRow[] = [];
    const seen = new Set<string>();
    const add = (rows: TickRow[]) => { let added = 0; for (const r of rows) { const k = `${r.sec}.${r.usecs}.${r.seq}.${r.price}.${r.volume}.${r.bidVolume}`; if (!seen.has(k)) { seen.add(k); all.push(r); added += 1; } } return added; };
    const note = (how: string, res: NonNullable<Awaited<ReturnType<typeof ticks>>>) => {
      chunks.push({ how, rows: res.rows.length, ms: res.ms, first: res.rows[0] ? iso(res.rows[0].sec) : null, last: res.rows.at(-1) ? iso(res.rows.at(-1)!.sec) : null, rp: res.terminal?.rpCode ?? null, error: res.error });
      console.log(`   ${how}: ${res.error ? `CHYBA ${res.error}` : `${res.rows.length} řádků za ${res.ms} ms, ${chunks.at(-1)!.first ?? '—'} → ${chunks.at(-1)!.last ?? '—'}`}`);
    };
    if (first) {
      note('žádost 1', first);
      add(first.rows);
      const lastSec = () => all.at(-1)?.sec ?? from;
      const capped = (res: { rows: TickRow[] }) => res.rows.length > 0 && res.rows.at(-1)!.sec < to - 30;
      if (capped(first)) {
        // a) navázání podle protokolu (resume_bars)
        const resumed = await ticks(symbol, from, to, true);
        if (resumed) {
          note('navázání resume_bars', resumed);
          const overlaps = resumed.rows.length > 0 && resumed.rows[0].sec <= first.rows[0].sec;
          console.log(`   → resume ${resumed.error ? 'odmítnuto' : overlaps ? 'začíná znovu od začátku (nenavazuje)' : `navazuje (+${add(resumed.rows)} nových)`}`);
        }
        // b) navázání novou žádostí od posledního času, dokud nepokryje okno
        let previous = first;
        while (!stopped && capped(previous) && lastSec() < to - 30) {
          const next = await ticks(symbol, lastSec(), to);
          if (!next) break;
          note(`od ${iso(lastSec())}`, next);
          const added = add(next.rows);
          if (next.error || added === 0) { console.log('   → bez nových řádků, konec'); break; }
          previous = next;
        }
      }
      const totalMs = chunks.reduce((s, c) => s + c.ms, 0);
      const perRequest = Math.max(...chunks.map((c) => c.rows));
      const coveredTo = all.at(-1)?.sec ?? from;
      console.log(`   celkem ${all.length} obchodů za ${totalMs} ms (${Math.round(all.length / Math.max(0.001, totalMs / 1000))} /s) · pokryto do ${iso(coveredTo)} · nejvíc na žádost ${perRequest}`);
      // Kolik obchodů má celý den: ze svíček (počet obchodů v minutě) — jedna levná žádost.
      const dayBars = await minutes(symbol, at(day, 0, 0) - 7 * 3600, at(day, 0, 0) + 17 * 3600);
      const dayTrades = dayBars?.reduce((s, b) => s + b.trades, 0) ?? null;
      const dayVolume = dayBars?.reduce((s, b) => s + b.volume, 0) ?? null;
      const perDay = dayTrades && perRequest > 0 ? Math.ceil(dayTrades / perRequest) : null;
      const secondsPerDay = dayTrades && all.length > 0 ? Math.round((dayTrades / all.length) * (totalMs / 1000)) : null;
      console.log(`   celý den ${day.toISOString().slice(0, 10)}: ${dayTrades ?? '—'} obchodů, objem ${dayVolume ?? '—'} → ≈ ${perDay ?? '—'} žádostí a ≈ ${secondsPerDay ?? '—'} s stahování`);
      report.throughput = { symbol, from: iso(from), to: iso(to), chunks, total: all.length, totalMs, perRequest, coveredTo: iso(coveredTo), dayTrades, dayVolume, requestsPerDay: perDay, secondsPerDay, analysis: analyse(all) };
    }
  }

  report.requests = requests;
  report.stopped = stopped;
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `tick-history-probe-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nžádostí: ${requests}${stopped ? ` · zastaveno: ${stopped}` : ''}\nuloženo: ${file}`);
  client.close();
  setTimeout(() => process.exit(0), 300);
})().catch((error) => { console.error('SELHALO', error instanceof Error ? error.message : error); client.close(); setTimeout(() => process.exit(1), 300); });

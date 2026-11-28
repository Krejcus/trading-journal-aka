/**
 * Porovnání přibližných bublin ze syrové historie (seskupení podle času µs a strany) s přesnými bublinami
 * ze živé služby (seskupení podle čísla příkazu agresora) za úsek, kdy služba běžela. Jen čte soubory.
 *   npx tsx scripts/rithmic/compareBubbles.ts --raw <den>.ofr.gz --live <orderflow-…-NQZ6-den.jsonl> [--min 15]
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeOrderFlowRaw } from '../../services/orderFlowArchive';

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const MIN = Number(arg('min', '15'));
/** Obrátit stranu ze souboru (ověření konvence bid/ask objemu). */
const FLIP = process.argv.includes('--flip') ? -1 : 1;
/** Nejvyšší mezera mezi dílčími obchody jednoho příkazu (µs); 0 = jen stejný čas. */
const GAP_US = Number(arg('gap-us', '10'));
/** Průjezd: navázat i po delší mezeře (do SWEEP_US), když cena pokračuje směrem příkazu. */
const SWEEP_US = Number(arg('sweep-us', '100'));

const decoded = decodeOrderFlowRaw(gunzipSync(readFileSync(arg('raw')!)));
const r = { header: decoded.header, dsec: decoded.dsec, usecs: decoded.usecs, price: decoded.priceTicks, size: decoded.size, side: decoded.side };
// Přibližné bubliny: po sobě jdoucí obchody se stejným časem (µs) a stranou.
type Bubble = { ms: number; side: number; size: number; lo: number; hi: number };
const approx: Bubble[] = [];
let cur: Bubble | null = null; let lastUs = -Infinity;
for (let i = 0; i < r.header.count; i += 1) {
  const sec = r.header.startSec + r.dsec[i];
  const us = sec * 1_000_000 + r.usecs[i];
  const side = r.side[i] * FLIP;
  const continues = cur !== null && side === cur.side && (us - lastUs <= GAP_US || (us - lastUs <= SWEEP_US && (side > 0 ? r.price[i] > cur.hi : r.price[i] < cur.lo)));
  if (cur && continues) { cur.size += r.size[i]; cur.lo = Math.min(cur.lo, r.price[i]); cur.hi = Math.max(cur.hi, r.price[i]); lastUs = us; continue; }
  if (cur) approx.push(cur);
  lastUs = us; cur = { ms: us / 1000, side, size: r.size[i], lo: r.price[i], hi: r.price[i] };
}
if (cur) approx.push(cur);

const live: Bubble[] = readFileSync(arg('live')!, 'utf8').split('\n').filter((l) => l.startsWith('{"t"')).map((l) => {
  const t = (JSON.parse(l) as { t: [string, number, number, number, number, number, number, number] }).t;
  return { ms: t[1], side: t[2], size: t[3], lo: t[5], hi: t[6] };
});
const from = Math.min(...live.map((b) => b.ms)); const to = Math.max(...live.map((b) => b.ms));
// Úseky, kdy služba neběžela (mezera mezi živými obchody > 2 min), se nepočítají.
const liveTimes = live.map((b) => b.ms).sort((a, b) => a - b);
const holes: Array<[number, number]> = [];
for (let i = 1; i < liveTimes.length; i += 1) if (liveTimes[i] - liveTimes[i - 1] > 120_000) holes.push([liveTimes[i - 1], liveTimes[i]]);
const inWindow = (b: Bubble) => b.ms >= from && b.ms <= to && !holes.some(([a, z]) => b.ms > a + 1_000 && b.ms < z - 1_000);
const liveBig = live.filter((b) => b.size >= MIN);
const approxBig = approx.filter((b) => b.size >= MIN && inWindow(b));

const used = new Set<number>();
let exact = 0; let close = 0; let missed = 0; const lags: number[] = []; const examples: string[] = [];
for (const b of liveBig) {
  let best = -1; let bestScore = Infinity;
  for (let i = 0; i < approx.length; i += 1) {
    const a = approx[i];
    if (a.side !== b.side || Math.abs(a.ms - b.ms) > 1_000 || used.has(i)) continue;
    const score = Math.abs(a.size - b.size) * 10 + Math.abs(a.ms - b.ms) / 100;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  if (best < 0 || approx[best].size < MIN * 0.5) { missed += 1; if (examples.length < 8) examples.push(`chybí: ${new Date(b.ms).toISOString().slice(11, 23)} ${b.side > 0 ? 'nákup' : 'prodej'} ${b.size}`); continue; }
  used.add(best); lags.push(approx[best].ms - b.ms);
  if (approx[best].size === b.size) exact += 1;
  else { close += 1; if (examples.length < 8) examples.push(`jiná velikost: ${new Date(b.ms).toISOString().slice(11, 23)} živě ${b.size}, z historie ${approx[best].size}`); }
}
const extraList = approxBig.filter((a) => !used.has(approx.indexOf(a)));
const extra = extraList.length;
if (process.argv.includes('--show-extra')) {
  for (const a of extraList.slice(0, 12)) {
    const near = live.filter((b) => Math.abs(b.ms - a.ms) <= 5).map((b) => `${b.side > 0 ? 'B' : 'S'}${b.size}@${(b.ms - a.ms).toFixed(1)}ms`).join(' ');
    console.log(`  navíc: ${new Date(a.ms).toISOString().slice(11, 23)} ${a.side > 0 ? 'nákup' : 'prodej'} ${a.size} (${a.lo / 4}–${a.hi / 4}) · živě poblíž: ${near || 'nic'}`);
  }
}
lags.sort((a, b) => a - b);
console.log(`Úsek ${new Date(from).toISOString().slice(11, 19)}–${new Date(to).toISOString().slice(11, 19)} UTC, bubliny ≥ ${MIN}:`);
console.log(`  živě ${liveBig.length} · z historie ${approxBig.length}`);
console.log(`  stejná velikost ${exact} · jiná velikost ${close} · chybí v historii ${missed} · navíc v historii ${extra}`);
if (lags.length) console.log(`  posun času (historie − živě): medián ${lags[Math.floor(lags.length / 2)]} ms, rozsah ${lags[0]} … ${lags[lags.length - 1]} ms`);
for (const e of examples) console.log(`  ${e}`);

/**
 * Měření „SL a potom TP k otevřené pozici" na Rithmic Test (simulované peníze) přes běžící místní službu.
 * Market bez ochrany → + SL → + TP (služba zruší SL a zadá svázaný pár) → posun TP → zrušení jedné nohy (má být odmítnuto) → zavření.
 *   RITHMIC_USER=… npx tsx scripts/rithmic/devTradeServer.ts --contract MNQZ6 --port 3312
 *   npx tsx scripts/rithmic/measureProtectPair.ts [--port 3312]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const i = process.argv.indexOf('--port');
const PORT = i >= 0 ? process.argv[i + 1] : '3312';
const token = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'results', 'dev-token'), 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}`, { origin: 'http://localhost:3000' });
const t0 = Date.now();
const log = (text: string) => console.log(`${String(Date.now() - t0).padStart(6)} ms  ${text}`);
type Order = { orderId: string; role: string; status: string; price?: number; tag?: string };
type State = { positions: Array<{ symbol: string; netQuantity: number; averagePrice?: number }>; orders: Order[]; blocked: string | null; incidents: Array<{ kind: string; message: string }>; closes?: unknown[] };
let hello: { system: string; symbol: string; tickSize: number; readOnly?: boolean; live?: boolean } | null = null;
let state: State | null = null;
let price: number | null = null;
let last = '';
const waiters: Array<{ test: (s: State) => boolean; resolve: (ok: boolean) => void }> = [];
const replies = new Map<string, (reply: Record<string, unknown>) => void>();
const brief = (s: State) => `pozice ${s.positions.map((p) => `${p.netQuantity}@${p.averagePrice ?? '?'}`).join(',') || '0'} | ${s.orders.map((o) => `${o.role}:${o.price ?? '-'}:${o.status}`).join(' ') || 'bez příkazů'}${s.blocked ? ` | BLOK ${s.blocked}` : ''}`;
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw)) as Record<string, unknown>;
  if (m.type === 'hello') { hello = m as never; if (typeof m.price === 'number') price = m.price; }
  else if (m.type === 'tick' && typeof m.price === 'number') price = m.price;
  else if (m.type === 'state') {
    state = m.state as State;
    const text = brief(state);
    if (text !== last) { last = text; log(`stav: ${text}`); }
    for (const w of [...waiters]) if (w.test(state)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(true); }
  } else if (m.type === 'reply') replies.get(String(m.id))?.(m);
});
const until = (test: (s: State) => boolean, ms: number) => new Promise<boolean>((resolve) => {
  if (state && test(state)) { resolve(true); return; }
  const w = { test, resolve };
  waiters.push(w);
  setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); resolve(false); } }, ms);
});
let n = 0;
const send = (command: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
  const id = `m${(n += 1)}`;
  const at = Date.now();
  replies.set(id, (reply) => { log(`odpověď ${String(command.op)}${command.kind ? ` ${String(command.kind)}` : ''} za ${Date.now() - at} ms: ${JSON.stringify(reply).slice(0, 240)}`); resolve(reply); });
  ws.send(JSON.stringify({ id, command }));
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const done = (code: number) => { ws.close(); setTimeout(() => process.exit(code), 200); };
const cur = () => state as unknown as State;

(async () => {
  await new Promise((resolve) => ws.on('open', resolve));
  if (!(await until(() => hello !== null, 8_000)) || !hello) { log('služba se neohlásila'); return done(1); }
  const h = hello as NonNullable<typeof hello>;
  if (h.system !== 'Rithmic Test' || h.readOnly || h.live) { log(`ODMÍTÁM: služba běží na "${h.system}" — měření je jen pro Rithmic Test`); return done(2); }
  const sym = h.symbol;
  const flat = (s: State) => !s.positions.some((p) => p.symbol === sym) && s.orders.length === 0;
  if (!state || !flat(state) || price === null) { log('účet není prázdný nebo chybí cena — neměřím'); return done(2); }
  const grid = (value: number) => Math.round(value / h.tickSize) * h.tickSize;
  const cid = () => `pp${Date.now().toString(36)}${n}`;
  const working = (s: State, role: string) => s.orders.filter((o) => o.role === role && o.status === 'working');
  try {
    const first = await send({ op: 'entry', clientId: cid(), symbol: sym, side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: price });
    if (!first.ok || !(await until((s) => s.positions.some((p) => p.netQuantity === 1) && s.orders.length === 0, 10_000))) throw new Error('vstup bez ochrany se nevyplnil');
    await wait(1_500);
    const px = price as number;
    log(`--- + SL ${grid(px - 40)} ---`);
    await send({ op: 'protect', clientId: cid(), symbol: sym, kind: 'stop', price: grid(px - 40) });
    if (!(await until((s) => working(s, 'stop').length === 1, 5_000))) throw new Error('SL nevznikl');
    await wait(1_500);
    log(`--- + TP ${grid(px + 40)} (svázaný pár) ---`);
    const at = Date.now();
    const pair = send({ op: 'protect', clientId: cid(), symbol: sym, kind: 'target', price: grid(px + 40) });
    const paired = await until((s) => working(s, 'stop').length === 1 && working(s, 'target').length === 1, 8_000);
    log(paired ? `SL i TP pracují za ${Date.now() - at} ms od odeslání` : 'pár se do 8 s neobjevil');
    await pair;
    await wait(1_000);
    const target = working(cur(), 'target')[0];
    const stop = working(cur(), 'stop')[0];
    log(`značky: SL ${stop?.tag} · TP ${target?.tag}`);
    log('--- posun TP o 2 b ---');
    await send({ op: 'move', orderId: target.orderId, price: grid(px + 42) });
    await wait(1_000);
    log('--- zrušení jen SL (má být odmítnuto) ---');
    await send({ op: 'cancel', orderId: stop.orderId });
    await wait(500);
    log(`před zavřením: ${brief(cur())}`);
  } catch (error) {
    log(`SELHALO: ${error instanceof Error ? error.message : String(error)}`);
  }
  log('--- zavření ---');
  await send({ op: 'ack' });
  await send({ op: 'flatten', clientId: cid(), symbol: sym });
  await until(flat, 10_000);
  await wait(1_500);
  log(`konec: ${brief(cur())} | incidenty: ${JSON.stringify(cur().incidents.slice(-3)).slice(0, 300)} | zavření: ${JSON.stringify((cur().closes ?? []).slice(-1)).slice(0, 220)}`);
  done(0);
})().catch((error) => { console.error('SELHALO', error); done(1); });

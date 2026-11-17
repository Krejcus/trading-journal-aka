/**
 * Měření částečného zavření na Rithmic Test (simulované peníze) přes běžící místní službu.
 * Postup: Market 1 se SL/TP → přikoupení Market 1 se stejnými SL/TP → `reduce` → co udělá burza → zavření zbytku.
 * Služba musí běžet na Rithmic Test:  RITHMIC_USER=… npx tsx scripts/rithmic/devTradeServer.ts --contract MNQZ6 --port 3312
 *   npx tsx scripts/rithmic/measureReduce.ts [--port 3312]
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
type Order = { orderId: string; role: string; status: string; price?: number; quantity: number; side: string };
type State = { positions: Array<{ symbol: string; netQuantity: number; averagePrice?: number }>; orders: Order[]; blocked: string | null; incidents: Array<{ kind: string; message: string }>; closes?: unknown[] };
let hello: { system: string; symbol: string; price: number | null; tickSize: number; readOnly?: boolean; live?: boolean } | null = null;
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
  replies.set(id, (reply) => { log(`odpověď ${String(command.op)} za ${Date.now() - at} ms: ${JSON.stringify(reply).slice(0, 260)}`); resolve(reply); });
  ws.send(JSON.stringify({ id, command }));
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const done = (code: number) => { ws.close(); setTimeout(() => process.exit(code), 200); };

(async () => {
  await new Promise((resolve) => ws.on('open', resolve));
  if (!(await until(() => hello !== null, 8_000)) || !hello) { log('služba se neohlásila'); return done(1); }
  const h = hello as NonNullable<typeof hello>;
  if (h.system !== 'Rithmic Test' || h.readOnly || h.live) { log(`ODMÍTÁM: služba běží na "${h.system}" — měření je jen pro Rithmic Test`); return done(2); }
  const sym = h.symbol;
  const flat = (s: State) => !s.positions.some((p) => p.symbol === sym) && !s.orders.some((o) => o.status === 'working');
  if (!state || !flat(state)) { log('účet není prázdný — neměřím'); return done(2); }
  if (price === null) { log('služba nemá cenu — trh stojí?'); return done(2); }
  const grid = (value: number) => Math.round(value / h.tickSize) * h.tickSize;
  const stopPrice = grid(price - 40);
  const targetPrice = grid(price + 40);
  const cid = () => `mr${Date.now().toString(36)}${n}`;
  log(`cena ${price}, SL ${stopPrice}, TP ${targetPrice}`);
  const first = await send({ op: 'entry', clientId: cid(), symbol: sym, side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: price, stopPrice, targetPrice });
  if (!first.ok) return done(1);
  const legsOf = (s: State, role: string) => s.orders.filter((o) => o.role === role && o.status === 'working');
  if (!(await until((s) => s.positions.some((p) => p.netQuantity === 1) && legsOf(s, 'stop').length === 1 && legsOf(s, 'target').length === 1, 10_000))) { log('první vstup se nevyplnil / nemá nohy'); await send({ op: 'flatten', clientId: cid(), symbol: sym }); return done(1); }
  await wait(1_500);
  const s1 = state as unknown as State;
  const sl = legsOf(s1, 'stop')[0].price!;
  const tp = legsOf(s1, 'target')[0].price!;
  const second = await send({ op: 'entry', clientId: cid(), symbol: sym, side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: price, stopPrice: sl, targetPrice: tp });
  if (!second.ok || !(await until((s) => s.positions.some((p) => p.netQuantity === 2) && legsOf(s, 'stop').length === 2 && legsOf(s, 'target').length === 2, 10_000))) {
    log('přikoupení neprošlo'); await send({ op: 'flatten', clientId: cid(), symbol: sym }); return done(1);
  }
  await wait(1_500);
  log('--- reduce ---');
  const at = Date.now();
  const reduce = send({ op: 'reduce', clientId: cid(), symbol: sym });
  const reduced = await until((s) => s.positions.some((p) => p.netQuantity === 1) && legsOf(s, 'stop').length === 1 && legsOf(s, 'target').length === 1, 10_000);
  log(reduced ? `pozice 1 ks s jednou ochranou za ${Date.now() - at} ms od odeslání` : 'do 10 s se stav „1 ks + jedna ochrana" neobjevil');
  await reduce;
  await wait(2_000);
  log(`po částečném zavření: ${brief(state as unknown as State)}`);
  log(`zavření: ${JSON.stringify((state as unknown as State).closes ?? []).slice(0, 300)}`);
  log('--- úklid: zavření zbytku ---');
  await send({ op: 'flatten', clientId: cid(), symbol: sym });
  await until(flat, 10_000);
  await wait(1_000);
  log(`konec: ${brief(state as unknown as State)} | incidenty: ${JSON.stringify((state as unknown as State).incidents.slice(-3)).slice(0, 300)}`);
  done(0);
})().catch((error) => { console.error('SELHALO', error); done(1); });

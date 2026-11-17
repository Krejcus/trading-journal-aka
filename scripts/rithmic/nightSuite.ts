/**
 * Sada měření proti Rithmic Test (simulované peníze) přes běžící místní službu: jednotlivé druhy příkazů a pozic.
 * Každý scénář začíná i končí na prázdném účtu; výsledek je PROŠEL / SELHAL s důvodem a časy.
 *   RITHMIC_USER=… npx tsx scripts/rithmic/devTradeServer.ts --contract MNQZ6
 *   npx tsx scripts/rithmic/nightSuite.ts [--port 3311] [--only S3,S5]
 * Odmítne běžet proti čemukoli jinému než Rithmic Test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const PORT = arg('port') ?? '3311';
const ONLY = arg('only')?.split(',') ?? null;
const token = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'results', 'dev-token'), 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}`, { origin: 'http://localhost:3000' });
type Order = { orderId: string; role: string; status: string; price?: number; quantity: number; filledQuantity: number; tag?: string; entryType?: string; plannedStop?: number; plannedTarget?: number; entryId?: string };
type State = { positions: Array<{ symbol: string; netQuantity: number; averagePrice?: number }>; orders: Order[]; blocked: string | null; incidents: Array<{ kind: string; message: string; at: number }>; closes: Array<Record<string, unknown>> };
type Reply = { ok: boolean; sent?: boolean | 'unknown'; error?: string; result?: Record<string, unknown>; serverMs?: number };
let hello: { system: string; symbol: string; tickSize: number; readOnly?: boolean; live?: boolean; limits?: unknown } | null = null;
let state: State | null = null;
let price: number | null = null;
const waiters: Array<{ test: (s: State) => boolean; resolve: (ok: boolean) => void }> = [];
const replies = new Map<string, (reply: Reply) => void>();
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw)) as Record<string, unknown>;
  if (m.type === 'hello') { hello = m as never; if (typeof m.price === 'number') price = m.price; }
  else if (m.type === 'tick' && typeof m.price === 'number') price = m.price;
  else if (m.type === 'state') { state = m.state as State; for (const w of [...waiters]) if (w.test(state)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(true); } }
  else if (m.type === 'reply') replies.get(String(m.id))?.(m as unknown as Reply);
});
const until = (test: (s: State) => boolean, ms = 8_000) => new Promise<boolean>((resolve) => {
  if (state && test(state)) { resolve(true); return; }
  const w = { test, resolve };
  waiters.push(w);
  setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); resolve(false); } }, ms);
});
let n = 0;
const times: string[] = [];
const send = (command: Record<string, unknown>, label?: string) => new Promise<Reply>((resolve) => {
  const id = `n${(n += 1)}`;
  const at = Date.now();
  const timer = setTimeout(() => { replies.delete(id); resolve({ ok: false, sent: 'unknown', error: 'bez odpovědi 20 s' }); }, 20_000);
  replies.set(id, (reply) => { clearTimeout(timer); times.push(`${label ?? String(command.op)} ${Date.now() - at} ms`); resolve(reply); });
  ws.send(JSON.stringify({ id, command }));
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cur = () => state as unknown as State;
const cid = () => `ns${Date.now().toString(36)}${n}`;
class Fail extends Error {}
const need = (condition: unknown, message: string): void => { if (!condition) throw new Fail(message); };
const brief = (s: State) => `pozice ${s.positions.map((p) => `${p.netQuantity}@${p.averagePrice ?? '?'}`).join(',') || '0'} | ${s.orders.map((o) => `${o.role}:${o.price ?? '-'}x${o.quantity}:${o.status}`).join(' ') || 'bez příkazů'}${s.blocked ? ` | BLOK ${s.blocked.slice(0, 80)}` : ''}`;

(async () => {
  await new Promise((resolve) => ws.on('open', resolve));
  await until(() => hello !== null && price !== null, 10_000);
  if (!hello || hello.system !== 'Rithmic Test' || hello.readOnly || hello.live) { console.log(`ODMÍTÁM: služba běží na "${hello?.system}" — sada je jen pro Rithmic Test`); process.exit(2); }
  const h = hello as NonNullable<typeof hello>;
  const sym = h.symbol;
  const grid = (value: number) => Math.round(value / h.tickSize) * h.tickSize;
  const flat = (s: State) => !s.positions.some((p) => p.symbol === sym) && s.orders.length === 0;
  const working = (role: string) => cur().orders.filter((o) => o.role === role && o.status === 'working');
  const net = () => cur().positions.find((p) => p.symbol === sym)?.netQuantity ?? 0;
  const px = () => grid(price as number);
  const entry = (extra: Record<string, unknown>) => send({ op: 'entry', clientId: cid(), symbol: sym, side: 'Buy', quantity: 1, ...extra }, `vstup ${String(extra.orderType)}`);
  const ok = (reply: Reply, what: string) => { need(reply.ok, `${what}: ${reply.error ?? 'neprošlo'}`); return reply.result ?? {}; };
  const cleanup = async () => {
    if (cur().blocked) await send({ op: 'ack' });
    if (!flat(cur())) { await send({ op: 'flatten', clientId: cid(), symbol: sym }); await until(flat, 10_000); }
    if (!flat(cur())) for (const o of cur().orders) { const r = await send({ op: 'cancel', orderId: o.orderId }); if (!r.ok) console.log(`     úklid: zrušení ${o.orderId} neprošlo: ${r.error}`); }
    if (!(await until(flat, 8_000))) console.log(`     úklid: účet není prázdný: ${brief(cur())}`);
    await wait(1_300); // usazení pozice před dalším scénářem
  };
  const marketBracket = async (quantity = 1, sl = 40, tp = 40) => {
    const p = px();
    ok(await entry({ orderType: 'Market', quantity, referencePrice: p, stopPrice: grid(p - sl), targetPrice: grid(p + tp) }), 'Market se SL/TP');
    need(await until((s) => (s.positions.find((x) => x.symbol === sym)?.netQuantity ?? 0) >= quantity && s.orders.filter((o) => o.role === 'stop' && o.status === 'working').length >= 1 && s.orders.filter((o) => o.role === 'target' && o.status === 'working').length >= 1), 'pozice s nohama nevznikla');
    await wait(1_300);
  };

  const scenarios: Array<[string, string, () => Promise<string>]> = [
    ['S1', 'Limit se SL/TP: posun vstupu (SL/TP stojí), posun čekajícího SL a TP, zrušení', async () => {
      const p = grid(px() - 15);
      const first = ok(await entry({ orderType: 'Limit', limitPrice: p, stopPrice: p - 10, targetPrice: p + 30 }), 'Limit');
      need(await until((s) => s.orders.some((o) => o.role === 'entry' && o.status === 'working')), 'vstup nepracuje');
      const a = ok(await send({ op: 'replace-entry', clientId: cid(), orderId: first.orderId, price: p + 3 }, 'posun vstupu'), 'posun vstupu');
      await wait(700);
      let e = working('entry')[0];
      need(e && e.price === p + 3 && e.plannedStop === p - 10 && e.plannedTarget === p + 30, `po posunu vstupu: ${brief(cur())} SL ${e?.plannedStop} TP ${e?.plannedTarget}`);
      const b = ok(await send({ op: 'replace-entry', clientId: cid(), orderId: a.orderId, stopPrice: p - 14 }, 'posun čekajícího SL'), 'posun SL');
      await wait(700);
      const c = ok(await send({ op: 'replace-entry', clientId: cid(), orderId: b.orderId, targetPrice: p + 25 }, 'posun čekajícího TP'), 'posun TP');
      await wait(700);
      e = working('entry')[0];
      need(e && e.price === p + 3 && e.plannedStop === p - 14 && e.plannedTarget === p + 25 && cur().orders.length === 1, `po posunu noh: ${brief(cur())}`);
      ok(await send({ op: 'cancel', orderId: c.orderId }, 'zrušení'), 'zrušení');
      need(await until(flat), 'po zrušení něco zbylo');
      return 'SL/TP při posunu vstupu stály';
    }],
    ['S2', 'Stop vstup se SL/TP: posun spouště (SL/TP stojí), zrušení', async () => {
      const t = grid(px() + 20);
      const first = ok(await entry({ orderType: 'Stop', triggerPrice: t, stopPrice: t - 12, targetPrice: t + 24 }), 'Stop');
      need(await until((s) => s.orders.some((o) => o.role === 'entry' && o.status === 'working')), 'vstup nepracuje');
      const a = ok(await send({ op: 'replace-entry', clientId: cid(), orderId: first.orderId, price: t + 2 }, 'posun spouště'), 'posun spouště');
      await wait(700);
      const e = working('entry')[0];
      need(e && e.entryType === 'Stop' && e.price === t + 2 && e.plannedStop === t - 12 && e.plannedTarget === t + 24, `po posunu: ${brief(cur())}`);
      ok(await send({ op: 'cancel', orderId: a.orderId }, 'zrušení'), 'zrušení');
      need(await until(flat), 'po zrušení něco zbylo');
      return 'spoušť posunuta, SL/TP stály';
    }],
    ['S3', 'Market se SL/TP: posun SL, posun TP, zavření brzdou, výsledek obchodu', async () => {
      await marketBracket();
      const stop = working('stop')[0];
      const target = working('target')[0];
      ok(await send({ op: 'move', orderId: stop.orderId, price: stop.price! + 2 }, 'posun SL'), 'posun SL');
      ok(await send({ op: 'move', orderId: target.orderId, price: target.price! - 2 }, 'posun TP'), 'posun TP');
      await wait(700);
      need(working('stop')[0]?.price === stop.price! + 2 && working('target')[0]?.price === target.price! - 2, `po posunu noh: ${brief(cur())}`);
      const before = cur().closes.length;
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      need(await until((s) => s.closes.length > before, 8_000), 'výsledek obchodu nevznikl');
      const close = cur().closes.at(-1)!;
      need(close.reason === 'manual' && close.quantity === 1, `výsledek: ${JSON.stringify(close)}`);
      return `výsledek ${String(close.pointsTotal)} b, důvod ${String(close.reason)}`;
    }],
    ['S4', 'Market bez ochrany → + SL → + TP (svázaný pár) → posun → zrušení jedné nohy odmítnuto → zavření', async () => {
      ok(await entry({ orderType: 'Market', referencePrice: px() }), 'Market bez ochrany');
      need(await until((s) => (s.positions.find((x) => x.symbol === sym)?.netQuantity ?? 0) === 1 && s.orders.length === 0), 'holá pozice nevznikla');
      await wait(1_300);
      const p = px();
      ok(await send({ op: 'protect', clientId: cid(), symbol: sym, kind: 'stop', price: grid(p - 40) }, '+ SL'), '+ SL');
      need(await until(() => working('stop').length === 1), 'SL nevznikl');
      await wait(1_300);
      const pair = ok(await send({ op: 'protect', clientId: cid(), symbol: sym, kind: 'target', price: grid(p + 40) }, '+ TP (pár)'), '+ TP');
      need(pair.paired === true && await until(() => working('stop').length === 1 && working('target').length === 1), `pár nevznikl: ${brief(cur())}`);
      await wait(700);
      ok(await send({ op: 'move', orderId: working('target')[0].orderId, price: grid(p + 42) }, 'posun TP páru'), 'posun TP páru');
      const refused = await send({ op: 'cancel', orderId: working('stop')[0].orderId }, 'zrušení nohy páru');
      need(!refused.ok && refused.sent === false, 'zrušení jedné nohy páru nebylo odmítnuto');
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      return 'pár vznikl, posun prošel, zrušení jedné nohy odmítnuto';
    }],
    ['S5', 'Market bez ochrany → SL i TP najednou (jeden zápis) → zavření', async () => {
      ok(await entry({ orderType: 'Market', referencePrice: px() }), 'Market bez ochrany');
      need(await until((s) => (s.positions.find((x) => x.symbol === sym)?.netQuantity ?? 0) === 1 && s.orders.length === 0), 'holá pozice nevznikla');
      await wait(1_300);
      const p = px();
      const pair = ok(await send({ op: 'protect-pair', clientId: cid(), symbol: sym, stopPrice: grid(p - 40), targetPrice: grid(p + 40) }, 'SL+TP najednou'), 'SL+TP najednou');
      need(pair.paired === true && await until(() => working('stop').length === 1 && working('target').length === 1), `pár nevznikl: ${brief(cur())}`);
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      return 'pár jedním zápisem';
    }],
    ['S6', 'Market se SL/TP + přikoupení Marketem → částečné zavření → zbytek má své SL/TP → zavření', async () => {
      await marketBracket();
      const sl = working('stop')[0].price!;
      const tp = working('target')[0].price!;
      ok(await entry({ orderType: 'Market', referencePrice: px(), stopPrice: sl, targetPrice: tp }), 'přikoupení');
      need(await until(() => net() === 2 && working('stop').length === 2 && working('target').length === 2), `po přikoupení: ${brief(cur())}`);
      await wait(1_300);
      ok(await send({ op: 'reduce', clientId: cid(), symbol: sym }, 'částečné zavření'), 'částečné zavření');
      need(await until(() => net() === 1 && working('stop').length === 1 && working('target').length === 1), `po částečném zavření: ${brief(cur())}`);
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      return '2 ks → 1 ks s vlastní ochranou → 0';
    }],
    ['S7', 'Vstup 2 kontrakty Marketem se SL/TP: nohy mají 2 ks, posun SL, zavření', async () => {
      await marketBracket(2);
      need(net() === 2 && working('stop')[0].quantity === 2 && working('target')[0].quantity === 2, `2 ks: ${brief(cur())}`);
      const stop = working('stop')[0];
      ok(await send({ op: 'move', orderId: stop.orderId, price: stop.price! + 2 }, 'posun SL 2 ks'), 'posun SL');
      await wait(700);
      need(working('stop')[0]?.price === stop.price! + 2 && working('stop')[0].quantity === 2, `po posunu: ${brief(cur())}`);
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      return 'pozice 2 ks s ochranou 2 ks';
    }],
    ['S8', 'Limit 2 kontrakty se SL/TP: posun vstupu, zrušení', async () => {
      const p = grid(px() - 15);
      const first = ok(await entry({ orderType: 'Limit', quantity: 2, limitPrice: p, stopPrice: p - 10, targetPrice: p + 30 }), 'Limit 2 ks');
      need(await until((s) => s.orders.some((o) => o.role === 'entry' && o.status === 'working')), 'vstup nepracuje');
      const a = await send({ op: 'replace-entry', clientId: cid(), orderId: first.orderId, price: p + 3 }, 'posun vstupu 2 ks');
      await wait(700);
      const e = working('entry')[0];
      const moved = a.ok && e?.price === p + 3 && e.quantity === 2 && e.plannedStop === p - 10;
      for (const o of cur().orders) await send({ op: 'cancel', orderId: o.orderId });
      need(await until(flat), 'po zrušení něco zbylo');
      need(moved, `posun vstupu 2 ks: ${a.error ?? brief(cur())}`);
      return 'posun vstupu 2 ks prošel';
    }],
    ['S9', 'Vstup jen se SL a vstup jen s TP (Market), zavření', async () => {
      const p = px();
      ok(await entry({ orderType: 'Market', referencePrice: p, stopPrice: grid(p - 40) }), 'Market jen se SL');
      need(await until(() => net() === 1 && working('stop').length === 1 && working('target').length === 0), `jen SL: ${brief(cur())}`);
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      await wait(1_500);
      const q = px();
      ok(await entry({ orderType: 'Market', referencePrice: q, targetPrice: grid(q + 40) }), 'Market jen s TP');
      need(await until(() => net() === 1 && working('target').length === 1 && working('stop').length === 0), `jen TP: ${brief(cur())}`);
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      return 'obě varianty';
    }],
    ['S10', 'Short: Market Sell se SL/TP, posun SL, zavření', async () => {
      const p = px();
      ok(await entry({ orderType: 'Market', side: 'Sell', referencePrice: p, stopPrice: grid(p + 40), targetPrice: grid(p - 40) }), 'Market Sell');
      need(await until(() => net() === -1 && working('stop').length === 1 && working('target').length === 1), `short: ${brief(cur())}`);
      await wait(1_300);
      const stop = working('stop')[0];
      ok(await send({ op: 'move', orderId: stop.orderId, price: stop.price! - 2 }, 'posun SL short'), 'posun SL');
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      return 'short s ochranou';
    }],
    ['S11', 'Market 2 ks bez ochrany → + SL → + TP (svázaný pár na 2 ks) → zavření', async () => {
      ok(await entry({ orderType: 'Market', quantity: 2, referencePrice: px() }), 'Market 2 ks bez ochrany');
      need(await until(() => net() === 2 && cur().orders.length === 0), `holá pozice 2 ks: ${brief(cur())}`);
      await wait(1_300);
      const p = px();
      ok(await send({ op: 'protect', clientId: cid(), symbol: sym, kind: 'stop', price: grid(p - 40) }, '+ SL 2 ks'), '+ SL');
      need(await until(() => working('stop').length === 1 && working('stop')[0].quantity === 2), `SL 2 ks: ${brief(cur())}`);
      await wait(1_300);
      const pair = ok(await send({ op: 'protect', clientId: cid(), symbol: sym, kind: 'target', price: grid(p + 40) }, '+ TP (pár 2 ks)'), '+ TP');
      need(pair.paired === true && await until(() => working('stop').length === 1 && working('target').length === 1), `pár: ${brief(cur())}`);
      need(working('stop')[0].quantity === 2 && working('target')[0].quantity === 2, `množství páru: ${brief(cur())}`);
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      return 'pár na 2 ks';
    }],
    ['S12', 'Market 2 ks bez ochrany → SL i TP najednou na 2 ks → zavření', async () => {
      ok(await entry({ orderType: 'Market', quantity: 2, referencePrice: px() }), 'Market 2 ks bez ochrany');
      need(await until(() => net() === 2 && cur().orders.length === 0), `holá pozice 2 ks: ${brief(cur())}`);
      await wait(1_300);
      const p = px();
      const pair = ok(await send({ op: 'protect-pair', clientId: cid(), symbol: sym, stopPrice: grid(p - 40), targetPrice: grid(p + 40) }, 'SL+TP najednou 2 ks'), 'SL+TP najednou');
      need(pair.paired === true && await until(() => working('stop').length === 1 && working('target').length === 1), `pár: ${brief(cur())}`);
      need(working('stop')[0].quantity === 2 && working('target')[0].quantity === 2, `množství páru: ${brief(cur())}`);
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      return 'pár jedním zápisem na 2 ks';
    }],
    ['S13', 'Limit BEZ ochrany 3 ks: posun vstupu (výměna), zrušení', async () => {
      const p = grid(px() - 15);
      const first = ok(await entry({ orderType: 'Limit', quantity: 3, limitPrice: p }), 'Limit 3 ks bez ochrany');
      need(await until((s) => s.orders.some((o) => o.role === 'entry' && o.status === 'working')), 'vstup nepracuje');
      const a = ok(await send({ op: 'replace-entry', clientId: cid(), orderId: first.orderId, price: p + 2 }, 'posun vstupu 3 ks'), 'posun vstupu');
      await wait(700);
      const e = working('entry')[0];
      need(e && e.price === p + 2 && e.quantity === 3 && cur().orders.length === 1, `po posunu: ${brief(cur())}`);
      ok(await send({ op: 'cancel', orderId: a.orderId }, 'zrušení'), 'zrušení');
      need(await until(flat), 'po zrušení něco zbylo');
      return 'holý Limit 3 ks posunut';
    }],
    ['S14', 'Čekající přikoupení Limitem: zadání, pozici zavře TP → služba přikoupení sama zruší', async () => {
      await marketBracket();
      const sl = working('stop')[0].price!;
      const tp = working('target')[0].price!;
      const addPrice = grid(px() - 12);
      need(addPrice > sl, 'přikoupení by bylo pod SL');
      ok(await send({ op: 'entry', clientId: `add-${cid()}`.slice(0, 30), symbol: sym, side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: addPrice, stopPrice: sl, targetPrice: tp }, 'přikoupení Limitem'), 'přikoupení Limitem');
      need(await until(() => working('entry').length === 1 && net() === 1), `po zadání přikoupení: ${brief(cur())}`);
      need(working('entry')[0].tag?.startsWith('ui-add-') === true, 'přikoupení nenese značku vazby');
      // pozici zavře TP posunutý za trh (vyplní se u trhu) → služba má přikoupení zrušit sama
      const target = working('target')[0];
      const before = cur().incidents.length;
      ok(await send({ op: 'move', orderId: target.orderId, price: grid(px() - 2) }, 'TP za trh (zavření pozice)'), 'TP za trh');
      need(await until(() => net() === 0, 10_000), `pozice se nezavřela: ${brief(cur())}`);
      need(await until(flat, 8_000), `přikoupení po zavření pozice zůstalo: ${brief(cur())}`);
      const kinds = cur().incidents.slice(before).map((i) => i.kind);
      need(kinds.includes('pending-add-cancelled'), `chybí záznam o zrušení přikoupení: ${kinds.join(', ')}`);
      return 'po zavření pozice služba čekající přikoupení zrušila';
    }],
    ['S15', 'JEDEN vstup 2 ks se SL/TP → zavřít 1 ks (ochrana se zmenší na 1 ks) → zbytek zavře brzda', async () => {
      await marketBracket(2);
      need(net() === 2 && working('stop')[0].quantity === 2, `2 ks: ${brief(cur())}`);
      const result = ok(await send({ op: 'reduce', clientId: cid(), symbol: sym }, 'zavření 1 ks ze 2'), 'zavření 1 ks ze 2');
      need(result.split === true, `výsledek: ${JSON.stringify(result)}`);
      need(await until(() => net() === 1 && working('stop').length === 1 && working('target').length === 1 && working('stop')[0].quantity === 1 && working('target')[0].quantity === 1), `po zavření 1 ks: ${brief(cur())}`);
      await wait(1_300);
      need(!cur().blocked, `blok: ${cur().blocked}`);
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      return '2 ks → 1 ks s ochranou 1 ks → 0';
    }],
    ['S16', 'JEDEN vstup 3 ks → dvakrát zavřít 1 ks → zbyde 1 ks s ochranou 1 ks', async () => {
      await marketBracket(3);
      need(net() === 3, `3 ks: ${brief(cur())}`);
      ok(await send({ op: 'reduce', clientId: cid(), symbol: sym }, 'zavření 1 ks ze 3'), 'první zavření');
      need(await until(() => net() === 2 && working('stop')[0]?.quantity === 2 && working('target')[0]?.quantity === 2), `po prvním: ${brief(cur())}`);
      await wait(1_500);
      ok(await send({ op: 'reduce', clientId: cid(), symbol: sym }, 'zavření 1 ks ze 2'), 'druhé zavření');
      need(await until(() => net() === 1 && working('stop')[0]?.quantity === 1 && working('target')[0]?.quantity === 1), `po druhém: ${brief(cur())}`);
      await wait(1_300);
      need(!cur().blocked, `blok: ${cur().blocked}`);
      ok(await send({ op: 'flatten', clientId: cid(), symbol: sym }, 'zavření'), 'zavření');
      need(await until(flat, 10_000), 'po zavření něco zbylo');
      return '3 → 2 → 1 → 0';
    }],
  ];

  // Sada sama nic cizího neuklízí: nečistý účet na začátku = konec (pozice nebo příkaz mohou být ruční).
  if (!flat(cur()) || cur().blocked) { console.log(`ÚČET NENÍ PRÁZDNÝ nebo je zablokovaný — sadu nespouštím: ${brief(cur())}`); ws.close(); process.exit(2); }
  let failed = 0;
  for (const [id, title, run] of scenarios) {
    if (ONLY && !ONLY.includes(id)) continue;
    await cleanup();
    if (!flat(cur())) { console.log(`${id} PŘESKOČEN — účet není prázdný: ${brief(cur())}`); failed += 1; continue; }
    times.length = 0;
    const incidentsBefore = cur().incidents.length;
    try {
      const note = await run();
      const incidents = cur().incidents.slice(incidentsBefore).map((i) => i.kind).filter((kind) => kind !== 'pending-add-cancelled');
      const clean = incidents.length === 0 && !cur().blocked;
      if (!clean) failed += 1;
      console.log(`${id} ${clean ? 'PROŠEL' : 'PROŠEL S INCIDENTEM'} — ${title}\n     ${note}${clean ? '' : ` | incidenty: ${incidents.join(', ')} | blok: ${cur().blocked}`}\n     časy: ${times.join(' · ')}`);
    } catch (error) {
      failed += 1;
      console.log(`${id} SELHAL — ${title}\n     ${error instanceof Error ? error.message : String(error)}\n     stav: ${brief(cur())}\n     časy: ${times.join(' · ')}`);
    }
  }
  await cleanup();
  console.log(`\nKonec: ${flat(cur()) ? 'účet prázdný' : `POZOR, účet není prázdný: ${brief(cur())}`} · selhalo ${failed}`);
  ws.close();
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})().catch((error) => { console.error('SELHALO', error); process.exit(1); });

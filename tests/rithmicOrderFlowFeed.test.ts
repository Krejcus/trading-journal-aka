import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOrderFlowFeed, ORDER_FLOW_HIGH_WATER, type OrderFlowFeed } from '../services/rithmic/orderFlowFeed';
import type { RithmicTick } from '../services/rithmic/rithmicClient';

const T0 = Date.UTC(2026, 10, 27, 14, 30, 0);
const M0 = T0 / 1000;

function trade(symbol: string, offsetMs: number, price: number, size: number, aggressor: 'buy' | 'sell', orderId: string): RithmicTick {
  return {
    kind: 'trade', symbol, exchange: 'CME', isSnapshot: false, tradePrice: price, tradeSize: size, bidPrice: null, askPrice: null,
    gatewayAt: T0 + offsetMs, exchangeAt: T0 + offsetMs, receivedAt: T0 + offsetMs + 80, aggressor, aggressorOrderId: orderId,
  };
}

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  failNext = false;
  send(text: string): void {
    if (this.failNext) { this.failNext = false; throw new Error('socket closing'); }
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  take(): Array<Record<string, unknown>> { const out = this.sent; this.sent = []; return out; }
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function make(options: { now?: () => number; dir?: string; logs?: string[] } = {}): { feed: OrderFlowFeed; clock: { at: number } } {
  const clock = { at: T0 + 10_000 };
  const feed = createOrderFlowFeed({
    sources: { NQ: 'NQZ6', MNQ: 'MNQZ6' }, tickSize: 0.25, timers: false, log: (line) => { options.logs?.push(line); },
    now: options.now ?? (() => clock.at), dir: options.dir, slug: 'test',
  });
  feed.feedOpened(T0 - 120_000);
  return { feed, clock };
}

describe('order flow — doručení klientům', () => {
  it('bez přihlášení k odběru klient nedostane nic', () => {
    const { feed } = make();
    const socket = new FakeSocket();
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    feed.flushTrades(); feed.flushCells(); feed.pumpSnapshots();
    expect(socket.sent).toEqual([]);
  });

  it('po přihlášení pošle snímek a potom jen změny s celkovými hodnotami', () => {
    const { feed } = make();
    const socket = new FakeSocket();
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    feed.flushTrades(); feed.flushCells();
    expect(feed.handle(socket, { subscribe: true, source: 'NQ', days: 1 })).toBeNull();
    feed.pumpSnapshots();
    const [snapshot] = socket.take();
    expect(snapshot).toMatchObject({ type: 'of-snapshot', source: 'NQ', symbol: 'NQZ6', part: 0, last: true, reset: true, tickSize: 0.25, floor: 5 });
    expect(snapshot.minutes).toEqual([[M0, [100000, 9, 0, 0]]]);
    expect((snapshot.trades as unknown[][]).map((row) => row[3])).toEqual([9]);

    feed.onTick(trade('NQZ6', 2_000, 25000, 1, 'sell', 'B'));
    feed.onTick(trade('NQZ6', 3_000, 25000.5, 6, 'sell', 'C'));
    feed.flushTrades(); feed.flushCells();
    const [trades, cells] = socket.take();
    expect(trades).toMatchObject({ type: 'of-trade', seq: 1 });
    expect((trades.trades as unknown[][]).map((row) => [row[0], row[3]])).toEqual([['C', 6]]);
    expect(cells).toMatchObject({ type: 'of', seq: 2 });
    expect(cells.cells).toEqual([[M0, [100000, 9, 1, 0, 100002, 0, 6, 0]]]);
  });

  it('každý klient dostává jen svůj zdroj', () => {
    const { feed } = make();
    const nq = new FakeSocket();
    const mnq = new FakeSocket();
    feed.handle(nq, { subscribe: true, source: 'NQ' });
    feed.handle(mnq, { subscribe: true, source: 'MNQ' });
    feed.pumpSnapshots(); nq.take(); mnq.take();
    feed.onTick(trade('MNQZ6', 1_000, 25000, 30, 'buy', 'A'));
    feed.flushTrades(); feed.flushCells();
    expect(nq.sent).toEqual([]);
    expect(mnq.sent.map((message) => message.type)).toEqual(['of-trade', 'of']);
  });

  it('pomalému klientovi dávku přeskočí a změny pošle, až se mu fronta uvolní', () => {
    const { feed } = make();
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots(); socket.take();
    socket.bufferedAmount = ORDER_FLOW_HIGH_WATER + 1;
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    feed.flushTrades(); feed.flushCells();
    feed.onTick(trade('NQZ6', 2_000, 25000, 2, 'buy', 'B'));
    feed.flushTrades(); feed.flushCells();
    expect(socket.sent).toEqual([]);
    socket.bufferedAmount = 0;
    feed.flushTrades(); feed.flushCells();
    const messages = socket.take();
    expect(messages.map((message) => message.type)).toEqual(['of-trade', 'of']);
    expect(messages[1].cells).toEqual([[M0, [100000, 11, 0, 0]]]);
    expect(feed.metricsLine()).toContain('přeskočeno');
  });

  it('snímek dělí na části a změny během něj doručí až po něm', () => {
    const { feed } = make();
    const socket = new FakeSocket();
    // 40 minut po 400 cenách = 16 000 buněk → dvě části
    for (let minute = 0; minute < 40; minute += 1) {
      for (let step = 0; step < 400; step += 1) feed.onTick(trade('NQZ6', minute * 60_000 + step, 25000 + step * 0.25, 1, 'buy', `o${minute}-${step}`));
    }
    for (let i = 0; i < 8; i += 1) { feed.flushTrades(); feed.flushCells(); }
    feed.handle(socket, { subscribe: true, source: 'NQ', days: 1 });
    feed.pumpSnapshots();
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ part: 0, last: false, reset: true });
    // nejnovější minuta jde první: to, co je v grafu vidět, dorazí hned
    expect((socket.sent[0].minutes as Array<[number, number[]]>)[0][0]).toBe(M0 + 39 * 60);
    feed.onTick(trade('NQZ6', 39 * 60_000 + 500, 25000, 7, 'sell', 'late'));
    feed.flushTrades(); feed.flushCells();
    expect(socket.sent).toHaveLength(1);
    for (let i = 0; i < 40 && socket.sent[socket.sent.length - 1].last !== true; i += 1) feed.pumpSnapshots();
    const parts = socket.sent.filter((message) => message.type === 'of-snapshot');
    expect(parts[parts.length - 1]).toMatchObject({ last: true });
    expect(parts.length).toBeGreaterThan(8);
    // žádná část nepřeroste strop, za kterým by zdržela odpovědi na příkazy na stejném spojení
    for (const part of parts) expect(JSON.stringify(part).length).toBeLessThan(ORDER_FLOW_HIGH_WATER);
    feed.flushTrades(); feed.flushCells();
    expect(socket.sent.slice(parts.length).map((message) => message.type)).toEqual(['of-trade', 'of']);
    const total = parts.reduce((sum, message) => sum + (message.minutes as Array<[number, number[]]>).reduce((cells, row) => cells + row[1].length / 4, 0), 0);
    expect(total).toBe(16_000);
  });

  it('jeden kus snímku na otočku, klienti se střídají', () => {
    const { feed } = make();
    for (let minute = 0; minute < 20; minute += 1) {
      for (let step = 0; step < 400; step += 1) feed.onTick(trade('NQZ6', minute * 60_000 + step, 25000 + step * 0.25, 1, 'buy', `o${minute}-${step}`));
    }
    for (let i = 0; i < 4; i += 1) feed.flushCells();
    const a = new FakeSocket(); const b = new FakeSocket();
    feed.handle(a, { subscribe: true, source: 'NQ' });
    feed.handle(b, { subscribe: true, source: 'NQ' });
    for (let i = 0; i < 4; i += 1) feed.pumpSnapshots();
    expect(a.sent.length + b.sent.length).toBe(4);
    expect(a.sent.length).toBe(2);
    expect(b.sent.length).toBe(2);
  });

  it('klient, kterému se nahromadí moc změn, dostane nový snímek místo obří dávky', () => {
    const { feed } = make();
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots(); socket.take();
    socket.bufferedAmount = ORDER_FLOW_HIGH_WATER + 1;
    for (let step = 0; step < 6_500; step += 1) feed.onTick(trade('NQZ6', 1_000, 20000 + step * 0.25, 1, 'buy', `o${step}`));
    for (let i = 0; i < 3; i += 1) { feed.flushTrades(); feed.flushCells(); }
    expect(socket.sent).toEqual([]);
    socket.bufferedAmount = 0;
    feed.pumpSnapshots();
    expect(socket.sent[0]).toMatchObject({ type: 'of-snapshot', part: 0, reset: true });
    expect(feed.metricsLine()).toContain('nových snímků');
  });

  it('chyba uvnitř vrstvu jen vypne: nic nevyhodí, odběratelé dostanou zprávu a služba ji přestane nabízet', () => {
    const logs: string[] = [];
    let broken = false;
    const base = T0 + 10_000;
    const { feed } = make({ logs, now: () => { if (broken) throw new Error('rozbité hodiny'); return base; } });
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots(); socket.take();
    broken = true;
    expect(() => feed.advance()).not.toThrow();
    expect(socket.take()).toEqual([{ type: 'of-error', message: 'order flow se ve službě po chybě vypnul' }]);
    expect(feed.capability()).toBeNull();
    expect(logs.join('\n')).toContain('VYPNUTO');
    expect(() => { feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A')); feed.flushTrades(); feed.flushCells(); feed.pumpSnapshots(); feed.feedLost(); }).not.toThrow();
    expect(socket.sent).toEqual([]);
    broken = false;
    expect(feed.handle(new FakeSocket(), { subscribe: true, source: 'NQ' })).toContain('vypnutý');
    expect(feed.metricsLine()).toContain('VYPNUTO');
  });

  it('zdroj přidaný po startu má data až od potvrzení svého odběru', () => {
    const clock = { at: T0 + 10_000 };
    const feed = createOrderFlowFeed({ sources: { MNQ: 'MNQZ6' }, tickSize: 0.25, timers: false, log: () => undefined, now: () => clock.at });
    feed.feedOpened(T0 - 120_000, 'MNQZ6');
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'early'));
    expect(feed.addSource('NQ', 'NQZ6')).toBe(true);
    expect(feed.addSource('NQ', 'NQH7')).toBe(false);
    expect(feed.capability()?.sources).toEqual({ MNQ: 'MNQZ6', NQ: 'NQZ6' });
    clock.at = T0 + 5 * 60_000 + 3_000;
    feed.flushTrades(); feed.advance();
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots();
    const [snapshot] = socket.take();
    // obchod před přidáním zdroje se nepočítá; odběr NQ se nepotvrdil → nic není pokryté
    expect(snapshot).toMatchObject({ last: true, minutes: [], coverage: [], liveSince: null });
  });

  it('obchody jen řadí do fronty a při zahlcení je zahodí, místo aby rostla paměť; minuta pak není úplná', () => {
    const { feed, clock } = make();
    for (let i = 0; i < 100_050; i += 1) feed.onTick(trade('NQZ6', 1_000, 25000, 1, 'buy', `o${i}`));
    for (let i = 0; i < 30; i += 1) feed.flushTrades();
    clock.at = T0 + 3 * 60_000 + 3_000;
    feed.advance();
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots();
    const [snapshot] = socket.take();
    expect((snapshot.minutes as Array<[number, number[]]>)[0]).toEqual([M0, [100000, 100_000, 0, 0]]);
    // minuta, ve které se obchody ztratily, se nevede jako pokrytá
    expect((snapshot.coverage as Array<[number, number]>).some(([from, to]) => from <= M0 && to > M0)).toBe(false);
    expect(feed.metricsLine()).toContain('ZAHOZENO obchodů 50');
  });

  it('mezera v hodinách (uspaný Mac) přeruší pokrytí — minuty spánku se nevedou jako úplné', () => {
    const { feed, clock } = make();
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    feed.advance();
    // proces stál 4 minuty: hodiny se ozvou až po probuzení
    clock.at = T0 + 4 * 60_000 + 10_000;
    feed.advance();
    clock.at += 1_000; feed.advance();
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots();
    const [snapshot] = socket.take();
    const coverage = snapshot.coverage as Array<[number, number]>;
    for (const minute of [M0, M0 + 60, M0 + 120, M0 + 180]) {
      expect(coverage.some(([from, to]) => from <= minute && to > minute), `minuta ${minute}`).toBe(false);
    }
    expect(snapshot.liveSince).not.toBeNull();
  });

  it('bez mezery v hodinách zůstává klidná minuta pokrytá', () => {
    const { feed, clock } = make();
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    for (let at = T0 + 10_000; at <= T0 + 3 * 60_000 + 5_000; at += 1_000) { clock.at = at; feed.advance(); }
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots();
    const coverage = socket.take()[0].coverage as Array<[number, number]>;
    expect(coverage.some(([from, to]) => from <= M0 + 60 && to > M0 + 60)).toBe(true);
  });

  it('hodiny před uzavřením minuty nejdřív dopočítají, co čeká ve frontě', () => {
    const { feed, clock } = make();
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    clock.at = T0 + 3 * 60_000 + 3_000; // smyčka se zasekla: obchod je pořád jen ve frontě
    feed.advance();
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots();
    expect(socket.take()[0].minutes).toEqual([[M0, [100000, 9, 0, 0]]]);
    expect(feed.metricsLine()).not.toContain('opožděných');
  });

  it('nahromaděné změny odcházejí po částech, ne jednou obří zprávou', () => {
    const { feed } = make();
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots(); socket.take();
    // pět minut po 700 cenách: do jedné zprávy se vejdou nejvýš dvě
    for (let minute = 0; minute < 5; minute += 1) {
      for (let step = 0; step < 700; step += 1) feed.onTick(trade('NQZ6', minute * 60_000 + step, 20000 + step * 0.25, 1, 'buy', `o${minute}-${step}`));
    }
    feed.flushTrades();
    for (let i = 0; i < 4; i += 1) feed.flushCells();
    const batches = socket.take().filter((message) => message.type === 'of');
    expect(batches.length).toBe(3);
    for (const batch of batches) expect(JSON.stringify(batch).length).toBeLessThan(ORDER_FLOW_HIGH_WATER);
    expect(batches.map((message) => message.seq)).toEqual([1, 2, 3]);
    const total = batches.reduce((sum, message) => sum + (message.cells as Array<[number, number[]]>).reduce((cells, row) => cells + row[1].length / 4, 0), 0);
    expect(total).toBe(3_500);
  });

  it('odhlášení zastaví zprávy; neznámý zdroj a neplatný tvar odmítne', () => {
    const { feed } = make();
    const socket = new FakeSocket();
    expect(feed.handle(socket, { subscribe: true, source: 'ES' })).toContain('neznámý zdroj');
    expect(feed.handle(socket, { subscribe: true, source: '__proto__' })).toContain('neznámý zdroj');
    expect(feed.handle(socket, { subscribe: 'ano', source: 'NQ' })).toContain('neplatná');
    expect(feed.handle(socket, 'cokoli')).toContain('neplatná');
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots(); socket.take();
    feed.handle(socket, { subscribe: false });
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    feed.flushTrades(); feed.flushCells();
    expect(socket.sent).toEqual([]);
  });

  it('strop žádostí počítá i odmítnuté pokusy, odpoví jen jednou a odhlášení pustí vždy', () => {
    const { feed } = make();
    const socket = new FakeSocket();
    for (let i = 0; i < 5; i += 1) expect(feed.handle(socket, { subscribe: true, source: 'ES' })).toContain('neznámý zdroj');
    expect(feed.handle(socket, { subscribe: true, source: 'NQ' })).toBeNull();
    feed.pumpSnapshots(); socket.take();
    expect(feed.handle(socket, { subscribe: true, source: 'NQ' })).toContain('příliš mnoho');
    expect(feed.handle(socket, { subscribe: true, source: 'NQ' })).toBeNull();
    // nad stropem: odhlášení se i tak provede a zprávy přestanou
    expect(feed.handle(socket, { subscribe: false })).toBeNull();
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    feed.flushTrades(); feed.flushCells();
    expect(socket.sent).toEqual([]);
  });

  it('chyba odeslání jednoho klienta nevypne vrstvu ostatním', () => {
    const { feed } = make();
    const bad = new FakeSocket();
    const good = new FakeSocket();
    feed.handle(bad, { subscribe: true, source: 'NQ' });
    feed.handle(good, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots(); bad.take(); good.take();
    bad.failNext = true;
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    feed.flushTrades(); feed.flushCells();
    feed.onTick(trade('NQZ6', 2_000, 25000, 9, 'buy', 'B'));
    feed.flushTrades(); feed.flushCells();
    expect(bad.sent).toEqual([]);
    expect(good.sent.filter((message) => message.type === 'of-trade')).toHaveLength(2);
    expect(feed.metricsLine()).not.toContain('VYPNUTO');
  });

  it('capability popisuje zdroje a prahy', () => {
    const { feed } = make();
    expect(feed.capability()).toEqual({ sources: { NQ: 'NQZ6', MNQ: 'MNQZ6' }, tickSize: 0.25, floors: { NQ: 5, MNQ: 20 }, keepDays: 7 });
    expect(feed.symbols()).toEqual(['NQZ6', 'MNQZ6']);
  });
});

describe('order flow — disk', () => {
  it('dokončené minuty a velké obchody zapíše a po startu znovu načte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'of-'));
    dirs.push(dir);
    const first = make({ dir });
    first.feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    first.feed.onTick(trade('NQZ6', 61_000, 25001, 1, 'sell', 'B'));
    first.feed.flushTrades(); first.feed.flushCells();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const files = readdirSync(dir);
    expect(files).toEqual(['orderflow-test-NQZ6-2026-11-27.jsonl']);
    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([{ m: M0, v: 1, c: [100000, 9, 0, 0] }, { t: ['A', T0 + 1_000, 1, 9, 1, 100000, 100000, 100000] }]);

    const second = make({ dir, now: () => T0 + 120_000 });
    const socket = new FakeSocket();
    second.feed.handle(socket, { subscribe: true, source: 'NQ', days: 1 });
    second.feed.pumpSnapshots();
    const [snapshot] = socket.take();
    expect(snapshot.minutes).toEqual([[M0, [100000, 9, 0, 0]]]);
    expect((snapshot.trades as unknown[][]).map((row) => row[0])).toEqual(['A']);
    expect(snapshot.coverage).toEqual([[M0, M0 + 60]]);
  });

  it('když disk nejde (chybí složka), jednou to vypíše a běží dál', async () => {
    const logs: string[] = [];
    const { feed } = make({ dir: join(tmpdir(), 'of-neexistuje', String(Date.now())), logs });
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots(); socket.take();
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    feed.onTick(trade('NQZ6', 61_000, 25001, 1, 'sell', 'B'));
    feed.onTick(trade('NQZ6', 121_000, 25001, 1, 'sell', 'C'));
    feed.flushTrades(); feed.flushCells(); feed.flushCells();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logs.filter((line) => line.includes('zápis na disk nejde'))).toHaveLength(1);
    expect(feed.capability()).not.toBeNull();
    expect(socket.sent.some((message) => message.type === 'of')).toBe(true);
  });

  it('po rolování kontraktu smaže staré soubory i jiného kontraktu, cizí soubory nechá', () => {
    const dir = mkdtempSync(join(tmpdir(), 'of-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'orderflow-test-NQU6-2026-09-01.jsonl'), `{"m":1,"v":1,"c":[]}\n`);
    writeFileSync(join(dir, 'orderflow-jiny-NQZ6-2026-09-01.jsonl'), 'jiný systém\n');
    writeFileSync(join(dir, 'orders-test-2026-09-01.jsonl'), 'deník příkazů\n');
    make({ dir });
    expect(readdirSync(dir).sort()).toEqual(['orderflow-jiny-NQZ6-2026-09-01.jsonl', 'orders-test-2026-09-01.jsonl']);
  });

  it('poškozený řádek přeskočí a staré soubory smaže', () => {
    const dir = mkdtempSync(join(tmpdir(), 'of-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'orderflow-test-NQZ6-2026-11-27.jsonl'), `{"m":${M0},"v":1,"c":[100000,3,0,0]}\n{"m":${M0 + 60},"v":1,"c":[1000\n`);
    writeFileSync(join(dir, 'orderflow-test-NQZ6-2026-10-01.jsonl'), `{"m":1,"v":1,"c":[]}\n`);
    writeFileSync(join(dir, 'orderflow-test-NQZ6-poznamky.jsonl'), 'cizí soubor\n');
    const { feed } = make({ dir });
    const socket = new FakeSocket();
    feed.handle(socket, { subscribe: true, source: 'NQ', days: 1 });
    feed.pumpSnapshots();
    expect(socket.take()[0].minutes).toEqual([[M0, [100000, 3, 0, 0]]]);
    expect(readdirSync(dir).sort()).toEqual(['orderflow-test-NQZ6-2026-11-27.jsonl', 'orderflow-test-NQZ6-poznamky.jsonl']);
  });
});

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

function make(options: { now?: () => number; dir?: string } = {}): { feed: OrderFlowFeed; clock: { at: number } } {
  const clock = { at: T0 + 10_000 };
  const feed = createOrderFlowFeed({
    sources: { NQ: 'NQZ6', MNQ: 'MNQZ6' }, tickSize: 0.25, timers: false, log: () => undefined,
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
    feed.flushCells();
    feed.handle(socket, { subscribe: true, source: 'NQ', days: 1 });
    feed.pumpSnapshots();
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ part: 0, last: false, reset: true });
    feed.onTick(trade('NQZ6', 39 * 60_000 + 500, 25000, 7, 'sell', 'late'));
    feed.flushTrades(); feed.flushCells();
    expect(socket.sent).toHaveLength(1);
    feed.pumpSnapshots();
    expect(socket.sent[1]).toMatchObject({ part: 1, last: true });
    feed.flushTrades(); feed.flushCells();
    expect(socket.sent.slice(2).map((message) => message.type)).toEqual(['of-trade', 'of']);
    const total = socket.sent.slice(0, 2).reduce((sum, message) => sum + (message.minutes as Array<[number, number[]]>).reduce((cells, row) => cells + row[1].length / 4, 0), 0);
    expect(total).toBe(16_000);
  });

  it('odhlášení zastaví zprávy; neznámý zdroj a zahlcení žádostmi odmítne', () => {
    const { feed } = make();
    const socket = new FakeSocket();
    expect(feed.handle(socket, { subscribe: true, source: 'ES' })).toContain('neznámý zdroj');
    expect(feed.handle(socket, { subscribe: true, source: '__proto__' })).toContain('neznámý zdroj');
    feed.handle(socket, { subscribe: true, source: 'NQ' });
    feed.pumpSnapshots(); socket.take();
    feed.handle(socket, { subscribe: false });
    feed.onTick(trade('NQZ6', 1_000, 25000, 9, 'buy', 'A'));
    feed.flushTrades(); feed.flushCells();
    expect(socket.sent).toEqual([]);
    const other = new FakeSocket();
    for (let i = 0; i < 6; i += 1) expect(feed.handle(other, { subscribe: true, source: 'NQ' })).toBeNull();
    expect(feed.handle(other, { subscribe: true, source: 'NQ' })).toContain('příliš mnoho');
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

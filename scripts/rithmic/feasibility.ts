/**
 * Krok 1 — důkaz proveditelnosti proti Rithmic Test.
 *
 * Ověřuje věci, na kterých může celý plán spadnout:
 *   A  přihlášení, účet, kontrakt, tick, limity souběžných přihlášení
 *   B  základní cesta Limit → posun → zrušení (TS klient)
 *   C  životní cyklus bracketu (kdy a jak vznikají nohy SL/TP, jejich vazby)
 *   D  ztráta spojení po odeslání příkazu — jde příkaz dohledat?
 *   E  úplné dorovnání stavu po novém připojení
 *   F  druhé přihlášení stejným účtem
 *
 * JEN systém „Rithmic Test" (jiný skript odmítne). Heslo jen z Klíčenky
 * (služba alphatrade-rithmic-test) nebo z proměnných prostředí. Na konci
 * zruší všechny příkazy a zavře pozici, kterou sám otevřel.
 *
 * Spuštění: npx tsx scripts/rithmic/feasibility.ts [--symbol ES] [--only A,B,C]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  RithmicClient,
  RithmicRequestError,
  type RithmicAccountPnl,
  type RithmicBracketUpdate,
  type RithmicInstrumentPosition,
  type RithmicOrderUpdate,
  type RithmicTick,
} from '../../services/rithmic/rithmicClient';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';

const SYSTEM = 'Rithmic Test';
const URL = 'wss://rituz00100.rithmic.com:443';
const KEYCHAIN_SERVICE = 'alphatrade-rithmic-test';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SYMBOL = arg('symbol', 'ES');
const EXCHANGE = arg('exchange', 'CME');
const ONLY = new Set(arg('only', 'A,B,C,D,E,F').split(','));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function credentials(): { user: string; password: string } {
  if (process.env.RITHMIC_USER && process.env.RITHMIC_PASSWORD) {
    return { user: process.env.RITHMIC_USER, password: process.env.RITHMIC_PASSWORD };
  }
  try {
    const meta = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const user = /"acct"<blob>="([^"]*)"/.exec(meta)?.[1];
    const password = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
    if (user && password) return { user, password };
  } catch {
    // spadne do chyby níže
  }
  console.error(`Chybí přihlášení. Ulož ho do Klíčenky:\n  security add-generic-password -s ${KEYCHAIN_SERVICE} -a TVUJ_RITHMIC_LOGIN -w`);
  process.exit(2);
}

interface Session {
  client: RithmicClient;
  sockets: WebSocket[];
  orders: RithmicOrderUpdate[];
  brackets: RithmicBracketUpdate[];
  ticks: RithmicTick[];
  positions: RithmicInstrumentPosition[];
  pnl: RithmicAccountPnl[];
  closed: string[];
  unknown: number[];
  byPlant: Partial<Record<'order' | 'ticker' | 'pnl', WebSocket>>;
}

function session(creds: { user: string; password: string }, appName = 'AlphaTrade'): Session {
  const s: Session = { client: null as unknown as RithmicClient, sockets: [], orders: [], brackets: [], ticks: [], positions: [], pnl: [], closed: [], unknown: [], byPlant: {} };
  s.client = new RithmicClient({
    url: URL,
    credentials: { ...creds, systemName: SYSTEM, appName, appVersion: '0.1.0' },
    socketFactory: (url) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      s.sockets.push(ws);
      return ws as unknown as RithmicSocketLike;
    },
    requestTimeoutMs: 10_000,
    events: {
      onOrderUpdate: (u) => s.orders.push(u),
      onBracketUpdate: (u) => s.brackets.push(u),
      onTick: (t) => s.ticks.push(t),
      onInstrumentPosition: (p) => s.positions.push(p),
      onAccountPnl: (p) => s.pnl.push(p),
      onPlantClosed: (plant, info) => s.closed.push(`${plant}:${info.code ?? '?'}:${info.forcedLogout ? 'forced' : info.intentional ? 'intentional' : 'dropped'}`),
      onUnknownTemplate: (_p, id) => s.unknown.push(id),
    },
  });
  return s;
}

/** Připojí plant a zapamatuje si jeho socket (kvůli řízenému shození spojení). */
async function connectPlant(s: Session, plant: 'order' | 'ticker' | 'pnl'): Promise<void> {
  const index = s.sockets.length;
  await s.client.connect([plant]);
  s.byPlant[plant] = s.sockets[index];
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= end) return undefined;
    await sleep(5);
  }
}

const brief = (u: RithmicOrderUpdate) => ({
  src: u.source, type: u.notifyType, basket: u.basketId, orig: u.originalBasketId, linked: u.linkedBasketIds, tag: u.userTag,
  side: u.side, priceType: u.priceType, bracket: u.bracketType, status: u.status, reason: u.completionReason, qty: u.quantity,
  price: u.price, trigger: u.triggerPrice, fill: u.fillPrice, fillSize: u.fillSize, totalFill: u.totalFillSize, snap: u.isSnapshot, text: u.text,
});

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)] * 10) / 10;
}

const report: Record<string, unknown> = { startedAt: new Date().toISOString(), system: SYSTEM, symbol: SYMBOL };
const run = `${Date.now().toString(36)}`;
let tagSeq = 0;
const tag = (label: string) => `at-${run}-${label}-${++tagSeq}`;

async function main(): Promise<void> {
  const creds = credentials();
  const s = session(creds);
  const t0 = performance.now();
  for (const p of ['order', 'ticker', 'pnl'] as const) await connectPlant(s, p);
  const connectMs = Math.round(performance.now() - t0);
  const account = s.client.accounts[0]?.accountId;
  if (!account) throw new Error('Login nemá žádný účet');

  // ---- A: identita, kontrakt, cena ----------------------------------------
  let contract = await s.client.frontMonthContract(SYMBOL, EXCHANGE).catch(() => null);
  if (!contract) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const found = (await s.client.searchSymbols(SYMBOL, EXCHANGE))
      .filter((r) => r.productCode === SYMBOL && !/[ :-]/.test(r.symbol) && r.expirationDate >= today)
      .sort((a, b) => a.expirationDate.localeCompare(b.expirationDate));
    contract = found[0]?.symbol ?? null;
  }
  if (!contract) throw new Error(`Test nemá kontrakt ${SYMBOL}`);
  const ref = await s.client.referenceData(contract, EXCHANGE);
  const tick = ref?.tickSize ?? 0.25;
  await s.client.subscribeMarketData(contract, EXCHANGE);
  await s.client.subscribePnl(account);
  await s.client.requestPnlSnapshot(account);
  await sleep(4_000);
  const lastBid = [...s.ticks].reverse().find((t) => t.bidPrice !== null)?.bidPrice ?? null;
  const lastTrade = [...s.ticks].reverse().find((t) => t.tradePrice !== null)?.tradePrice ?? null;
  const refPrice = lastBid ?? lastTrade;
  if (refPrice === null) throw new Error('Z testu nepřišla žádná cena');
  const li = s.client.loginInfo ?? {};
  report.A = {
    connectMs, account, accounts: s.client.accounts.length, contract, tickSize: tick, pointValue: ref?.pointValue ?? null,
    refPrice, ticksIn4s: s.ticks.length,
    maxSessions: { tickerPlant: li.tp_max_session_count ?? null, orderPlant: li.op_max_session_count ?? null },
    userType: s.client.userType, orderCopyStatus: li.order_copy_status ?? null,
    pnlSnapshot: { positions: s.positions.length, account: s.pnl.at(-1) ?? null },
  };
  console.log('A', JSON.stringify(report.A));
  const far = Math.round(refPrice / tick - 200) * tick;
  const base = { accountId: account, symbol: contract, exchange: EXCHANGE, quantity: 1 } as const;
  const since = (from: number) => s.orders.slice(from);
  const stage = (from: number, basket: string, source: string, type: string) =>
    since(from).find((u) => u.basketId === basket && u.source === source && u.notifyType === type);

  // ---- B: Limit → posun → zrušení -----------------------------------------
  if (ONLY.has('B')) {
    const place: number[] = [];
    const modify: number[] = [];
    const cancel: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      let from = s.orders.length;
      let t = performance.now();
      const ack = await s.client.placeOrder({ ...base, userTag: tag('b'), side: 'BUY', priceType: 'LIMIT', price: far });
      if (await waitFor(() => stage(from, ack.basketId, 'exchange', 'STATUS'), 5_000)) place.push(performance.now() - t);
      from = s.orders.length;
      t = performance.now();
      await s.client.modifyOrder({ ...base, basketId: ack.basketId, priceType: 'LIMIT', price: far - tick });
      if (await waitFor(() => stage(from, ack.basketId, 'exchange', 'MODIFY'), 5_000)) modify.push(performance.now() - t);
      from = s.orders.length;
      t = performance.now();
      await s.client.cancelOrder(account, ack.basketId);
      if (await waitFor(() => stage(from, ack.basketId, 'exchange', 'CANCEL'), 5_000)) cancel.push(performance.now() - t);
      await sleep(250);
    }
    report.B = {
      rounds: 20,
      placeMs: { n: place.length, median: median(place), max: Math.round(Math.max(...place)) },
      modifyMs: { n: modify.length, median: median(modify), max: Math.round(Math.max(...modify)) },
      cancelMs: { n: cancel.length, median: median(cancel), max: Math.round(Math.max(...cancel)) },
    };
    console.log('B', JSON.stringify(report.B));
  }

  // ---- C: bracket ----------------------------------------------------------
  if (ONLY.has('C')) {
    const c: Record<string, unknown> = {};
    // C1: bracket Limit daleko od trhu — nesmí se vyplnit; co o nohách víme před fillem?
    let from = s.orders.length;
    const bFrom = s.brackets.length;
    const resting = await s.client.placeBracketOrder({ ...base, userTag: tag('c1'), side: 'BUY', priceType: 'LIMIT', price: far, stopTicks: 40, targetTicks: 80 });
    await waitFor(() => stage(from, resting.basketId, 'exchange', 'STATUS'), 5_000);
    await sleep(500);
    c.restingNotifications = since(from).map(brief);
    c.restingBracketUpdates = s.brackets.slice(bFrom);
    c.restingShowOrders = (await s.client.showOrders(account)).map(brief);
    c.restingShowBrackets = await s.client.showBrackets(account).catch((e) => `chyba: ${(e as Error).message}`);
    c.restingShowBracketStops = await s.client.showBracketStops(account).catch((e) => `chyba: ${(e as Error).message}`);
    // posun SL před vznikem nohy
    c.updateStopLevelBeforeFill = await s.client.updateStopBracketLevel(account, resting.basketId, 40, 60).then(() => 'ok').catch((e) => `chyba: ${(e as Error).message}`);
    c.stopsAfterUpdate = await s.client.showBracketStops(account).catch((e) => `chyba: ${(e as Error).message}`);
    from = s.orders.length;
    await s.client.cancelOrder(account, resting.basketId);
    await waitFor(() => stage(from, resting.basketId, 'exchange', 'CANCEL'), 5_000);
    await sleep(300);
    c.afterCancelNotifications = since(from).map(brief);
    c.afterCancelShowOrders = (await s.client.showOrders(account)).map(brief);

    // C2: bracket Market — vyplní se; kdy vzniknou nohy a jak jsou svázané?
    from = s.orders.length;
    const bFrom2 = s.brackets.length;
    const tSend = performance.now();
    const entry = await s.client.placeBracketOrder({ ...base, userTag: tag('c2'), side: 'BUY', priceType: 'MARKET', stopTicks: 40, targetTicks: 80 });
    const fill = await waitFor(() => stage(from, entry.basketId, 'exchange', 'FILL'), 8_000);
    const fillMs = fill ? Math.round(performance.now() - tSend) : null;
    const legs = () => since(from).filter((u) => u.source === 'exchange' && u.basketId !== entry.basketId && u.notifyType === 'STATUS');
    await waitFor(() => (legs().length >= 2 ? true : undefined), 5_000);
    const legsMs = legs().length >= 2 ? Math.round(performance.now() - tSend) : null;
    await sleep(500);
    c.marketFilled = !!fill;
    c.fillMs = fillMs;
    c.legsActiveMs = legsMs;
    c.fillPrice = fill?.fillPrice ?? null;
    c.marketNotifications = since(from).map(brief);
    c.marketBracketUpdates = s.brackets.slice(bFrom2);
    const open = await s.client.showOrders(account);
    c.marketShowOrders = open.map(brief);
    c.positionAfterFill = [...s.positions].reverse().find((p) => p.symbol === contract) ?? null;
    // posun SL nohy jako běžného příkazu
    const stopLeg = open.find((o) => o.priceType === 'STOP_MARKET' || o.priceType === 'STOP_LIMIT');
    if (stopLeg && stopLeg.triggerPrice !== null) {
      from = s.orders.length;
      c.modifyStopLeg = await s.client
        .modifyOrder({ ...base, basketId: stopLeg.basketId, priceType: 'STOP_MARKET', triggerPrice: stopLeg.triggerPrice - 4 * tick })
        .then(() => 'ok').catch((e) => `chyba: ${(e as Error).message}`);
      await waitFor(() => stage(from, stopLeg.basketId, 'exchange', 'MODIFY'), 5_000);
      c.modifyStopLegNotifications = since(from).map(brief);
    } else {
      c.modifyStopLeg = 'noha SL ve snímku není';
    }
    // zavření pozice: zruší server nohy sám?
    if (fill) {
      from = s.orders.length;
      c.exitPosition = await s.client.exitPosition(account, contract, EXCHANGE).then(() => 'ok').catch((e) => `chyba: ${(e as Error).message}`);
      await sleep(2_500);
      c.exitNotifications = since(from).map(brief);
      c.afterExitShowOrders = (await s.client.showOrders(account)).map(brief);
      c.positionAfterExit = [...s.positions].reverse().find((p) => p.symbol === contract) ?? null;
    }
    report.C = c;
    console.log('C', JSON.stringify({ marketFilled: c.marketFilled, fillMs, legsMs, legs: legs().length, afterExitOpen: (c.afterExitShowOrders as unknown[] | undefined)?.length }));
  }

  // ---- D: ztráta spojení po odeslání --------------------------------------
  if (ONLY.has('D')) {
    const d: unknown[] = [];
    for (const delayMs of [0, 20, 60, 100]) {
      if (!s.client.isConnected('order')) await connectPlant(s, 'order');
      const userTag = tag(`d${delayMs}`);
      const target = s.byPlant.order!;
      const promise = s.client.placeOrder({ ...base, userTag, side: 'BUY', priceType: 'LIMIT', price: far });
      promise.catch(() => undefined);
      if (delayMs > 0) await sleep(delayMs);
      target.terminate();
      let outcome = 'resolved';
      try {
        await promise;
      } catch (error) {
        outcome = error instanceof RithmicRequestError ? error.outcome : `other: ${(error as Error).message}`;
      }
      await sleep(1_500);
      const t = performance.now();
      await connectPlant(s, 'order');
      const openFound = (await s.client.showOrders(account)).filter((o) => o.userTag === userTag);
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const history = await s.client.showOrderHistorySummary(account, today).catch((e) => `chyba: ${(e as Error).message}`);
      const historyFound = Array.isArray(history) ? history.filter((o) => o.userTag === userTag) : history;
      d.push({
        dropAfterMs: delayMs, outcome, reconnectAndLookupMs: Math.round(performance.now() - t),
        foundInOpenOrders: openFound.length, foundInHistory: Array.isArray(historyFound) ? historyFound.length : historyFound,
        historyRows: Array.isArray(history) ? history.length : null,
      });
      for (const o of openFound) await s.client.cancelOrder(account, o.basketId).catch(() => undefined);
      await sleep(500);
    }
    report.D = d;
    console.log('D', JSON.stringify(d));
  }

  // ---- E: dorovnání po novém připojení ------------------------------------
  if (ONLY.has('E')) {
    for (const p of ['order', 'ticker', 'pnl'] as const) if (!s.client.isConnected(p)) await connectPlant(s, p);
    const keep = await s.client.placeOrder({ ...base, userTag: tag('e'), side: 'BUY', priceType: 'LIMIT', price: far });
    await sleep(500);
    const beforeOrders = (await s.client.showOrders(account)).map((o) => o.basketId).sort();
    for (const w of s.sockets) if (w.readyState === WebSocket.OPEN) w.terminate();
    await sleep(1_500);
    const posFrom = s.positions.length;
    const pnlFrom = s.pnl.length;
    const t = performance.now();
    for (const p of ['order', 'ticker', 'pnl'] as const) await connectPlant(s, p);
    const afterOrders = (await s.client.showOrders(account)).map((o) => o.basketId).sort();
    await s.client.subscribePnl(account);
    await s.client.requestPnlSnapshot(account);
    await s.client.subscribeMarketData(contract, EXCHANGE);
    const gotPnl = await waitFor(() => (s.pnl.length > pnlFrom ? true : undefined), 5_000);
    report.E = {
      resyncMs: Math.round(performance.now() - t), ordersBefore: beforeOrders, ordersAfter: afterOrders,
      ordersMatch: JSON.stringify(beforeOrders) === JSON.stringify(afterOrders),
      pnlSnapshotArrived: !!gotPnl, positionSnapshots: s.positions.length - posFrom,
    };
    await s.client.cancelOrder(account, keep.basketId).catch(() => undefined);
    console.log('E', JSON.stringify(report.E));
  }

  // ---- F: druhé přihlášení -------------------------------------------------
  if (ONLY.has('F')) {
    if (!s.client.isConnected('order')) await connectPlant(s, 'order');
    const closedBefore = s.closed.length;
    const second = session(creds);
    let secondResult = 'ok';
    try {
      await second.client.connect(['order']);
    } catch (error) {
      secondResult = `chyba: ${(error as Error).message}`;
    }
    await sleep(3_000);
    report.F = {
      secondLogin: secondResult, firstStillConnected: s.client.isConnected('order'),
      firstCloseEvents: s.closed.slice(closedBefore), secondConnected: second.client.isConnected('order'), secondCloseEvents: second.closed,
    };
    second.client.close();
    console.log('F', JSON.stringify(report.F));
  }

  // ---- úklid ---------------------------------------------------------------
  if (!s.client.isConnected('order')) await connectPlant(s, 'order').catch(() => undefined);
  const cleanup: Record<string, unknown> = {};
  if (s.client.isConnected('order')) {
    const left = await s.client.showOrders(account).catch(() => []);
    cleanup.openOrdersLeft = left.length;
    if (left.length) cleanup.cancelAll = await s.client.cancelAllOrders(account).then(() => 'ok').catch((e) => `chyba: ${(e as Error).message}`);
    const position = [...s.positions].reverse().find((p) => p.symbol === contract);
    cleanup.lastKnownNetQuantity = position?.netQuantity ?? null;
    if (position && position.netQuantity !== 0) {
      cleanup.exit = await s.client.exitPosition(account, contract, EXCHANGE).then(() => 'ok').catch((e) => `chyba: ${(e as Error).message}`);
    }
    await sleep(1_500);
    cleanup.openOrdersAfter = (await s.client.showOrders(account).catch(() => [])).length;
  } else {
    cleanup.error = 'order plant se nepodařilo znovu připojit — zkontroluj testovací účet';
  }
  report.cleanup = cleanup;
  report.unknownTemplates = [...new Set(s.unknown)];
  report.closeEvents = s.closed;
  s.client.close();

  const dir = join(dirname(fileURLToPath(import.meta.url)), 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `feasibility-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('cleanup', JSON.stringify(cleanup));
  console.log(`Uloženo: ${file}`);
}

if (SYSTEM !== 'Rithmic Test') throw new Error('Skript smí jen na Rithmic Test');
main().then(
  () => setTimeout(() => process.exit(0), 300),
  (error) => {
    console.error('SELHALO:', error instanceof Error ? error.message : error);
    report.error = String(error);
    setTimeout(() => process.exit(1), 300);
  },
);

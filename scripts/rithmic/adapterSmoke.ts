/**
 * Zkouška adaptéru (BrokerPort) proti SKUTEČNÉMU serveru Rithmic Test: vstup se serverovým
 * SL/TP → stav ochrany → zavření pozice přes `liquidatePosition` → ověření stavem.
 * Jen „Rithmic Test" (simulované prostředí). Heslo z Klíčenky, login z RITHMIC_USER.
 *
 * Spuštění: RITHMIC_USER=... npx tsx scripts/rithmic/adapterSmoke.ts [--contract ESZ6]
 */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import type { BrokerEvent } from '../../services/brokerPort';
import { RithmicAccountRegistry, type RithmicAccountRegistryEntry } from '../../services/rithmic/rithmicAccountRegistry';
import { createRithmicBroker, type RithmicIncident } from '../../services/rithmic/rithmicBroker';
import { memoryProtectionStore } from '../../services/rithmic/rithmicProtection';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';

const SYSTEM = 'Rithmic Test';
const URL = 'wss://rituz00100.rithmic.com:443';
const KEYCHAIN_SERVICE = 'alphatrade-rithmic-test';
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const CONTRACT = arg('contract', 'ESZ6');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function credentials(): { user: string; password: string } {
  const password = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
  const user = process.env.RITHMIC_USER;
  if (!user || !password) throw new Error('Chybí RITHMIC_USER nebo heslo v Klíčence');
  return { user, password };
}

async function main(): Promise<void> {
  if (SYSTEM !== 'Rithmic Test') throw new Error('Skript smí jen na Rithmic Test');
  let entries: RithmicAccountRegistryEntry[] = [];
  let revision = 0;
  const registry = new RithmicAccountRegistry({
    load: async () => ({ entries: entries.map((e) => ({ ...e })), revision }),
    save: async (next, expected) => {
      if (expected !== revision) throw new Error('revision conflict');
      entries = next.map((e) => ({ ...e }));
      revision += 1;
    },
  });
  await registry.load();
  const events: BrokerEvent[] = [];
  const incidents: RithmicIncident[] = [];
  const store = memoryProtectionStore();
  const broker = createRithmicBroker({
    url: URL,
    credentials: { ...credentials(), systemName: SYSTEM, appName: 'AlphaTrade', appVersion: '0.1.0' },
    socketFactory: (url) => new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike,
    registry,
    protectionStore: store,
    onIncident: (i) => incidents.push(i),
  });
  broker.subscribe((e) => events.push(e));
  const out: Record<string, unknown> = {};
  await broker.start();
  const account = broker.accountIds()[0];
  const state = async () => ({
    positions: (await broker.listPositions(account)).filter((p) => p.symbol === CONTRACT),
    working: (await broker.listOrders(account)).filter((o) => o.symbol === CONTRACT && !['filled', 'canceled', 'rejected'].includes(o.status)).map((o) => `${o.brokerOrderId}:${o.orderType}/${o.brokerOrderType ?? ''}:${o.status}`),
  });
  try {
    out.before = await state();
    const run = Date.now().toString(36);

    // 1) vstup Market se SL 40 / TP 80 ticků
    let t = performance.now();
    const ack = await broker.placeBracket({ tag: `sm-${run}-1`, accountId: account, symbol: CONTRACT, side: 'Buy', quantity: 1, orderType: 'Market', stopTicks: 40, targetTicks: 80 });
    out.placeMs = Math.round(performance.now() - t);
    let protectedMs: number | null = null;
    for (let i = 0; i < 100; i += 1) {
      if (broker.bracketState(account, ack.entryBrokerOrderId).state === 'protected') {
        protectedMs = Math.round(performance.now() - t);
        break;
      }
      await sleep(20);
    }
    out.protectedMs = protectedMs;
    out.bracketState = broker.bracketState(account, ack.entryBrokerOrderId);
    out.afterEntry = await state();

    // 1b) posun SL o 8 ticků dál a TP o 8 ticků dál
    const legsNow = (await broker.listOrders(account)).filter((o) => o.symbol === CONTRACT && o.brokerOrderId !== ack.entryBrokerOrderId && o.status === 'working');
    const sl = legsNow.find((o) => o.stopPrice !== undefined);
    const tp = legsNow.find((o) => o.stopPrice === undefined && o.limitPrice !== undefined);
    if (sl && tp) {
      t = performance.now();
      await broker.modifyOrder(account, sl.brokerOrderId, { quantity: 1, orderType: 'Stop', stopPrice: sl.stopPrice! - 2 });
      await broker.modifyOrder(account, tp.brokerOrderId, { quantity: 1, orderType: 'Limit', limitPrice: tp.limitPrice! + 2 });
      let movedMs: number | null = null;
      for (let i = 0; i < 100; i += 1) {
        const now = await broker.listOrders(account);
        if (now.find((o) => o.brokerOrderId === sl.brokerOrderId)?.stopPrice === sl.stopPrice! - 2 && now.find((o) => o.brokerOrderId === tp.brokerOrderId)?.limitPrice === tp.limitPrice! + 2) {
          movedMs = Math.round(performance.now() - t);
          break;
        }
        await sleep(30);
      }
      out.move = { from: [sl.stopPrice, tp.limitPrice], movedMs, stateAfter: broker.bracketState(account, ack.entryBrokerOrderId) };
    } else out.move = 'nohy nenalezeny';

    // 2) zrušení nohy při otevřené pozici se nesmí odeslat
    const leg = (await broker.listOrders(account)).find((o) => o.symbol === CONTRACT && o.brokerOrderId !== ack.entryBrokerOrderId && o.status === 'working');
    out.cancelLeg = leg ? await broker.cancelOrder(account, leg.brokerOrderId).then(() => 'ODESLÁNO (chyba!)', (e: Error) => `${e.name}: ${e.message.slice(0, 80)}`) : 'noha nenalezena';

    // 3) zavření
    t = performance.now();
    out.flatten = await broker.liquidatePosition({ tag: `sm-${run}-flat`, accountId: account, symbol: CONTRACT });
    out.flattenMs = Math.round(performance.now() - t);
    await sleep(2_500);
    out.afterFlatten = await state();
    out.bracketStateEnd = broker.bracketState(account, ack.entryBrokerOrderId);

    // 4) stejná značka podruhé a flat účet
    out.sameTagAgain = await broker.liquidatePosition({ tag: `sm-${run}-flat`, accountId: account, symbol: CONTRACT });
    out.flatAgain = await broker.liquidatePosition({ tag: `sm-${run}-flat2`, accountId: account, symbol: CONTRACT });

    // 5) čekající vstup (Limit daleko) → zavření ho jen zruší
    const price = events.flatMap((e) => (e.type === 'fill' ? [e.fill.price] : []))[0] ?? 7000;
    const far = Math.round((price - 50) * 4) / 4;
    const resting = await broker.placeBracket({ tag: `sm-${run}-2`, accountId: account, symbol: CONTRACT, side: 'Buy', quantity: 1, orderType: 'Limit', limitPrice: far, stopTicks: 40, targetTicks: 80 });
    await sleep(600);
    out.restingState = broker.bracketState(account, resting.entryBrokerOrderId);
    out.flattenResting = await broker.liquidatePosition({ tag: `sm-${run}-flat3`, accountId: account, symbol: CONTRACT });
    await sleep(1_000);
    out.end = await state();
  } finally {
    out.incidents = incidents.map((i) => `${i.kind}: ${i.message.slice(0, 140)}`);
    out.orderEventTypes = [...new Set(events.flatMap((e) => (e.type === 'order' ? [`${e.order.orderType}/${e.order.brokerOrderType ?? ''}`] : [])))];
    out.orderEvents = events.flatMap((e) => (e.type === 'order' ? [`${e.order.brokerOrderId} ${e.order.orderType}/${e.order.brokerOrderType ?? ''} ${e.order.status} tag=${e.order.tag ?? ''}`] : []));
    out.fills = events.flatMap((e) => (e.type === 'fill' ? [`${e.fill.side} ${e.fill.quantity} @ ${e.fill.price} (${e.fill.brokerOrderId})`] : []));
    out.record = store.saved();
    console.log(JSON.stringify(out, null, 2));
    broker.stop();
  }
}

main().then(() => setTimeout(() => process.exit(0), 300), (error) => {
  console.error('SELHALO:', error instanceof Error ? error.message : error);
  setTimeout(() => process.exit(1), 300);
});

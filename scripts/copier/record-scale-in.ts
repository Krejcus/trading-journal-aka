/**
 * Fáze 0 dokupování (`docs/reviews/scale-in-design-20261102.md` §4): nahraje, jak
 * Tradovate zachází s přikoupením do otevřené pozice druhým OSO. Jen DEMO,
 * jen MNQ, jen leader manual-only skupiny workeru bez followerů za DISARMED.
 *
 *   1. Market OSO 1 MNQ se SL/TP (základ),
 *   2. Market OSO 1 MNQ se stejným SL/TP (přikoupení) — dvě nezávislé OCO? TP s `parentId`?
 *   3. souběžný posun obou SL a obou TP o 1 b dál od trhu (jedna kontrola, N× modify),
 *   4. čekající přikoupení: Limit mezi trhem a SL se stejným (posunutým) SL/TP,
 *   5. liquidate — zruší Tradovate i čekající přikoupení a jeho pozastavené nohy?
 *   6. úklid: zrušit, co zbylo (vstupy dřív než nohy), ověřit flat bez příkazů.
 *
 *   npx tsx scripts/copier/record-scale-in.ts --account <leaderId> --symbol MNQZ6 --side Buy \
 *     --market-price 28075 --sl 27900 --tp 28500 --add-limit 28000 [--confirm]
 *
 * Exit 0 = záznam + leader ověřeně čistý; 4 = stav leadera neověřen; 1 = nespuštěno.
 * Po záznamu: `npm run copier:mac -- reconcile` (read-only) před ARM.
 *
 * R16 / R17 (`docs/reviews/trading-gaps-designs/safety.md` C16/C17 bod 6) jdou přes
 * společný interpret `recordDemoSession.ts` (jen DEMO8661118, MNQ front, DISARMED gate
 * před scénářem i každým zadáním, expozice ≤ 2, flat na začátku, úklid a ověřený flat):
 *
 *   npx tsx scripts/copier/record-scale-in.ts --scenario foreign-close --account 61038658 \
 *     --symbol MNQZ6 --side Buy --market-price 28075 [--confirm --allow-fill]
 *   npx tsx scripts/copier/record-scale-in.ts --scenario pending-modify --account 61038658 \
 *     --symbol MNQZ6 --side Buy --market-price 28075 [--add-points 45 --sl-points 85 --tp-points 80] [--confirm --allow-fill]
 *
 * Exit pro R16/R17: 0 hotovo a čisto; 2 přerušeno, čisto; 4 neověřeno; 1 nespuštěno.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTradovateBroker, type WebSocketLike } from '../../services/tradovateBroker';
import type { BrokerEvent, BrokerOsoAck } from '../../services/brokerPort';
import { loadMacCopierConnectionManifest } from '../../server/macCopierConnectionManifest';
import { createMacCopierDeviceTokenProvider, loadMacCopierDevice } from '../../server/macCopierDevice';
import { leakedIdentifiers, sanitizeRecordedFrame } from './recordLeaderOsoPlan';
import {
  decideScaleInCleanup,
  isScaleInDemoScenario,
  SCALE_IN_FIVE_ADDS,
  parseRecordScaleInArgs,
  parseScaleInDemoArgs,
  recordScaleInProblems,
  scaleInLoosened,
  type ScaleInCleanupDecision,
} from './recordScaleInPlan';
import { runDemoRecording } from './recordDemoSession';

// R16 `foreign-close` / R17 `pending-modify`: společný interpret, původní tok níže se nespustí.
if (isScaleInDemoScenario(process.argv.slice(2))) {
  let demoPlan: ReturnType<typeof parseScaleInDemoArgs>;
  try {
    demoPlan = parseScaleInDemoArgs(process.argv.slice(2));
  } catch (reason) {
    console.error(`NESPUŠTĚNO: ${reason instanceof Error ? reason.message : String(reason)}`);
    process.exit(1);
  }
  process.exit(await runDemoRecording(demoPlan, { script: 'record-scale-in', filePrefix: 'leader-scale-in', tagPrefix: 'rsd' }));
}

const COPIER_DIR = join(homedir(), 'Library/Application Support/AlphaTrade/copier');
const STATUS_URL = 'http://127.0.0.1:3211/v1/status';
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const readStatus = async () => {
  const response = await fetch(STATUS_URL, { headers: { Origin: 'http://localhost:3000' }, signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`status workeru ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
};
const refuse = (problems: string[]) => {
  console.error(`NESPUŠTĚNO:\n- ${problems.join('\n- ')}`);
  process.exit(1);
};

const plan = parseRecordScaleInArgs(process.argv.slice(2));
const loosened = scaleInLoosened(plan);
console.log(`Plán: ${plan.side} 1 ${plan.symbol} MKT ~${plan.marketPrice} + přikoupení 1 MKT, SL ${plan.stopLoss}, TP ${plan.takeProfit}; `
  + `posun na SL ${loosened.stopLoss} / TP ${loosened.takeProfit}; čekající přikoupení LMT ${plan.addLimit}; pak liquidate. `
  + `Max. ztráta při SL ≈ ${(Math.abs(plan.marketPrice - plan.stopLoss) * 2 * (plan.scenario === 'five' ? 5 : 2)).toFixed(0)} USD (DEMO, scénář ${plan.scenario})`);
const initialStatus = await readStatus();
const initialProblems = recordScaleInProblems(plan, initialStatus, Date.now());
if (initialProblems.length) refuse(initialProblems);
if (!plan.confirm) {
  console.log('Pojistky prošly. Nic se neposlalo — pro skutečné zadání přidej --confirm.');
  process.exit(0);
}

const discovery = (initialStatus.connectionDiscovery ?? {}) as { connectionAccounts?: Array<{ connectionId: string; accountIds: number[] }> };
const connectionId = discovery.connectionAccounts?.find(entry => entry.accountIds.includes(plan.accountId))?.connectionId;
if (!connectionId) refuse(['worker nezná připojení leadera']);
const manifest = await loadMacCopierConnectionManifest(join(COPIER_DIR, 'connections.json'));
const deviceEntry = manifest.connections.find(entry => entry.connectionId === connectionId)
  ?? manifest.connections.find(entry => entry.connectionId === manifest.primaryConnectionId)!;
const provider = createMacCopierDeviceTokenProvider({ config: await loadMacCopierDevice(deviceEntry.deviceConfigPath), connectionId });
const lease = await provider.refresh();

const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;
const frames: Array<{ t: number; data: string }> = [];
const events: Array<{ t: number; event: BrokerEvent }> = [];
const steps: Array<{ t: number; step: string; detail?: unknown }> = [];
const step = (name: string, detail?: unknown) => {
  steps.push({ t: elapsed(), step: name, ...(detail === undefined ? {} : { detail }) });
  console.log(`${elapsed()} ms  ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)).replace(/conn:[0-9a-f-]+/gi, 'conn:x');

// Jen příchozí rámce, jen v paměti; odchozí (authorize s tokenem) se nenahrávají.
const recordingSocket = (url: string): WebSocketLike => {
  const socket = new WebSocket(url) as unknown as WebSocketLike;
  let handler: WebSocketLike['onmessage'] = null;
  socket.onmessage = event => {
    frames.push({ t: elapsed(), data: String(event.data) });
    handler?.(event);
  };
  return new Proxy(socket, {
    get(target, property) {
      if (property === 'onmessage') return handler;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === 'onmessage') { handler = value; return true; }
      return Reflect.set(target, property, value, target);
    },
  });
};

const broker = createTradovateBroker({
  environment: 'demo',
  accountSpec: lease.accountSpec,
  getAccessToken: provider.getAccessToken,
  webSocketFactory: recordingSocket,
});
let synced = false;
const unsubscribe = broker.subscribe(event => {
  events.push({ t: elapsed(), event });
  if (event.type === 'connection' && event.connected) synced = true;
});
const abort = (problems: string[]) => { unsubscribe(); refuse(problems); };
for (let waited = 0; !synced && waited < 20_000; waited += 250) await sleep(250);
if (!synced) abort(['WS se nesynchronizoval do 20 s — nic se neposlalo']);

const directory = await broker.refreshAccountDirectory();
const leader = directory.find(account => account.accountId === plan.accountId);
if (!leader?.canTrade || !leader.accountSpec) abort(['leader není v adresáři připojení obchodovatelný']);
const identifiers: Array<string | number> = [
  ...directory.flatMap(account => [account.accountId, account.accountSpec ?? '']),
  lease.accountSpec ?? '', connectionId!,
];
const accountMap = new Map(directory.map((account, index) => [account.accountId, account.accountId === plan.accountId ? 1001 : 2001 + index]));

const before = await broker.listOrders(plan.accountId, { fresh: true });
const positions = await broker.listPositions(plan.accountId);
if (before.some(order => order.status === 'working' || order.status === 'pending') || positions.some(position => position.netQuantity !== 0)) {
  abort(['leader má otevřenou pozici nebo working order — nic se neposlalo']);
}
const beforeIds = new Set(before.map(order => order.brokerOrderId));
const finalProblems = recordScaleInProblems(plan, await readStatus(), Date.now());
if (finalProblems.length) abort(finalProblems);

const observe = async () => {
  const [orders, netPosition] = await Promise.all([
    broker.listOrders(plan.accountId, { fresh: true })
      .then(items => items.filter(order => !beforeIds.has(order.brokerOrderId)).map(order => ({
        id: order.brokerOrderId, status: order.status, side: order.side, type: order.orderType,
        quantity: order.quantity, filledQuantity: order.filledQuantity,
        ...(order.limitPrice != null ? { limitPrice: order.limitPrice } : {}),
        ...(order.stopPrice != null ? { stopPrice: order.stopPrice } : {}),
        ...(order.parentOrderId ? { parentOrderId: order.parentOrderId } : {}),
        ...(order.ocoId ? { ocoId: order.ocoId } : {}),
        ...(order.linkedOrderId ? { linkedOrderId: order.linkedOrderId } : {}),
      })))
      .catch(reason => { step('čtení příkazů selhalo', message(reason)); return null; }),
    broker.listPositions(plan.accountId)
      .then(items => items.reduce((sum, position) => sum + Math.abs(position.netQuantity), 0))
      .catch(reason => { step('čtení pozice selhalo', message(reason)); return null; }),
  ]);
  return { orders, netPosition };
};
const waitNet = async (target: number, label: string) => {
  for (let waited = 0; waited < 10_000; waited += 500) {
    const net = await broker.listPositions(plan.accountId)
      .then(items => items.reduce((sum, position) => sum + Math.abs(position.netQuantity), 0)).catch(() => null);
    if (net === target) { step(label, { net }); return true; }
    await sleep(500);
  }
  step(`${label}: pozice nedosáhla ${target} do 10 s`);
  return false;
};

const tag = () => `rsi${randomUUID().replace(/-/g, '').slice(0, 18)}`;
const exitSide = plan.side === 'Buy' ? 'Sell' : 'Buy';
const ownOrderIds = new Set<number>();
const entryIds = new Set<string>();
const acks: BrokerOsoAck[] = [];
let inFlight: Promise<unknown> | null = null;
const place = async (label: string, entry: { orderType: 'Market' } | { orderType: 'Limit'; limitPrice: number }, stopLoss: number, takeProfit: number, quantity = 1) => {
  step(label);
  const request = broker.placeOso!({
    tag: tag(), accountId: plan.accountId, symbol: plan.symbol, side: plan.side, quantity, ...entry,
    first: { side: exitSide, orderType: 'Stop', stopPrice: stopLoss },
    second: { side: exitSide, orderType: 'Limit', limitPrice: takeProfit },
  });
  inFlight = request;
  const ack = await request;
  inFlight = null;
  step(`${label} ack`, ack);
  acks.push(ack);
  if (Number(ack.entryBrokerOrderId) > 0) entryIds.add(ack.entryBrokerOrderId);
  for (const id of [ack.entryBrokerOrderId, ack.firstBrokerOrderId, ack.secondBrokerOrderId]) if (Number(id) > 0) ownOrderIds.add(Number(id));
  return ack;
};

let cleanup: Promise<ScaleInCleanupDecision> | null = null;
const runCleanup = () => cleanup ??= (async (): Promise<ScaleInCleanupDecision> => {
  if (inFlight) {
    step('čekám na dokončení zadání');
    await Promise.race([inFlight.catch(() => undefined), sleep(50_000)]);
  }
  let liquidations = 0;
  let lastNet: number | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const observation = await observe();
    for (const order of observation.orders ?? []) ownOrderIds.add(Number(order.id));
    step('stav leadera (úklid)', observation);
    const decision = decideScaleInCleanup(observation, entryIds);
    if (decision.kind === 'clean') return decision;
    // Liquidate jen po novém pozorování pozice (např. čekající přikoupení se vyplnilo) — nejvýš 2×.
    if (decision.kind === 'liquidate' && liquidations < 2 && observation.netPosition !== lastNet) {
      liquidations += 1;
      lastNet = observation.netPosition;
      step('liquidate (úklid)');
      await broker.liquidatePosition!({ tag: `${tag()}x`, accountId: plan.accountId, symbol: plan.symbol })
        .then(result => step('liquidate výsledek', result))
        .catch(reason => step('liquidate selhal', message(reason)));
    } else if (decision.kind === 'cancel') {
      for (const id of decision.ids) {
        step('cancel', id);
        await broker.cancelOrder(plan.accountId, id).catch(reason => step('cancel selhal', message(reason)));
      }
    }
    await sleep(1_500);
  }
  return { kind: 'unverified', reason: 'leader po úklidu není ověřeně flat bez příkazů' };
})();

const finish = async (decision: ScaleInCleanupDecision) => {
  unsubscribe();
  await writeRecording(decision).catch(reason => console.error(`Záznam neuložen: ${message(reason)}`));
  if (decision.kind === 'clean') {
    console.log('Leader ověřeně čistý. Teď: npm run copier:mac -- reconcile (read-only).');
    process.exit(0);
  }
  console.error(`POZOR: ${'reason' in decision ? decision.reason : decision.kind}. Zkontroluj leadera v Tradovate.`);
  process.exit(4);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => { step(`signál ${signal} — uklízím`); void runCleanup().then(finish); });
}

const runFive = async () => {
  const tickets: BrokerOsoAck[] = [];
  const base = await place('OSO základ (Market 1)', { orderType: 'Market' }, plan.stopLoss, plan.takeProfit);
  if (!base.accepted) throw new Error('základ nepřijat');
  if (!(await waitNet(1, 'základ vyplněn'))) throw new Error('základ se nevyplnil');
  tickets.push(base);
  let net = 1;
  for (const quantity of SCALE_IN_FIVE_ADDS) {
    const add = await place(`OSO přikoupení (Market ${quantity})`, { orderType: 'Market' }, plan.stopLoss, plan.takeProfit, quantity);
    if (!add.accepted) throw new Error('přikoupení nepřijato');
    net += quantity;
    if (!(await waitNet(net, `přikoupení vyplněno (pozice ${net})`))) throw new Error('přikoupení se nevyplnilo');
    tickets.push(add);
  }
  await sleep(1_000);
  const shape = await observe();
  step('tvar pozice 5', shape);
  const quantityOf = (id: string) => shape.orders?.find(order => order.id === id)?.quantity ?? 1;
  for (const [label, ids, change] of [
    ['SL', tickets.map(ticket => ticket.firstBrokerOrderId), (id: string) => ({ quantity: quantityOf(id), orderType: 'Stop' as const, stopPrice: loosened.stopLoss })],
    ['TP', tickets.map(ticket => ticket.secondBrokerOrderId), (id: string) => ({ quantity: quantityOf(id), orderType: 'Limit' as const, limitPrice: loosened.takeProfit })],
  ] as const) {
    const sentAt = elapsed();
    step(`modify ${label} souběžně (${ids.length} nohou)`, { ids });
    const results = await Promise.allSettled(ids.map(id => broker.modifyOrder(plan.accountId, id, change(id))
      .then(result => ({ id, ms: elapsed() - sentAt, confirmedBy: result ? result.confirmedBy ?? null : null }))));
    step(`modify ${label} výsledky`, results.map(item => item.status === 'fulfilled' ? item.value : { error: message(item.reason) }));
  }
  await sleep(1_000);
  step('tvar po posunu', await observe());
  step('liquidate (test)');
  step('liquidate výsledek', await broker.liquidatePosition!({ tag: `${tag()}x`, accountId: plan.accountId, symbol: plan.symbol }));
  await waitNet(0, 'pozice zavřena');
  await sleep(1_000);
  step('tvar po liquidate', await observe());
};

try {
  if (plan.scenario === 'five') {
    await runFive();
    throw new Error('__done__');
  }
  const base = await place('OSO základ (Market)', { orderType: 'Market' }, plan.stopLoss, plan.takeProfit);
  if (!base.accepted) throw new Error('základ nepřijat');
  if (!(await waitNet(1, 'základ vyplněn'))) throw new Error('základ se nevyplnil');
  step('tvar po základu', await observe());

  const add = await place('OSO přikoupení (Market)', { orderType: 'Market' }, plan.stopLoss, plan.takeProfit);
  if (!add.accepted) throw new Error('přikoupení nepřijato');
  if (!(await waitNet(2, 'přikoupení vyplněno'))) throw new Error('přikoupení se nevyplnilo');
  await sleep(1_000);
  step('tvar po přikoupení', await observe());

  // Souběžný posun: všechny SL najednou, pak všechny TP najednou (žádné kontroly mezi nohama).
  for (const [label, ids, change] of [
    ['SL', [base.firstBrokerOrderId, add.firstBrokerOrderId], { quantity: 1, orderType: 'Stop' as const, stopPrice: loosened.stopLoss }],
    ['TP', [base.secondBrokerOrderId, add.secondBrokerOrderId], { quantity: 1, orderType: 'Limit' as const, limitPrice: loosened.takeProfit }],
  ] as const) {
    const sentAt = elapsed();
    step(`modify ${label} souběžně`, { ids, change });
    const results = await Promise.allSettled(ids.map(id => broker.modifyOrder(plan.accountId, id, change)
      .then(result => ({ id, ms: elapsed() - sentAt, confirmedBy: result ? result.confirmedBy ?? null : null }))));
    step(`modify ${label} výsledky`, results.map(item => item.status === 'fulfilled' ? item.value : { error: message(item.reason) }));
  }
  await sleep(1_000);
  step('tvar po posunu', await observe());

  const pending = await place('OSO čekající přikoupení (Limit)', { orderType: 'Limit', limitPrice: plan.addLimit }, loosened.stopLoss, loosened.takeProfit);
  if (!pending.accepted) step('čekající přikoupení nepřijato');
  await sleep(1_500);
  step('tvar s čekajícím přikoupením', await observe());

  step('liquidate (test)');
  const liquidation = await broker.liquidatePosition!({ tag: `${tag()}x`, accountId: plan.accountId, symbol: plan.symbol });
  step('liquidate výsledek', liquidation);
  await waitNet(0, 'pozice zavřena');
  for (const delay of [500, 2_000, 4_000]) {
    await sleep(delay);
    step(`tvar po liquidate (+${delay} ms)`, await observe());
  }
} catch (reason) {
  inFlight = null;
  if (message(reason) !== '__done__') step('výjimka', message(reason));
}
await finish(await runCleanup());

async function writeRecording(decision: ScaleInCleanupDecision) {
  const placedAt = steps.find(item => item.step.startsWith('OSO základ'))?.t ?? Infinity;
  const context = { orderIds: ownOrderIds, commandIds: new Set<number>(), accountMap };
  const sanitizedFrames = frames
    .filter(frame => frame.t >= placedAt)
    .flatMap(frame => sanitizeRecordedFrame(frame.data, context).map(item => ({ t: frame.t, ...item })));
  const sanitizedEvents = events
    .filter(item => (item.event.type === 'order' && ownOrderIds.has(Number(item.event.order.brokerOrderId)))
      || (item.event.type === 'fill' && ownOrderIds.has(Number(item.event.fill.brokerOrderId))))
    .map(item => ({ t: item.t, event: JSON.parse(JSON.stringify(item.event, (key, value) =>
      key === 'tag' ? undefined : key === 'accountId' ? (accountMap.get(Number(value)) ?? 0) : value)) }));
  const recording = {
    version: 3,
    recordedAt: new Date(startedAt).toISOString(),
    scenario: plan.scenario === 'five' ? 'scale-in-five' : 'scale-in',
    symbol: plan.symbol, side: plan.side,
    prices: { market: plan.marketPrice, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, loosened, addLimit: plan.addLimit },
    acks, outcome: decision,
    steps, events: sanitizedEvents, frames: sanitizedFrames,
  };
  const serialized = `${JSON.stringify(recording, null, 2)}\n`;
  const leaks = leakedIdentifiers(serialized, identifiers);
  if (leaks.length) throw new Error(`záznam obsahuje ${leaks.length} identifikátor(ů) účtu — neuloženo`);
  const directoryPath = join(COPIER_DIR, 'recordings');
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const path = join(directoryPath, `leader-scale-in-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(path, serialized, { mode: 0o600 });
  console.log(`Záznam (mimo repo, ke kontrole): ${path} — ${sanitizedFrames.length} entit z WS, ${sanitizedEvents.length} eventů`);
}

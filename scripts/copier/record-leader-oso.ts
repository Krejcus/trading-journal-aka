/**
 * Fáze 0 obchodování z grafu: nahraje, jak Tradovate hlásí OSO zadané přes
 * API na leaderovi (`docs/CHART_ORDER_ENTRY_PLAN.md`). Spouští JEN Filip.
 *
 * Zadá 1 MNQ Limit daleko od trhu se SL a TP (žádná noha nejde hned
 * vyplnit), nahraje WS, po `--hold-ms` vstup zruší a uklidí — ale jen když
 * se nic nevyplnilo (jinak ochranu nechá a skončí chybou). Uloží
 * anonymizovaný záznam MIMO repo. Pojistky se kontrolují před připojením
 * i těsně před zadáním. Bez `--confirm` jen vypíše plán.
 *
 *   npx tsx scripts/copier/record-leader-oso.ts --account <leaderId> --symbol MNQZ6 \
 *     --side Buy --market-price 30000 --entry 29500 --sl 29450 --tp 30500 [--confirm]
 *
 * Během běhu: na nic nesahat (ARM, Tradovate), NEpřerušovat Ctrl+C.
 * Exit 0 = záznam + leader ověřeně čistý; 3 = něco se vyplnilo (ochrana
 * ponechána); 4 = stav leadera neověřen; 1 = nespuštěno.
 * Po záznamu: `npm run copier:mac -- reconcile` (read-only) před ARM.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTradovateBroker, type WebSocketLike } from '../../services/tradovateBroker';
import type { BrokerEvent } from '../../services/brokerPort';
import { loadMacCopierConnectionManifest } from '../../server/macCopierConnectionManifest';
import { createMacCopierDeviceTokenProvider, loadMacCopierDevice } from '../../server/macCopierDevice';
import {
  decideRecordCleanup,
  leakedIdentifiers,
  parseRecordLeaderOsoArgs,
  recordLeaderOsoProblems,
  sanitizeRecordedFrame,
  type CleanupDecision,
  type CleanupObservation,
  type RecordPlacement,
} from './recordLeaderOsoPlan';

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

const plan = parseRecordLeaderOsoArgs(process.argv.slice(2));
console.log(`Plán: ${plan.side} 1 ${plan.symbol} LMT ${plan.entry}, SL ${plan.stopLoss}, TP ${plan.takeProfit}; trh ${plan.marketPrice}; zrušit po ${plan.holdMs} ms`);
const initialStatus = await readStatus();
const initialProblems = recordLeaderOsoProblems(plan, initialStatus, Date.now());
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

// Přesné Account.name leadera (ne e-mail z lease) a seznam identifikátorů k anonymizaci.
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

// Těsně před zadáním znovu: ARM / auto-resume mohly přijít během připojování.
const finalProblems = recordLeaderOsoProblems(plan, await readStatus(), Date.now());
if (finalProblems.length) abort(finalProblems);

const observe = async (): Promise<CleanupObservation> => {
  const [orders, netPosition] = await Promise.all([
    broker.listOrders(plan.accountId, { fresh: true })
      .then(items => items.filter(order => !beforeIds.has(order.brokerOrderId)).map(order => ({
        id: order.brokerOrderId, status: order.status, filledQuantity: order.filledQuantity, side: order.side,
        ...(order.parentOrderId ? { parentOrderId: order.parentOrderId } : {}),
      })))
      .catch(reason => { step('čtení příkazů selhalo', message(reason)); return null; }),
    broker.listPositions(plan.accountId)
      .then(items => items.reduce((sum, position) => sum + Math.abs(position.netQuantity), 0))
      .catch(reason => { step('čtení pozice selhalo', message(reason)); return null; }),
  ]);
  return { orders, netPosition };
};

let placement: RecordPlacement = { kind: 'not-sent' };
let placeInFlight: Promise<unknown> | null = null;
let cleanup: Promise<CleanupDecision> | null = null;
const runCleanup = () => cleanup ??= (async () => {
  // Signál během REST zadání: nejdřív počkat na jeho výsledek (Tradovate odpovídal i > 15 s).
  if (placeInFlight) {
    step('čekám na dokončení zadání');
    await Promise.race([placeInFlight.catch(() => undefined), sleep(50_000)]);
  }
  // Nejistý výsledek: příkaz se u Tradovate může objevit později.
  if (placement.kind === 'uncertain') await sleep(10_000);
  let decision: CleanupDecision = { kind: 'unverified', reason: 'úklid nedoběhl' };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const observation = await observe();
    step('stav leadera', observation);
    decision = decideRecordCleanup(observation, placement);
    // „Neověřeno“ může být jen zpoždění čtení — zkusit znovu; nejisté zadání „čisto“ nikdy nedá.
    if (decision.kind === 'filled' || decision.kind === 'clean') return decision;
    if (decision.kind === 'cancel') {
      for (const id of decision.ids) {
        step('cancel', id);
        await broker.cancelOrder(plan.accountId, id).catch(reason => step('cancel selhal', message(reason)));
      }
    }
    await sleep(1_500);
  }
  return decision.kind === 'cancel' ? { kind: 'unverified', reason: 'příkazy se nepodařilo zrušit' } : decision;
})();

const finish = async (decision: CleanupDecision) => {
  unsubscribe();
  await writeRecording(decision).catch(reason => console.error(`Záznam neuložen: ${message(reason)}`));
  if (decision.kind === 'clean') {
    console.log('Leader ověřeně čistý. Teď: npm run copier:mac -- reconcile (read-only) — leaderův příkaz zneplatnil kontrolu pozic.');
    process.exit(0);
  }
  console.error(`POZOR: ${decision.reason}. Zkontroluj leadera v Tradovate${decision.kind === 'filled' ? ' (SL/TP ponechány)' : ' a ruč zruš/zavři, co tam zůstalo'}.`);
  process.exit(decision.kind === 'filled' ? 3 : 4);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => { step(`signál ${signal} — uklízím`); void runCleanup().then(finish); });
}

const tag = `rec${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const exitSide = plan.side === 'Buy' ? 'Sell' : 'Buy';
const ownOrderIds = new Set<number>();
try {
  step('placeOso');
  placement = { kind: 'uncertain', entrySide: plan.side };
  const request = broker.placeOso!({
    tag, accountId: plan.accountId, symbol: plan.symbol, side: plan.side, quantity: 1,
    orderType: 'Limit', limitPrice: plan.entry,
    first: { side: exitSide, orderType: 'Stop', stopPrice: plan.stopLoss },
    second: { side: exitSide, orderType: 'Limit', limitPrice: plan.takeProfit },
  });
  placeInFlight = request;
  const ack = await request;
  placeInFlight = null;
  step('placeOso ack', ack);
  for (const id of [ack.entryBrokerOrderId, ack.firstBrokerOrderId, ack.secondBrokerOrderId]) if (Number(id) > 0) ownOrderIds.add(Number(id));
  // „Čisto“ půjde jen s id všech tří příkazů; jinak zůstává nejisté.
  if ([ack.entryBrokerOrderId, ack.firstBrokerOrderId, ack.secondBrokerOrderId].every(id => Number(id) > 0)) {
    placement = { kind: 'acknowledged', entryId: ack.entryBrokerOrderId, legIds: [ack.firstBrokerOrderId, ack.secondBrokerOrderId] };
  } else if (!ack.accepted && ack.definitive && !(Number(ack.entryBrokerOrderId) > 0)) {
    placement = { kind: 'not-sent' };
  }
  const shape = await observe();
  step('tvar po ack', shape);
  for (const order of shape.orders ?? []) ownOrderIds.add(Number(order.id));
  await sleep(plan.holdMs);
} catch (reason) {
  placeInFlight = null;
  step('placeOso výjimka', message(reason));
}
await finish(await runCleanup());

async function writeRecording(decision: CleanupDecision) {
  const placedAt = steps.find(item => item.step === 'placeOso')?.t ?? Infinity;
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
    version: 2,
    recordedAt: new Date(startedAt).toISOString(),
    symbol: plan.symbol, side: plan.side,
    prices: { entry: plan.entry, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, market: plan.marketPrice },
    outcome: decision,
    steps, events: sanitizedEvents, frames: sanitizedFrames,
  };
  const serialized = `${JSON.stringify(recording, null, 2)}\n`;
  const leaks = leakedIdentifiers(serialized, identifiers);
  if (leaks.length) throw new Error(`záznam obsahuje ${leaks.length} identifikátor(ů) účtu — neuloženo`);
  const directoryPath = join(COPIER_DIR, 'recordings');
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const path = join(directoryPath, `leader-oso-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(path, serialized, { mode: 0o600 });
  console.log(`Záznam (mimo repo, ke kontrole): ${path} — ${sanitizedFrames.length} entit z WS, ${sanitizedEvents.length} eventů`);
}

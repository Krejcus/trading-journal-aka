/**
 * REC-TYPES + R12 (`docs/reviews/trading-gaps-designs/types.md` §1.2 S1–S9, `safety.md` C12 bod 6):
 * nahraje, jak Tradovate zachází se StopLimit a MIT vstupem, TrailingStop nohou, TIF
 * (bez/Day/GTC/GTD, výchozí TIF nohou), SL nohou přes trh a TIF Day v denní pauze CME.
 * Spouští JEN Filip. Jen DEMO8661118 (61038658), jen front MNQ, qty ≤ 2, jen za DISARMED
 * manual-only local-only skupiny workeru bez followerů. Čistá logika: `recordTypesPlan.ts`.
 *
 *   npx tsx scripts/copier/record-types.ts --account 61038658 --symbol MNQZ6 --market-price 25000 --scenario all [--confirm]
 *   --scenario stoplimit-cancel,leg-through-buy      (výběr; pořadí je vždy pevné)
 *   --scenario tif-pause                             (jen Po–Čt 16:00–16:50 CT, samostatně)
 *   volitelně --qty 1|2, --trail-peg offset|flip, --mit-trigger price|stopPrice
 *
 * S4–S6 (TrailingStop, MIT) jen když lokální worker hlásí `controller.unsupportedOrders`
 * (oprava C1): starý worker by na takovém příkazu ztratil stream až do konce session.
 * Bez `--confirm` jen vypíše plán a zkontroluje pojistky (čte jen lokální status workeru).
 * Před každým scénářem: worker DISARMED (jako armed-gate.sh), účet flat bez příkazů; po každém
 * úklid (zrušit / liquidate) a ověření flat bez příkazů — jinak se další scénář nespustí.
 * Během běhu na nic nesahat (ARM, Tradovate); Ctrl+C = úklid aktuálního scénáře a konec.
 * Exit 0 = vše nahráno + účet ověřeně čistý; 1 = nespuštěno; 4 = stav účtu NEOVĚŘEN (zkontroluj
 * Tradovate); 5 = zastaveno pojistkou mezi scénáři, účet ověřeně čistý.
 * Po záznamu: `npm run copier:mac -- reconcile` (read-only) před ARM.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTradovateBroker, type WebSocketLike } from '../../services/tradovateBroker';
// `isSupportedOrderType` přinesla oprava C1: bez ní tento import selže a skript se nespustí —
// adaptér bez opravy by na TrailingStop/MIT sám spadl a úklid by nešel ověřit.
import { isSupportedOrderType, type BrokerEvent } from '../../services/brokerPort';
import { TRADOVATE_HOSTS } from '../../services/tradovateMapping';
import { loadMacCopierConnectionManifest } from '../../server/macCopierConnectionManifest';
import { createMacCopierDeviceTokenProvider, loadMacCopierDevice } from '../../server/macCopierDevice';
import {
  decideFillCleanup,
  frontContractProblem,
  leakedIdentifiers,
  sanitizeRecordedFrame,
  type FillCleanupDecision,
  type RecordPlacement,
} from './recordLeaderOsoPlan';
import {
  RECORD_TYPES_ACCOUNT_SPEC,
  TYPES_SCENARIOS,
  buildTypesOsoPayload,
  buildTypesPlacements,
  classifyTypesOsoResponse,
  definitiveHttpRejection,
  describeTypesPlan,
  parseRecordTypesArgs,
  placementFromTypesResult,
  recordTypesMayPlace,
  recordTypesReference,
  recordTypesStatusProblems,
  redactSecrets,
  sanitizeRestRows,
  sanitizeTypesPayload,
  typesPayloadProblems,
  typesPlacementVerdict,
  type RecordTypesPlan,
  type TypesObservation,
  type TypesOsoResult,
  type TypesPlacement,
  type TypesPlacementVerdict,
  type TypesScenarioId,
} from './recordTypesPlan';

const COPIER_DIR = join(homedir(), 'Library/Application Support/AlphaTrade/copier');
const STATUS_URL = 'http://127.0.0.1:3211/v1/status';
/** Pevně DEMO REST — LIVE host se v tomto skriptu nikdy nesestaví. */
const TRADOVATE_REST = TRADOVATE_HOSTS.demo.rest;
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const message = (reason: unknown) => redactSecrets(reason instanceof Error ? reason.message : String(reason));
function refuse(problems: string[]): never {
  console.error(`NESPUŠTĚNO:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
const readStatus = async (): Promise<Record<string, unknown>> => {
  const response = await fetch(STATUS_URL, { headers: { Origin: 'http://localhost:3000' }, signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`status workeru ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
};

const plan: RecordTypesPlan = (() => {
  try { return parseRecordTypesArgs(process.argv.slice(2)); } catch (reason) { return refuse([message(reason)]); }
})();
console.log(describeTypesPlan(plan, Date.now()));
const initialStatus = await readStatus().catch(reason => refuse([`status workeru nejde přečíst (${message(reason)})`]));
const startProblems = recordTypesStatusProblems(plan, initialStatus, Date.now(), { kind: 'start' });
if (!recordTypesMayPlace(plan, startProblems)) {
  if (startProblems.length) refuse(startProblems);
  console.log('Pojistky prošly. Nic se neposlalo — pro skutečné zadání přidej --confirm.'
    + ' (Účet DEMO8661118 a front kontrakt se ověří u brokera před prvním příkazem.)');
  process.exit(0);
}
if (isSupportedOrderType('TrailingStop') || isSupportedOrderType('MIT')) {
  // Až adaptér tyto typy jednou bude umět, záznam se musí přepsat (jinak by skládal jinak než teď).
  refuse(['adaptér tohoto checkoutu bere TrailingStop/MIT jako podporované — záznam je psaný pro opravu C1']);
}

const discovery = (initialStatus.connectionDiscovery ?? {}) as { connectionAccounts?: Array<{ connectionId: string; accountIds: number[] }> };
const connectionId = discovery.connectionAccounts?.find(entry => entry.accountIds.includes(plan.accountId))?.connectionId
  ?? refuse(['worker nezná připojení účtu DEMO8661118']);
const manifest = await loadMacCopierConnectionManifest(join(COPIER_DIR, 'connections.json'));
const deviceEntry = manifest.connections.find(entry => entry.connectionId === connectionId)
  ?? manifest.connections.find(entry => entry.connectionId === manifest.primaryConnectionId)
  ?? refuse(['manifest připojení nezná připojení účtu']);
const provider = createMacCopierDeviceTokenProvider({ config: await loadMacCopierDevice(deviceEntry.deviceConfigPath), connectionId });
const lease = await provider.refresh();

const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;
const frames: Array<{ t: number; data: string }> = [];
const events: Array<{ t: number; event: BrokerEvent }> = [];
const steps: Array<{ t: number; step: string; detail?: unknown }> = [];
const step = (name: string, detail?: unknown) => {
  steps.push({ t: elapsed(), step: name, ...(detail === undefined ? {} : { detail }) });
  console.log(`${elapsed()} ms  ${name}${detail === undefined ? '' : ` ${redactSecrets(JSON.stringify(detail))}`}`);
};

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
function abort(problems: string[]): never {
  unsubscribe();
  return refuse(problems);
}
for (let waited = 0; !synced && waited < 20_000; waited += 250) await sleep(250);
if (!synced) abort(['WS se nesynchronizoval do 20 s — nic se neposlalo']);

const directory = await broker.refreshAccountDirectory();
const account = directory.find(item => item.accountId === plan.accountId);
if (!account?.canTrade || account.accountSpec !== RECORD_TYPES_ACCOUNT_SPEC) abort(['účet 61038658 není v adresáři připojení obchodovatelný DEMO8661118']);
const front = broker.frontContract ? await broker.frontContract('MNQ', plan.accountId).catch(() => null) : null;
const frontProblem = frontContractProblem(plan.symbol, front);
if (frontProblem) abort([frontProblem]);
const identifiers: Array<string | number> = [
  ...directory.flatMap(item => [item.accountId, item.accountSpec ?? '']),
  lease.accountSpec ?? '', connectionId,
];
const accountMap = new Map(directory.map((item, index) => [item.accountId, item.accountId === plan.accountId ? 1001 : 2001 + index]));

/** Celý účet (ne jen nové příkazy): flat a nic otevřeného. */
const accountClean = async (): Promise<string | null> => {
  const [orders, positions] = await Promise.all([broker.listOrders(plan.accountId, { fresh: true }), broker.listPositions(plan.accountId)]);
  if (positions.some(position => position.netQuantity !== 0)) return 'účet má otevřenou pozici';
  if (orders.some(order => order.status === 'working' || order.status === 'pending')) return 'účet má pracující příkaz';
  return null;
};
const initiallyDirty = await accountClean().catch(reason => `stav účtu nejde přečíst (${message(reason)})`);
if (initiallyDirty) abort([`${initiallyDirty} — nic se neposlalo`]);
const beforeIds = new Set((await broker.listOrders(plan.accountId, { fresh: true })).map(order => order.brokerOrderId));

const rest = async (path: string, body?: unknown): Promise<unknown> => {
  const accessToken = await provider.getAccessToken();
  const response = await fetch(`${TRADOVATE_REST}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Tradovate ${path.split('?')[0]} ${response.status}: ${redactSecrets(text).slice(0, 300)}`),
      { httpStatus: response.status, body: text });
  }
  return text ? JSON.parse(text) : null;
};

const ownOrderIds = new Set<number>();
const observe = async (): Promise<TypesObservation> => {
  const [orders, netPosition] = await Promise.all([
    broker.listOrders(plan.accountId, { fresh: true })
      .then(items => items.filter(order => !beforeIds.has(order.brokerOrderId)).map(order => ({
        id: order.brokerOrderId, status: order.status, side: order.side, filledQuantity: order.filledQuantity,
        orderType: order.orderType === 'Unsupported' ? `Unsupported:${order.brokerOrderType ?? '?'}` : order.orderType,
        ...(order.limitPrice != null ? { limitPrice: order.limitPrice } : {}),
        ...(order.stopPrice != null ? { stopPrice: order.stopPrice } : {}),
        ...(order.parentOrderId ? { parentOrderId: order.parentOrderId } : {}),
      })))
      .catch(reason => { step('čtení příkazů selhalo', message(reason)); return null; }),
    broker.listPositions(plan.accountId)
      .then(items => items.reduce((sum, position) => sum + Math.abs(position.netQuantity), 0))
      .catch(reason => { step('čtení pozice selhalo', message(reason)); return null; }),
  ]);
  for (const order of orders ?? []) ownOrderIds.add(Number(order.id));
  return { orders, netPosition };
};
const netPosition = () => broker.listPositions(plan.accountId)
  .then(items => items.reduce((sum, position) => sum + Math.abs(position.netQuantity), 0)).catch(() => null);

interface PlacementRecord {
  scenario: TypesScenarioId;
  code: string;
  label: string;
  reference: number;
  payload: Record<string, unknown>;
  response: unknown;
  result: TypesOsoResult | null;
  observations: Array<{ t: number; label: string; observation: TypesObservation }>;
  readback?: Record<string, unknown>;
  verdict?: TypesPlacementVerdict;
  cleanup?: FillCleanupDecision;
}
const records: PlacementRecord[] = [];

// Stav právě běžícího zadání (signál uklízí jen to; mezi scénáři je účet ověřeně čistý).
let active: { placement: RecordPlacement; inFlight: Promise<unknown> | null; tag: string } = { placement: { kind: 'not-sent' }, inFlight: null, tag: 'rtyidle' };
let activeCleanup: Promise<FillCleanupDecision> | null = null;
/** true od zadání do konce jeho úklidu; mimo to signál ověřuje účet znovu od nuly. */
let placementOpen = false;
let stopRequested = false;

const runCleanup = () => activeCleanup ??= (async (): Promise<FillCleanupDecision> => {
  if (active.inFlight) {
    step('úklid: čekám na dokončení zadání');
    await Promise.race([active.inFlight.catch(() => undefined), sleep(50_000)]);
  }
  // Nejistý výsledek: příkaz se u Tradovate může objevit později.
  if (active.placement.kind === 'uncertain') await sleep(10_000);
  let liquidations = 0;
  let lastNet: number | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const observation = await observe();
    step('úklid: stav účtu', observation);
    const decision = decideFillCleanup(observation, active.placement);
    if (decision.kind === 'clean') return decision;
    if (decision.kind === 'unverified' && observation.orders && observation.netPosition === 0) return decision;
    // Liquidate jen po novém pozorování pozice, nejvýš 2× — nikdy slepé opakování.
    if (decision.kind === 'liquidate' && liquidations < 2 && observation.netPosition !== lastNet) {
      liquidations += 1;
      lastNet = observation.netPosition;
      step('úklid: liquidate');
      await broker.liquidatePosition!({ tag: `${active.tag}x`, accountId: plan.accountId, symbol: plan.symbol })
        .then(result => step('úklid: liquidate výsledek', result))
        .catch(reason => step('úklid: liquidate selhal', message(reason)));
    } else if (decision.kind === 'cancel') {
      for (const id of decision.ids) {
        step('úklid: cancel', id);
        await broker.cancelOrder(plan.accountId, id).catch(reason => step('úklid: cancel selhal', message(reason)));
      }
    }
    await sleep(1_500);
  }
  return { kind: 'unverified', reason: 'účet po úklidu není ověřeně flat bez příkazů' };
})();

let finishing = false;
const finish = async (outcome: { kind: 'done' | 'stopped' | 'unverified'; reason?: string }) => {
  if (finishing) return;
  finishing = true;
  unsubscribe();
  await writeRecording(outcome).catch(reason => console.error(`Záznam neuložen: ${message(reason)}`));
  if (outcome.kind === 'unverified') {
    console.error(`POZOR: ${outcome.reason}. Zkontroluj DEMO8661118 v Tradovate a ruč zruš/zavři, co tam zůstalo.`);
    process.exit(4);
  }
  console.log(`${outcome.kind === 'stopped' ? `Zastaveno (${outcome.reason}), ` : ''}účet ověřeně čistý. Teď: npm run copier:mac -- reconcile (read-only).`);
  process.exit(outcome.kind === 'done' ? 0 : 5);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    step(`signál ${signal} — uklízím`);
    stopRequested = true;
    if (!placementOpen) {
      // Mezi scénáři: čerstvé ověření (nové příkazy od startu), ne výsledek minulého úklidu.
      active = { placement: { kind: 'not-sent' }, inFlight: null, tag: active.tag };
      activeCleanup = null;
    }
    void runCleanup().then(decision => finish(decision.kind === 'clean'
      ? { kind: 'stopped', reason: `signál ${signal}` }
      : { kind: 'unverified', reason: 'reason' in decision ? decision.reason : decision.kind }));
  });
}

const readback = async (ids: Array<string | null>) => {
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    if (!(Number(id) > 0)) continue;
    for (const [key, path] of [
      ['order', `/order/item?id=${id}`],
      ['orderVersion', `/orderVersion/deps?masterid=${id}`],
      ['executionReport', `/executionReport/deps?masterid=${id}`],
    ] as const) {
      out[`${key}:${id}`] = await rest(path).then(rows => sanitizeRestRows(rows, accountMap)).catch(reason => ({ error: message(reason) }));
    }
  }
  return out;
};

const runPlacement = async (scenario: TypesScenarioId, placement: TypesPlacement, reference: number, tag: string) => {
  const definition = TYPES_SCENARIOS[scenario];
  const payload = buildTypesOsoPayload(placement, {
    accountId: plan.accountId, accountSpec: account!.accountSpec!, symbol: plan.symbol, quantity: plan.quantity, tag, mitTrigger: plan.mitTrigger,
  });
  const payloadProblems = typesPayloadProblems(payload, { plan, scenario, reference, now: Date.now() });
  if (payloadProblems.length) return { kind: 'refused' as const, problems: payloadProblems };
  // Synchronně až do POSTu: signál, který přišel během kontrol, zadání zastaví.
  if (stopRequested || finishing) return { kind: 'refused' as const, problems: ['zastaveno signálem před zadáním'] };
  placementOpen = true;
  const record: PlacementRecord = {
    scenario, code: definition.code, label: placement.label, reference,
    payload: sanitizeTypesPayload(payload), response: null, result: null, observations: [],
  };
  records.push(record);
  activeCleanup = null;
  active = { placement: { kind: 'uncertain', entrySide: placement.entry.side }, inFlight: null, tag };
  const snapshot = async (label: string) => {
    const observation = await observe();
    record.observations.push({ t: elapsed(), label, observation });
    step(`${definition.code} ${label}`, observation);
    return observation;
  };

  step(`${definition.code} ${placement.label}: placeoso`, { reference, payload: record.payload });
  const request = rest('/order/placeoso', payload);
  active.inFlight = request;
  let httpRejected = false;
  const response = await request.catch(reason => {
    step(`${definition.code} placeoso výjimka`, message(reason));
    const http = reason as { httpStatus?: number; body?: unknown };
    const rejection = definitiveHttpRejection(http.httpStatus, typeof http.body === 'string' ? http.body : '');
    httpRejected = rejection != null;
    return rejection ?? undefined;
  });
  active.inFlight = null;
  const result = classifyTypesOsoResponse(response);
  record.response = response ?? null;
  record.result = result;
  active.placement = placementFromTypesResult(result, placement.entry.side);
  step(`${definition.code} placeoso výsledek`, result);
  const ids = result.result === 'accepted' || result.result === 'partial' ? [result.entryId, result.stopId, result.targetId] : [];
  for (const id of ids) if (Number(id) > 0) ownOrderIds.add(Number(id));

  let afterFill: TypesObservation | null = null;
  if (result.result !== 'rejected' && !stopRequested) {
    await sleep(500);
    await snapshot('po ack');
    // REST snímky střídmě (jeden snímek ≈ 6 REST volání na loginu sdíleném s workerem);
    // průběh mezi nimi zachytí rámce WS.
    if (placement.flow === 'fill') {
      let filled = false;
      for (let waited = 0; waited < 10_000 && !filled && !stopRequested; waited += 500) {
        const net = await netPosition();
        filled = net != null && net !== 0;
        if (!filled) await sleep(500);
      }
      afterFill = await snapshot(filled ? 'hned po fillu' : 'fill nepřišel do 10 s');
      await sleep(1_500);
      await snapshot('po fillu +1,5 s');
    }
    for (let held = 0; held < placement.holdMs && !stopRequested;) {
      const pause = Math.min(5_000, placement.holdMs - held);
      await sleep(pause);
      held += pause;
      await snapshot(`drženo ${held} ms`);
    }
    if (placement.flow === 'expire' && placement.entry.expireAt != null) {
      const until = placement.entry.expireAt + placement.afterExpireMs;
      while (Date.now() < until && !stopRequested) {
        await sleep(Math.min(10_000, Math.max(250, until - Date.now())));
        await snapshot(`expireTime ${Math.round((Date.now() - placement.entry.expireAt) / 1000)} s`);
      }
    }
    if (placement.readback && !stopRequested) record.readback = await readback(ids);
  }
  const last = record.observations.length ? record.observations[record.observations.length - 1].observation : null;
  record.verdict = typesPlacementVerdict(scenario, result, { afterFill, last });
  step(`${definition.code} výsledek`, record.verdict);
  // HTTP odmítnutí: krátce počkat, kdyby se příkaz přece objevil (úklid ho pak zruší).
  if (httpRejected) await sleep(2_000);
  record.cleanup = await runCleanup();
  placementOpen = false;
  step(`${definition.code} úklid`, record.cleanup);
  return { kind: 'done' as const, cleanup: record.cleanup };
};

// Hlavní smyčka: každý scénář jen nad DISARMED workerem a ověřeně čistým účtem.
let outcome: { kind: 'done' | 'stopped' | 'unverified'; reason?: string } = { kind: 'done' };
scenarios: for (const scenario of plan.scenarios) {
  const definition = TYPES_SCENARIOS[scenario];
  const count = buildTypesPlacements(scenario, plan.marketPrice, plan, Date.now()).length;
  for (let index = 0; index < count; index += 1) {
    if (stopRequested) { outcome = { kind: 'stopped', reason: 'signál' }; break scenarios; }
    // Armed gate + pojistky scénáře těsně před každým zadáním.
    const status = await readStatus().catch(() => null);
    const problems = status ? recordTypesStatusProblems(plan, status, Date.now(), { kind: 'scenario', scenario }) : ['status workeru nejde přečíst'];
    if (problems.length) { outcome = { kind: 'stopped', reason: `${definition.code}: ${problems.join('; ')}` }; break scenarios; }
    const dirty = await accountClean().catch(reason => `stav účtu nejde přečíst (${message(reason)})`);
    if (dirty) { outcome = { kind: 'stopped', reason: `${definition.code}: ${dirty}` }; break scenarios; }
    const reference = recordTypesReference(plan, status, Date.now(), definition.window).price;
    if (reference == null) { outcome = { kind: 'stopped', reason: `${definition.code}: chybí reference ceny` }; break scenarios; }
    const placement = buildTypesPlacements(scenario, reference, plan, Date.now())[index];
    const tag = `rty${randomUUID().replace(/-/g, '').slice(0, 18)}`;
    const result = await runPlacement(scenario, placement, reference, tag);
    if (result.kind === 'refused') { outcome = { kind: 'stopped', reason: `${definition.code}: ${result.problems.join('; ')}` }; break scenarios; }
    if (result.cleanup.kind !== 'clean') {
      outcome = { kind: 'unverified', reason: `${definition.code}: ${'reason' in result.cleanup ? result.cleanup.reason : result.cleanup.kind}` };
      break scenarios;
    }
  }
}
// Poslední ověření celého účtu (nejen nových příkazů).
if (outcome.kind !== 'unverified') {
  const dirty = await accountClean().catch(reason => `stav účtu nejde přečíst (${message(reason)})`);
  if (dirty) outcome = { kind: 'unverified', reason: dirty };
}
await finish(outcome);

async function writeRecording(ending: { kind: string; reason?: string }) {
  const placedAt = steps.find(item => item.step.endsWith(': placeoso'))?.t ?? Infinity;
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
    version: 1,
    script: 'record-types',
    recordedAt: new Date(startedAt).toISOString(),
    symbol: plan.symbol, quantity: plan.quantity, trailPeg: plan.trailPeg, mitTrigger: plan.mitTrigger,
    scenarios: plan.scenarios,
    outcome: ending,
    placements: records,
    steps, events: sanitizedEvents, frames: sanitizedFrames,
  };
  const serialized = `${JSON.stringify(recording, null, 2)}\n`;
  const leaks = leakedIdentifiers(serialized, identifiers);
  if (leaks.length) throw new Error(`záznam obsahuje ${leaks.length} identifikátor(ů) účtu — neuloženo`);
  if (/Bearer\s+(?!\*\*\*)\S/.test(serialized)) throw new Error('záznam obsahuje token — neuloženo');
  const directoryPath = join(COPIER_DIR, 'recordings');
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const path = join(directoryPath, `types-${plan.scenarios.length === 1 ? plan.scenarios[0] : 'set'}-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(path, serialized, { mode: 0o600 });
  console.log(`Záznam (mimo repo, ke kontrole): ${path} — ${records.length} zadání, ${sanitizedFrames.length} entit z WS, ${sanitizedEvents.length} eventů`);
}

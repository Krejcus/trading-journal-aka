/**
 * Interpret DEMO záznamů (`recordDemoPlan.ts`). Spouští ho jen Filip přes
 * `record-exits.ts`, `record-pending.ts` a `record-scale-in.ts --scenario
 * foreign-close|pending-modify`. Vzor: `record-scale-in.ts` (připojení tokenem
 * workeru, nahrávání příchozích WS rámců, úklid, anonymizovaný záznam mimo repo).
 *
 * Pořadí: výpis plánu → statické pojistky → plná kontrola workeru → bez
 * `--confirm` konec (nic se nepřipojí). S `--confirm`: WS sync → adresář účtů
 * (přesně DEMO8661118) → front kontrakt u brokera (jen čtení) → plná kontrola
 * znovu → scénáře. Každý scénář: ARMED gate + flat bez příkazů (REST) → kroky
 * (před každým zadáním ARMED gate, čerstvá cena, skutečná expozice ≤ 2) →
 * úklid (zavřít pozici, zrušit vstupy, pak nohy) → ověřený flat → záznam.
 *
 * Exit 0 = vše hotovo a účet ověřeně čistý; 2 = scénář přerušen, účet čistý;
 * 4 = účet NEověřen (zkontrolovat v Tradovate); 1 = nespuštěno.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTradovateBroker, type WebSocketLike } from '../../services/tradovateBroker';
import type { BrokerEvent, BrokerOrder, OrderType } from '../../services/brokerPort';
import { loadMacCopierConnectionManifest } from '../../server/macCopierConnectionManifest';
import { createMacCopierDeviceTokenProvider, loadMacCopierDevice } from '../../server/macCopierDevice';
import { LEADER_PLACEHOLDER_ID, leakedIdentifiers, sanitizeRecordedFrame } from './recordLeaderOsoPlan';
import { decideScaleInCleanup, type ScaleInCleanupDecision } from './recordScaleInPlan';
import {
  DEMO_RECORD_ACCOUNT_SPEC,
  classifyDemo,
  containsSecret,
  demoAnchor,
  demoGateProblems,
  demoOrderPrice,
  demoPlanProblems,
  demoStartProblems,
  describeDemoPlan,
  dryRunScenario,
  exitOrderProblems,
  exposureProblem,
  leaderExtraEntities,
  legsQuantityMatch,
  liquidationTail,
  modifyProblems,
  osoPlacementProblems,
  plainOrderProblems,
  redactDemoText,
  resolveDemoPrice,
  reverseOrdering,
  roundDemoTick,
  scenarioFills,
  type DemoClassify,
  type DemoFinding,
  type DemoLegName,
  type DemoObservation,
  type DemoObservedOrder,
  type DemoOrderRef,
  type DemoRecordPlan,
  type DemoScenario,
  type DemoSide,
  type DemoStep,
  type DemoTicketIds,
  type DemoTicketPrices,
  type DemoTimelineEntity,
  type ResolvedOso,
} from './recordDemoPlan';

const COPIER_DIR = join(homedir(), 'Library/Application Support/AlphaTrade/copier');
const STATUS_URL = 'http://127.0.0.1:3211/v1/status';
const OPEN = new Set(['working', 'pending']);
const CLASSIFIERS_WITH_BEFORE = new Set(['relative-leg-move', 'parent-qty', 'cancel-one-of-many', 'through-market-entry']);

const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const readStatus = async () => {
  const response = await fetch(STATUS_URL, { headers: { Origin: 'http://localhost:3000' }, signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`status workeru ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
};
const refuse = (problems: string[]) => {
  console.error(`NESPUŠTĚNO:\n- ${problems.join('\n- ')}`);
  return 1;
};

export interface DemoRunOptions {
  /** Jméno skriptu do záznamu. */
  script: string;
  /** Předpona souboru záznamu (`leader-exits`, …). */
  filePrefix: string;
  /** Tři znaky na začátek tagu příkazů (tag se nikdy neukládá). */
  tagPrefix: string;
}

class StepAbort extends Error {}

type StepResult = { id: string; ok: boolean; error?: string; notSent?: boolean; confirmedBy?: string | null; ms?: number };

interface TicketState {
  side: DemoSide;
  dir: 1 | -1;
  entryType: 'Market' | 'Limit' | 'Stop';
  ids: DemoTicketIds;
  placed: DemoTicketPrices;
  current: DemoTicketPrices;
  quantities: Record<DemoLegName, number>;
}

interface PlainState { id: string; side: DemoSide; orderType: 'Market' | 'Limit' | 'Stop'; price: number | null; quantity: number; reducing: boolean }

export async function runDemoRecording(plan: DemoRecordPlan, options: DemoRunOptions): Promise<number> {
  for (const line of describeDemoPlan(plan)) console.log(line);
  const staticProblems = demoPlanProblems(plan, Date.now());
  if (staticProblems.length) return refuse(staticProblems);
  let initialStatus: Record<string, unknown>;
  try {
    initialStatus = await readStatus();
  } catch (reason) {
    return refuse([`status workeru nejde přečíst (${redactDemoText(String((reason as Error)?.message ?? reason))})`]);
  }
  const startProblems = demoStartProblems(plan, initialStatus, Date.now());
  if (startProblems.length) return refuse(startProblems);
  // Suchý průchod při aktuální ceně workeru: každé zadání i modify musí projít pojistkami.
  const anchor = demoAnchor(initialStatus, plan.symbol, Date.now())!;
  const dryProblems = plan.scenarios.flatMap(scenario => dryRunScenario(scenario, plan.side, anchor).map(problem => `${scenario.name}: ${problem}`));
  if (dryProblems.length) return refuse(dryProblems);
  if (!plan.confirm) {
    const fills = plan.scenarios.some(scenario => scenarioFills(scenario.steps));
    console.log(`Pojistky prošly. Nic se neposlalo — pro skutečné zadání přidej --confirm${fills ? ' --allow-fill' : ''}.`);
    return 0;
  }
  return runConfirmed(plan, options, initialStatus);
}

async function runConfirmed(plan: DemoRecordPlan, options: DemoRunOptions, initialStatus: Record<string, unknown>): Promise<number> {
  const identifiers: Array<string | number> = [plan.accountId, DEMO_RECORD_ACCOUNT_SPEC];
  const errorText = (reason: unknown) => redactDemoText(reason instanceof Error ? reason.message : String(reason), identifiers);

  const discovery = (initialStatus.connectionDiscovery ?? {}) as { connectionAccounts?: Array<{ connectionId: string; accountIds: number[] }> };
  const connectionId = discovery.connectionAccounts?.find(entry => entry.accountIds.includes(plan.accountId))?.connectionId;
  if (!connectionId) return refuse(['worker nezná připojení účtu']);
  identifiers.push(connectionId);
  const manifest = await loadMacCopierConnectionManifest(join(COPIER_DIR, 'connections.json'));
  const deviceEntry = manifest.connections.find(entry => entry.connectionId === connectionId)
    ?? manifest.connections.find(entry => entry.connectionId === manifest.primaryConnectionId);
  if (!deviceEntry) return refuse(['manifest připojení neobsahuje zařízení']);
  const provider = createMacCopierDeviceTokenProvider({ config: await loadMacCopierDevice(deviceEntry.deviceConfigPath), connectionId });
  // Token zůstává v provideru; do konzole ani do záznamu nejde (odchozí rámce se nenahrávají).
  const lease = await provider.refresh();
  if (lease.accountSpec) identifiers.push(lease.accountSpec);

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const frames: Array<{ t: number; data: string }> = [];
  const events: Array<{ t: number; event: BrokerEvent }> = [];
  const accountKey = `"accountId":${plan.accountId}`;
  let lastActivityT = 0;
  let abortReason: string | null = null;
  let log: Array<{ t: number; step: string; detail?: unknown }> = [];
  let scenarioName = '-';
  const note = (name: string, detail?: unknown) => {
    log.push({ t: elapsed(), step: name, ...(detail === undefined ? {} : { detail }) });
    console.log(redactDemoText(`${elapsed()} ms  [${scenarioName}] ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`, identifiers));
  };

  // Jen příchozí rámce, jen v paměti; odchozí (authorize s tokenem) se nikdy nenahrávají.
  const recordingSocket = (url: string): WebSocketLike => {
    const socket = new WebSocket(url) as unknown as WebSocketLike;
    let handler: WebSocketLike['onmessage'] = null;
    socket.onmessage = event => {
      const data = String(event.data);
      frames.push({ t: elapsed(), data });
      if (data.includes(accountKey)) lastActivityT = elapsed();
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
    const accountId = event.type === 'order' ? event.order.accountId
      : event.type === 'fill' ? event.fill.accountId
        : event.type === 'position' ? event.position.accountId : null;
    if (accountId === plan.accountId) lastActivityT = elapsed();
  });
  const stop = (problems: string[]) => { unsubscribe(); return refuse(problems); };
  for (let waited = 0; !synced && waited < 20_000; waited += 250) await sleep(250);
  if (!synced) return stop(['WS se nesynchronizoval do 20 s — nic se neposlalo']);

  const directory = await broker.refreshAccountDirectory().catch(() => null);
  if (!directory) return stop(['adresář účtů připojení nejde přečíst — nic se neposlalo']);
  const account = directory.find(item => item.accountId === plan.accountId);
  if (!account?.canTrade || account.accountSpec !== DEMO_RECORD_ACCOUNT_SPEC) {
    return stop([`účet ${plan.accountId} není v adresáři připojení obchodovatelný ${DEMO_RECORD_ACCOUNT_SPEC}`]);
  }
  identifiers.push(...directory.flatMap(item => [item.accountId, item.accountSpec ?? '']));
  const accountMap = new Map<number, number>(directory.map((item, index) => [Number(item.accountId), item.accountId === plan.accountId ? LEADER_PLACEHOLDER_ID : 2001 + index]));
  const front = await broker.frontContract?.('MNQ', plan.accountId).catch(() => null);
  if (front?.contract !== plan.symbol) return stop([`broker hlásí front kontrakt ${front?.contract ?? 'neznámý'}, plán ${plan.symbol}`]);
  const finalProblems = demoStartProblems(plan, await readStatus().catch(() => ({})), Date.now());
  if (finalProblems.length) return stop(finalProblems);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      abortReason ??= `signál ${signal}`;
      note(`signál ${signal} — dokončuji rozpracovaný krok a uklízím (NEpřerušovat znovu)`);
    });
  }

  // Tvrdá chyba procesu bez úklidu: nikdy se netvářit, že je účet čistý.
  for (const signal of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(signal, reason => {
      console.error(`NEČEKANÁ CHYBA (${errorText(reason)}): úklid neproběhl, účet NEověřen. Zkontroluj Tradovate.`);
      process.exit(4);
    });
  }

  // Tag jde do záznamu jen jako příznak: nese událost před ACK vlastní tag? (návrh, okno `sending`).
  const ownTags = new Set<string>();
  const newTag = () => {
    const tag = `${options.tagPrefix.slice(0, 3)}${randomUUID().replace(/-/g, '').slice(0, 18)}`;
    ownTags.add(tag);
    return tag;
  };
  const sideOf = (which: 'position' | 'opposite' | undefined): DemoSide =>
    which === 'opposite' ? (plan.side === 'Buy' ? 'Sell' : 'Buy') : plan.side;
  const exitSide = (side: DemoSide): DemoSide => (side === 'Buy' ? 'Sell' : 'Buy');
  const positive = (id: string | undefined) => (Number(id) > 0 ? String(id) : undefined);
  const checkAbort = () => { if (abortReason) throw new StepAbort(abortReason); };
  const pause = async (ms: number) => {
    for (let left = ms; left > 0; left -= 250) { checkAbort(); await sleep(Math.min(250, left)); }
  };

  let sentAnything = false;
  for (const scenario of plan.scenarios) {
    scenarioName = scenario.name;
    log = [];
    const result = await runScenario(scenario);
    if (result.started) {
      await writeRecording(scenario, result).catch(reason => console.error(`Záznam neuložen: ${errorText(reason)}`));
    }
    if (!result.started) {
      unsubscribe();
      console.error(`NESPUŠTĚNO (${scenario.name}): ${result.aborted}`);
      // Gate odmítl nad čistým účtem = 2 (předchozí scénáře hotové); účet není flat = 4.
      return !sentAnything ? 1 : result.outcome.kind === 'clean' ? 2 : 4;
    }
    sentAnything = true;
    if (result.outcome.kind !== 'clean') {
      unsubscribe();
      console.error(`POZOR: ${'reason' in result.outcome ? result.outcome.reason : result.outcome.kind}. Zkontroluj účet v Tradovate a ruč zruš/zavři, co tam zůstalo.`);
      return 4;
    }
    if (result.aborted) {
      unsubscribe();
      console.error(`Scénář ${scenario.name} přerušen: ${result.aborted}. Účet ověřeně čistý. Teď: npm run copier:mac -- reconcile (read-only).`);
      return 2;
    }
  }
  unsubscribe();
  console.log('Hotovo, účet ověřeně flat bez příkazů. Teď: npm run copier:mac -- reconcile (read-only) — záznam zneplatnil kontrolu pozic.');
  return 0;

  interface ScenarioResult {
    started: boolean;
    aborted: string | null;
    outcome: ScaleInCleanupDecision;
    startT: number;
    endT: number;
    tickets: Map<string, TicketState>;
    plain: Map<string, PlainState>;
    ownIds: Set<number>;
    acks: unknown[];
    findings: Array<{ step: string; t: number; finding: DemoFinding }>;
    tails: Array<{ liquidate: string; fromT: number; toT: number; quiet: boolean }>;
    reverseMarks: Array<{ liquidate: string; sentT: number; oldIds: string[]; newIds: string[] }>;
    skipped: string[];
  }

  async function runScenario(scenario: DemoScenario): Promise<ScenarioResult> {
    const startT = elapsed();
    const tickets = new Map<string, TicketState>();
    const plain = new Map<string, PlainState>();
    const entryIds = new Set<string>();
    const ownIds = new Set<number>();
    const liquidations = new Map<string, { t: number; result: unknown }>();
    const findings: ScenarioResult['findings'] = [];
    const tails: ScenarioResult['tails'] = [];
    const reverseMarks: ScenarioResult['reverseMarks'] = [];
    const acks: unknown[] = [];
    const skipped: string[] = [];
    const inFlight = new Set<Promise<unknown>>();
    let beforeIds = new Set<string>();
    const base = { startT, tickets, plain, ownIds, acks, findings, tails, reverseMarks, skipped };

    const toObserved = (order: BrokerOrder): DemoObservedOrder => ({
      id: order.brokerOrderId, status: order.status, side: order.side, type: order.orderType,
      quantity: order.quantity, filledQuantity: order.filledQuantity,
      ...(order.limitPrice != null ? { limitPrice: order.limitPrice } : {}),
      ...(order.stopPrice != null ? { stopPrice: order.stopPrice } : {}),
      ...(order.parentOrderId ? { parentOrderId: order.parentOrderId } : {}),
      ...(order.ocoId ? { ocoId: order.ocoId } : {}),
      ...(order.linkedOrderId ? { linkedOrderId: order.linkedOrderId } : {}),
    });
    const observe = async (): Promise<DemoObservation & { signedNet: number | null }> => {
      const [orders, positions] = await Promise.all([
        broker.listOrders(plan.accountId, { fresh: true })
          .then(items => items.filter(order => !beforeIds.has(order.brokerOrderId)).map(toObserved))
          .catch(reason => { note('čtení příkazů selhalo', errorText(reason)); return null; }),
        broker.listPositions(plan.accountId)
          .catch(reason => { note('čtení pozice selhalo', errorText(reason)); return null; }),
      ]);
      // Účet byl na začátku bez otevřených příkazů: vše nové je ze záznamu (nebo z liquidate).
      for (const order of orders ?? []) ownIds.add(Number(order.id));
      return {
        orders,
        netPosition: positions == null ? null : positions.reduce((sum, position) => sum + Math.abs(position.netQuantity), 0),
        signedNet: positions == null ? null : positions.filter(position => position.symbol === plan.symbol)
          .reduce((sum, position) => sum + position.netQuantity, 0),
      };
    };
    const findOrder = (observation: DemoObservation | null, id: string | undefined) =>
      id == null ? undefined : observation?.orders?.find(order => order.id === id);
    // Samostatné výstupní nohy (`place-exit`) jsou redukce: do možné pozice se nepočítají.
    const legIds = () => new Set([
      ...[...tickets.values()].flatMap(ticket => [ticket.ids.sl, ticket.ids.tp]),
      ...[...plain.values()].filter(order => order.reducing).map(order => order.id),
    ].filter((id): id is string => id != null));
    const ticketPrice = (name: string, order: DemoLegName) => tickets.get(name)?.current[order] ?? null;
    const idsRecord = () => Object.fromEntries([...tickets].map(([name, ticket]) => [name, ticket.ids]));
    const plainRecord = () => Object.fromEntries([...plain].map(([name, order]) => [name, order.id]));

    const gate = async (label: string): Promise<number | null> => {
      let status: unknown;
      try { status = await readStatus(); } catch (reason) { throw new StepAbort(`${label}: status workeru nejde přečíst (${errorText(reason)})`); }
      const problems = demoGateProblems(plan, status);
      if (problems.length) throw new StepAbort(`${label}: ${problems.join('; ')}`);
      return demoAnchor(status, plan.symbol, Date.now());
    };
    const requireAnchor = (anchor: number | null, label: string) => {
      if (anchor == null) throw new StepAbort(`${label}: worker nemá čerstvou cenu`);
      return anchor;
    };
    /** Skutečná expozice u brokera: |net| + otevřené vstupy (vše, co není noha) + nový ≤ 2. */
    const exposureCheck = async (addQuantity: number, reducing: boolean, reduceSide?: DemoSide) => {
      const observation = await observe();
      const legs = legIds();
      const openEntries = observation.orders == null ? null
        : observation.orders.filter(order => OPEN.has(order.status) && !legs.has(order.id));
      const problem = exposureProblem({ netPosition: observation.netPosition, openEntries, addQuantity, reducing });
      if (problem) throw new StepAbort(problem);
      // Nohy zrušeného vstupu, které dál běží (kaskáda neproběhla): nic dalšího neposílat.
      const orphaned = [...tickets].filter(([, ticket]) => {
        const entry = findOrder(observation, ticket.ids.entry);
        return entry != null && (entry.status === 'canceled' || entry.status === 'rejected') && entry.filledQuantity === 0
          && [ticket.ids.sl, ticket.ids.tp].some(id => OPEN.has(findOrder(observation, id)?.status ?? ''));
      });
      if (orphaned.length) throw new StepAbort(`nohy zrušeného vstupu ${orphaned.map(([name]) => name).join(', ')} dál běží — další zadání se neposílá`);
      if (reducing && reduceSide) {
        // Redukce jen proti pozici: Sell jen nad longem, Buy jen nad shortem.
        const net = observation.signedNet ?? 0;
        if (!((reduceSide === 'Sell' && net > 0) || (reduceSide === 'Buy' && net < 0))) throw new StepAbort('redukce není proti otevřené pozici');
      }
      return observation;
    };
    let writeUncertain = false;
    const track = async <T>(request: Promise<T>): Promise<T> => {
      inFlight.add(request);
      try {
        return await request;
      } catch (reason) {
        // Výjimka zápisu neříká, že příkaz nevznikl: úklid pak chce dvě čisté kontroly.
        writeUncertain = true;
        throw reason;
      } finally {
        inFlight.delete(request);
      }
    };

    const after = async (
      step: { label: string; observeMs?: number[]; classify?: DemoClassify; kind: string },
      context: { before?: DemoObservation | null; results?: StepResult[]; requested?: Record<string, DemoTicketPrices> },
    ) => {
      const offsets = step.observeMs ?? (step.classify || step.kind === 'observe' ? [0] : []);
      const actionEnd = elapsed();
      let last: DemoObservation | null = null;
      for (const offset of offsets) {
        const wait = offset - (elapsed() - actionEnd);
        if (wait > 0) await pause(wait);
        last = await observe();
        note(`${step.label} — stav (+${offset} ms)`, last);
      }
      if (step.classify && last) {
        const expected = Object.fromEntries([...tickets].map(([name, ticket]) => [name, { ...ticket.current, ...(context.requested?.[name] ?? {}) }]));
        const placed = Object.fromEntries([...tickets].map(([name, ticket]) => [name, ticket.placed]));
        const finding = classifyDemo(step.classify, {
          before: context.before, after: last, tickets: idsRecord(), plain: plainRecord(),
          results: context.results, expected, placed,
        });
        findings.push({ step: step.label, t: elapsed(), finding });
        note(`${step.label} → ${finding.classifier}: ${finding.verdict}`);
      }
      if (last) {
        // Stav lístků podle brokera (např. venue posunula nohy s rodičem).
        for (const ticket of tickets.values()) {
          for (const name of ['entry', 'sl', 'tp'] as const) {
            const order = findOrder(last, ticket.ids[name]);
            if (!order || !OPEN.has(order.status)) continue;
            const price = demoOrderPrice(order);
            if (price != null) ticket.current[name] = price;
            ticket.quantities[name] = order.quantity;
          }
        }
      }
    };

    const placeOsoStep = async (step: Extract<DemoStep, { kind: 'place-oso' }>) => {
      const anchor = requireAnchor(await gate(step.label), step.label);
      const resolved = step.tickets.map(ticket => {
        const side = sideOf(ticket.side);
        const dir: 1 | -1 = side === 'Buy' ? 1 : -1;
        const entryPrice = 'price' in ticket.entry ? resolveDemoPrice(ticket.entry.price, { anchor, dir, ticketPrice }) : null;
        const context = { anchor, dir, entryPrice: entryPrice ?? anchor, ticketPrice };
        const oso: ResolvedOso = {
          side, quantity: ticket.quantity, entryType: ticket.entry.orderType, entry: entryPrice,
          stopLoss: resolveDemoPrice(ticket.stopLoss, context), takeProfit: resolveDemoPrice(ticket.takeProfit, context),
          marketable: 'price' in ticket.entry && ticket.entry.price.from === 'market' && ticket.entry.price.marketable === true,
        };
        return { name: ticket.ticket, dir, oso, problems: osoPlacementProblems(oso, anchor) };
      });
      const problems = resolved.flatMap(item => item.problems.map(problem => `${item.name}: ${problem}`));
      if (problems.length) throw new StepAbort(`${step.label}: ${problems.join('; ')}`);
      const oldIds = [...ownIds].map(String);
      await exposureCheck(resolved.reduce((sum, item) => sum + item.oso.quantity, 0), false);
      checkAbort();
      const sentT = elapsed();
      sentAnything = true;
      note(step.label, { anchor, tickets: resolved.map(item => ({ ticket: item.name, ...item.oso })) });
      const settled = await Promise.allSettled(resolved.map(item => track(broker.placeOso!({
        tag: newTag(), accountId: plan.accountId, symbol: plan.symbol, side: item.oso.side, quantity: item.oso.quantity,
        ...(item.oso.entryType === 'Market' ? { orderType: 'Market' as const }
          : item.oso.entryType === 'Limit' ? { orderType: 'Limit' as const, limitPrice: item.oso.entry! }
            : { orderType: 'Stop' as const, stopPrice: item.oso.entry! }),
        first: { side: exitSide(item.oso.side), orderType: 'Stop', stopPrice: item.oso.stopLoss },
        second: { side: exitSide(item.oso.side), orderType: 'Limit', limitPrice: item.oso.takeProfit },
      }))));
      const failed: string[] = [];
      const newIds: string[] = [];
      settled.forEach((item, index) => {
        const { name, dir, oso } = resolved[index];
        if (item.status === 'rejected') { failed.push(`${name}: ${errorText(item.reason)}`); note(`${name} výjimka`, errorText(item.reason)); return; }
        const ack = item.value;
        acks.push({ ticket: name, ack });
        note(`${name} ack (${elapsed() - sentT} ms)`, ack);
        const ids: DemoTicketIds = { entry: positive(ack.entryBrokerOrderId), sl: positive(ack.firstBrokerOrderId), tp: positive(ack.secondBrokerOrderId) };
        for (const id of [ids.entry, ids.sl, ids.tp]) if (id) { ownIds.add(Number(id)); newIds.push(id); }
        if (ids.entry) entryIds.add(ids.entry);
        const prices: DemoTicketPrices = { entry: oso.entry ?? anchor, sl: oso.stopLoss, tp: oso.takeProfit };
        tickets.set(name, {
          side: oso.side, dir, entryType: oso.entryType, ids, placed: { ...prices }, current: { ...prices },
          quantities: { entry: oso.quantity, sl: oso.quantity, tp: oso.quantity },
        });
        if (!ack.accepted || !ids.entry) failed.push(`${name}: nepřijato (${ack.rejectReason ?? 'bez id'})`);
      });
      if (step.reverseAfter) reverseMarks.push({ liquidate: step.reverseAfter, sentT, oldIds, newIds });
      if (failed.length) throw new StepAbort(`${step.label}: ${failed.join('; ')}`);
      await after(step, {});
    };

    const placeOrderStep = async (step: Extract<DemoStep, { kind: 'place-order' }>) => {
      if (step.onlyIfLegsQuantity) {
        const observation = await observe();
        if (!legsQuantityMatch(observation, tickets.get(step.onlyIfLegsQuantity.ticket)?.ids, step.onlyIfLegsQuantity.quantity)) {
          note(`${step.label}: PŘESKOČENO — nohy nemají pozorovaně qty ${step.onlyIfLegsQuantity.quantity}`, observation);
          skipped.push(step.label);
          return;
        }
      }
      const gated = await gate(step.label);
      // Holý vstup jen s čerstvou cenou: jinak by se vyplnil a krok s nohou by až potom skončil.
      const anchor = step.bare ? requireAnchor(gated, step.label) : gated;
      const side = sideOf(step.side);
      const dir: 1 | -1 = side === 'Buy' ? 1 : -1;
      const price = step.price ? resolveDemoPrice(step.price, { anchor, dir, ticketPrice }) : null;
      const marketable = step.price?.from === 'market' && step.price.marketable === true;
      const problems = plainOrderProblems({ side, orderType: step.orderType, price, quantity: step.quantity, reducing: step.reducing === true, anchor, bare: step.bare === true, marketable });
      if (problems.length) throw new StepAbort(`${step.label}: ${problems.join('; ')}`);
      await exposureCheck(step.quantity, step.reducing === true, side);
      checkAbort();
      sentAnything = true;
      const sentT = elapsed();
      note(step.label, { side, orderType: step.orderType, quantity: step.quantity, price, anchor });
      const ack = await track(broker.placeOrder({
        tag: newTag(), accountId: plan.accountId, symbol: plan.symbol, side, quantity: step.quantity, orderType: step.orderType,
        ...(price != null ? (step.orderType === 'Stop' ? { stopPrice: price } : { limitPrice: price }) : {}),
      }));
      acks.push({ ref: step.ref, ack });
      note(`${step.ref} ack (${elapsed() - sentT} ms)`, ack);
      const id = positive(ack.brokerOrderId);
      if (id) {
        ownIds.add(Number(id));
        plain.set(step.ref, { id, side, orderType: step.orderType, price, quantity: step.quantity, reducing: step.reducing === true });
        if (!step.reducing) entryIds.add(id);
      }
      if (!ack.accepted || !id) throw new StepAbort(`${step.label}: nepřijato (${ack.rejectReason ?? 'bez id'})`);
      await after(step, {});
    };

    /** Pracující výstupní nohy nesmí krýt víc než pozici; dvojí SL jen výslovně v kroku `overlapExit`. */
    const exitCoverCheck = (observation: DemoObservation, quantity: number, label: string) => {
      const legs = legIds();
      const working = (observation.orders ?? []).filter(order => OPEN.has(order.status) && legs.has(order.id))
        .reduce((sum, order) => sum + order.quantity, 0);
      if (working > 0 && working + quantity > (observation.netPosition ?? 0)) throw new StepAbort(`${label}: už pracuje noha ${working} ks, další by kryla víc než pozici`);
    };

    const placeExitStep = async (step: Extract<DemoStep, { kind: 'place-exit' }>) => {
      const anchor = requireAnchor(await gate(step.label), step.label);
      const side = sideOf('position');
      const dir: 1 | -1 = side === 'Buy' ? 1 : -1;
      const price = roundDemoTick(anchor + dir * (step.leg === 'stop' ? -step.points : step.points));
      const problems = exitOrderProblems({ side, leg: step.leg, price, quantity: step.quantity, anchor });
      if (problems.length) throw new StepAbort(`${step.label}: ${problems.join('; ')}`);
      exitCoverCheck(await exposureCheck(step.quantity, true, exitSide(side)), step.quantity, step.label);
      checkAbort();
      sentAnything = true;
      const sentT = elapsed();
      note(step.label, { leg: step.leg, price, quantity: step.quantity, anchor });
      const ack = await track(broker.placeOrder({
        tag: newTag(), accountId: plan.accountId, symbol: plan.symbol, side: exitSide(side), quantity: step.quantity,
        ...(step.leg === 'stop' ? { orderType: 'Stop' as const, stopPrice: price } : { orderType: 'Limit' as const, limitPrice: price }),
      }));
      acks.push({ ref: step.ref, ack });
      note(`${step.ref} ack (${elapsed() - sentT} ms)`, ack);
      const id = positive(ack.brokerOrderId);
      if (id) {
        ownIds.add(Number(id));
        plain.set(step.ref, { id, side: exitSide(side), orderType: step.leg === 'stop' ? 'Stop' : 'Limit', price, quantity: step.quantity, reducing: true });
      }
      if (!ack.accepted || !id) throw new StepAbort(`${step.label}: nepřijato (${ack.rejectReason ?? 'bez id'})`);
      await after(step, {});
    };

    const placeOcoStep = async (step: Extract<DemoStep, { kind: 'place-oco' }>) => {
      const anchor = requireAnchor(await gate(step.label), step.label);
      const side = sideOf('position');
      const dir: 1 | -1 = side === 'Buy' ? 1 : -1;
      const stopLoss = roundDemoTick(anchor - dir * step.slPoints);
      const takeProfit = roundDemoTick(anchor + dir * step.tpPoints);
      const problems = [
        ...exitOrderProblems({ side, leg: 'stop', price: stopLoss, quantity: step.quantity, anchor }),
        ...exitOrderProblems({ side, leg: 'limit', price: takeProfit, quantity: step.quantity, anchor }),
      ];
      if (problems.length) throw new StepAbort(`${step.label}: ${problems.join('; ')}`);
      if (!broker.placeOco) throw new StepAbort(`${step.label}: broker neumí OCO`);
      const exposure = await exposureCheck(step.quantity, true, exitSide(side));
      if (!step.overlapExit) exitCoverCheck(exposure, step.quantity, step.label);
      checkAbort();
      sentAnything = true;
      const sentT = elapsed();
      note(step.label, { stopLoss, takeProfit, quantity: step.quantity, anchor });
      const ack = await track(broker.placeOco({
        tag: newTag(), accountId: plan.accountId, symbol: plan.symbol, quantity: step.quantity,
        first: { side: exitSide(side), orderType: 'Stop', stopPrice: stopLoss },
        second: { side: exitSide(side), orderType: 'Limit', limitPrice: takeProfit },
      }));
      acks.push({ ticket: step.ticket, ack });
      note(`${step.ticket} ack (${elapsed() - sentT} ms)`, ack);
      const ids: DemoTicketIds = { sl: positive(ack.firstBrokerOrderId), tp: positive(ack.secondBrokerOrderId) };
      for (const id of [ids.sl, ids.tp]) if (id) ownIds.add(Number(id));
      const prices: DemoTicketPrices = { entry: anchor, sl: stopLoss, tp: takeProfit };
      tickets.set(step.ticket, {
        side, dir, entryType: 'Market', ids, placed: { ...prices }, current: { ...prices },
        quantities: { entry: step.quantity, sl: step.quantity, tp: step.quantity },
      });
      if (!ack.accepted || !ids.sl || !ids.tp) throw new StepAbort(`${step.label}: nepřijato (${ack.rejectReason ?? 'bez id'})`);
      await after(step, {});
    };

    const resolveTarget = (ref: DemoOrderRef) => {
      if ('plain' in ref) {
        const order = plain.get(ref.plain);
        return order ? {
          name: ref.plain, ticketName: null, id: order.id, order: 'entry' as DemoLegName, side: order.side,
          entryType: order.orderType as 'Market' | 'Limit' | 'Stop', price: order.price, quantity: order.quantity, ticket: null as TicketState | null,
        } : null;
      }
      const ticket = tickets.get(ref.ticket);
      return ticket ? {
        name: `${ref.ticket}.${ref.order}`, ticketName: ref.ticket, id: ticket.ids[ref.order], order: ref.order, side: ticket.side,
        entryType: ticket.entryType, price: ticket.current[ref.order] ?? null, quantity: ticket.quantities[ref.order], ticket,
      } : null;
    };

    const modifyStep = async (step: Extract<DemoStep, { kind: 'modify' }>) => {
      const anchor = await gate(step.label);
      const needsObservation = step.changes.some(change => change.throughMarket || change.price?.from === 'market' || change.quantity !== undefined)
        || (step.classify != null && CLASSIFIERS_WITH_BEFORE.has(step.classify.name));
      const before = needsObservation ? await observe() : null;
      const results: StepResult[] = [];
      const requested: Record<string, DemoTicketPrices> = {};
      const prepared: Array<{ id: string; name: string; changes: { quantity: number; orderType: OrderType; limitPrice?: number; stopPrice?: number }; apply: () => void }> = [];
      for (const change of step.changes) {
        const target = resolveTarget(change.target);
        if (!target?.id) { results.push({ id: '', ok: false, notSent: true, error: 'nevyslán: cíl bez id' }); note(`${step.label}: cíl bez id — nevyslán`); continue; }
        const dir: 1 | -1 = target.side === 'Buy' ? 1 : -1;
        const orderType: OrderType = change.orderType ?? (target.order === 'sl' ? 'Stop' : target.order === 'tp' ? 'Limit' : target.entryType);
        const problems: string[] = [];
        let newPrice: number | null = null;
        try {
          newPrice = change.orderType === 'Market' ? null : change.price
            ? resolveDemoPrice(change.price, { anchor, dir, current: target.price, ticketPrice, entryPrice: target.ticket?.current.entry ?? null })
            : target.price;
        } catch (reason) { problems.push(errorText(reason)); }
        const newQuantity = change.quantity ?? target.quantity;
        problems.push(...modifyProblems({
          order: target.order, side: target.side, entryType: target.entryType,
          status: before ? findOrder(before, target.id)?.status ?? 'missing' : null,
          assumeSuspended: target.order !== 'entry' && target.entryType !== 'Market',
          entryPrice: target.ticket?.current.entry ?? null,
          newPrice, newQuantity, toMarket: change.orderType === 'Market', anchor,
          throughMarket: change.throughMarket === true,
          marketable: change.orderType === 'Market' || (change.price?.from === 'market' && change.price.marketable === true),
        }));
        if (target.order === 'entry' && newQuantity > target.quantity && before) {
          const legs = legIds();
          const openEntries = before.orders == null ? null : before.orders.filter(order => OPEN.has(order.status) && !legs.has(order.id));
          const problem = exposureProblem({ netPosition: before.netPosition, openEntries, addQuantity: newQuantity - target.quantity, reducing: false });
          if (problem) problems.push(problem);
        }
        if (target.ticketName && newPrice != null) (requested[target.ticketName] ??= {})[target.order] = newPrice;
        if (problems.length) {
          results.push({ id: target.id, ok: false, notSent: true, error: `nevyslán: ${problems.join('; ')}` });
          note(`${step.label}: ${target.name} NEVYSLÁN`, problems);
          continue;
        }
        prepared.push({
          id: target.id, name: target.name,
          changes: {
            quantity: newQuantity, orderType,
            ...(orderType === 'Limit' && newPrice != null ? { limitPrice: newPrice } : {}),
            ...(orderType === 'Stop' && newPrice != null ? { stopPrice: newPrice } : {}),
          },
          apply: () => {
            if (target.ticket) {
              if (newPrice != null) target.ticket.current[target.order] = newPrice;
              target.ticket.quantities[target.order] = newQuantity;
            }
          },
        });
      }
      checkAbort();
      if (prepared.length) sentAnything = true;
      const sentAt = elapsed();
      note(step.label, prepared.map(item => ({ order: item.name, id: item.id, ...item.changes })));
      const settled = await Promise.allSettled(prepared.map(item => track(broker.modifyOrder(plan.accountId, item.id, item.changes))
        .then(result => ({ ms: elapsed() - sentAt, confirmedBy: result ? result.confirmedBy ?? null : null }))));
      settled.forEach((item, index) => {
        const { id, apply } = prepared[index];
        if (item.status === 'fulfilled') { apply(); results.push({ id, ok: true, ...item.value }); }
        else results.push({ id, ok: false, error: errorText(item.reason), ms: elapsed() - sentAt });
      });
      note(`${step.label} výsledky`, results);
      await after(step, { before, results, requested });
    };

    const cancelStep = async (step: Extract<DemoStep, { kind: 'cancel' }>) => {
      const needsBefore = step.onlyIfOpen === true || (step.classify != null && CLASSIFIERS_WITH_BEFORE.has(step.classify.name));
      const before = needsBefore ? await observe() : null;
      const results: StepResult[] = [];
      for (const ref of step.targets) {
        const target = resolveTarget(ref);
        if (!target?.id) { results.push({ id: '', ok: false, notSent: true, error: 'cíl bez id' }); continue; }
        if (step.onlyIfOpen && !OPEN.has(findOrder(before, target.id)?.status ?? '')) {
          note(`${step.label}: ${target.name} už neběží — nerušeno`);
          continue;
        }
        const sentAt = elapsed();
        note(`${step.label}: ${target.name}`, { id: target.id });
        await track(broker.cancelOrder(plan.accountId, target.id))
          .then(() => results.push({ id: target.id!, ok: true, ms: elapsed() - sentAt }))
          .catch(reason => results.push({ id: target.id!, ok: false, error: errorText(reason), ms: elapsed() - sentAt }));
      }
      note(`${step.label} výsledky`, results);
      if (step.abortIfFailed && results.some(result => !result.ok)) throw new StepAbort(`${step.label}: zrušení nepotvrzené, další krok by nic nedokázal`);
      await after(step, { before, results });
    };

    const liquidateStep = async (step: Extract<DemoStep, { kind: 'liquidate' }>) => {
      const t = elapsed();
      sentAnything = true;
      note(step.label);
      const result = await track(broker.liquidatePosition!({ tag: `${newTag()}x`, accountId: plan.accountId, symbol: plan.symbol }))
        .catch(reason => ({ status: 'error' as const, reason: errorText(reason) }));
      if (result.status === 'submitted' && result.brokerOrderId) ownIds.add(Number(result.brokerOrderId));
      liquidations.set(step.ref, { t, result });
      note(`${step.label} výsledek (${elapsed() - t} ms)`, result);
      await after(step, {});
    };

    const netNow = async () => broker.listPositions(plan.accountId)
      .then(items => items.reduce((sum, position) => sum + Math.abs(position.netQuantity), 0)).catch(() => null);

    const runStep = async (step: DemoStep) => {
      checkAbort();
      switch (step.kind) {
        case 'place-oso': return placeOsoStep(step);
        case 'place-order': return placeOrderStep(step);
        case 'place-exit': return placeExitStep(step);
        case 'place-oco': return placeOcoStep(step);
        case 'modify': return modifyStep(step);
        case 'cancel': return cancelStep(step);
        case 'liquidate': return liquidateStep(step);
        case 'observe': return after(step, {});
        case 'sleep': note(step.label); return pause(step.ms);
        case 'wait-net': {
          for (let waited = 0; waited <= step.timeoutMs; waited += 500) {
            checkAbort();
            const net = await netNow();
            if (net === step.net) { note(`${step.label} (pozice ${net})`); return; }
            await sleep(500);
          }
          if (step.optional) { note(`${step.label}: pozice nedosáhla ${step.net} do ${step.timeoutMs} ms (neprůkazné)`); return; }
          throw new StepAbort(`${step.label}: pozice nedosáhla ${step.net} do ${step.timeoutMs} ms`);
        }
        case 'wait-fill': {
          const ticket = tickets.get(step.ticket);
          for (const deadline = elapsed() + step.timeoutMs; elapsed() < deadline;) {
            checkAbort();
            const observation = await observe();
            const entry = findOrder(observation, ticket?.ids.entry);
            if ((entry && (entry.status === 'filled' || entry.filledQuantity > 0)) || (observation.netPosition ?? 0) !== 0) {
              note(`${step.label}: vyplněno`, observation);
              return;
            }
            await sleep(1_000);
          }
          note(`${step.label}: nevyplněno do ${step.timeoutMs} ms — neprůkazné, zopakovat`);
          return;
        }
        case 'wait-quiet': {
          const liquidation = liquidations.get(step.liquidate);
          if (!liquidation) throw new StepAbort(`${step.label}: liquidate ${step.liquidate} neproběhl`);
          let quiet = false;
          for (;;) {
            checkAbort();
            const now = elapsed();
            if (now - Math.max(lastActivityT, liquidation.t) >= step.quietMs) { quiet = true; break; }
            if (now - liquidation.t >= step.maxMs) break;
            await sleep(250);
          }
          tails.push({ liquidate: step.liquidate, fromT: liquidation.t, toT: elapsed(), quiet });
          note(`${step.label}${quiet ? '' : ' — TICHO NENASTALO'}`, { lastActivityMs: Math.max(0, lastActivityT - liquidation.t), waitedMs: elapsed() - liquidation.t });
          return;
        }
        case 'require-flat': {
          const observation = await observe();
          const open = observation.orders?.filter(order => OPEN.has(order.status)) ?? null;
          if (observation.netPosition !== 0 || open == null || open.length) {
            throw new StepAbort(`${step.label}: účet není flat bez příkazů (pozice ${observation.netPosition}, otevřené ${open?.length ?? '?'})`);
          }
          note(step.label);
          return;
        }
      }
    };

    const cleanup = async (): Promise<ScaleInCleanupDecision> => {
      if (inFlight.size) {
        note('čekám na dokončení rozpracovaných zápisů');
        await Promise.race([Promise.allSettled([...inFlight]), sleep(50_000)]);
        if (inFlight.size) return { kind: 'unverified', reason: 'zápis po 50 s pořád běží — zkontroluj Tradovate' };
      }
      let liquidated = 0;
      let lastNet: number | null = null;
      let cleanSeen = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const observation = await observe();
        note('stav (úklid)', observation);
        const decision = decideScaleInCleanup(observation, entryIds);
        if (decision.kind === 'clean') {
          if (!writeUncertain || cleanSeen) return decision;
          cleanSeen = true;
          note('zápis skončil výjimkou — čekám 5 s na druhou kontrolu');
          await sleep(5_000);
          continue;
        }
        cleanSeen = false;
        // Liquidate jen po novém pozorování pozice (např. se mezitím vyplnil vstup) — nejvýš 2×, nikdy slepě.
        if (decision.kind === 'liquidate' && liquidated < 2 && observation.signedNet !== lastNet) {
          liquidated += 1;
          lastNet = observation.signedNet;
          note('liquidate (úklid)');
          await broker.liquidatePosition!({ tag: `${newTag()}x`, accountId: plan.accountId, symbol: plan.symbol })
            .then(result => {
              if (result.status === 'submitted' && result.brokerOrderId) ownIds.add(Number(result.brokerOrderId));
              note('liquidate výsledek (úklid)', result);
            })
            .catch(reason => note('liquidate selhal (úklid)', errorText(reason)));
        } else if (decision.kind === 'cancel') {
          for (const id of decision.ids) {
            note('cancel (úklid)', id);
            await broker.cancelOrder(plan.accountId, id).catch(reason => note('cancel selhal (úklid)', errorText(reason)));
          }
        }
        await sleep(1_500);
      }
      return { kind: 'unverified', reason: 'účet po úklidu není ověřeně flat bez příkazů' };
    };

    // Před scénářem: ARMED gate a REST flat bez příkazů — jinak se nic nepošle.
    try {
      await gate(`start ${scenario.name}`);
    } catch (reason) {
      return { ...base, started: false, aborted: errorText(reason), outcome: { kind: 'clean' }, endT: elapsed() };
    }
    const [beforeOrders, beforePositions] = await Promise.all([
      broker.listOrders(plan.accountId, { fresh: true }).catch(() => null),
      broker.listPositions(plan.accountId).catch(() => null),
    ]);
    if (beforeOrders == null || beforePositions == null
      || beforeOrders.some(order => OPEN.has(order.status)) || beforePositions.some(position => position.netQuantity !== 0)) {
      return { ...base, started: false, aborted: 'účet není ověřeně flat bez příkazů — nic se neposlalo', outcome: { kind: 'unverified', reason: 'start' }, endT: elapsed() };
    }
    beforeIds = new Set(beforeOrders.map(order => order.brokerOrderId));
    note(`start: ${scenario.purpose}`);

    let aborted: string | null = null;
    try {
      for (const step of scenario.steps) await runStep(step);
    } catch (reason) {
      aborted = errorText(reason);
      note(`PŘERUŠENO: ${aborted}`);
    }
    const outcome = await cleanup();
    note(`úklid: ${outcome.kind}`);
    return { ...base, started: true, aborted, outcome, endT: elapsed() };
  }

  async function writeRecording(scenario: DemoScenario, result: ScenarioResult) {
    const context = { orderIds: result.ownIds, commandIds: new Set<number>(), accountMap };
    const timeline: DemoTimelineEntity[] = frames
      .filter(frame => frame.t >= result.startT && frame.t <= result.endT)
      .flatMap(frame => [
        ...sanitizeRecordedFrame(frame.data, context).map(item => ({ t: frame.t, ...item })),
        ...leaderExtraEntities(frame.data, accountMap, LEADER_PLACEHOLDER_ID).map(item => ({ t: frame.t, ...item })),
      ]);
    const sanitizedEvents = events
      .filter(item => item.t >= result.startT && item.t <= result.endT)
      .filter(item => (item.event.type === 'order' && result.ownIds.has(Number(item.event.order.brokerOrderId)))
        || (item.event.type === 'fill' && result.ownIds.has(Number(item.event.fill.brokerOrderId)))
        || (item.event.type === 'position' && item.event.position.accountId === plan.accountId))
      .map(item => {
        const tag = item.event.type === 'order' ? item.event.order.tag : item.event.type === 'fill' ? item.event.fill.tag : undefined;
        return {
          t: item.t,
          ...(item.event.type === 'position' ? {} : { tagMatchesOwn: typeof tag === 'string' && [...ownTags].some(own => tag.startsWith(own)) }),
          event: JSON.parse(JSON.stringify(item.event, (key, value) =>
            key === 'tag' ? undefined : key === 'accountId' ? (accountMap.get(Number(value)) ?? 0) : value)),
        };
      });
    const recording = {
      version: 4,
      script: options.script,
      recordedAt: new Date(startedAt + result.startT).toISOString(),
      scenario: scenario.name,
      purpose: scenario.purpose,
      symbol: plan.symbol,
      side: plan.side,
      outcome: result.outcome,
      aborted: result.aborted,
      skipped: result.skipped,
      plan: scenario.steps,
      tickets: Object.fromEntries([...result.tickets].map(([name, ticket]) => [name, { side: ticket.side, entryType: ticket.entryType, ids: ticket.ids, placed: ticket.placed }])),
      plain: Object.fromEntries([...result.plain].map(([name, order]) => [name, { id: order.id, side: order.side, orderType: order.orderType, price: order.price, reducing: order.reducing }])),
      acks: result.acks,
      findings: result.findings,
      analyses: {
        tails: result.tails.map(tail => ({ ...tail, ...liquidationTail(timeline, tail.fromT, tail.toT) })),
        reverse: result.reverseMarks.map(mark => ({
          liquidate: mark.liquidate,
          ...reverseOrdering(timeline, new Set(mark.oldIds), new Set(mark.newIds), mark.sentT),
        })),
      },
      log,
      events: sanitizedEvents,
      frames: timeline,
    };
    const serialized = `${JSON.stringify(recording, null, 2)}\n`;
    const leaks = leakedIdentifiers(serialized, identifiers);
    if (leaks.length) throw new Error(`záznam obsahuje ${leaks.length} identifikátor(ů) účtu — neuloženo`);
    if (containsSecret(serialized)) throw new Error('záznam obsahuje řetězec podobný tokenu — neuloženo');
    const directoryPath = join(COPIER_DIR, 'recordings');
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const stamp = new Date(startedAt + result.startT).toISOString().replace(/[:.]/g, '-');
    const path = join(directoryPath, `${options.filePrefix}-${scenario.name}-${stamp}.json`);
    await writeFile(path, serialized, { mode: 0o600 });
    console.log(`Záznam (mimo repo, ke kontrole): ${path} — ${timeline.length} entit z WS, ${sanitizedEvents.length} eventů, ${result.findings.length} zjištění`);
  }
}

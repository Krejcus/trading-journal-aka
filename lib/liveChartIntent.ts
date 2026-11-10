import { LIVE_WORKING_OWNER, type LiveWorkingOrderLine } from './liveWorkingOrderLines';
import type { LiveChartPosition } from './liveChartPosition';
import { isLiveCommandNotSent } from './liveCommandErrors';

/**
 * Čekající záměr v LIVE grafu (10. 11. 2026): po kliknutí (Market/Limit vstup, přidat /
 * posunout / odebrat SL/TP, BE, zavření, zrušení vstupu) hned tlumená tečkovaná čára
 * „odesílám“. JEN ZOBRAZENÍ (INV-UI-01/03):
 *
 * - Záměr vzniká synchronně v deskovém callbacku (před prvním `await`), je vázaný na
 *   `operationId` příkazu a sdílí ho PC graf i telefonní graf téhož desku (kanál
 *   `workingOrders`, čáry `live-working` s `displayOnly` — handlery je ignorují, nic z nich
 *   neodejde k brokerovi ani do „co jsem viděl“).
 * - ACK workeru čáru NEPOTVRDÍ jako ochranu: zůstává tlumená („přijato · čekám na stav
 *   brokera“), dokud cenu neukáže read model brokera (pak skutečná čára) nebo nevyprší.
 * - Odmítnutí / blokace / „nic se neodeslalo“ = čára hned zmizí (návrat).
 * - Neznámý výsledek = „výsledek neznámý“ a po čase zmizí; nic se neopakuje.
 * - Odebrání SL/TP nesahá na skutečnou čáru: ta zůstává, dokud ji read model neodebere.
 */

export type LiveChartIntentKind =
  | 'entry'
  | 'move-stop' | 'move-target' | 'move-limit'
  | 'add-stop' | 'add-target' | 'attach'
  | 'remove-stop' | 'remove-target'
  | 'close' | 'cancel-entry';

export type LiveChartIntentState = 'sending' | 'acknowledged' | 'unknown';

export interface LiveChartIntentLeg { role: 'entry' | 'stopLoss' | 'takeProfit'; price: number }

export interface LiveChartIntentDraft {
  kind: LiveChartIntentKind;
  symbol: string;
  side: 'long' | 'short';
  quantity?: number | null;
  /** „MARKET“, „LIMIT“ — jen štítek vstupu. */
  orderType?: string | null;
  /** Kde kreslit tlumenou čáru; prázdné = nic ke kreslení (záměr se jen eviduje). */
  legs: readonly LiveChartIntentLeg[];
  /**
   * `operationId` příkazu, který tento klik odešle — POVINNÝ a známý předem na všech cestách
   * (vstup, správa, skupina, holé nohy, × holé pozice). Je klíčem záměru: výsledek, timeout
   * i pozdní odpověď se párují jen přes něj.
   */
  operationId: string;
  /**
   * Tvar pozice grafu (druh, strana, množství — žádné ceny, P&L ani mark) v okamžiku kliku:
   * stará pozice nesmí „potvrdit“ nový vstup; potvrdí ho jen změna tvaru nebo důkaz workeru.
   */
  baselinePosition?: LiveChartPositionBaseline | null;
}

export interface LiveChartIntent extends LiveChartIntentDraft {
  state: LiveChartIntentState;
  /** Relay požadavek s tímto `operationId` opravdu odešel (`markSent`). */
  sent: boolean;
  createdAt: number;
  settledAt: number | null;
}

/** Odeslání čeká na relay (až ~35 s) — déle se „odesílám“ netvrdí. */
export const LIVE_INTENT_SENDING_MAX_MS = 45_000;
/** Po ACK / neznámém výsledku čára vydrží nejvýš tolik, pak platí jen read model brokera. */
export const LIVE_INTENT_SETTLED_HOLD_MS = 20_000;

export type LiveChartIntentOutcome =
  | { status: 'acknowledged' | 'unknown' }
  | { status: 'rejected' | 'blocked' | 'abandoned' | 'not-sent' };

export interface LiveChartIntentStore {
  /** Založí (nebo nahradí) záměr s `draft.operationId`; vrací ho. */
  begin(draft: LiveChartIntentDraft): string;
  /** Relay požadavek s tímto `operationId` odchází — od teď výjimka = výsledek neznámý. */
  markSent(operationId: string): void;
  /** Uzavře záměr výsledkem; neznámé / prošlé `operationId` = nic (pozdní odpověď nic neoživí). */
  settle(operationId: string, outcome: LiveChartIntentOutcome): void;
  /** Smaže splněné (read model ukazuje cíl) a prošlé záměry. */
  prune(now: number, position: LiveChartPosition | null | undefined, evidence?: LiveChartIntentEvidence): void;
  snapshot(): readonly LiveChartIntent[];
  subscribe(listener: () => void): () => void;
}

export function createLiveChartIntentStore(options: { now?: () => number } = {}): LiveChartIntentStore {
  const now = options.now ?? Date.now;
  let intents: readonly LiveChartIntent[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: readonly LiveChartIntent[]) => {
    if (next === intents) return;
    intents = next;
    for (const listener of [...listeners]) listener();
  };
  const update = (operationId: string, change: (intent: LiveChartIntent) => LiveChartIntent | null) => {
    if (!intents.some(intent => intent.operationId === operationId)) return;
    publish(intents.flatMap(intent => {
      if (intent.operationId !== operationId) return [intent];
      const next = change(intent);
      return next ? [next] : [];
    }));
  };
  return {
    begin(draft) {
      // Týž operationId je týž příkaz: už založený záměr (i jeho `sent`) se nepřepisuje.
      if (intents.some(intent => intent.operationId === draft.operationId)) return draft.operationId;
      publish([...intents, {
        ...draft, legs: draft.legs.filter(leg => Number.isFinite(leg.price)),
        state: 'sending', sent: false, createdAt: now(), settledAt: null,
      }]);
      return draft.operationId;
    },
    markSent(operationId) {
      update(operationId, intent => (intent.sent ? intent : { ...intent, sent: true }));
    },
    settle(operationId, outcome) {
      update(operationId, intent => (outcome.status === 'acknowledged' || outcome.status === 'unknown'
        ? { ...intent, state: outcome.status, settledAt: now() }
        : null));
    },
    prune(at, position, evidence) {
      const next = intents.filter(intent => !intentExpired(intent, at) && !intentLanded(intent, position, evidence));
      if (next.length !== intents.length) publish(next);
    },
    snapshot: () => intents,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export function intentExpired(intent: LiveChartIntent, now: number): boolean {
  if (intent.state === 'sending') return now - intent.createdAt > LIVE_INTENT_SENDING_MAX_MS;
  return intent.settledAt != null && now - intent.settledAt > LIVE_INTENT_SETTLED_HOLD_MS;
}

/** Tvar pozice pro potvrzení vstupu — jen druh, strana a množství, nikdy ceny / P&L / mark. */
export interface LiveChartPositionBaseline { kind: 'position' | 'pending'; side: 'long' | 'short'; quantity: number }

export function liveChartPositionBaseline(position: LiveChartPosition | null | undefined): LiveChartPositionBaseline | null {
  const summary = position?.summary;
  return summary ? { kind: summary.kind, side: summary.side, quantity: summary.quantity } : null;
}

/** Důkaz workeru / brokera k záměrům: `operationId` vstupů, které worker už má u brokera (příkaz nebo fill). */
export interface LiveChartIntentEvidence { workerEntryOperationIds?: ReadonlySet<string> }

/**
 * Vstupy, ke kterým worker hlásí příkaz u brokera nebo fill (`controller.manualEntries`:
 * `entryBrokerOrderId`, `timing.orderAt` / `fillAt` / `positionAt`). Jen zobrazení.
 */
export function liveChartWorkerEntryEvidence(entries: ReadonlyArray<{
  operationId: string; entryBrokerOrderId?: string;
  timing?: { orderAt?: number; fillAt?: number; positionAt?: number };
}> | null | undefined): Set<string> {
  return new Set((entries ?? []).filter(entry => entry.entryBrokerOrderId != null
    || entry.timing?.orderAt != null || entry.timing?.fillAt != null || entry.timing?.positionAt != null).map(entry => entry.operationId));
}

const shapeChanged = (before: LiveChartPositionBaseline | null | undefined, now: LiveChartPositionBaseline) => (
  before == null || before.kind !== now.kind || before.side !== now.side || before.quantity !== now.quantity);

const samePrice = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Math.abs(a - b) < 1e-9;
const legPrice = (intent: LiveChartIntent, role: LiveChartIntentLeg['role']) => intent.legs.find(leg => leg.role === role)?.price ?? null;

/**
 * Read model brokera už ukazuje cíl záměru → tlumená čára není potřeba (skutečná čára
 * ji nahradí). Jen ověřený, ne neověřený pohled (`summary.unverified`), a jen týž kontrakt.
 * Při odeslání (`sending`) se nic nesmaže — cíl mohl být vidět už před klikem. Vstup se
 * potvrdí jen důkazem workeru se shodným `operationId` nebo změnou tvaru pozice (druh/strana/
 * množství) proti stavu při kliku — nikdy cenou, P&L ani mark.
 */
export function intentLanded(intent: LiveChartIntent, position: LiveChartPosition | null | undefined, evidence: LiveChartIntentEvidence = {}): boolean {
  if (intent.state === 'sending') return false;
  if (!position || position.issue != null) return false;
  const summary = position.summary;
  // Vstup (DEMO 10. 11.: čáry záměru mizely 200–250 ms před pozicí): záměr zmizí, až když ho
  // NAHRADÍ nakreslená pozice / čekající příkaz téže strany na tomtéž kontraktu (i „neověřeno“
  // — čáry jsou vidět) A zároveň je tu důkaz workeru se shodným operationId nebo změna tvaru
  // pozice. Samotný důkaz workeru bez nakreslené pozice záměr nesmaže.
  if (intent.kind === 'entry') {
    if (!summary || position.symbol !== intent.symbol || summary.side !== intent.side || intent.baselinePosition === undefined) return false;
    const shape = shapeChanged(intent.baselinePosition, liveChartPositionBaseline(position)!);
    const workerEvidence = evidence.workerEntryOperationIds?.has(intent.operationId) === true;
    return shape || (workerEvidence && intent.baselinePosition == null);
  }
  if (summary?.unverified === true) return false;
  if (summary == null) return (intent.kind === 'close' || intent.kind === 'cancel-entry') && position.key === 'none';
  if (position.symbol !== intent.symbol) return false;
  switch (intent.kind) {
    case 'move-stop': case 'add-stop': return samePrice(summary.stop, legPrice(intent, 'stopLoss'));
    case 'move-target': case 'add-target': return samePrice(summary.target, legPrice(intent, 'takeProfit'));
    case 'attach': return samePrice(summary.stop, legPrice(intent, 'stopLoss')) && samePrice(summary.target, legPrice(intent, 'takeProfit'));
    case 'move-limit': return summary.kind === 'pending' && samePrice(summary.entry, legPrice(intent, 'entry'));
    case 'remove-stop': return summary.stop == null && summary.rows.every(row => row.stopCoverage === 0);
    case 'remove-target': return summary.target == null && summary.rows.every(row => row.targetCoverage === 0);
    default: return false;
  }
}

/**
 * Obal deskového odeslání. Záměr vznikne synchronně (před prvním `await` volajícího) pod
 * `draft.operationId`; desk ho při odchodu relay požadavku označí `markSent`. Uzavření:
 * - výsledek se stejným `operationId`: ACK / neznámý drží čáru, odmítnutí / blokace ji vrátí;
 *   výsledek s JINÝM `operationId` (nemá nastat) = neznámý, nic se nepáruje naslepo;
 * - výjimka: když požadavek prokazatelně neodešel (`markSent` nebyl, nebo chyba nese kód
 *   `not-sent` — `LiveCommandNotSentError`), čára zmizí; jinak výsledek neznámý.
 *   Rozhoduje stav a typ chyby, NIKDY text.
 * Výsledek ani výjimku nemění — vrací / hází přesně to, co `run`.
 */
export async function trackLiveChartIntent<R extends { status: string; operationId?: string }>(
  store: LiveChartIntentStore | null | undefined,
  draft: LiveChartIntentDraft | null,
  run: () => Promise<R>,
): Promise<R> {
  const operationId = store && draft ? store.begin(draft) : null;
  try {
    const result = await run();
    if (operationId) {
      const matches = result.operationId == null || result.operationId === operationId;
      const status = !matches ? 'unknown'
        : result.status === 'acknowledged' || result.status === 'unknown' ? result.status
        : result.status === 'rejected' || result.status === 'blocked' || result.status === 'abandoned' ? result.status : 'unknown';
      store!.settle(operationId, { status } as LiveChartIntentOutcome);
    }
    return result;
  } catch (reason) {
    if (operationId) {
      const sent = store!.snapshot().find(intent => intent.operationId === operationId)?.sent === true;
      store!.settle(operationId, { status: sent && !isLiveCommandNotSent(reason) ? 'unknown' : 'not-sent' });
    }
    throw reason;
  }
}

const INTENT_COLOR = '#94a3b8';

const kindLabel = (intent: LiveChartIntent, leg: LiveChartIntentLeg): string => {
  const legName = leg.role === 'stopLoss' ? 'SL' : leg.role === 'takeProfit' ? 'TP' : '';
  switch (intent.kind) {
    case 'entry': return leg.role === 'entry'
      ? `${intent.side === 'long' ? 'BUY' : 'SELL'}${intent.quantity ? ` ${intent.quantity}` : ''}${intent.orderType ? ` ${intent.orderType.toUpperCase()}` : ''}`
      : `${legName} vstupu`;
    case 'move-stop': case 'move-target': return `${legName} →`;
    case 'move-limit': return 'LIMIT →';
    case 'add-stop': case 'add-target': case 'attach': return `+ ${legName}`;
    case 'remove-stop': case 'remove-target': return `ruším ${legName}`;
    case 'close': return 'ZAVÍRÁM';
    case 'cancel-entry': return 'RUŠÍM VSTUP';
    default: return legName;
  }
};

const stateLabel = (state: LiveChartIntentState) => (state === 'sending' ? 'odesílám'
  : state === 'acknowledged' ? 'přijato · čekám na stav brokera' : 'výsledek neznámý — zkontroluj Tradovate');

/**
 * Tlumené čáry záměrů jednoho kontraktu. Struktura `LiveWorkingOrderLine` (owner `live-working`,
 * `displayOnly`, netáhne se, nejde zrušit) → PC i telefon je kreslí jako čáry jen pro zobrazení.
 * Barva nikdy ne SL/TP: ACK ani neznámý výsledek nedělají z čáry potvrzenou ochranu.
 */
export function liveChartIntentLines(intents: readonly LiveChartIntent[], symbol: string | null): LiveWorkingOrderLine[] {
  if (!symbol) return [];
  return intents.filter(intent => intent.symbol === symbol).flatMap(intent => intent.legs.map((leg): LiveWorkingOrderLine => {
    const text = `${kindLabel(intent, leg)}  ${leg.price.toFixed(2)} · ${stateLabel(intent.state)}`;
    return {
      id: `${LIVE_WORKING_OWNER}:intent:${intent.operationId}:${leg.role}`,
      ownerId: LIVE_WORKING_OWNER,
      ownerType: 'order',
      kind: leg.role,
      price: leg.price,
      color: INTENT_COLOR,
      label: text,
      title: `Čekající záměr (${intent.operationId}) — jen zobrazení, skutečný stav ukazuje broker.`,
      draggable: false,
      cancellable: false,
      displayOnly: true,
      lineStyle: 'dotted',
      role: leg.role === 'stopLoss' ? 'stop-leg' : leg.role === 'takeProfit' ? 'target-leg' : 'order',
      side: (leg.role === 'entry') === (intent.side === 'long') ? 'buy' : 'sell',
      orderClass: 'limit',
      quantity: intent.quantity ?? 0,
      accountId: 0,
      orderIds: [intent.operationId],
    };
  }));
}

/** Přidá čáry záměrů k pracujícím příkazům grafu; obsahový klíč se mění jen se změnou čar. */
export function withLiveChartIntentLines<T extends { lines: LiveWorkingOrderLine[]; badges: unknown[]; key: string; contract: string | null }>(
  view: T,
  intents: readonly LiveChartIntent[],
  fallbackContract: string | null,
): T {
  const contract = view.contract ?? fallbackContract;
  const lines = liveChartIntentLines(intents, contract);
  if (lines.length === 0) return view;
  return {
    ...view,
    contract,
    lines: [...view.lines, ...lines],
    key: JSON.stringify([view.key, lines.map(line => [line.id, line.price, line.label])]),
  };
}

const sideOf = (side: 'Buy' | 'Sell' | 'long' | 'short'): 'long' | 'short' => (side === 'Buy' || side === 'long' ? 'long' : 'short');
const leg = (role: LiveChartIntentLeg['role'], price: number | null | undefined): LiveChartIntentLeg[] => (
  price != null && Number.isFinite(price) ? [{ role, price }] : []);

/** Záměr ručního vstupu (Market na ceně, kterou uživatel viděl; Limit/Stop na ceně příkazu). */
export function entryIntentDraft(draft: {
  symbol: string; side: 'Buy' | 'Sell'; quantity: number; orderType: string;
  price?: number; referencePrice?: number; stopLoss?: number; takeProfit?: number;
}, operationId: string, baselinePosition: LiveChartPositionBaseline | null): LiveChartIntentDraft {
  return {
    kind: 'entry', symbol: draft.symbol, side: sideOf(draft.side), quantity: draft.quantity, orderType: draft.orderType, operationId, baselinePosition,
    legs: [
      ...leg('entry', draft.orderType === 'Market' ? draft.referencePrice : draft.price),
      ...leg('stopLoss', draft.stopLoss),
      ...leg('takeProfit', draft.takeProfit),
    ],
  };
}

/** Záměr správy leadera z čar / panelu / zkratek (`manage-leader-order`). null = nic ke kreslení. */
export function manageIntentDraft(action: string, input: {
  symbol: string | null | undefined; side: 'long' | 'short' | null | undefined; expectPrice: number;
  newPrice?: number; entry?: number | null; quantity?: number | null; operationId: string;
}): LiveChartIntentDraft | null {
  if (!input.symbol || !input.side) return null;
  const base = { symbol: input.symbol, side: input.side, quantity: input.quantity ?? null, operationId: input.operationId };
  switch (action) {
    case 'move-stop': return { ...base, kind: 'move-stop', legs: leg('stopLoss', input.newPrice) };
    case 'move-target': return { ...base, kind: 'move-target', legs: leg('takeProfit', input.newPrice) };
    case 'move-limit': return { ...base, kind: 'move-limit', legs: leg('entry', input.newPrice) };
    case 'close-position': return { ...base, kind: 'close', legs: leg('entry', input.entry ?? input.expectPrice) };
    case 'cancel-entry': return { ...base, kind: 'cancel-entry', legs: leg('entry', input.expectPrice) };
    default: return null;
  }
}

/** Záměr SL a TP po jedné (`manual-order-single-leg-v1`): přidat, posunout, odebrat. */
export function bareLegIntentDraft(
  seen: { symbol: string; side: 'Buy' | 'Sell'; quantity: number },
  intent: { kind: 'add' | 'move' | 'remove'; leg: 'stopLoss' | 'takeProfit'; price?: number; stop?: number | null; target?: number | null },
  operationId: string,
): LiveChartIntentDraft {
  const stop = intent.leg === 'stopLoss';
  const kind: LiveChartIntentKind = intent.kind === 'add' ? (stop ? 'add-stop' : 'add-target')
    : intent.kind === 'move' ? (stop ? 'move-stop' : 'move-target') : (stop ? 'remove-stop' : 'remove-target');
  // Odebrání kreslí „ruším“ na dosavadní ceně; skutečná čára z read modelu zůstává.
  const price = intent.kind === 'remove' ? (stop ? intent.stop : intent.target) : intent.price;
  return { kind, symbol: seen.symbol, side: sideOf(seen.side), quantity: seen.quantity, legs: leg(intent.leg, price), operationId };
}

export function attachIntentDraft(input: { symbol: string; side: 'long' | 'short' | null | undefined; quantity: number; stopLoss: number; takeProfit: number }, operationId: string): LiveChartIntentDraft | null {
  if (!input.side) return null;
  return { kind: 'attach', symbol: input.symbol, side: input.side, quantity: input.quantity, operationId,
    legs: [...leg('stopLoss', input.stopLoss), ...leg('takeProfit', input.takeProfit)] };
}

export function closeBareIntentDraft(seen: { symbol: string; side: 'Buy' | 'Sell'; quantity: number; referencePrice: number }, entry: number | null | undefined, operationId: string): LiveChartIntentDraft {
  return { kind: 'close', symbol: seen.symbol, side: sideOf(seen.side), quantity: seen.quantity, legs: leg('entry', entry ?? seen.referencePrice), operationId };
}

import { LIVE_WORKING_OWNER, type LiveWorkingOrderLine } from './liveWorkingOrderLines';
import { MNQ_TICK, type LiveChartPosition } from './liveChartPosition';
import { isLiveChartNotSent } from './liveChartNotSent';

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
 * - Záměr žije jen v téhle instanci desku. Druhé zařízení (telefon / jiný prohlížeč) ho
 *   nevidí a nesmí ho mít z čeho vykreslit jako potvrzenou cenu: kreslí jen sdílenou
 *   projekci workeru. Sdílený zámek záměrů by potřeboval nový kanál a starý záměr
 *   na druhém zařízení by vypadal jako druhý příkaz — proto se nesdílí.
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
  /** Je-li známé předem (vstup, správa z desku); jinak se doplní z výsledku. */
  operationId?: string | null;
  /**
   * Kusy pozice v okamžiku kliku (0 = flat). Přikoupení „přistane“, až když se
   * pozice zvětší o qty příkazu — shoda strany sama nestačí.
   */
  baselineQuantity?: number | null;
}

export interface LiveChartIntent extends LiveChartIntentDraft {
  id: string;
  operationId: string | null;
  state: LiveChartIntentState;
  createdAt: number;
  settledAt: number | null;
}

/** Odeslání čeká na relay (až ~35 s) — déle se „odesílám“ netvrdí. */
export const LIVE_INTENT_SENDING_MAX_MS = 45_000;
/** Po ACK / neznámém výsledku čára vydrží nejvýš tolik, pak platí jen read model brokera. */
export const LIVE_INTENT_SETTLED_HOLD_MS = 20_000;

export type LiveChartIntentOutcome =
  | { status: 'acknowledged' | 'unknown'; operationId?: string | null }
  | { status: 'rejected' | 'blocked' | 'abandoned' | 'not-sent'; operationId?: string | null };

export interface LiveChartIntentStore {
  begin(draft: LiveChartIntentDraft): string;
  settle(id: string, outcome: LiveChartIntentOutcome): void;
  /** Smaže splněné (read model ukazuje cíl) a prošlé záměry. */
  prune(now: number, position: LiveChartPosition | null | undefined): void;
  snapshot(): readonly LiveChartIntent[];
  subscribe(listener: () => void): () => void;
}

export function createLiveChartIntentStore(options: { now?: () => number; newId?: () => string } = {}): LiveChartIntentStore {
  const now = options.now ?? Date.now;
  let seq = 0;
  const newId = options.newId ?? (() => `intent-${Date.now().toString(36)}-${(seq += 1)}`);
  let intents: readonly LiveChartIntent[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: readonly LiveChartIntent[]) => {
    if (next === intents) return;
    intents = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    begin(draft) {
      const id = newId();
      publish([...intents, {
        ...draft, legs: draft.legs.filter(leg => Number.isFinite(leg.price)),
        id, operationId: draft.operationId ?? null, state: 'sending', createdAt: now(), settledAt: null,
      }]);
      return id;
    },
    settle(id, outcome) {
      const current = intents.find(intent => intent.id === id);
      if (!current) return;
      if (outcome.status === 'acknowledged' || outcome.status === 'unknown') {
        publish(intents.map(intent => (intent.id === id ? {
          ...intent, state: outcome.status as LiveChartIntentState, settledAt: now(),
          // Skutečné id příkazu z výsledku má přednost (skupinová cesta generuje vlastní).
          operationId: outcome.operationId ?? intent.operationId ?? null,
        } : intent)));
      } else {
        publish(intents.filter(intent => intent.id !== id));
      }
    },
    prune(at, position) {
      const next = intents.filter(intent => !intentExpired(intent, at) && !intentLanded(intent, position));
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

/** Stejný tick (MNQ 0.25). Přesná shoda 1e-9 nechávala čáru viset po zaokrouhlení ceny. */
export function sameTick(a: number | null | undefined, b: number | null | undefined, tick = MNQ_TICK): boolean {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || !(tick > 0)) return false;
  return Math.round(a / tick) === Math.round(b / tick);
}
const legPrice = (intent: LiveChartIntent, role: LiveChartIntentLeg['role']) => intent.legs.find(leg => leg.role === role)?.price ?? null;

/**
 * Read model brokera už ukazuje cíl záměru → tlumená čára není potřeba (skutečná čára
 * ji nahradí). Jen ověřený, ne neověřený pohled (`summary.unverified`), a jen týž kontrakt.
 * Při odeslání (`sending`) se nic nesmaže — cíl mohl být vidět už před klikem.
 */
export function intentLanded(intent: LiveChartIntent, position: LiveChartPosition | null | undefined): boolean {
  if (intent.state === 'sending' || !position || position.issue != null) return false;
  const summary = position.summary;
  if (summary?.unverified === true) return false;
  if (summary == null) return (intent.kind === 'close' || intent.kind === 'cancel-entry') && position.key === 'none';
  if (position.symbol !== intent.symbol) return false;
  switch (intent.kind) {
    case 'entry': {
      if (summary.kind !== 'position' || summary.side !== intent.side) return false;
      const orderQty = intent.quantity;
      const baseline = intent.baselineQuantity;
      if (orderQty == null || !(orderQty > 0) || baseline == null || !Number.isFinite(baseline)) return false;
      if (summary.quantity < baseline + orderQty) return false;
      const stop = legPrice(intent, 'stopLoss');
      const target = legPrice(intent, 'takeProfit');
      if (stop != null && !sameTick(summary.stop, stop)) return false;
      if (target != null && !sameTick(summary.target, target)) return false;
      return true;
    }
    case 'move-stop': case 'add-stop': return sameTick(summary.stop, legPrice(intent, 'stopLoss'));
    case 'move-target': case 'add-target': return sameTick(summary.target, legPrice(intent, 'takeProfit'));
    case 'attach': return sameTick(summary.stop, legPrice(intent, 'stopLoss')) && sameTick(summary.target, legPrice(intent, 'takeProfit'));
    case 'move-limit': return summary.kind === 'pending' && sameTick(summary.entry, legPrice(intent, 'entry'));
    case 'remove-stop': return summary.stop == null && summary.rows.every(row => row.stopCoverage === 0);
    case 'remove-target': return summary.target == null && summary.rows.every(row => row.targetCoverage === 0);
    case 'close': case 'cancel-entry': return false;
    default: return false;
  }
}

/**
 * Obal deskového odeslání: záměr vznikne synchronně (před prvním `await` volajícího),
 * výsledek ho uzavře. Výjimka s „nic se neodeslalo“ = návrat, jiná = neznámý výsledek.
 * Výsledek ani výjimku nemění — vrací / hází přesně to, co `run`.
 */
export async function trackLiveChartIntent<R extends { status: string; operationId?: string }>(
  store: LiveChartIntentStore | null | undefined,
  draft: LiveChartIntentDraft | null,
  run: () => Promise<R>,
): Promise<R> {
  const id = store && draft ? store.begin(draft) : null;
  try {
    const result = await run();
    if (id) {
      const status = result.status === 'acknowledged' || result.status === 'unknown' ? result.status
        : result.status === 'rejected' || result.status === 'blocked' || result.status === 'abandoned' ? result.status : 'unknown';
      store!.settle(id, { status, operationId: result.operationId ?? null } as LiveChartIntentOutcome);
    }
    return result;
  } catch (reason) {
    if (id) {
      store!.settle(id, { status: isLiveChartNotSent(reason) ? 'not-sent' : 'unknown' });
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
      id: `${LIVE_WORKING_OWNER}:intent:${intent.id}:${leg.role}`,
      ownerId: LIVE_WORKING_OWNER,
      ownerType: 'order',
      kind: leg.role,
      price: leg.price,
      color: INTENT_COLOR,
      label: text,
      title: `Čekající záměr${intent.operationId ? ` (${intent.operationId})` : ''} — jen zobrazení, skutečný stav ukazuje broker.`,
      draggable: false,
      cancellable: false,
      displayOnly: true,
      lineStyle: 'dotted',
      role: leg.role === 'stopLoss' ? 'stop-leg' : leg.role === 'takeProfit' ? 'target-leg' : 'order',
      side: (leg.role === 'entry') === (intent.side === 'long') ? 'buy' : 'sell',
      orderClass: 'limit',
      quantity: intent.quantity ?? 0,
      accountId: 0,
      orderIds: intent.operationId ? [intent.operationId] : [],
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
  /** Kusy pozice před klikem. 0 = vstup z flatu. Bez toho přikoupení „přistane“ hned. */
  baselineQuantity?: number | null;
}, operationId: string): LiveChartIntentDraft {
  return {
    kind: 'entry', symbol: draft.symbol, side: sideOf(draft.side), quantity: draft.quantity, orderType: draft.orderType, operationId,
    baselineQuantity: draft.baselineQuantity ?? 0,
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
): LiveChartIntentDraft {
  const stop = intent.leg === 'stopLoss';
  const kind: LiveChartIntentKind = intent.kind === 'add' ? (stop ? 'add-stop' : 'add-target')
    : intent.kind === 'move' ? (stop ? 'move-stop' : 'move-target') : (stop ? 'remove-stop' : 'remove-target');
  // Odebrání kreslí „ruším“ na dosavadní ceně; skutečná čára z read modelu zůstává.
  const price = intent.kind === 'remove' ? (stop ? intent.stop : intent.target) : intent.price;
  return { kind, symbol: seen.symbol, side: sideOf(seen.side), quantity: seen.quantity, legs: leg(intent.leg, price) };
}

export function attachIntentDraft(input: { symbol: string; side: 'long' | 'short' | null | undefined; quantity: number; stopLoss: number; takeProfit: number }): LiveChartIntentDraft | null {
  if (!input.side) return null;
  return { kind: 'attach', symbol: input.symbol, side: input.side, quantity: input.quantity,
    legs: [...leg('stopLoss', input.stopLoss), ...leg('takeProfit', input.takeProfit)] };
}

export function closeBareIntentDraft(seen: { symbol: string; side: 'Buy' | 'Sell'; quantity: number; referencePrice: number }, entry: number | null | undefined): LiveChartIntentDraft {
  return { kind: 'close', symbol: seen.symbol, side: sideOf(seen.side), quantity: seen.quantity, legs: leg('entry', entry ?? seen.referencePrice) };
}

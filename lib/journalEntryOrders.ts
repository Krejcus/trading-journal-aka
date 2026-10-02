import type { JournalEvidence, JournalProtectionEvent } from './tradovateJournalEvidence.js';

/**
 * Čekající vstupní příkazy obchodu (limit/stop): vyplněný vstupní příkaz
 * i limity a stopy zadané před vstupem a zrušené. Graf je kreslí jako příkaz
 * v TradingView — linka od zadání po vyplnění/zrušení, posun = schod.
 *
 * Zdroj jsou verze příkazů z Tradovate (projekce je hrubě třídí na `sl`
 * = Stop/StopLimit/Trailing a `tp` = Limit); tady se z nich stávají vstupy.
 */
export interface TradeEntryOrder {
  orderId: string;
  side: 'Buy' | 'Sell';
  type: 'Limit' | 'Stop';
  quantity: number | null;
  placedAt: number;
  /** Potvrzená zadání a posuny ceny v čase (první = zadání). */
  legs: Array<{ at: number; price: number }>;
  /** `null` = v době posledního pozorování ještě čekal. */
  end: { kind: 'fill' | 'cancel'; at: number } | null;
  /** Zamýšlený bracket (OSO) k příkazu — poslední potvrzené ceny. */
  bracket?: { sl: number | null; tp: number | null };
}

const MAX_ENTRY_ORDERS = 12;
/** Ruční OSO bez propojení: SL/TP vznikají v řádu milisekund po vstupním příkazu. */
const BRACKET_SIBLING_MS = 1_000;

export interface EntryOrderEpisode {
  accountId: number;
  contractId: number;
  /** Příkazy, jejichž plnění obchod otevřela/přikoupila, a čas jejich prvního plnění. */
  entryFillAtByOrder: ReadonlyMap<string, number>;
  /** SL/TP navázané na pozici (bracket, kopírka, samostatné) — nejsou vstupy. */
  protectiveOrderIds: ReadonlySet<string>;
}

/** Zrušený vstup bez pozice = samostatný nevzatý obchod (vlastní karta v Hodnotit). */
export interface JournalUntakenOrder extends TradeEntryOrder {
  accountId: number;
  contractId: number;
  symbol: string;
}

const legsOf = (events: readonly JournalProtectionEvent[]) => {
  const legs: Array<{ at: number; price: number }> = [];
  for (const event of events) {
    if (event.status !== 'confirmed' || event.operation === 'cancel' || event.price == null || !Number.isFinite(event.price)) continue;
    if (legs.length && Math.abs(legs[legs.length - 1].price - event.price) < 1e-9) continue;
    legs.push({ at: event.at, price: event.price });
  }
  return legs;
};

interface OrderContext {
  protectionByOrder: ReadonlyMap<string, readonly JournalProtectionEvent[]>;
  latest: ReadonlyMap<string, JournalEvidence>;
  childrenByParent: ReadonlyMap<string, readonly string[]>;
  /** Příkazy, které nesmí být bracketem (ochrana pozic, vstupy obchodů). */
  excluded: ReadonlySet<string>;
}

/** Vstupní příkaz z verzí Tradovate: ceny v čase a zamýšlený bracket. */
function buildEntryOrder(orderId: string, accountId: number, contractId: number, ctx: OrderContext,
  end: (events: readonly JournalProtectionEvent[]) => TradeEntryOrder['end'] | undefined): TradeEntryOrder | null {
  const order = ctx.latest.get(`order:${orderId}`)?.entity;
  if (!order || order.accountId !== accountId || order.contractId !== contractId || order.parentId != null) return null;
  const side = order.action;
  if (side !== 'Buy' && side !== 'Sell') return null;
  const sorted = [...(ctx.protectionByOrder.get(orderId) ?? [])].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const legs = legsOf(sorted);
  if (!legs.length) return null;
  const finish = end(sorted);
  if (finish === undefined) return null;
  // Bracket (OSO): děti přes parentId; Tradovate je u ručních OSO nemusí
  // propojit vůbec — pak SL/TP opačné strany vytvořené do 1 s po vstupu.
  let children = ctx.childrenByParent.get(`${accountId}:${orderId}`) ?? [];
  if (!children.length) {
    const created = Date.parse(String(order.timestamp ?? ''));
    if (Number.isFinite(created)) children = [...ctx.protectionByOrder.keys()].filter(id => {
      if (id === orderId || ctx.excluded.has(id)) return false;
      const sibling = ctx.latest.get(`order:${id}`)?.entity;
      const at = Date.parse(String(sibling?.timestamp ?? ''));
      return sibling != null && sibling.accountId === accountId && sibling.contractId === contractId
        && sibling.parentId == null && sibling.action !== side && (sibling.action === 'Buy' || sibling.action === 'Sell')
        && Number.isFinite(at) && at >= created && at - created <= BRACKET_SIBLING_MS;
    });
  }
  // OSO děti čekají („pending“), dokud se vstup nevyplní — cena platí i tak.
  const bracketPrice = (want: 'sl' | 'tp') => {
    const priced = children.flatMap(id => (ctx.protectionByOrder.get(id) ?? [])
      .filter(event => event.kind === want && event.status !== 'rejected' && event.operation !== 'cancel' && event.price != null && Number.isFinite(event.price)));
    return priced.length ? priced.sort((a, b) => a.at - b.at)[priced.length - 1].price : null;
  };
  const sl = bracketPrice('sl'), tp = bracketPrice('tp');
  return {
    orderId, side, type: sorted[0].kind === 'tp' ? 'Limit' : 'Stop', quantity: sorted.find(event => event.quantity != null)?.quantity ?? null,
    placedAt: legs[0].at, legs: finish ? legs.filter(leg => leg.at <= finish.at) : legs, end: finish,
    ...(sl != null || tp != null ? { bracket: { sl, tp } } : {}),
  };
}

/** Vstupní limit/stop obchodu (ten, který obchod otevřel nebo přikoupil). */
export function episodeEntryOrders(
  episode: EntryOrderEpisode,
  protectionByOrder: ReadonlyMap<string, readonly JournalProtectionEvent[]>,
  latest: ReadonlyMap<string, JournalEvidence>,
  childrenByParent: ReadonlyMap<string, readonly string[]>,
): TradeEntryOrder[] {
  const ctx: OrderContext = { protectionByOrder, latest, childrenByParent, excluded: episode.protectiveOrderIds };
  const result: TradeEntryOrder[] = [];
  for (const [orderId, fillAt] of episode.entryFillAtByOrder) {
    if (episode.protectiveOrderIds.has(orderId)) continue;
    const order = buildEntryOrder(orderId, episode.accountId, episode.contractId, ctx, () => ({ kind: 'fill', at: fillAt }));
    if (order) result.push(order);
  }
  return result.sort((a, b) => a.placedAt - b.placedAt || a.orderId.localeCompare(b.orderId)).slice(-MAX_ENTRY_ORDERS);
}

/**
 * Nevzaté obchody: vstupní limit/stop zadaný bez otevřené pozice a zrušený.
 * Vynechává kopie kopírky (patří leaderovi), čekající děti OSO (nemají
 * potvrzenou verzi), příkazy obchodů a příkazy bez SL i TP (Filip: bez
 * bracketu nejde poctivě říct, co by se stalo).
 */
export function journalUntakenOrders(input: {
  protectionByOrder: ReadonlyMap<string, readonly JournalProtectionEvent[]>;
  latest: ReadonlyMap<string, JournalEvidence>;
  childrenByParent: ReadonlyMap<string, readonly string[]>;
  /** Vstupy a ochrana všech obchodů. */
  usedOrderIds: ReadonlySet<string>;
  /** Příkazy vytvořené kopírkou (`účet:příkaz`). */
  copiedOrderKeys: ReadonlySet<string>;
  /** Doby otevřených pozic na účtu/kontraktu. */
  positionWindows: ReadonlyArray<{ accountId: number; contractId: number; from: number; to: number }>;
}): JournalUntakenOrder[] {
  const ctx: OrderContext = { ...input, excluded: input.usedOrderIds };
  const result: JournalUntakenOrder[] = [];
  for (const orderId of input.protectionByOrder.keys()) {
    if (input.usedOrderIds.has(orderId)) continue;
    const entity = input.latest.get(`order:${orderId}`)?.entity;
    const accountId = Number(entity?.accountId), contractId = Number(entity?.contractId);
    if (!Number.isFinite(accountId) || !Number.isFinite(contractId) || input.copiedOrderKeys.has(`${accountId}:${orderId}`)) continue;
    const order = buildEntryOrder(orderId, accountId, contractId, ctx, events => {
      const cancel = events.find(event => event.status === 'cancelled' && event.operation === 'cancel');
      return cancel ? { kind: 'cancel', at: cancel.at } : undefined;
    });
    if (!order || !order.bracket) continue;
    // Zadaný při otevřené pozici = přikoupení nebo výstup, ne nový obchod.
    if (input.positionWindows.some(window => window.accountId === accountId && window.contractId === contractId
      && order.placedAt >= window.from && order.placedAt < window.to)) continue;
    const contract = input.latest.get(`contract:${contractId}`)?.entity;
    result.push({ ...order, accountId, contractId, symbol: String(contract?.name ?? '') });
  }
  return result.sort((a, b) => a.placedAt - b.placedAt || a.orderId.localeCompare(b.orderId));
}

/** Přehrávání: příkazy tak, jak vypadaly v okamžiku `at`. */
export function entryOrdersAt(orders: readonly TradeEntryOrder[] | undefined, at: number): TradeEntryOrder[] | undefined {
  if (!orders) return undefined;
  return orders.filter(order => order.placedAt <= at).map(order => ({
    ...order,
    legs: order.legs.filter(leg => leg.at <= at),
    end: order.end && order.end.at <= at ? order.end : null,
  }));
}

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

/** Jak daleko před vstupem ještě hledat zrušené pokusy o vstup. */
export const ENTRY_ORDER_LOOKBACK_MS = 2 * 60 * 60_000;
const MAX_ENTRY_ORDERS = 12;
/** Ruční OSO bez propojení: SL/TP vznikají v řádu milisekund po vstupním příkazu. */
const BRACKET_SIBLING_MS = 1_000;

export interface EntryOrderEpisode {
  accountId: number;
  contractId: number;
  entryAt: number;
  /** Konec obchodu (nebo poslední pozorování otevřené pozice). */
  through: number;
  /** Výstup předchozí pozice na stejném účtu a kontraktu — dřívější příkazy patří jí. */
  previousExitAt: number | null;
  /** Příkazy, jejichž plnění obchod otevřela/přikoupila, a čas jejich prvního plnění. */
  entryFillAtByOrder: ReadonlyMap<string, number>;
  /** SL/TP navázané na pozici (bracket, kopírka, samostatné) — nejsou vstupy. */
  protectiveOrderIds: ReadonlySet<string>;
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

export function episodeEntryOrders(
  episode: EntryOrderEpisode,
  protectionByOrder: ReadonlyMap<string, readonly JournalProtectionEvent[]>,
  latest: ReadonlyMap<string, JournalEvidence>,
  childrenByParent: ReadonlyMap<string, readonly string[]>,
): TradeEntryOrder[] {
  const windowStart = Math.max(episode.entryAt - ENTRY_ORDER_LOOKBACK_MS, (episode.previousExitAt ?? -Infinity) + 1);
  const result: TradeEntryOrder[] = [];
  for (const [orderId, events] of protectionByOrder) {
    if (episode.protectiveOrderIds.has(orderId)) continue;
    const order = latest.get(`order:${orderId}`)?.entity;
    if (!order || order.accountId !== episode.accountId || order.contractId !== episode.contractId || order.parentId != null) continue;
    const side = order.action;
    if (side !== 'Buy' && side !== 'Sell') continue;
    const sorted = [...events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const legs = legsOf(sorted);
    if (!legs.length) continue;
    const placedAt = legs[0].at;
    const fillAt = episode.entryFillAtByOrder.get(orderId);
    const cancel = sorted.find(event => event.status === 'cancelled' && event.operation === 'cancel');
    let end: TradeEntryOrder['end'];
    if (fillAt != null) end = { kind: 'fill', at: fillAt };
    else {
      // Zrušený pokus o vstup: zadaný před vstupem (v okně tohoto obchodu).
      if (placedAt < windowStart || placedAt >= episode.entryAt || !cancel || cancel.at > episode.through) continue;
      end = { kind: 'cancel', at: cancel.at };
    }
    const kind = sorted[0].kind;
    // Bracket (OSO): děti přes parentId; Tradovate je u ručních OSO nemusí
    // propojit vůbec — pak SL/TP opačné strany vytvořené do 1 s po vstupu.
    let children = childrenByParent.get(`${episode.accountId}:${orderId}`) ?? [];
    if (!children.length) {
      const created = Date.parse(String(order.timestamp ?? ''));
      if (Number.isFinite(created)) children = [...protectionByOrder.keys()].filter(id => {
        if (id === orderId || episode.protectiveOrderIds.has(id)) return false;
        const sibling = latest.get(`order:${id}`)?.entity;
        const at = Date.parse(String(sibling?.timestamp ?? ''));
        return sibling != null && sibling.accountId === episode.accountId && sibling.contractId === episode.contractId
          && sibling.parentId == null && sibling.action !== side && (sibling.action === 'Buy' || sibling.action === 'Sell')
          && Number.isFinite(at) && at >= created && at - created <= BRACKET_SIBLING_MS;
      });
    }
    // OSO děti čekají („pending“), dokud se vstup nevyplní — cena platí i tak.
    const bracketPrice = (want: 'sl' | 'tp') => {
      const priced = children.flatMap(id => (protectionByOrder.get(id) ?? [])
        .filter(event => event.kind === want && event.status !== 'rejected' && event.operation !== 'cancel' && event.price != null && Number.isFinite(event.price)));
      return priced.length ? priced.sort((a, b) => a.at - b.at)[priced.length - 1].price : null;
    };
    const sl = bracketPrice('sl'), tp = bracketPrice('tp');
    result.push({
      orderId, side, type: kind === 'tp' ? 'Limit' : 'Stop', quantity: sorted.find(event => event.quantity != null)?.quantity ?? null,
      placedAt, legs: legs.filter(leg => leg.at <= end!.at), end,
      ...(sl != null || tp != null ? { bracket: { sl, tp } } : {}),
    });
  }
  return result.sort((a, b) => a.placedAt - b.placedAt || a.orderId.localeCompare(b.orderId)).slice(-MAX_ENTRY_ORDERS);
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

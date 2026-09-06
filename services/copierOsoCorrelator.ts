import type { OrderType } from './brokerPort';
import type { LeaderEvent } from './copierEngine';

export interface LeaderOsoPair {
  entryOrderId: string;
  stopOrderId: string;
  targetOrderId: string;
  accountId: number;
  symbol: string;
  entrySide: 'Buy' | 'Sell';
  quantity: number;
  entryOrderType: Extract<OrderType, 'Limit' | 'Stop' | 'StopLimit'>;
  entryLimitPrice?: number;
  entryStopPrice?: number;
  stopPrice: number;
  targetPrice: number;
  detectedAt: number;
  correlation: 'broker-parent' | 'inferred-window';
}

interface EntryCandidate {
  event: LeaderEvent & {
    kind: 'submitted';
    orderType: Extract<OrderType, 'Limit' | 'Stop' | 'StopLimit'>;
  };
  receivedAt: number;
}

interface LegCandidate {
  event: LeaderEvent & {
    kind: 'submitted';
    orderType: Extract<OrderType, 'Limit' | 'Stop' | 'StopLimit'>;
  };
  type: 'stop' | 'target';
  price: number;
  exactParent: boolean;
}

export type OsoObservation =
  | { kind: 'unrelated' }
  | { kind: 'entry'; entryOrderId: string }
  | { kind: 'leg'; entryOrderId: string }
  /** Replace dorazil dřív, než vznikly follower linky; kandidát drží nový execution shape. */
  | { kind: 'updated'; entryOrderId: string }
  | { kind: 'pair'; pair: LeaderOsoPair }
  | { kind: 'ambiguous'; reason: string };

const opposite = (side: 'Buy' | 'Sell') => side === 'Buy' ? 'Sell' : 'Buy';
const isEntryType = (type: OrderType): type is Extract<OrderType, 'Limit' | 'Stop' | 'StopLimit'> =>
  type === 'Limit' || type === 'Stop' || type === 'StopLimit';

/**
 * Korelace OSO ještě před fill entry. Entry se krátce podrží a odešle se až
 * tehdy, když dorazí přesně jeden opačný Stop a jeden opačný Limit.
 */
export class CopierOsoCorrelator {
  private readonly windowMs: number;
  private readonly entries = new Map<string, EntryCandidate>();
  private readonly legs = new Map<string, Map<string, LegCandidate>>();
  private readonly emitted = new Set<string>();

  // TradingView → Tradovate propaguje SL/TP i se stovkami ms zpoždění za
  // entry; 500 ms okno je v praxi míjelo (živý pád 2026-08-20: TP dorazil
  // po okně, lone-leg shodil copier). Cena za širší okno je jen o ~1 s
  // pomalejší kopie ČEKAJÍCÍCH (limit/stop) entry — market jde mimo okno.
  constructor(windowMs = 1500) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('OSO inference window musí být kladné číslo');
    this.windowMs = windowMs;
  }

  observe(event: LeaderEvent): OsoObservation {
    this.prune(event.receivedAt);
    if (
      event.kind === 'replaced'
      && event.executionShapeChanged === true
      && isEntryType(event.orderType)
    ) {
      const pendingEntry = this.entries.get(event.orderId);
      if (pendingEntry && !this.emitted.has(event.orderId)) {
        pendingEntry.event = this.updatedPendingEvent(pendingEntry.event, event, false);
        return { kind: 'updated', entryOrderId: event.orderId };
      }

      for (const [entryOrderId, byOrder] of this.legs) {
        if (this.emitted.has(entryOrderId)) continue;
        const leg = byOrder.get(event.orderId);
        if (!leg) continue;
        const nextType = event.orderType === 'Limit' ? 'target' : 'stop';
        const nextPrice = nextType === 'target' ? event.limitPrice : event.stopPrice;
        if (nextType !== leg.type || nextPrice == null || !Number.isFinite(nextPrice)) {
          return { kind: 'ambiguous', reason: 'OSO replace změnil protective roli nebo nemá platnou cenu' };
        }
        leg.event = this.updatedPendingEvent(leg.event, event, true);
        leg.price = nextPrice;
        return { kind: 'updated', entryOrderId };
      }
      return { kind: 'unrelated' };
    }
    if (event.kind !== 'submitted' || !isEntryType(event.orderType)) return { kind: 'unrelated' };
    const submittedEvent = event as LeaderEvent & {
      kind: 'submitted';
      orderType: Extract<OrderType, 'Limit' | 'Stop' | 'StopLimit'>;
    };

    const exact = submittedEvent.parentOrderId ? this.entries.get(submittedEvent.parentOrderId) : undefined;
    const inferred = exact ? [] : [...this.entries.values()].filter(candidate => {
      const entry = candidate.event;
      return submittedEvent.receivedAt >= candidate.receivedAt
        && submittedEvent.receivedAt - candidate.receivedAt <= this.windowMs
        && entry.accountId === submittedEvent.accountId && entry.symbol === submittedEvent.symbol
        && entry.quantity === submittedEvent.quantity && opposite(entry.side) === submittedEvent.side;
    });
    if (!exact && inferred.length > 1) return { kind: 'ambiguous', reason: 'více možných OSO entry' };
    const entryCandidate = exact ?? inferred[0];

    if (!entryCandidate) {
      this.entries.set(submittedEvent.orderId, { event: submittedEvent, receivedAt: submittedEvent.receivedAt });
      return { kind: 'entry', entryOrderId: submittedEvent.orderId };
    }
    const entry = entryCandidate.event;
    if (
      exact
      && (
        entry.accountId !== submittedEvent.accountId
        || entry.symbol !== submittedEvent.symbol
        || entry.quantity !== submittedEvent.quantity
        || opposite(entry.side) !== submittedEvent.side
      )
    ) {
      return { kind: 'ambiguous', reason: 'OSO child neodpovídá parent entry' };
    }
    if (this.emitted.has(entry.orderId)) return { kind: 'unrelated' };
    const type = submittedEvent.orderType === 'Limit' ? 'target' : 'stop';
    const price = type === 'target' ? submittedEvent.limitPrice : submittedEvent.stopPrice;
    if (price == null || !Number.isFinite(price)) {
      return { kind: 'ambiguous', reason: `OSO ${type} nemá platnou cenu` };
    }
    const byOrder = this.legs.get(entry.orderId) ?? new Map<string, LegCandidate>();
    byOrder.set(submittedEvent.orderId, { event: submittedEvent, type, price, exactParent: exact != null });
    this.legs.set(entry.orderId, byOrder);
    const stops = [...byOrder.values()].filter(item => item.type === 'stop');
    const targets = [...byOrder.values()].filter(item => item.type === 'target');
    if (stops.length > 1 || targets.length > 1 || byOrder.size > 2) {
      return { kind: 'ambiguous', reason: 'OSO nemá přesně jeden SL a jeden TP' };
    }
    if (stops.length !== 1 || targets.length !== 1) return { kind: 'leg', entryOrderId: entry.orderId };

    this.emitted.add(entry.orderId);
    return {
      kind: 'pair',
      pair: {
        entryOrderId: entry.orderId,
        stopOrderId: stops[0].event.orderId,
        targetOrderId: targets[0].event.orderId,
        accountId: entry.accountId,
        symbol: entry.symbol,
        entrySide: entry.side,
        quantity: entry.quantity,
        entryOrderType: entry.orderType,
        ...(entry.limitPrice != null ? { entryLimitPrice: entry.limitPrice } : {}),
        ...(entry.stopPrice != null ? { entryStopPrice: entry.stopPrice } : {}),
        stopPrice: stops[0].price,
        targetPrice: targets[0].price,
        detectedAt: Math.max(stops[0].event.receivedAt, targets[0].event.receivedAt),
        correlation: stops[0].exactParent && targets[0].exactParent ? 'broker-parent' : 'inferred-window',
      },
    };
  }

  isPending(entryOrderId: string): boolean {
    return this.entries.has(entryOrderId) && !this.emitted.has(entryOrderId);
  }

  /**
   * Kolik protective legů se k entry stihlo přiřadit bez dokončeného páru.
   * Nenulová hodnota při expiraci okna znamená „SL bez TP" (nebo naopak) —
   * entry se nesmí tiše zkopírovat bez ochrany.
   */
  pendingLegCount(entryOrderId: string): number {
    if (this.emitted.has(entryOrderId)) return 0;
    return this.legs.get(entryOrderId)?.size ?? 0;
  }

  /**
   * Po vypršení inference okna už byl entry zpracován jako samostatný příkaz.
   * Musí proto zmizet i z korelačního stavu, jinak by se při pomalu rostoucím
   * broker timestampu mohl pozdější opačný příkaz chybně vydávat za jeho SL/TP.
   */
  release(entryOrderId: string): void {
    this.entries.delete(entryOrderId);
    this.legs.delete(entryOrderId);
    this.emitted.delete(entryOrderId);
  }

  pendingWindowMs(): number { return this.windowMs; }

  /**
   * Pending replace smí změnit execution parametry, nikoli transient quantity
   * nativní OSO nohy. `kind: submitted` zachovává kandidáta jako dosud
   * neodeslanou část páru; skutečný replace event se zvlášť durable zaznamená.
   */
  private updatedPendingEvent(
    current: EntryCandidate['event'] | LegCandidate['event'],
    update: LeaderEvent,
    preserveQuantity: boolean,
  ): EntryCandidate['event'] {
    return {
      ...current,
      kind: 'submitted',
      orderType: update.orderType as Extract<OrderType, 'Limit' | 'Stop' | 'StopLimit'>,
      limitPrice: update.limitPrice,
      stopPrice: update.stopPrice,
      // Identita/sekvence/čas zůstávají na původním submitted eventu. Replace
      // se durable zaznamenává samostatně a nesmí změnit deferred replay key.
      // Protective child drží venue-managed quantity. Samotný čekající entry
      // ale smí uživatel legitimně zvětšit/zmenšit spolu s cenou ještě před
      // dokončením OSO inference okna.
      quantity: preserveQuantity ? current.quantity : update.quantity,
    };
  }

  private prune(now: number): void {
    for (const [id, candidate] of this.entries) {
      if (now - candidate.receivedAt > this.windowMs && !this.emitted.has(id)) {
        this.entries.delete(id);
        this.legs.delete(id);
      }
    }
  }
}

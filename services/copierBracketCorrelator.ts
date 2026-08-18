import type { LeaderEvent } from './copierEngine';

export interface LeaderBracketPair {
  entryOrderId: string;
  stopOrderId: string;
  targetOrderId: string;
  accountId: number;
  symbol: string;
  side: 'Buy' | 'Sell';
  quantity: number;
  stopPrice: number;
  targetPrice: number;
  detectedAt: number;
  correlation: 'broker-parent' | 'inferred-window';
}

export interface CopierBracketCorrelatorOptions {
  /** Maximální odstup protective legu od fillu entry při chybějícím parentId. */
  inferenceWindowMs?: number;
}

interface EntryCandidate {
  orderId: string;
  accountId: number;
  symbol: string;
  side: 'Buy' | 'Sell';
  quantity: number;
  filledAt: number;
}

interface LegCandidate {
  orderId: string;
  entryOrderId: string;
  accountId: number;
  symbol: string;
  side: 'Buy' | 'Sell';
  quantity: number;
  type: 'stop' | 'target';
  price: number;
  receivedAt: number;
  exactParent: boolean;
}

const opposite = (side: 'Buy' | 'Sell') => side === 'Buy' ? 'Sell' : 'Buy';

/**
 * Koreluje leader entry s nativním SL/TP párem.
 *
 * Tradovate demo stream při testu 2026-08-17 neposlal parentId/ocoId ani
 * linkedId, přestože order REST model tato pole má. Proto podporujeme úzkou
 * deterministickou inference: přesně jeden Stop a jeden Limit na opačné straně
 * stejného symbolu a množství krátce po entry fillu. Více kandidátů nebo
 * chybějící leg nikdy nehádáme.
 */
export class CopierBracketCorrelator {
  private readonly inferenceWindowMs: number;
  private readonly entries = new Map<string, EntryCandidate>();
  private readonly legsByEntry = new Map<string, Map<string, LegCandidate>>();
  private readonly emittedEntries = new Set<string>();
  /**
   * Entry, u kterých už dorazil protective leg, ale pár se nesešel.
   *
   * Vede se schválně mimo dosah `prune()`. Controller na tuhle množinu
   * věší fail-closed timer, a pojistka nesmí sdílet životní cyklus s tím,
   * co hlídá — jinak ji úklid cache tiše odzbrojí.
   */
  private readonly awaitingPair = new Set<string>();

  constructor(options: CopierBracketCorrelatorOptions = {}) {
    this.inferenceWindowMs = options.inferenceWindowMs ?? 1_500;
    if (!Number.isFinite(this.inferenceWindowMs) || this.inferenceWindowMs <= 0) {
      throw new Error('Bracket inference window musí být kladné číslo');
    }
  }

  observe(event: LeaderEvent): LeaderBracketPair | null {
    this.prune(event.receivedAt);
    if (event.kind === 'filled') {
      this.entries.set(event.orderId, {
        orderId: event.orderId,
        accountId: event.accountId,
        symbol: event.symbol,
        side: event.side,
        quantity: event.cumulativeQuantity ?? event.quantity,
        filledAt: event.receivedAt,
      });
      return null;
    }
    if (event.kind !== 'submitted') return null;
    const type = event.orderType === 'Limit'
      ? 'target'
      : event.orderType === 'Stop' || event.orderType === 'StopLimit'
        ? 'stop'
        : null;
    const price = type === 'target' ? event.limitPrice : event.stopPrice;
    if (!type || price == null || !Number.isFinite(price)) return null;

    const exact = event.parentOrderId ? this.entries.get(event.parentOrderId) : undefined;
    const inferred = exact ? [] : [...this.entries.values()].filter(entry =>
      event.receivedAt - entry.filledAt >= 0
      && event.receivedAt - entry.filledAt <= this.inferenceWindowMs
      && entry.accountId === event.accountId
      && entry.symbol === event.symbol
      && entry.quantity === event.quantity
      && opposite(entry.side) === event.side);
    const entry = exact ?? (inferred.length === 1 ? inferred[0] : undefined);
    if (!entry || this.emittedEntries.has(entry.orderId)) return null;

    const legs = this.legsByEntry.get(entry.orderId) ?? new Map<string, LegCandidate>();
    legs.set(event.orderId, {
      orderId: event.orderId,
      entryOrderId: entry.orderId,
      accountId: event.accountId,
      symbol: event.symbol,
      side: event.side,
      quantity: event.quantity,
      type,
      price,
      receivedAt: event.receivedAt,
      exactParent: exact != null,
    });
    this.legsByEntry.set(entry.orderId, legs);
    this.awaitingPair.add(entry.orderId);
    const stops = [...legs.values()].filter(item => item.type === 'stop');
    const targets = [...legs.values()].filter(item => item.type === 'target');
    if (stops.length !== 1 || targets.length !== 1 || legs.size !== 2) return null;

    this.emittedEntries.add(entry.orderId);
    this.awaitingPair.delete(entry.orderId);
    return {
      entryOrderId: entry.orderId,
      stopOrderId: stops[0].orderId,
      targetOrderId: targets[0].orderId,
      accountId: entry.accountId,
      symbol: entry.symbol,
      side: opposite(entry.side),
      quantity: entry.quantity,
      stopPrice: stops[0].price,
      targetPrice: targets[0].price,
      detectedAt: Math.max(stops[0].receivedAt, targets[0].receivedAt),
      correlation: stops[0].exactParent && targets[0].exactParent
        ? 'broker-parent'
        : 'inferred-window',
    };
  }

  /** Vrátí entry, ke kterému už byl order bezpečně zařazen jako protective leg. */
  entryOrderIdForLeg(orderId: string): string | null {
    for (const [entryOrderId, legs] of this.legsByEntry) {
      if (legs.has(orderId)) return entryOrderId;
    }
    return null;
  }

  hasPendingPair(entryOrderId: string): boolean {
    return this.awaitingPair.has(entryOrderId);
  }

  pendingTimeoutMs(): number {
    return this.inferenceWindowMs;
  }

  private prune(now: number): void {
    for (const [orderId, entry] of this.entries) {
      if (now - entry.filledAt > this.inferenceWindowMs) {
        this.entries.delete(orderId);
        if (!this.emittedEntries.has(orderId)) this.legsByEntry.delete(orderId);
      }
    }
  }
}

import type { BrokerEvent, BrokerFill, BrokerOrder } from './brokerPort';
import type { LeaderEvent, LeaderEventKind } from './copierEngine';

/**
 * Překládá broker lifecycle na stabilní leader události.
 *
 * Všechny entity z počátečního `user/syncrequest` jsou pouze baseline.
 * Kopírovat se smí až eventy, které přijdou po potvrzení synchronizace.
 * Po reconnectu se nová baseline také nikdy nereplikuje; vyžaduje se ruční
 * kontrola pozic, protože během výpadku mohly proběhnout neviděné obchody.
 */
export class CopierLeaderEventSource {
  private ready = false;
  private connectedOnce = false;
  private reconciliationRequired = false;
  private readonly orderSignatures = new Map<string, string>();
  private readonly orderShapes = new Map<string, string>();
  private readonly seenFillIds = new Set<string>();
  private readonly liveFillTotals = new Map<string, number>();

  connection(connected: boolean): void {
    if (!connected) {
      if (this.connectedOnce) this.reconciliationRequired = true;
      this.ready = false;
      return;
    }
    this.ready = true;
    this.connectedOnce = true;
  }

  needsReconciliation(): boolean {
    return this.reconciliationRequired;
  }

  acknowledgeReconciliation(): void {
    this.reconciliationRequired = false;
  }

  /** Konfigurace účtů se změnila; další live ARM musí znovu ověřit realitu. */
  requireReconciliation(): void {
    this.reconciliationRequired = true;
  }

  observe(event: BrokerEvent, leaderAccountId: number, sequence: number, receivedAt: number): LeaderEvent | null {
    if (event.type === 'connection') {
      this.connection(event.connected);
      return null;
    }
    if (event.type === 'heartbeat' || event.type === 'position' || event.type === 'error') return null;
    if (event.type === 'order') return this.orderEvent(event.order, leaderAccountId, sequence, receivedAt);
    return this.fillEvent(event.fill, leaderAccountId, sequence, receivedAt);
  }

  private orderEvent(
    order: BrokerOrder,
    leaderAccountId: number,
    sequence: number,
    receivedAt: number,
  ): LeaderEvent | null {
    const shape = [
      order.orderType,
      order.quantity,
      order.limitPrice ?? '',
      order.stopPrice ?? '',
      order.parentOrderId ?? '',
      order.ocoId ?? '',
      order.linkedOrderId ?? '',
    ].join(':');
    const signature = [
      order.sourceVersion ?? order.updatedAt,
      order.status,
      shape,
    ].join(':');
    const previous = this.orderSignatures.get(order.brokerOrderId);
    const previousShape = this.orderShapes.get(order.brokerOrderId);
    this.orderSignatures.set(order.brokerOrderId, signature);
    this.orderShapes.set(order.brokerOrderId, shape);
    // Baseline držíme pro všechny účty v připojení, ne pouze pro právě
    // zvoleného leadera. Když se follower bezpečně povýší na leadera přes
    // UI, jeho historický working/fill event se tím nemůže vydávat za nový.
    if (order.accountId !== leaderAccountId) return null;
    if (!this.ready || previous === signature) return null;

    let kind: LeaderEventKind | null = null;
    if (order.status === 'canceled') kind = 'canceled';
    else if (order.status === 'rejected') kind = 'rejected';
    else if (order.status === 'pending') {
      // PendingNew/Suspended může být první viditelná část nativního OSO a
      // musí založit korelaci entry+SL+TP. Další změny v pending stavu jsou
      // ale venue tranzice (typicky partial-fill resize), nikdy replace.
      if (previous == null) kind = 'submitted';
    }
    else if (order.status === 'working') {
      // PendingNew -> Working často přinese novou broker revizi, ale žádnou
      // uživatelskou změnu objednávky. Modify posíláme jen při změně skutečných
      // parametrů; potvrzení přijetí samo o sobě follower order nemění.
      if (previous == null) kind = 'submitted';
      else if (previousShape !== shape) kind = 'replaced';
    }
    // `filled` vzniká výhradně z Fill entity, aby se partial fill nezapočítal dvakrát.
    if (!kind) return null;

    return {
      id: `order:${order.brokerOrderId}:${kind}:${signature}`,
      orderId: order.brokerOrderId,
      kind,
      accountId: order.accountId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      ...(order.limitPrice != null ? { limitPrice: order.limitPrice } : {}),
      ...(order.stopPrice != null ? { stopPrice: order.stopPrice } : {}),
      ...(order.parentOrderId ? { parentOrderId: order.parentOrderId } : {}),
      ...(order.ocoId ? { ocoId: order.ocoId } : {}),
      ...(order.linkedOrderId ? { linkedOrderId: order.linkedOrderId } : {}),
      sequence,
      receivedAt,
    };
  }

  private fillEvent(
    fill: BrokerFill,
    leaderAccountId: number,
    sequence: number,
    receivedAt: number,
  ): LeaderEvent | null {
    if (this.seenFillIds.has(fill.fillId)) return null;
    this.seenFillIds.add(fill.fillId);
    const cumulativeQuantity = (this.liveFillTotals.get(fill.brokerOrderId) ?? 0) + fill.quantity;
    this.liveFillTotals.set(fill.brokerOrderId, cumulativeQuantity);
    // Stejně jako u orderů se fill ID všech připojených účtů baselinuje
    // ještě před filtrem leadera. Změna role pak nikdy nepřehrává historii.
    if (fill.accountId !== leaderAccountId || !this.ready) return null;
    return {
      id: `fill:${fill.fillId}`,
      orderId: fill.brokerOrderId,
      kind: 'filled',
      accountId: fill.accountId,
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      cumulativeQuantity,
      // On-fill kopie replikuje skutečnou exekuci, proto používá Market.
      orderType: 'Market',
      sequence,
      receivedAt,
    };
  }
}

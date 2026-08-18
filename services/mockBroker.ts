import type {
  BrokerEnvironment,
  BrokerEvent,
  BrokerOrder,
  BrokerOrderAck,
  BrokerOrderRequest,
  BrokerOcoRequest,
  BrokerOsoRequest,
  BrokerPort,
  BrokerPosition,
  BrokerAccountCapability,
} from './brokerPort';

/**
 * Mock brokera pro vývoj a testy před OAuth.
 *
 * Plně deterministický — žádný `Date.now()`, žádná náhoda. Čas i chování
 * objednávek se vstřikují zvenčí, takže přehrání stejného scénáře dá vždy
 * stejný výsledek.
 *
 * ZÁMĚRNĚ NENÍ IDEMPOTENTNÍ. Dvě volání `placeOrder()` se stejným tagem
 * založí dvě objednávky — přesně jako Tradovate. Dřívější verze tohohle
 * mocku duplicitu odmítala, což byla vymyšlená garance a schovávala
 * nejnebezpečnější chybu celého copieru.
 *
 * Umí simulovat i oba druhy timeoutu, protože právě ty rozhodují o tom,
 * jestli je retry bezpečný.
 */

export type MockOrderOutcome =
  | { kind: 'fill'; price: number }
  | { kind: 'partial'; quantity: number; price: number }
  | { kind: 'working' }
  | { kind: 'reject'; reason: string }
  /** Objednávka se u brokera založila, ale odpověď se ztratila. */
  | { kind: 'timeout-after-accept' }
  /** Požadavek k brokerovi vůbec nedorazil. */
  | { kind: 'timeout-before-accept' };

export interface MockBrokerOptions {
  environment?: BrokerEnvironment;
  /** Deterministické hodiny. Výchozí čítač po 1 ms na volání. */
  clock?: () => number;
  /**
   * Rozhodne osud každé objednávky. Dostává i pořadí pokusu, takže jde
   * napsat scénář „poprvé timeout, podruhé projde".
   */
  behavior?: (request: BrokerOrderRequest, attempt: number) => MockOrderOutcome;
  lookupCompleteness?: 'authoritative' | 'eventual';
  /** Počet prvních tag lookupů, ve kterých přijaté objednávky ještě nejsou vidět. */
  lookupVisibilityDelay?: number;
  cancelBehavior?: (
    order: BrokerOrder | undefined,
    attempt: number,
  ) => 'success' | 'timeout-before-cancel' | 'timeout-after-cancel';
  accountCapabilities?: readonly BrokerAccountCapability[];
}

export class MockBrokerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockBrokerTimeoutError';
  }
}

export interface MockBroker extends BrokerPort {
  /** Simuluje ztrátu a obnovení spojení. */
  setConnected(connected: boolean): void;
  /** Vstříkne broker event pro integrační test runtime controlleru. */
  emitEvent(event: BrokerEvent): void;
  /** Vše, co bylo skutečně odesláno — pro kontrolu duplicit v testech. */
  placedRequests(): readonly BrokerOrderRequest[];
  placedOcoRequests(): readonly BrokerOcoRequest[];
  placedOsoRequests(): readonly BrokerOsoRequest[];
  orders(): readonly BrokerOrder[];
  cancelRequestCount(brokerOrderId: string): number;
}

export function createMockBroker(options: MockBrokerOptions = {}): MockBroker {
  const environment = options.environment ?? 'demo';
  let tick = 0;
  const clock = options.clock ?? (() => (tick += 1));
  const behavior = options.behavior ?? (() => ({ kind: 'fill', price: 0 } as MockOrderOutcome));
  const lookupCompleteness = options.lookupCompleteness ?? 'authoritative';
  const lookupVisibilityDelay = options.lookupVisibilityDelay ?? 0;
  const cancelBehavior = options.cancelBehavior ?? (() => 'success' as const);

  const listeners = new Set<(event: BrokerEvent) => void>();
  /** Objednávky podle brokerId — tag NENÍ unikátní klíč. */
  const ordersById = new Map<string, BrokerOrder>();
  const positions = new Map<string, BrokerPosition>();
  const placed: BrokerOrderRequest[] = [];
  const placedOco: BrokerOcoRequest[] = [];
  const placedOso: BrokerOsoRequest[] = [];
  const attemptsByTag = new Map<string, number>();
  const cancelAttempts = new Map<string, number>();
  let tagLookupCount = 0;
  let connected = true;
  let orderSequence = 0;
  let fillSequence = 0;

  const emit = (event: BrokerEvent) => {
    for (const listener of listeners) listener(event);
  };

  const positionKey = (accountId: number, symbol: string) => `${accountId}:${symbol}`;

  const applyFill = (order: BrokerOrder, quantity: number, price: number) => {
    const key = positionKey(order.accountId, order.symbol);
    const current = positions.get(key) ?? {
      accountId: order.accountId,
      symbol: order.symbol,
      netQuantity: 0,
    };
    const signed = order.side === 'Buy' ? quantity : -quantity;
    const next: BrokerPosition = { ...current, netQuantity: current.netQuantity + signed };
    positions.set(key, next);

    fillSequence += 1;
    emit({
      type: 'fill',
      fill: {
        fillId: `mf-${fillSequence}`,
        tag: order.tag,
        brokerOrderId: order.brokerOrderId,
        accountId: order.accountId,
        symbol: order.symbol,
        side: order.side,
        quantity,
        price,
        filledAt: clock(),
      },
    });
    emit({ type: 'position', position: next });
  };

  const registerOrder = (request: BrokerOrderRequest): BrokerOrder => {
    orderSequence += 1;
    const order: BrokerOrder = {
      tag: request.tag,
      brokerOrderId: `mo-${orderSequence}`,
      accountId: request.accountId,
      symbol: request.symbol,
      side: request.side,
      orderType: request.orderType,
      quantity: request.quantity,
      filledQuantity: 0,
      ...(request.limitPrice != null ? { limitPrice: request.limitPrice } : {}),
      ...(request.stopPrice != null ? { stopPrice: request.stopPrice } : {}),
      status: 'working',
      updatedAt: clock(),
    };
    ordersById.set(order.brokerOrderId, order);
    return order;
  };

  return {
    environment,

    async placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderAck> {
      if (!connected) throw new MockBrokerTimeoutError('mock broker: disconnected');

      const attempt = (attemptsByTag.get(request.tag) ?? 0) + 1;
      attemptsByTag.set(request.tag, attempt);
      const outcome = behavior(request, attempt);

      if (outcome.kind === 'timeout-before-accept') {
        throw new MockBrokerTimeoutError('mock broker: request timed out before reaching broker');
      }

      // Od tohoto bodu objednávka u brokera existuje.
      placed.push(request);
      const order = registerOrder(request);

      if (outcome.kind === 'timeout-after-accept') {
        emit({ type: 'order', order });
        throw new MockBrokerTimeoutError('mock broker: response lost after order was accepted');
      }

      if (outcome.kind === 'reject') {
        order.status = 'rejected';
        order.rejectReason = outcome.reason;
        emit({ type: 'order', order });
        return { brokerOrderId: order.brokerOrderId, accepted: false, definitive: true, rejectReason: outcome.reason };
      }

      emit({ type: 'order', order });

      if (outcome.kind === 'fill') {
        order.filledQuantity = request.quantity;
        order.status = 'filled';
        order.updatedAt = clock();
        emit({ type: 'order', order });
        applyFill(order, request.quantity, outcome.price);
      } else if (outcome.kind === 'partial') {
        const quantity = Math.min(outcome.quantity, request.quantity);
        order.filledQuantity = quantity;
        order.status = quantity >= request.quantity ? 'filled' : 'working';
        order.updatedAt = clock();
        emit({ type: 'order', order });
        if (quantity > 0) applyFill(order, quantity, outcome.price);
      }

      return { brokerOrderId: order.brokerOrderId, accepted: true, definitive: true };
    },

    async placeOco(request: BrokerOcoRequest) {
      if (!connected) throw new MockBrokerTimeoutError('mock broker: disconnected');
      placedOco.push(request);
      const first = registerOrder({
        tag: request.tag,
        accountId: request.accountId,
        symbol: request.symbol,
        side: request.first.side,
        quantity: request.quantity,
        orderType: request.first.orderType,
        ...(request.first.limitPrice != null ? { limitPrice: request.first.limitPrice } : {}),
        ...(request.first.stopPrice != null ? { stopPrice: request.first.stopPrice } : {}),
      });
      const second = registerOrder({
        tag: `${request.tag}b`,
        accountId: request.accountId,
        symbol: request.symbol,
        side: request.second.side,
        quantity: request.quantity,
        orderType: request.second.orderType,
        ...(request.second.limitPrice != null ? { limitPrice: request.second.limitPrice } : {}),
        ...(request.second.stopPrice != null ? { stopPrice: request.second.stopPrice } : {}),
      });
      first.ocoId = second.brokerOrderId;
      first.linkedOrderId = second.brokerOrderId;
      second.ocoId = first.brokerOrderId;
      second.linkedOrderId = first.brokerOrderId;
      emit({ type: 'order', order: first });
      emit({ type: 'order', order: second });
      return {
        firstBrokerOrderId: first.brokerOrderId,
        secondBrokerOrderId: second.brokerOrderId,
        accepted: true,
        definitive: true,
      };
    },

    async placeOso(request: BrokerOsoRequest) {
      if (!connected) throw new MockBrokerTimeoutError('mock broker: disconnected');
      placedOso.push(request);
      const entry = registerOrder(request);
      const first = registerOrder({
        tag: `${request.tag}s`, accountId: request.accountId, symbol: request.symbol,
        side: request.first.side, quantity: request.quantity, orderType: request.first.orderType,
        ...(request.first.limitPrice != null ? { limitPrice: request.first.limitPrice } : {}),
        ...(request.first.stopPrice != null ? { stopPrice: request.first.stopPrice } : {}),
      });
      const second = registerOrder({
        tag: `${request.tag}t`, accountId: request.accountId, symbol: request.symbol,
        side: request.second.side, quantity: request.quantity, orderType: request.second.orderType,
        ...(request.second.limitPrice != null ? { limitPrice: request.second.limitPrice } : {}),
        ...(request.second.stopPrice != null ? { stopPrice: request.second.stopPrice } : {}),
      });
      first.parentOrderId = entry.brokerOrderId;
      second.parentOrderId = entry.brokerOrderId;
      first.ocoId = second.brokerOrderId;
      first.linkedOrderId = second.brokerOrderId;
      second.ocoId = first.brokerOrderId;
      second.linkedOrderId = first.brokerOrderId;
      emit({ type: 'order', order: entry });
      emit({ type: 'order', order: first });
      emit({ type: 'order', order: second });
      return {
        entryBrokerOrderId: entry.brokerOrderId,
        firstBrokerOrderId: first.brokerOrderId,
        secondBrokerOrderId: second.brokerOrderId,
        accepted: true,
        definitive: true,
      };
    },

    async cancelOrder(_accountId: number, brokerOrderId: string): Promise<void> {
      const order = ordersById.get(brokerOrderId);
      const attempt = (cancelAttempts.get(brokerOrderId) ?? 0) + 1;
      cancelAttempts.set(brokerOrderId, attempt);
      const outcome = cancelBehavior(order, attempt);
      if (outcome === 'timeout-before-cancel') {
        throw new MockBrokerTimeoutError('mock broker: cancel timed out before reaching broker');
      }
      if (!order || order.status !== 'working') return;
      order.status = 'canceled';
      order.updatedAt = clock();
      emit({ type: 'order', order });
      if (outcome === 'timeout-after-cancel') {
        throw new MockBrokerTimeoutError('mock broker: cancel response lost after cancellation');
      }
    },

    async modifyOrder(
      _accountId: number,
      brokerOrderId: string,
      changes: { quantity: number; orderType: import('./brokerPort').OrderType; limitPrice?: number; stopPrice?: number },
    ): Promise<void> {
      const order = ordersById.get(brokerOrderId);
      if (!order || order.status !== 'working') return;
      order.quantity = changes.quantity;
      order.orderType = changes.orderType;
      order.limitPrice = changes.limitPrice;
      order.stopPrice = changes.stopPrice;
      order.updatedAt = clock();
      emit({ type: 'order', order });
    },

    async listPositions(accountId: number): Promise<BrokerPosition[]> {
      return [...positions.values()].filter(position => position.accountId === accountId);
    },

    async listAccountCapabilities(accountIds: readonly number[]): Promise<BrokerAccountCapability[]> {
      if (options.accountCapabilities) {
        return options.accountCapabilities.filter(item => accountIds.includes(item.accountId));
      }
      return accountIds.map(accountId => ({ accountId, active: true, canTrade: true }));
    },

    async listOrders(accountId: number): Promise<BrokerOrder[]> {
      return [...ordersById.values()].filter(order => order.accountId === accountId);
    },

    async findOrdersByTag(accountId: number, tag: string) {
      if (!connected) throw new MockBrokerTimeoutError('mock broker: disconnected');
      tagLookupCount += 1;
      const orders = tagLookupCount <= lookupVisibilityDelay ? [] : [...ordersById.values()].filter(
        order => order.accountId === accountId && order.tag === tag,
      );
      return { orders, completeness: lookupCompleteness, observedAt: clock() };
    },

    async findOrderById(accountId: number, brokerOrderId: string) {
      if (!connected) throw new MockBrokerTimeoutError('mock broker: disconnected');
      const order = ordersById.get(brokerOrderId);
      return {
        order: order?.accountId === accountId ? order : null,
        completeness: lookupCompleteness,
        observedAt: clock(),
      };
    },

    subscribe(listener: (event: BrokerEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setConnected(next: boolean): void {
      connected = next;
      emit({ type: 'connection', connected: next, at: clock() });
    },

    emitEvent: emit,

    placedRequests: () => placed,
    placedOcoRequests: () => placedOco,
    placedOsoRequests: () => placedOso,
    orders: () => [...ordersById.values()],
    cancelRequestCount: brokerOrderId => cancelAttempts.get(brokerOrderId) ?? 0,
  };
}

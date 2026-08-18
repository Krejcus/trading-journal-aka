import type {
  BrokerAccountCapability,
  BrokerEvent,
  BrokerPort,
} from './brokerPort';

export interface BrokerRoute {
  broker: BrokerPort;
  accountIds: readonly number[];
}

/**
 * Složí několik OAuth spojení do jednoho broker portu.
 *
 * Každý side effect se směruje výhradně podle accountId. Jakmile vypadne
 * jediné spojení, agregovaný stream hlásí disconnect a controller zruší ARM
 * celé skupiny. To je bezpečnější než pokračovat jen na části propfirem.
 */
export function createBrokerRouter(routes: readonly BrokerRoute[]): BrokerPort {
  if (routes.length === 0) throw new Error('Broker router vyžaduje alespoň jedno spojení');
  const environment = routes[0].broker.environment;
  const byAccount = new Map<number, BrokerPort>();
  const seenBrokers = new Set<BrokerPort>();
  for (const route of routes) {
    if (seenBrokers.has(route.broker)) {
      throw new Error('Stejné OAuth spojení nesmí být ve více broker routes');
    }
    seenBrokers.add(route.broker);
    if (route.broker.environment !== environment) {
      throw new Error('Broker router nesmí míchat DEMO a LIVE prostředí');
    }
    for (const accountId of route.accountIds) {
      if (!Number.isSafeInteger(accountId) || accountId <= 0) {
        throw new Error('Broker route obsahuje neplatný accountId');
      }
      if (byAccount.has(accountId)) throw new Error(`Účet ${accountId} je ve více broker routes`);
      byAccount.set(accountId, route.broker);
    }
  }

  const brokerFor = (accountId: number): BrokerPort => {
    const broker = byAccount.get(accountId);
    if (!broker) throw new Error(`Pro účet ${accountId} není nakonfigurované OAuth spojení`);
    return broker;
  };

  return {
    environment,
    placeOrder: request => brokerFor(request.accountId).placeOrder(request),
    placeOco: async request => {
      const broker = brokerFor(request.accountId);
      if (!broker.placeOco) throw new Error('OAuth spojení nepodporuje nativní OCO');
      return broker.placeOco(request);
    },
    placeOso: async request => {
      const broker = brokerFor(request.accountId);
      if (!broker.placeOso) throw new Error('OAuth spojení nepodporuje nativní OSO');
      return broker.placeOso(request);
    },
    cancelOrder: (accountId, brokerOrderId) => brokerFor(accountId).cancelOrder(accountId, brokerOrderId),
    modifyOrder: (accountId, brokerOrderId, changes) =>
      brokerFor(accountId).modifyOrder(accountId, brokerOrderId, changes),
    async listAccountCapabilities(accountIds): Promise<BrokerAccountCapability[]> {
      const grouped = new Map<BrokerPort, number[]>();
      for (const accountId of accountIds) {
        const broker = brokerFor(accountId);
        grouped.set(broker, [...(grouped.get(broker) ?? []), accountId]);
      }
      return (await Promise.all([...grouped].map(([broker, ids]) =>
        broker.listAccountCapabilities(ids)))).flat();
    },
    listPositions: accountId => brokerFor(accountId).listPositions(accountId),
    listOrders: accountId => brokerFor(accountId).listOrders(accountId),
    findOrdersByTag: (accountId, tag) => brokerFor(accountId).findOrdersByTag(accountId, tag),
    findOrderById: (accountId, brokerOrderId) =>
      brokerFor(accountId).findOrderById(accountId, brokerOrderId),
    subscribe(listener) {
      const connected = new Map(routes.map(route => [route.broker, false]));
      let aggregateConnected = false;
      const accountIdsByBroker = new Map(routes.map(route => [
        route.broker,
        new Set(route.accountIds),
      ]));
      const unsubs = routes.map(route => route.broker.subscribe((event: BrokerEvent) => {
        if (event.type === 'order' || event.type === 'fill' || event.type === 'position') {
          const accountId = event.type === 'order'
            ? event.order.accountId
            : event.type === 'fill'
              ? event.fill.accountId
              : event.position.accountId;
          // Jedno OAuth může vidět více účtů, než mu bylo svěřeno v route.
          // Takové entity sem nesmí projít: při překryvu OAuth viditelnosti by
          // se leader lifecycle zpracoval dvakrát.
          if (!accountIdsByBroker.get(route.broker)?.has(accountId)) return;
          listener(event);
          return;
        }
        if (event.type !== 'connection') {
          listener(event);
          return;
        }
        connected.set(route.broker, event.connected);
        const next = [...connected.values()].every(Boolean);
        if (next !== aggregateConnected) {
          aggregateConnected = next;
          listener({ type: 'connection', connected: next, at: event.at });
        }
      }));
      return () => unsubs.forEach(unsubscribe => unsubscribe());
    },
  };
}

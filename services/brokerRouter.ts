import type {
  BrokerAccountCapability,
  BrokerEvent,
  BrokerPort,
} from './brokerPort';

export interface BrokerRoute {
  broker: BrokerPort;
  accountIds: readonly number[];
  /**
   * `false` označuje follower-only spojení, jehož krátký výpadek smí projít
   * ochrannou lhůtou (`reconnectGraceMs`) bez shození celé skupiny.
   * Default `true` = kritické spojení (nese leader stream) — každý výpadek
   * se hlásí okamžitě, protože ztracené leader eventy nejde dopočítat.
   */
  critical?: boolean;
}

export interface BrokerRouterOptions {
  /**
   * Jak dlouho smí nekritické spojení mlčet, než se výpadek ohlásí.
   * Tradovate zavírá WebSocket při cyklu access tokenu (~80 min) a worker
   * se do ~1 s připojí zpět — bez tolerance každé takové mrknutí JEDNOHO
   * follower spojení odzbrojilo VŠECHNY propfirmy. Objednávka odeslaná
   * během mezery stále selže fail-closed vlastní cestou (outbox lookup);
   * lhůta jen brání planým poplachům bez broker akce.
   */
  reconnectGraceMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

/**
 * Složí několik OAuth spojení do jednoho broker portu.
 *
 * Každý side effect se směruje výhradně podle accountId. Výpadek kritického
 * spojení (leader) hlásí agregovaný stream okamžitě a controller zruší ARM
 * celé skupiny; nekritická follower spojení dostávají krátkou reconnect
 * lhůtu, aby token cyklus jedné propfirmy nezastavoval všechny ostatní.
 */
export function createBrokerRouter(
  routes: readonly BrokerRoute[],
  options: BrokerRouterOptions = {},
): BrokerPort {
  if (routes.length === 0) throw new Error('Broker router vyžaduje alespoň jedno spojení');
  const environment = routes[0].broker.environment;
  const byAccount = new Map<number, BrokerPort>();
  const seenBrokers = new Set<BrokerPort>();
  const criticalBrokers = new Set(
    routes.filter(route => route.critical !== false).map(route => route.broker),
  );
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
    setCriticalAccounts(accountIds) {
      const next = new Set<BrokerPort>();
      for (const accountId of accountIds) next.add(brokerFor(accountId));
      criticalBrokers.clear();
      for (const broker of next) criticalBrokers.add(broker);
    },
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
      const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
      const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
      const graceMs = options.reconnectGraceMs ?? 10_000;
      const connected = new Map(routes.map(route => [route.broker, false]));
      let aggregateConnected = false;
      const accountIdsByBroker = new Map(routes.map(route => [
        route.broker,
        new Set(route.accountIds),
      ]));
      /** Zadržené error/connection eventy nekritické route během reconnect lhůty. */
      const pendingOutage = new Map<BrokerPort, {
        timer: ReturnType<typeof setTimeout>;
        held: BrokerEvent[];
      }>();

      const applyConnection = (broker: BrokerPort, event: Extract<BrokerEvent, { type: 'connection' }>) => {
        connected.set(broker, event.connected);
        const next = [...connected.values()].every(Boolean);
        if (next !== aggregateConnected) {
          aggregateConnected = next;
          listener({ type: 'connection', connected: next, at: event.at });
        }
      };

      const flushOutage = (broker: BrokerPort) => {
        const outage = pendingOutage.get(broker);
        if (!outage) return;
        pendingOutage.delete(broker);
        for (const held of outage.held) {
          if (held.type === 'connection') applyConnection(broker, held);
          else listener(held);
        }
      };

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
        const grace = !criticalBrokers.has(route.broker) && graceMs > 0;
        if (event.type === 'error') {
          if (!grace) {
            listener(event);
            return;
          }
          // Transport chyba nekritické route předchází jejímu disconnect
          // eventu — zadržíme ji ve stejné lhůtě. Objednávky mají vlastní
          // fail-closed cestu, tady jde jen o plané poplachy.
          const outage = pendingOutage.get(route.broker);
          if (outage) {
            outage.held.push(event);
          } else {
            pendingOutage.set(route.broker, {
              held: [event],
              timer: setTimeoutImpl(() => flushOutage(route.broker), graceMs),
            });
          }
          return;
        }
        if (event.type !== 'connection') {
          listener(event);
          return;
        }
        if (!grace) {
          applyConnection(route.broker, event);
          return;
        }
        const outage = pendingOutage.get(route.broker);
        if (!event.connected) {
          if (outage) {
            outage.held.push(event);
          } else {
            pendingOutage.set(route.broker, {
              held: [event],
              timer: setTimeoutImpl(() => flushOutage(route.broker), graceMs),
            });
          }
          return;
        }
        if (outage) {
          // Reconnect ve lhůtě: mrknutí se nikdy nestalo — zadržené eventy
          // se zahodí a agregát zůstává beze změny.
          clearTimeoutImpl(outage.timer);
          pendingOutage.delete(route.broker);
          connected.set(route.broker, true);
          return;
        }
        applyConnection(route.broker, event);
      }));
      return () => {
        for (const outage of pendingOutage.values()) clearTimeoutImpl(outage.timer);
        pendingOutage.clear();
        unsubs.forEach(unsubscribe => unsubscribe());
      };
    },
  };
}

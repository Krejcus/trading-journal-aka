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

export interface BrokerRouterPort extends BrokerPort {
  /** Atomicky nahradí account -> OAuth routy; underlying sockety zůstávají stejné. */
  replaceRoutes(routes: readonly BrokerRoute[]): void;
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
): BrokerRouterPort {
  if (routes.length === 0) throw new Error('Broker router vyžaduje alespoň jedno spojení');
  const environment = routes[0].broker.environment;
  let byAccount = new Map<number, BrokerPort>();
  let accountIdsByBroker = new Map<BrokerPort, Set<number>>();
  const fixedBrokers = routes.map(route => route.broker);
  const configuredBrokers = new Set(fixedBrokers);
  const criticalBrokers = new Set(
    routes.filter(route => route.critical !== false).map(route => route.broker),
  );
  const validateRoutes = (nextRoutes: readonly BrokerRoute[], requireFixedSet: boolean) => {
    const nextByAccount = new Map<number, BrokerPort>();
    const nextAccountIdsByBroker = new Map<BrokerPort, Set<number>>();
    const seenBrokers = new Set<BrokerPort>();
    for (const route of nextRoutes) {
      if (seenBrokers.has(route.broker)) {
        throw new Error('Stejné OAuth spojení nesmí být ve více broker routes');
      }
      seenBrokers.add(route.broker);
      if (requireFixedSet && !configuredBrokers.has(route.broker)) {
        throw new Error('Dynamická broker route obsahuje neznámé OAuth spojení');
      }
      if (route.broker.environment !== environment) {
        throw new Error('Broker router nesmí míchat DEMO a LIVE prostředí');
      }
      const ids = new Set<number>();
      for (const accountId of route.accountIds) {
        if (!Number.isSafeInteger(accountId) || accountId <= 0) {
          throw new Error('Broker route obsahuje neplatný accountId');
        }
        if (nextByAccount.has(accountId)) throw new Error(`Účet ${accountId} je ve více broker routes`);
        nextByAccount.set(accountId, route.broker);
        ids.add(accountId);
      }
      nextAccountIdsByBroker.set(route.broker, ids);
    }
    if (requireFixedSet && (seenBrokers.size !== configuredBrokers.size || fixedBrokers.some(item => !seenBrokers.has(item)))) {
      throw new Error('Dynamická změna rout nesmí přidat ani odebrat OAuth spojení');
    }
    return { nextByAccount, nextAccountIdsByBroker };
  };
  ({ nextByAccount: byAccount, nextAccountIdsByBroker: accountIdsByBroker } = validateRoutes(routes, false));

  const brokerFor = (accountId: number): BrokerPort => {
    const broker = byAccount.get(accountId);
    if (!broker) throw new Error(`Pro účet ${accountId} není nakonfigurované OAuth spojení`);
    return broker;
  };

  return {
    environment,
    replaceRoutes(nextRoutes) {
      const validated = validateRoutes(nextRoutes, true);
      // Přepnutí je synchronní a atomické: při jediné validační chybě zůstane
      // původní mapa i event filtr beze změny.
      byAccount = validated.nextByAccount;
      accountIdsByBroker = validated.nextAccountIdsByBroker;
    },
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
      const connected = new Map(fixedBrokers.map(broker => [broker, false]));
      let aggregateConnected = false;
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

      const unsubs = fixedBrokers.map(routeBroker => routeBroker.subscribe((event: BrokerEvent) => {
        if (event.type === 'order' || event.type === 'fill' || event.type === 'position') {
          const accountId = event.type === 'order'
            ? event.order.accountId
            : event.type === 'fill'
              ? event.fill.accountId
              : event.position.accountId;
          // Jedno OAuth může vidět více účtů, než mu bylo svěřeno v route.
          // Takové entity sem nesmí projít: při překryvu OAuth viditelnosti by
          // se leader lifecycle zpracoval dvakrát.
          if (!accountIdsByBroker.get(routeBroker)?.has(accountId)) return;
          listener(event);
          return;
        }
        const grace = !criticalBrokers.has(routeBroker) && graceMs > 0;
        if (event.type === 'error') {
          if (!grace) {
            listener(event);
            return;
          }
          // Transport chyba nekritické route předchází jejímu disconnect
          // eventu — zadržíme ji ve stejné lhůtě. Objednávky mají vlastní
          // fail-closed cestu, tady jde jen o plané poplachy.
          const outage = pendingOutage.get(routeBroker);
          if (outage) {
            outage.held.push(event);
          } else {
            pendingOutage.set(routeBroker, {
              held: [event],
              timer: setTimeoutImpl(() => flushOutage(routeBroker), graceMs),
            });
          }
          return;
        }
        if (event.type !== 'connection') {
          listener(event);
          return;
        }
        if (!grace) {
          applyConnection(routeBroker, event);
          return;
        }
        const outage = pendingOutage.get(routeBroker);
        if (!event.connected) {
          if (outage) {
            outage.held.push(event);
          } else {
            pendingOutage.set(routeBroker, {
              held: [event],
              timer: setTimeoutImpl(() => flushOutage(routeBroker), graceMs),
            });
          }
          return;
        }
        if (outage) {
          // Reconnect ve lhůtě: mrknutí se nikdy nestalo — zadržené eventy
          // se zahodí a agregát zůstává beze změny.
          clearTimeoutImpl(outage.timer);
          pendingOutage.delete(routeBroker);
          connected.set(routeBroker, true);
          return;
        }
        applyConnection(routeBroker, event);
      }));
      return () => {
        for (const outage of pendingOutage.values()) clearTimeoutImpl(outage.timer);
        pendingOutage.clear();
        unsubs.forEach(unsubscribe => unsubscribe());
      };
    },
  };
}

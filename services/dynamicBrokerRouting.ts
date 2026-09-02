import type { BrokerRoute, BrokerRouterPort } from './brokerRouter';
import type { TradovateBrokerPort, TradovateVisibleAccount } from './tradovateBroker';

export interface DynamicOAuthConnection {
  connectionId: string;
  broker: TradovateBrokerPort;
}

export interface DynamicRoutedAccount {
  id: number;
  name: string;
  active: boolean;
  canTrade: boolean;
  connectionId: string;
}

export interface DynamicBrokerRoutingRequest {
  /** Účty, jejichž absence nebo nejednoznačnost vždy zablokuje refresh. */
  required: readonly number[];
  /** Účty, které se smějí vynechat výhradně tehdy, když je nevrátí žádný OAuth adresář. */
  optional: readonly number[];
}

interface AccountOwner {
  connection: DynamicOAuthConnection;
  account: TradovateVisibleAccount;
}

export interface DynamicBrokerRouteResolution {
  routes: BrokerRoute[];
  accounts: DynamicRoutedAccount[];
  missingOptional: number[];
}

export interface DynamicBrokerRouteRefresh {
  accounts: DynamicRoutedAccount[];
  missingOptional: number[];
}

/**
 * Čisté, fail-closed rozlišení account -> OAuth. Nikdy nehádá vlastníka:
 * nula i více shod jsou chyba a router se proto vůbec nepřepne.
 */
export function resolveDynamicBrokerRoutes(
  connections: readonly DynamicOAuthConnection[],
  snapshots: ReadonlyMap<string, readonly TradovateVisibleAccount[]>,
  request?: DynamicBrokerRoutingRequest,
): DynamicBrokerRouteResolution {
  if (connections.length === 0) throw new Error('Není nakonfigurované žádné OAuth spojení');
  const owners = new Map<number, AccountOwner[]>();
  for (const connection of connections) {
    const accounts = snapshots.get(connection.connectionId);
    if (!accounts) throw new Error(`OAuth ${connection.connectionId} nevrátilo adresář účtů`);
    for (const account of accounts) {
      owners.set(account.accountId, [...(owners.get(account.accountId) ?? []), { connection, account }]);
    }
  }

  const required = request == null
    ? [...owners].filter(([, matches]) => matches.some(match => (
      match.account.active && match.account.canTrade && match.account.accountSpec != null
    ))).map(([accountId]) => accountId)
    : [...new Set(request.required)];
  const optional = request == null ? [] : [...new Set(request.optional)];
  const requiredSet = new Set(required);
  const overlap = optional.filter(accountId => requiredSet.has(accountId));
  if (overlap.length > 0) {
    throw new Error(`Účet nesmí být současně required i optional: ${overlap.join(',')}`);
  }
  const requested = [...required, ...optional];
  const optionalSet = new Set(optional);
  const selected: AccountOwner[] = [];
  const missingOptional: number[] = [];
  for (const accountId of requested) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error(`Neplatné ID účtu ${accountId}`);
    const matches = owners.get(accountId) ?? [];
    if (matches.length === 0) {
      if (optionalSet.has(accountId)) {
        missingOptional.push(accountId);
        continue;
      }
      throw new Error(`Účet ${accountId} není viditelný v žádném připojeném OAuth. Připoj nebo obnov jeho prop firmu v Connections.`);
    }
    if (matches.length > 1) {
      throw new Error(`Účet ${accountId} je viditelný ve více OAuth spojeních; routing nelze bezpečně určit.`);
    }
    const match = matches[0];
    if (!match.account.active) throw new Error(`Účet ${accountId} není u Tradovate aktivní`);
    if (!match.account.canTrade) throw new Error(`Účet ${accountId} nemá execution oprávnění`);
    if (!match.account.accountSpec) throw new Error(`Účet ${accountId} nemá platné Tradovate Account.name`);
    selected.push(match);
  }

  return {
    routes: connections.map(connection => ({
      broker: connection.broker,
      accountIds: selected.filter(item => item.connection === connection).map(item => item.account.accountId),
    })),
    accounts: selected.map(({ connection, account }) => ({
      id: account.accountId,
      name: account.accountSpec as string,
      active: account.active,
      canTrade: account.canTrade,
      connectionId: connection.connectionId,
    })),
    missingOptional,
  };
}

/** Obnoví všechny OAuth adresáře a teprve po úplném úspěchu atomicky přepne router. */
export async function refreshDynamicBrokerRoutes(
  connections: readonly DynamicOAuthConnection[],
  router: BrokerRouterPort,
  request?: DynamicBrokerRoutingRequest,
): Promise<DynamicBrokerRouteRefresh> {
  const refreshed = await Promise.all(connections.map(async connection => (
    [connection.connectionId, await connection.broker.refreshAccountDirectory()] as const
  )));
  const resolution = resolveDynamicBrokerRoutes(connections, new Map(refreshed), request);
  router.replaceRoutes(resolution.routes);
  return {
    accounts: resolution.accounts,
    missingOptional: resolution.missingOptional,
  };
}

import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';

export type CopierWorkerAccountRoute = 'routable' | 'missing-worker' | 'unknown';

export interface CopierWorkerAccountRoutes {
  /** False means the UI must warn but must not block a selection. */
  known: boolean;
  routes: ReadonlyMap<number, CopierWorkerAccountRoute>;
}

interface ConnectionAccounts {
  accounts: readonly { id: number }[];
}

const workerConnectionIds = (
  status: LocalCopierAgentStatus | null | undefined,
): Set<string> | null => {
  if (!status) return null;
  // Propfirmy, které si spárovaný Mac načetl sám (owner scope, 4. 10. 2026).
  const discovered = status.connectionDiscovery?.loadedConnectionIds ?? [];
  // `devices` is the installed manifest. An explicitly empty array is useful
  // evidence too: this worker has no loaded execution connection.
  if (Array.isArray(status.devices)) {
    return new Set([
      ...status.devices
        .filter(device => device.state === 'paired')
        .map(device => device.connectionId),
      ...discovered,
    ]);
  }
  if (status.device) {
    return new Set(status.device.state === 'paired' ? [status.device.connectionId] : []);
  }
  // Compatibility with an older worker that already publishes per-session
  // usage but not the multi-device manifest. accountDisplay is deliberately
  // not used: its contract is display-only and must never authorize execution.
  if (Array.isArray(status.connectionUsage) && status.connectionUsage.length > 0) {
    return new Set(status.connectionUsage.map(connection => connection.connectionId));
  }
  return null;
};

/**
 * Joins the web OAuth directory to the fresh worker manifest. Ambiguous or
 * incomplete ownership remains `unknown` and never blocks the editor; the
 * worker still has the final word when the group is saved.
 */
export function buildCopierWorkerAccountRoutes(
  status: LocalCopierAgentStatus | null | undefined,
  statusKnown: boolean,
  connections: Readonly<Record<string, ConnectionAccounts>>,
): CopierWorkerAccountRoutes {
  const loadedConnections = statusKnown ? workerConnectionIds(status) : null;
  const owners = new Map<number, string[]>();
  for (const [connectionId, connection] of Object.entries(connections)) {
    for (const account of connection.accounts) {
      const current = owners.get(account.id) ?? [];
      current.push(connectionId);
      owners.set(account.id, current);
    }
  }
  const routes = new Map<number, CopierWorkerAccountRoute>();
  for (const [accountId, accountOwners] of owners) {
    routes.set(accountId, loadedConnections == null || accountOwners.length !== 1
      ? 'unknown'
      : loadedConnections.has(accountOwners[0]) ? 'routable' : 'missing-worker');
  }
  return { known: loadedConnections != null, routes };
}

export const copierWorkerAccountRoute = (
  routes: CopierWorkerAccountRoutes | undefined,
  accountId: number,
): CopierWorkerAccountRoute => routes?.routes.get(accountId) ?? 'unknown';

/** A selected missing account stays removable; only adding/selecting is blocked. */
export const copierWorkerAccountSelectionBlocked = (
  route: CopierWorkerAccountRoute,
  selected: boolean,
): boolean => route === 'missing-worker' && !selected;

export const copierWorkerMissingAccountIds = (
  routes: CopierWorkerAccountRoutes | undefined,
  accountIds: Iterable<number | null | undefined>,
): number[] => [...new Set([...accountIds].filter(
  (accountId): accountId is number => accountId != null
    && copierWorkerAccountRoute(routes, accountId) === 'missing-worker',
))];

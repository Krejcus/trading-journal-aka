import type { TradovateAccountProfilesResult } from './tradovateAccountProfileTypes';
import type { TradovateOAuthStatus, TradovatePreflightResult } from '../services/tradovateOAuthConnection';
import type { PrestartedTradovatePreflights, SettledTradovatePreflight } from './tradovatePreflightCoordinator';

export const TRADOVATE_INTENT_PREFETCH_TTL_MS = 3_000;

interface Dependencies {
  status(): Promise<TradovateOAuthStatus>;
  bootstrap(connectionId: string): Promise<TradovatePreflightResult>;
  profiles(): Promise<TradovateAccountProfilesResult>;
  now?: () => number;
  blocked?: () => boolean;
  onError?: (reason: unknown) => void;
}

interface PendingRead {
  promise: Promise<SettledTradovatePreflight>;
  failed: boolean;
}
interface Entry {
  userId: string;
  startedAt: number;
  status: Promise<PromiseSettledResult<TradovateOAuthStatus>>;
  profiles: Promise<TradovateAccountProfilesResult | null>;
  profilesFailed: boolean;
  bootstrap: Map<string, PendingRead>;
}

export interface TradovateIntentPrefetchResult {
  status: TradovateOAuthStatus;
  bootstrap: PrestartedTradovatePreflights;
  profiles: Promise<TradovateAccountProfilesResult | null> | null;
}

/** Hover/focus warming owns promises only. It never publishes account state,
 * starts polling, runs onboarding, or performs a configuration/broker write. */
export function createTradovateIntentPrefetch(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  let userId = '';
  let entry: Entry | null = null;
  const current = (candidate: Entry) => entry === candidate && candidate.userId === userId;
  const fresh = (candidate: Entry) => current(candidate)
    && now() >= candidate.startedAt
    && now() - candidate.startedAt < TRADOVATE_INTENT_PREFETCH_TTL_MS;
  const settled = async <T>(read: () => Promise<T>, candidate: Entry): Promise<PromiseSettledResult<T>> => {
    try {
      return { status: 'fulfilled', value: await read() };
    } catch (reason) {
      if (current(candidate)) deps.onError?.(reason);
      return { status: 'rejected', reason };
    }
  };
  const startBootstrap = (candidate: Entry, ids: readonly string[]) => {
    for (const id of new Set(ids)) {
      if (!id || candidate.bootstrap.has(id) || !fresh(candidate) || deps.blocked?.()) continue;
      const pending: PendingRead = { promise: Promise.resolve({ status: 'rejected', reason: 'not-started' }), failed: false };
      candidate.bootstrap.set(id, pending);
      pending.promise = settled(() => deps.bootstrap(id), candidate).then(result => {
        pending.failed = result.status === 'rejected';
        return result;
      });
    }
  };

  return {
    /** Called on each hook render: changing identity immediately revokes old work,
     * including A -> B -> A without waiting for effects to flush. */
    setUser(nextUserId: string) {
      if (nextUserId === userId) return;
      userId = nextUserId;
      entry = null;
    },
    prefetch(knownConnectionIds: readonly string[]) {
      if (!userId || deps.blocked?.() || entry && fresh(entry)) return;
      const candidate: Entry = {
        userId, startedAt: now(),
        status: Promise.resolve({ status: 'rejected', reason: 'not-started' }),
        profiles: Promise.resolve(null), profilesFailed: false, bootstrap: new Map(),
      };
      entry = candidate;
      candidate.status = settled(deps.status, candidate).then(result => {
        if (result.status === 'fulfilled' && fresh(candidate) && !deps.blocked?.()) {
          // No cached IDs is a normal first visit. Fresh OAuth status can warm
          // bootstrap while the pointer is still approaching the LIVE button.
          startBootstrap(candidate, result.value.connections.filter(connection => connection.connected).map(connection => connection.id));
        }
        return result;
      });
      candidate.profiles = settled(deps.profiles, candidate).then(result => {
        candidate.profilesFailed = result.status === 'rejected';
        return result.status === 'fulfilled' ? result.value : null;
      });
      startBootstrap(candidate, knownConnectionIds);
    },
    async claim(expectedUserId: string): Promise<TradovateIntentPrefetchResult | null> {
      const candidate = entry;
      if (!candidate || expectedUserId !== userId || !fresh(candidate) || deps.blocked?.()) return null;
      const status = await candidate.status;
      // TTL admits or rejects reuse at entry. Once a pending status was
      // admitted, awaiting it is the ordinary request latency: expiring it
      // now would chain a second status request (or a second timeout).
      if (!current(candidate) || expectedUserId !== userId || status.status === 'rejected' || deps.blocked?.()) return null;
      const ids = new Set(status.value.connections.filter(connection => connection.connected).map(connection => connection.id));
      const bootstrap: PrestartedTradovatePreflights = new Map();
      for (const [id, pending] of candidate.bootstrap) {
        // A failed speculative read must not poison the ordinary entry path.
        // If still pending, it is already safely settled and the existing
        // refresh error/full-retry path handles a later failure.
        if (ids.has(id) && !pending.failed) bootstrap.set(id, pending.promise);
      }
      return { status: status.value, bootstrap, profiles: candidate.profilesFailed ? null : candidate.profiles };
    },
    clear() { entry = null; },
  };
}

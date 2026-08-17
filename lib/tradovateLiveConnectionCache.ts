import type { TradovateAccountProfile } from './tradovateAccountProfileTypes';
import type {
  TradovateOAuthStatus,
  TradovatePreflightResult,
} from '../services/tradovateOAuthConnection';

export interface TradovateConnectionSummary {
  accountCount: number;
  organizationName: string | null;
}

interface PersistedTradovateConnectionShell {
  version: 1;
  status: TradovateOAuthStatus;
  summaries: Record<string, TradovateConnectionSummary>;
}

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CACHE_PREFIX = 'alphatrade:tradovate-live-shell:v1:';

const cacheKey = (userId: string) => `${CACHE_PREFIX}${userId}`;

const isEnvironment = (value: unknown): value is 'demo' | 'live' => value === 'demo' || value === 'live';

const sanitizedStatus = (status: TradovateOAuthStatus): TradovateOAuthStatus => ({
  connected: status.connected,
  environment: status.environment,
  connections: status.connections.map(connection => ({
    id: connection.id,
    connected: connection.connected,
    environment: connection.environment,
    expiresAt: null,
    hasRefreshToken: false,
    connectedAt: null,
    refreshedAt: null,
    tradovateUserId: null,
    tradovateEmail: null,
    organizationName: connection.organizationName,
    disconnectedAt: null,
    disconnectReason: null,
  })),
});

export const buildTradovateConnectionSummaries = (
  status: TradovateOAuthStatus | null,
  connectionData: Record<string, TradovatePreflightResult>,
  profiles: TradovateAccountProfile[],
  previous: Record<string, TradovateConnectionSummary> = {},
): Record<string, TradovateConnectionSummary> => Object.fromEntries((status?.connections ?? []).map(connection => {
  const dataset = connectionData[connection.id];
  const accountIds = new Set(dataset?.accounts.map(account => String(account.id)) ?? []);
  const propFirms = Array.from(new Set(
    profiles
      .filter(profile => accountIds.has(profile.externalAccountId))
      .map(profile => profile.propFirm.trim())
      .filter(Boolean),
  ));
  return [connection.id, {
    accountCount: dataset?.accounts.length ?? previous[connection.id]?.accountCount ?? 0,
    organizationName: propFirms.join(', ')
      || connection.organizationName
      || previous[connection.id]?.organizationName
      || null,
  }];
}));

export const readTradovateConnectionShell = (
  userId: string,
  storage?: SessionStorageLike,
): PersistedTradovateConnectionShell | null => {
  if (!userId || !storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(cacheKey(userId)) ?? 'null') as Partial<PersistedTradovateConnectionShell> | null;
    if (!parsed || parsed.version !== 1 || !parsed.status || !Array.isArray(parsed.status.connections)) return null;
    if (!isEnvironment(parsed.status.environment)) return null;
    if (parsed.status.connections.some(connection => !connection || typeof connection.id !== 'string' || !isEnvironment(connection.environment))) return null;
    return {
      version: 1,
      status: sanitizedStatus(parsed.status),
      summaries: parsed.summaries ?? {},
    };
  } catch {
    return null;
  }
};

export const writeTradovateConnectionShell = (
  userId: string,
  status: TradovateOAuthStatus | null,
  summaries: Record<string, TradovateConnectionSummary>,
  storage?: SessionStorageLike,
): void => {
  if (!userId || !status || !storage) return;
  try {
    const payload: PersistedTradovateConnectionShell = {
      version: 1,
      status: sanitizedStatus(status),
      summaries,
    };
    storage.setItem(cacheKey(userId), JSON.stringify(payload));
  } catch {
    // Storage may be blocked or full. The in-memory cache remains the fallback.
  }
};

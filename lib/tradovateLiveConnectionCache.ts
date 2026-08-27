import type { TradovateAccountProfile } from './tradovateAccountProfileTypes';
import type {
  TradovateOAuthStatus,
  TradovatePreflightResult,
} from '../services/tradovateOAuthConnection';

export interface TradovateConnectionSummary {
  accountCount: number;
  organizationName: string | null;
}

export type TradovateConnectionDataRefreshMode = 'replace' | 'merge';

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
const DATA_CACHE_PREFIX = 'alphatrade:tradovate-live-data:v1:';

/**
 * Snapshot starší než plný reconciliation interval už nemá na kartě co dělat —
 * po vypršení se reload chová jako dřív (spinner do prvního preflightu).
 */
export const TRADOVATE_LIVE_DATA_CACHE_MAX_AGE_MS = 10 * 60_000;

const cacheKey = (userId: string) => `${CACHE_PREFIX}${userId}`;
const dataCacheKey = (userId: string) => `${DATA_CACHE_PREFIX}${userId}`;

interface PersistedTradovateConnectionData {
  version: 1;
  savedAt: number;
  connectionData: Record<string, TradovatePreflightResult>;
}

const isEnvironment = (value: unknown): value is 'demo' | 'live' => value === 'demo' || value === 'live';

export const applyTradovateConnectionDataRefresh = (
  current: Record<string, TradovatePreflightResult>,
  datasets: TradovatePreflightResult[],
  mode: TradovateConnectionDataRefreshMode,
): Record<string, TradovatePreflightResult> => {
  const incoming = Object.fromEntries(datasets.map(dataset => [dataset.connectionId, dataset]));
  return mode === 'merge' ? { ...current, ...incoming } : incoming;
};

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

/**
 * Poslední potvrzený broker read model pro okamžité vykreslení LIVE karty po
 * reloadu stránky (in-memory cache přežívá jen SPA navigaci). Neobsahuje OAuth
 * tokeny — jen stejná data, která UI už zobrazovalo. Freshness hlídá
 * `TRADOVATE_LIVE_DATA_CACHE_MAX_AGE_MS`; 2s P&L tick a plný preflight cache
 * hned po mountu přepíšou, takže zastaralé hodnoty žijí nejvýš sekundy.
 */
export const readTradovateConnectionDataCache = (
  userId: string,
  storage?: SessionStorageLike,
  now = Date.now(),
): Record<string, TradovatePreflightResult> | null => {
  if (!userId || !storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(dataCacheKey(userId)) ?? 'null') as Partial<PersistedTradovateConnectionData> | null;
    if (!parsed || parsed.version !== 1) return null;
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) return null;
    if (now - parsed.savedAt > TRADOVATE_LIVE_DATA_CACHE_MAX_AGE_MS || parsed.savedAt > now) return null;
    const connectionData = parsed.connectionData;
    if (!connectionData || typeof connectionData !== 'object' || Array.isArray(connectionData)) return null;
    const entries = Object.entries(connectionData);
    const valid = entries.every(([connectionId, dataset]) => dataset
      && typeof dataset === 'object'
      && dataset.connectionId === connectionId
      && isEnvironment(dataset.environment)
      && typeof dataset.capturedAt === 'string'
      && Array.isArray(dataset.accounts)
      && Array.isArray(dataset.contracts)
      && dataset.coverage != null && typeof dataset.coverage === 'object');
    if (!valid || entries.length === 0) return null;
    // Freshness podle capturedAt datasetů, ne podle savedAt zápisu: hydratace
    // zapisuje cache znovu, a savedAt by tak staré snapshoty držel naživu.
    // Každé připojení se posuzuje samostatně — čerstvý dataset jednoho
    // připojení nesmí do UI protáhnout výrazně starší dataset jiného.
    const fresh = entries.filter(([, dataset]) => {
      const capturedAt = Date.parse(dataset.capturedAt);
      return Number.isFinite(capturedAt) && now - capturedAt <= TRADOVATE_LIVE_DATA_CACHE_MAX_AGE_MS;
    });
    if (fresh.length === 0) return null;
    return Object.fromEntries(fresh);
  } catch {
    return null;
  }
};

/** Nejnovější broker capturedAt napříč datasety — pro „data z HH:MM:SS" v UI. */
export const newestTradovateConnectionCapturedAt = (
  connectionData: Record<string, TradovatePreflightResult>,
): number | null => {
  const newest = Object.values(connectionData)
    .map(dataset => Date.parse(dataset.capturedAt))
    .reduce((current, value) => Number.isFinite(value) ? Math.max(current, value) : current, Number.NEGATIVE_INFINITY);
  return Number.isFinite(newest) ? newest : null;
};

export const writeTradovateConnectionDataCache = (
  userId: string,
  connectionData: Record<string, TradovatePreflightResult>,
  storage?: SessionStorageLike,
  now = Date.now(),
): void => {
  if (!userId || !storage) return;
  try {
    const payload: PersistedTradovateConnectionData = { version: 1, savedAt: now, connectionData };
    storage.setItem(dataCacheKey(userId), JSON.stringify(payload));
  } catch {
    // Storage may be blocked or full. The in-memory cache remains the fallback.
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

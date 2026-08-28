import { supabase } from './supabase';
import { apiUrl } from '../utils/runtimeConfig';
import type {
  TradovateAccountDataAccount,
  TradovateAccountDataResult,
  TradovateHistoricalSyncCapability,
  TradovateSourceCoverage,
} from '../lib/tradovateAccountDataTypes';
import type {
  TradovateAccountProfileInput,
  TradovateAccountProfilesResult,
} from '../lib/tradovateAccountProfileTypes';
import type {
  TradovateHistorySnapshot,
  TradovateHistorySyncResult,
} from '../lib/tradovateHistoricalTypes';
import type {
  TradovateLivePnlAnchorTick,
  TradovateLivePnlTick,
} from '../lib/tradovateLivePnlTypes';
import {
  beginTradovateApiRequest,
  finishTradovateApiRequest,
} from '../lib/tradovateApiTelemetry';
import type { LocalCopierAgentCommand, LocalCopierAgentCommandResult, LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';

export interface TradovateOAuthConnectionStatus {
  id: string;
  connected: boolean;
  environment: 'demo' | 'live';
  expiresAt: string | null;
  hasRefreshToken: boolean;
  connectedAt: string | null;
  refreshedAt: string | null;
  tradovateUserId: number | null;
  tradovateEmail: string | null;
  organizationName: string | null;
  disconnectedAt: string | null;
  disconnectReason: string | null;
}

export interface TradovateOAuthStatus {
  connected: boolean;
  environment: 'demo' | 'live';
  connections: TradovateOAuthConnectionStatus[];
}

export type TradovatePreflightAccount = TradovateAccountDataAccount;
export type { TradovateSourceCoverage };

export interface TradovatePreflightResult extends TradovateAccountDataResult {
  connectionId: string;
  environment: 'demo' | 'live';
  historicalSync: TradovateHistoricalSyncCapability;
}

export interface TradovateHistoricalReportResult {
  status: 'available' | 'unauthorized' | 'forbidden' | 'invalid-response' | 'unavailable';
  httpStatus: number | null;
  reportName: 'Performance';
  accountId: number;
  startDate: string;
  endDate: string;
  contentType: string | null;
  byteLength: number;
  columns: string[];
  rowCount: number;
  rows: string[][];
  truncated: boolean;
  diagnostic: string | null;
}

export interface TradovatePilotLeaseEnvelope {
  version: 1;
  algorithm: 'RSA-OAEP-256+A256GCM';
  encryptedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const authorization = async (): Promise<string> => {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error('Nejdřív se přihlas do AlphaTrade.');
  return `Bearer ${data.session.access_token}`;
};

export class TradovateRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'TradovateRequestError';
  }
}

export const parseTradovateOAuthStatus = (value: unknown): TradovateOAuthStatus => {
  if (!value || typeof value !== 'object') {
    throw new Error('Tradovate API vrátilo neplatný stav připojení. Spusť localhost přes Vercel dev.');
  }
  const candidate = value as Partial<TradovateOAuthStatus>;
  if (
    typeof candidate.connected !== 'boolean'
    || (candidate.environment !== 'demo' && candidate.environment !== 'live')
    || !Array.isArray(candidate.connections)
  ) {
    throw new Error('Tradovate API vrátilo neplatný stav připojení. Spusť localhost přes Vercel dev.');
  }
  return candidate as TradovateOAuthStatus;
};

const authenticatedRequest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const telemetry = beginTradovateApiRequest();
  let completed = false;
  try {
    // V Capacitor buildu je origin capacitor://localhost — relativní /api/
    // cesta by skončila v bundlu (vrátí index.html místo API odpovědi).
    // apiUrl() ji v nativním buildu přesměruje na Vercel; web nechává být.
    const response = await fetch(apiUrl(path), {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        Authorization: await authorization(),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => ({})) as { error?: string; retryAfterMs?: number } & T;
    const retryAfterMs = typeof body.retryAfterMs === 'number' ? body.retryAfterMs : null;
    finishTradovateApiRequest(telemetry, response.status, retryAfterMs);
    completed = true;
    if (!response.ok) {
      throw new TradovateRequestError(
        body.error || `Tradovate request failed (${response.status})`,
        response.status,
        retryAfterMs,
      );
    }
    return body;
  } catch (reason) {
    if (!completed) {
      // Rozliš, kde fetch umřel: chybějící session vs. síťová vrstva.
      const message = reason instanceof Error ? reason.message : String(reason);
      finishTradovateApiRequest(telemetry, 0, null, Date.now(),
        message.includes('přihlas') ? 'auth' : 'network');
    }
    throw reason;
  }
};

export async function beginTradovateOAuth(connectionId?: string): Promise<void> {
  const { authorizationUrl } = await authenticatedRequest<{ authorizationUrl: string }>(
    '/api/tradovate/oauth/start',
    {
      method: 'POST',
      ...(connectionId ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      } : {}),
    },
  );
  const url = new URL(authorizationUrl);
  if (url.origin !== 'https://trader.tradovate.com' || url.pathname !== '/oauth') {
    throw new Error('Server vrátil neplatnou Tradovate OAuth adresu.');
  }
  window.location.assign(url.toString());
}

export async function loadTradovateOAuthStatus(): Promise<TradovateOAuthStatus> {
  return parseTradovateOAuthStatus(await authenticatedRequest<unknown>('/api/tradovate/oauth/status'));
}

export function disconnectTradovateOAuth(connectionId: string): Promise<{ connected: false }> {
  return authenticatedRequest(`/api/tradovate/oauth/status?connectionId=${encodeURIComponent(connectionId)}`, { method: 'DELETE' });
}

export function runTradovateReadOnlyPreflight(
  connectionId: string,
  mode: 'bootstrap' | 'full' = 'full',
): Promise<TradovatePreflightResult> {
  return authenticatedRequest('/api/tradovate/oauth/preflight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, mode }),
  });
}

export function createTradovatePilotLease(
  connectionId: string,
  publicKey: string,
): Promise<{ envelope: TradovatePilotLeaseEnvelope; expiresAt: string; issuedAt: string }> {
  return authenticatedRequest('/api/tradovate/oauth/pilot-lease', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, publicKey }),
  });
}

export function pairTradovateCopierDevice(input: {
  connectionId: string;
  deviceId: string;
  deviceSecret: string;
  publicKey: string;
  deviceName: string;
}): Promise<{ paired: true }> {
  return authenticatedRequest('/api/tradovate/oauth/copier-device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function revokeTradovateCopierDevice(deviceId: string): Promise<{ revoked: true }> {
  return authenticatedRequest('/api/tradovate/oauth/copier-device', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
}

export function loadTradovateCopierRelayStatus(connectionId: string): Promise<{
  status: LocalCopierAgentStatus;
  lastSeenAt: string;
  connected: boolean;
} | null> {
  return authenticatedRequest(`/api/tradovate/oauth/copier-relay?connectionId=${encodeURIComponent(connectionId)}`);
}

export async function executeTradovateCopierRelayCommand(
  connectionId: string,
  command: LocalCopierAgentCommand,
): Promise<LocalCopierAgentCommandResult> {
  const idempotencyKey = crypto.randomUUID();
  const queued = await authenticatedRequest<{
    id: string;
    expiresAt: string;
    /** Server long-poll: hotový výsledek už v enqueue odpovědi — bez dalších kol. */
    resolution?: { status: string; result?: LocalCopierAgentCommandResult; error?: string };
  }>('/api/tradovate/oauth/copier-relay', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, command, idempotencyKey }),
  });
  if (queued.resolution) {
    if (queued.resolution.status === 'succeeded' && queued.resolution.result) return queued.resolution.result;
    throw new Error(queued.resolution.error || `Copier příkaz skončil stavem ${queued.resolution.status}`);
  }
  const deadline = Math.min(Date.parse(queued.expiresAt) + 5_000, Date.now() + 35_000);
  while (Date.now() < deadline) {
    const result = await authenticatedRequest<{ status: string; result?: LocalCopierAgentCommandResult; error?: string }>(
      `/api/tradovate/oauth/copier-relay?connectionId=${encodeURIComponent(connectionId)}&commandId=${encodeURIComponent(queued.id)}`,
    );
    if (result.status === 'succeeded' && result.result) return result.result;
    if (result.status === 'rejected' || result.status === 'expired') throw new Error(result.error || `Copier příkaz skončil stavem ${result.status}`);
    await new Promise(resolve => window.setTimeout(resolve, 400));
  }
  throw new Error('Mac worker příkaz včas nepotvrdil. Příkaz expiroval a nebude automaticky opakován.');
}

export function runTradovateLivePnlTick(
  connectionId: string,
  contractCursor = 0,
): Promise<TradovateLivePnlTick> {
  return authenticatedRequest('/api/tradovate/oauth/live-pnl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, contractCursor }),
  });
}

export function runTradovateLivePnlAnchor(
  connectionId: string,
  accountId: number,
  contractId: number,
): Promise<TradovateLivePnlAnchorTick> {
  return authenticatedRequest('/api/tradovate/oauth/live-pnl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, mode: 'anchor', accountId, contractId }),
  });
}

export function runTradovatePerformanceHistory(options: {
  connectionId: string;
  accountId: number;
  startDate: string;
  endDate: string;
}): Promise<TradovateHistoricalReportResult> {
  return authenticatedRequest('/api/tradovate/oauth/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
}

export function runTradovateHistoricalBackfill(options: {
  connectionId: string;
  accountId: number;
  startDate?: string;
  endDate?: string;
}): Promise<TradovateHistorySnapshot & { sync: TradovateHistorySyncResult }> {
  return authenticatedRequest('/api/tradovate/oauth/history-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
}

export function loadTradovateHistoricalSnapshot(
  accountId: number,
  limit = 500,
): Promise<TradovateHistorySnapshot> {
  return authenticatedRequest(`/api/tradovate/oauth/history-sync?accountId=${encodeURIComponent(accountId)}&limit=${encodeURIComponent(limit)}`);
}

export function loadTradovateAccountProfiles(): Promise<TradovateAccountProfilesResult> {
  return authenticatedRequest('/api/tradovate/account-profiles');
}

export function saveTradovateAccountProfiles(
  profiles: TradovateAccountProfileInput[],
): Promise<TradovateAccountProfilesResult> {
  return authenticatedRequest('/api/tradovate/account-profiles', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profiles }),
  });
}

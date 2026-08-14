import { supabase } from './supabase';

export interface TradovateOAuthStatus {
  connected: boolean;
  expiresAt: string | null;
  hasRefreshToken: boolean;
  connectedAt: string | null;
  refreshedAt: string | null;
  tradovateUserId: number | null;
  tradovateEmail: string | null;
}

export interface TradovatePreflightAccount {
  id: number;
  name: string;
  active: boolean;
  canTrade: boolean;
  netPositionCount: number;
  workingOrderCount: number;
}

export interface TradovatePreflightResult {
  environment: 'live';
  accounts: TradovatePreflightAccount[];
}

const authorization = async (): Promise<string> => {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error('Nejdřív se přihlas do AlphaTrade.');
  return `Bearer ${data.session.access_token}`;
};

const authenticatedRequest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      Authorization: await authorization(),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `Tradovate request failed (${response.status})`);
  return body;
};

export async function beginTradovateOAuth(): Promise<void> {
  const { authorizationUrl } = await authenticatedRequest<{ authorizationUrl: string }>(
    '/api/tradovate/oauth/start',
    { method: 'POST' },
  );
  const url = new URL(authorizationUrl);
  if (url.origin !== 'https://trader.tradovate.com' || url.pathname !== '/oauth') {
    throw new Error('Server vrátil neplatnou Tradovate OAuth adresu.');
  }
  window.location.assign(url.toString());
}

export function loadTradovateOAuthStatus(): Promise<TradovateOAuthStatus> {
  return authenticatedRequest('/api/tradovate/oauth/status');
}

export function disconnectTradovateOAuth(): Promise<{ connected: false }> {
  return authenticatedRequest('/api/tradovate/oauth/status', { method: 'DELETE' });
}

export function runTradovateReadOnlyPreflight(): Promise<TradovatePreflightResult> {
  return authenticatedRequest('/api/tradovate/oauth/preflight', { method: 'POST' });
}

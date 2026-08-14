import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  decryptTradovateSecret,
  encryptTradovateSecret,
  refreshTradovateAccessToken,
  type TradovateEnvironment,
  type TradovateTokenResponse,
} from './tradovateOAuth.js';

export interface TradovateServerConfig {
  environment: TradovateEnvironment;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
  tokenEncryptionKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
}

export interface TradovateConnectionStatus {
  connected: boolean;
  environment: TradovateEnvironment;
  expiresAt: string | null;
  hasRefreshToken: boolean;
  connectedAt: string | null;
  refreshedAt: string | null;
  tradovateUserId: number | null;
  tradovateEmail: string | null;
}

interface ConnectionRow {
  user_id: string;
  environment: TradovateEnvironment;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  access_token_expires_at: string;
  token_type: string;
  scope: string | null;
  tradovate_user_id: number | null;
  tradovate_email: string | null;
  connected_at: string;
  refreshed_at: string | null;
  updated_at: string;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing server environment variable: ${name}`);
  return value;
};

const tradovateEnvironment = (): TradovateEnvironment => {
  const value = required('TRADOVATE_ENVIRONMENT').toLowerCase();
  if (value !== 'demo' && value !== 'live') {
    throw new Error('TRADOVATE_ENVIRONMENT must be demo or live');
  }
  return value;
};

export function readTradovateServerConfig(): TradovateServerConfig {
  return {
    environment: tradovateEnvironment(),
    clientId: required('TRADOVATE_CLIENT_ID'),
    clientSecret: required('TRADOVATE_CLIENT_SECRET'),
    redirectUri: required('TRADOVATE_REDIRECT_URI'),
    stateSecret: required('TRADOVATE_OAUTH_STATE_SECRET'),
    tokenEncryptionKey: required('TRADOVATE_TOKEN_ENCRYPTION_KEY'),
    supabaseUrl: required('SUPABASE_URL'),
    supabaseAnonKey: required('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

export function createTradovateAdminClient(config: TradovateServerConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function requireSupabaseUserId(
  authorization: string | undefined,
  config: TradovateServerConfig,
): Promise<string> {
  if (!authorization?.startsWith('Bearer ')) throw new Error('missing-auth-token');
  const auth = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) throw new Error('invalid-auth-token');
  return data.user.id;
}

const expiresAt = (token: TradovateTokenResponse, now: number): string =>
  new Date(now + token.expiresIn * 1_000).toISOString();

export async function saveTradovateConnection(options: {
  db: SupabaseClient;
  config: TradovateServerConfig;
  userId: string;
  token: TradovateTokenResponse;
  now?: number;
  tradovateUserId?: number | null;
  tradovateEmail?: string | null;
}): Promise<void> {
  const now = options.now ?? Date.now();
  const { error } = await options.db.from('tradovate_oauth_connections').upsert({
    user_id: options.userId,
    environment: options.config.environment,
    encrypted_access_token: encryptTradovateSecret(options.token.accessToken, options.config.tokenEncryptionKey),
    encrypted_refresh_token: options.token.refreshToken
      ? encryptTradovateSecret(options.token.refreshToken, options.config.tokenEncryptionKey)
      : null,
    access_token_expires_at: expiresAt(options.token, now),
    token_type: options.token.tokenType,
    scope: options.token.scope,
    tradovate_user_id: options.tradovateUserId ?? null,
    tradovate_email: options.tradovateEmail ?? null,
    connected_at: new Date(now).toISOString(),
    refreshed_at: null,
    updated_at: new Date(now).toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw new Error(`Tradovate connection save failed: ${error.message}`);
}

async function connectionRow(db: SupabaseClient, userId: string): Promise<ConnectionRow | null> {
  const { data, error } = await db
    .from('tradovate_oauth_connections')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle<ConnectionRow>();
  if (error) throw new Error(`Tradovate connection load failed: ${error.message}`);
  return data;
}

const sanitizedStatus = (
  row: ConnectionRow | null,
  environment: TradovateEnvironment,
): TradovateConnectionStatus => {
  const activeRow = row?.environment === environment ? row : null;
  return {
    connected: activeRow != null,
    environment,
    expiresAt: activeRow?.access_token_expires_at ?? null,
    hasRefreshToken: Boolean(activeRow?.encrypted_refresh_token),
    connectedAt: activeRow?.connected_at ?? null,
    refreshedAt: activeRow?.refreshed_at ?? null,
    tradovateUserId: activeRow?.tradovate_user_id ?? null,
    tradovateEmail: activeRow?.tradovate_email ?? null,
  };
};

export async function getTradovateConnectionStatus(
  db: SupabaseClient,
  userId: string,
  environment: TradovateEnvironment,
): Promise<TradovateConnectionStatus> {
  return sanitizedStatus(await connectionRow(db, userId), environment);
}

export async function getValidTradovateAccessToken(options: {
  db: SupabaseClient;
  config: TradovateServerConfig;
  userId: string;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; expiresAt: string }> {
  const now = options.now ?? Date.now();
  const row = await connectionRow(options.db, options.userId);
  if (!row) throw new Error('tradovate-not-connected');
  if (row.environment !== options.config.environment) {
    throw new Error('tradovate-reauthorization-required');
  }
  const expires = Date.parse(row.access_token_expires_at);
  if (Number.isFinite(expires) && expires - now > 120_000) {
    return {
      accessToken: decryptTradovateSecret(row.encrypted_access_token, options.config.tokenEncryptionKey),
      expiresAt: row.access_token_expires_at,
    };
  }
  if (!row.encrypted_refresh_token) throw new Error('tradovate-reauthorization-required');

  const refreshToken = decryptTradovateSecret(row.encrypted_refresh_token, options.config.tokenEncryptionKey);
  let refreshed: TradovateTokenResponse;
  try {
    refreshed = await refreshTradovateAccessToken({
      refreshToken,
      clientId: options.config.clientId,
      clientSecret: options.config.clientSecret,
      environment: options.config.environment,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    // A concurrent invocation may have rotated the refresh token first. If so,
    // consume the newer row rather than turning a harmless race into logout.
    const latest = await connectionRow(options.db, options.userId);
    const latestExpiry = Date.parse(latest?.access_token_expires_at ?? '');
    if (latest && latest.updated_at !== row.updated_at && latestExpiry - now > 120_000) {
      return {
        accessToken: decryptTradovateSecret(latest.encrypted_access_token, options.config.tokenEncryptionKey),
        expiresAt: latest.access_token_expires_at,
      };
    }
    throw error;
  }

  const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
  const nextExpiresAt = expiresAt(refreshed, now);
  const timestamp = new Date(now).toISOString();
  const { data: updated, error } = await options.db.from('tradovate_oauth_connections').update({
    encrypted_access_token: encryptTradovateSecret(refreshed.accessToken, options.config.tokenEncryptionKey),
    encrypted_refresh_token: encryptTradovateSecret(nextRefreshToken, options.config.tokenEncryptionKey),
    access_token_expires_at: nextExpiresAt,
    token_type: refreshed.tokenType,
    scope: refreshed.scope ?? row.scope,
    refreshed_at: timestamp,
    updated_at: timestamp,
  }).eq('user_id', options.userId).eq('updated_at', row.updated_at).select('user_id').maybeSingle<{ user_id: string }>();
  if (error) throw new Error(`Tradovate token refresh save failed: ${error.message}`);
  if (!updated) {
    const latest = await connectionRow(options.db, options.userId);
    const latestExpiry = Date.parse(latest?.access_token_expires_at ?? '');
    if (!latest || latestExpiry - now <= 120_000) throw new Error('tradovate-refresh-race-unresolved');
    return {
      accessToken: decryptTradovateSecret(latest.encrypted_access_token, options.config.tokenEncryptionKey),
      expiresAt: latest.access_token_expires_at,
    };
  }

  return { accessToken: refreshed.accessToken, expiresAt: nextExpiresAt };
}

export async function deleteTradovateConnection(db: SupabaseClient, userId: string): Promise<void> {
  const { error } = await db.from('tradovate_oauth_connections').delete().eq('user_id', userId);
  if (error) throw new Error(`Tradovate disconnect failed: ${error.message}`);
}

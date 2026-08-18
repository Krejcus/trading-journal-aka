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
  id: string;
  connected: boolean;
  environment: TradovateEnvironment;
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

interface ConnectionRow {
  id: string;
  user_id: string;
  environment: TradovateEnvironment;
  encrypted_access_token: string | null;
  encrypted_refresh_token: string | null;
  access_token_expires_at: string | null;
  token_type: string;
  scope: string | null;
  tradovate_user_id: number | null;
  tradovate_email: string | null;
  organization_name: string | null;
  connected_at: string;
  refreshed_at: string | null;
  updated_at: string;
  connection_status: 'connected' | 'disconnected';
  disconnected_at: string | null;
  disconnect_reason: string | null;
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
  connectionId: string;
  now?: number;
  tradovateUserId?: number | null;
  tradovateEmail?: string | null;
  organizationName?: string | null;
}): Promise<void> {
  const now = options.now ?? Date.now();
  let targetId = options.connectionId;
  if (options.tradovateUserId != null) {
    const { data: existing, error: existingError } = await options.db
      .from('tradovate_oauth_connections')
      .select('id')
      .eq('user_id', options.userId)
      .eq('environment', options.config.environment)
      .eq('tradovate_user_id', options.tradovateUserId)
      .maybeSingle<{ id: string }>();
    if (existingError) throw new Error(`Tradovate connection identity lookup failed: ${existingError.message}`);
    if (existing?.id) targetId = existing.id;
  }
  const { error } = await options.db.from('tradovate_oauth_connections').upsert({
    id: targetId,
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
    organization_name: options.organizationName ?? null,
    connection_status: 'connected',
    disconnected_at: null,
    disconnect_reason: null,
    connected_at: new Date(now).toISOString(),
    refreshed_at: null,
    updated_at: new Date(now).toISOString(),
  }, { onConflict: 'id' });
  if (error) throw new Error(`Tradovate connection save failed: ${error.message}`);
}

async function connectionRow(db: SupabaseClient, userId: string, connectionId?: string): Promise<ConnectionRow | null> {
  let query = db
    .from('tradovate_oauth_connections')
    .select('*')
    .eq('user_id', userId);
  if (connectionId) query = query.eq('id', connectionId);
  const { data, error } = await query
    .order('connected_at', { ascending: true })
    .limit(1)
    .maybeSingle<ConnectionRow>();
  if (error) throw new Error(`Tradovate connection load failed: ${error.message}`);
  return data;
}

const sanitizedStatus = (
  row: ConnectionRow | null,
  environment: TradovateEnvironment,
): TradovateConnectionStatus => {
  const activeRow = row?.environment === environment ? row : null;
  const connected = activeRow?.connection_status === 'connected' && Boolean(activeRow.encrypted_access_token);
  return {
    id: activeRow?.id ?? '',
    connected,
    environment,
    expiresAt: connected ? activeRow?.access_token_expires_at ?? null : null,
    hasRefreshToken: connected && Boolean(activeRow?.encrypted_refresh_token),
    connectedAt: activeRow?.connected_at ?? null,
    refreshedAt: activeRow?.refreshed_at ?? null,
    tradovateUserId: activeRow?.tradovate_user_id ?? null,
    tradovateEmail: activeRow?.tradovate_email ?? null,
    organizationName: activeRow?.organization_name ?? null,
    disconnectedAt: activeRow?.disconnected_at ?? null,
    disconnectReason: activeRow?.disconnect_reason ?? null,
  };
};

export async function listTradovateConnectionStatuses(
  db: SupabaseClient,
  userId: string,
  environment: TradovateEnvironment,
): Promise<TradovateConnectionStatus[]> {
  const { data, error } = await db
    .from('tradovate_oauth_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('environment', environment)
    .order('connected_at', { ascending: true });
  if (error) throw new Error(`Tradovate connection list failed: ${error.message}`);
  return ((data ?? []) as ConnectionRow[]).map(row => sanitizedStatus(row, environment));
}

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
  connectionId?: string;
  /** Refresh early when a caller needs the token to survive a bounded operation. */
  minimumValidityMs?: number;
}): Promise<{ accessToken: string; expiresAt: string }> {
  const now = options.now ?? Date.now();
  const minimumValidityMs = Math.max(120_000, options.minimumValidityMs ?? 120_000);
  const row = await connectionRow(options.db, options.userId, options.connectionId);
  if (!row) throw new Error('tradovate-not-connected');
  if (row.connection_status !== 'connected' || !row.encrypted_access_token || !row.access_token_expires_at) {
    throw new Error('tradovate-reauthorization-required');
  }
  if (row.environment !== options.config.environment) {
    throw new Error('tradovate-reauthorization-required');
  }
  const expires = Date.parse(row.access_token_expires_at);
  if (Number.isFinite(expires) && expires - now > minimumValidityMs) {
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
    const latest = await connectionRow(options.db, options.userId, row.id);
    const latestExpiry = Date.parse(latest?.access_token_expires_at ?? '');
    if (latest?.connection_status === 'connected' && latest.encrypted_access_token && latest.access_token_expires_at && latest.updated_at !== row.updated_at && latestExpiry - now > minimumValidityMs) {
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
  }).eq('id', row.id).eq('user_id', options.userId).eq('connection_status', 'connected').eq('updated_at', row.updated_at).select('user_id').maybeSingle<{ user_id: string }>();
  if (error) throw new Error(`Tradovate token refresh save failed: ${error.message}`);
  if (!updated) {
    const latest = await connectionRow(options.db, options.userId, row.id);
    const latestExpiry = Date.parse(latest?.access_token_expires_at ?? '');
    if (latest?.connection_status !== 'connected' || !latest.encrypted_access_token || !latest.access_token_expires_at || latestExpiry - now <= minimumValidityMs) {
      throw new Error('tradovate-refresh-race-unresolved');
    }
    return {
      accessToken: decryptTradovateSecret(latest.encrypted_access_token, options.config.tokenEncryptionKey),
      expiresAt: latest.access_token_expires_at,
    };
  }

  return { accessToken: refreshed.accessToken, expiresAt: nextExpiresAt };
}

export async function disconnectTradovateConnection(
  db: SupabaseClient,
  userId: string,
  connectionId: string,
  now = Date.now(),
): Promise<void> {
  const timestamp = new Date(now).toISOString();
  const { data, error } = await db.from('tradovate_oauth_connections').update({
    encrypted_access_token: null,
    encrypted_refresh_token: null,
    access_token_expires_at: null,
    connection_status: 'disconnected',
    disconnected_at: timestamp,
    disconnect_reason: 'user',
    updated_at: timestamp,
  }).eq('user_id', userId).eq('id', connectionId).select('id').maybeSingle<{ id: string }>();
  if (error) throw new Error(`Tradovate disconnect failed: ${error.message}`);
  if (!data) throw new Error('tradovate-connection-not-found');
}

export async function requireReconnectableTradovateConnection(options: {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  environment: TradovateEnvironment;
}): Promise<void> {
  const { data, error } = await options.db
    .from('tradovate_oauth_connections')
    .select('id')
    .eq('user_id', options.userId)
    .eq('id', options.connectionId)
    .eq('environment', options.environment)
    .eq('connection_status', 'disconnected')
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`Tradovate reconnect lookup failed: ${error.message}`);
  if (!data) throw new Error('tradovate-connection-not-reconnectable');
}

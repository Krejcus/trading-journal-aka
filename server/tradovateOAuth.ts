import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const TRADOVATE_OAUTH_AUTHORIZE_URL = 'https://trader.tradovate.com/oauth';
export const TRADOVATE_OAUTH_TOKEN_URL = 'https://live.tradovateapi.com/auth/oauthtoken';
export const TRADOVATE_OAUTH_COOKIE = '__Host-at_tv_oauth';
export const TRADOVATE_OAUTH_STATE_TTL_SECONDS = 10 * 60;

export interface TradovateOAuthState {
  sub: string;
  nonce: string;
  exp: number;
}

export interface TradovateTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
  scope: string | null;
}

export class TradovateOAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'TradovateOAuthError';
  }
}

const base64Url = (value: Buffer | string): string =>
  Buffer.from(value).toString('base64url');

const parseJson = <T>(value: string, code: string): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new TradovateOAuthError('Invalid OAuth payload', code);
  }
};

const stateSignature = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export function createTradovateOAuthState(
  userId: string,
  secret: string,
  now = Date.now(),
  nonce = randomBytes(24).toString('base64url'),
): string {
  if (!userId.trim()) throw new TradovateOAuthError('Missing OAuth user', 'invalid-state-user');
  if (secret.length < 32) throw new TradovateOAuthError('OAuth state secret is too short', 'invalid-state-secret', 500);
  const claims: TradovateOAuthState = {
    sub: userId,
    nonce,
    exp: Math.floor(now / 1_000) + TRADOVATE_OAUTH_STATE_TTL_SECONDS,
  };
  const payload = base64Url(JSON.stringify(claims));
  return `${payload}.${stateSignature(payload, secret)}`;
}

export function verifyTradovateOAuthState(
  state: string,
  secret: string,
  now = Date.now(),
): TradovateOAuthState {
  const [payload, signature, extra] = state.split('.');
  if (!payload || !signature || extra) {
    throw new TradovateOAuthError('Malformed OAuth state', 'invalid-state');
  }
  const expected = Buffer.from(stateSignature(payload, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new TradovateOAuthError('OAuth state signature mismatch', 'invalid-state');
  }
  const claims = parseJson<TradovateOAuthState>(Buffer.from(payload, 'base64url').toString('utf8'), 'invalid-state');
  if (!claims.sub || !claims.nonce || !Number.isSafeInteger(claims.exp)) {
    throw new TradovateOAuthError('OAuth state claims are incomplete', 'invalid-state');
  }
  if (claims.exp < Math.floor(now / 1_000)) {
    throw new TradovateOAuthError('OAuth state expired', 'expired-state');
  }
  return claims;
}

export function buildTradovateAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(TRADOVATE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);
  return url.toString();
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

export function buildTradovateStateCookie(state: string, secure = true): string {
  return [
    `${TRADOVATE_OAUTH_COOKIE}=${encodeURIComponent(state)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${TRADOVATE_OAUTH_STATE_TTL_SECONDS}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearTradovateStateCookie(secure = true): string {
  return [
    `${TRADOVATE_OAUTH_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function encryptionKey(encoded: string): Buffer {
  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(encoded)) key = Buffer.from(encoded, 'hex');
  else key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32) {
    throw new TradovateOAuthError(
      'TRADOVATE_TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes',
      'invalid-encryption-key',
      500,
    );
  }
  return key;
}

export function encryptTradovateSecret(value: string, encodedKey: string): string {
  if (!value) throw new TradovateOAuthError('Cannot encrypt an empty token', 'empty-token', 500);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(encodedKey), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptTradovateSecret(value: string, encodedKey: string): string {
  const [version, ivValue, tagValue, encryptedValue, extra] = value.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue || extra) {
    throw new TradovateOAuthError('Encrypted token is malformed', 'invalid-encrypted-token', 500);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(encodedKey), Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof TradovateOAuthError) throw error;
    throw new TradovateOAuthError('Encrypted token authentication failed', 'invalid-encrypted-token', 500);
  }
}

function normalizeTokenResponse(value: unknown): TradovateTokenResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TradovateOAuthError('Tradovate returned an invalid token response', 'invalid-token-response', 502);
  }
  const body = value as Record<string, unknown>;
  if (typeof body.error === 'string') {
    const description = typeof body.error_description === 'string' ? body.error_description : body.error;
    throw new TradovateOAuthError(`Tradovate OAuth rejected the request: ${description}`, 'token-rejected', 502);
  }
  const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';
  const expiresIn = Number(body.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new TradovateOAuthError('Tradovate token response is incomplete', 'invalid-token-response', 502);
  }
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token.trim()
      ? body.refresh_token.trim()
      : null,
    expiresIn: Math.floor(expiresIn),
    tokenType: typeof body.token_type === 'string' && body.token_type.trim() ? body.token_type.trim() : 'Bearer',
    scope: typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : null,
  };
}

async function requestToken(
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TradovateTokenResponse> {
  const response = await fetchImpl(TRADOVATE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const body = text ? parseJson<unknown>(text, 'invalid-token-response') : null;
  if (!response.ok) {
    const detail = body && typeof body === 'object' && !Array.isArray(body)
      ? String((body as Record<string, unknown>).error_description ?? (body as Record<string, unknown>).error ?? response.status)
      : String(response.status);
    throw new TradovateOAuthError(`Tradovate token exchange failed: ${detail}`, 'token-exchange-failed', 502);
  }
  return normalizeTokenResponse(body);
}

export function exchangeTradovateAuthorizationCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<TradovateTokenResponse> {
  return requestToken({
    grant_type: 'authorization_code',
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    code: options.code,
  }, options.fetchImpl ?? fetch);
}

export function refreshTradovateAccessToken(options: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<TradovateTokenResponse> {
  return requestToken({
    grant_type: 'refresh_token',
    client_id: options.clientId,
    client_secret: options.clientSecret,
    refresh_token: options.refreshToken,
  }, options.fetchImpl ?? fetch);
}

import { describe, expect, it } from 'vitest';
import {
  buildTradovateAuthorizationUrl,
  buildTradovateStateCookie,
  createTradovateOAuthState,
  decryptTradovateSecret,
  encryptTradovateSecret,
  exchangeTradovateAuthorizationCode,
  normalizeTradovateOAuthIdentity,
  parseCookies,
  refreshTradovateAccessToken,
  tradovateApiBaseUrl,
  tradovateOAuthResultLocation,
  tradovateOAuthTokenUrl,
  verifyTradovateOAuthState,
} from '../server/tradovateOAuth';

const stateSecret = 'state-secret-that-is-definitely-longer-than-32-bytes';
const encryptionKey = Buffer.alloc(32, 7).toString('base64url');

describe('Tradovate OAuth primitives', () => {
  it('normalizuje OAuth identitu i při číselném stringu nebo REST obálce', () => {
    expect(normalizeTradovateOAuthIdentity({ userId: '123', email: ' trader@example.com ' })).toMatchObject({
      userId: 123,
      email: 'trader@example.com',
    });
    expect(normalizeTradovateOAuthIdentity({ d: { user_id: 456, organization_name: 'Tradeify' } })).toMatchObject({
      userId: 456,
      organizationName: 'Tradeify',
    });
  });

  it('neblokuje platný OAuth token jen kvůli chybějícím volitelným identity metadatům', () => {
    expect(normalizeTradovateOAuthIdentity({ name: 'prop-user' })).toEqual({
      userId: null,
      email: null,
      name: 'prop-user',
      organizationName: null,
    });
  });

  it('podepíše stav, sváže ho s uživatelem a odmítne změnu i expiraci', () => {
    const now = Date.UTC(2026, 7, 14, 10, 0, 0);
    const state = createTradovateOAuthState('user-123', stateSecret, now, 'nonce-1');
    expect(verifyTradovateOAuthState(state, stateSecret, now)).toMatchObject({ sub: 'user-123', nonce: 'nonce-1' });
    expect(() => verifyTradovateOAuthState(`${state}x`, stateSecret, now)).toThrow('signature');
    expect(() => verifyTradovateOAuthState(state, stateSecret, now + 11 * 60_000)).toThrow('expired');
  });

  it('přenese podepsané ID nového připojení přes OAuth callback', () => {
    const now = Date.UTC(2026, 7, 15, 5, 0, 0);
    const connectionId = '8d4b37f5-79ac-4ea8-a73f-6ef940f6e8a9';
    const state = createTradovateOAuthState('user-123', stateSecret, now, 'nonce-multi', connectionId);
    expect(verifyTradovateOAuthState(state, stateSecret, now)).toMatchObject({
      sub: 'user-123',
      connectionId,
    });
  });

  it('stav drží v HttpOnly SameSite cookie a OAuth URL neobsahuje secret', () => {
    const state = createTradovateOAuthState('user-123', stateSecret, Date.now(), 'nonce-2');
    const cookie = buildTradovateStateCookie(state);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(parseCookies(cookie).get('__Host-at_tv_oauth')).toBe(state);

    const url = new URL(buildTradovateAuthorizationUrl({
      clientId: 'client-id',
      redirectUri: 'https://alphatrade-mentor-15.vercel.app/oauth/tradovate/callback',
      state,
    }));
    expect(url.origin).toBe('https://trader.tradovate.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.toString()).not.toContain('client-secret');
  });

  it('šifruje token autentizovaně a odmítne zásah do ciphertextu', () => {
    const encrypted = encryptTradovateSecret('broker-token', encryptionKey);
    expect(encrypted).not.toContain('broker-token');
    expect(decryptTradovateSecret(encrypted, encryptionKey)).toBe('broker-token');
    const parts = encrypted.split('.');
    parts[3] = `${parts[3].slice(0, -1)}${parts[3].endsWith('A') ? 'B' : 'A'}`;
    expect(() => decryptTradovateSecret(parts.join('.'), encryptionKey)).toThrow('authentication failed');
  });

  it('oddělí LIVE a DEMO endpointy', () => {
    expect(tradovateApiBaseUrl('live')).toBe('https://live.tradovateapi.com/v1');
    expect(tradovateApiBaseUrl('demo')).toBe('https://demo.tradovateapi.com/v1');
    expect(tradovateOAuthTokenUrl('demo')).toBe('https://demo.tradovateapi.com/v1/auth/oauthtoken');
  });

  it('po OAuth vrátí uživatele zpět do LIVE části aplikace', () => {
    const connected = new URL(tradovateOAuthResultLocation('connected'), 'https://alphatrade.example');
    expect(connected.pathname).toBe('/');
    expect(connected.searchParams.get('page')).toBe('live');
    expect(connected.searchParams.get('tradovate')).toBe('connected');

    const error = new URL(tradovateOAuthResultLocation('error', 'denied'), 'https://alphatrade.example');
    expect(error.searchParams.get('page')).toBe('live');
    expect(error.searchParams.get('reason')).toBe('denied');
  });

  it('vymění code i refresh token form-encoded přes zvolené prostředí', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        access_token: 'access', refresh_token: 'refresh-next', expires_in: 3600,
        token_type: 'Bearer', scope: 'orders',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await exchangeTradovateAuthorizationCode({
      code: 'single-use-code', clientId: 'client', clientSecret: 'secret',
      redirectUri: 'https://example.com/oauth/tradovate/callback', environment: 'demo', fetchImpl,
    });
    await refreshTradovateAccessToken({
      refreshToken: 'refresh-old', clientId: 'client', clientSecret: 'secret', environment: 'demo', fetchImpl,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('https://demo.tradovateapi.com/v1/auth/oauthtoken');
    expect(new URLSearchParams(String(requests[0].init.body)).get('grant_type')).toBe('authorization_code');
    expect(new URLSearchParams(String(requests[0].init.body)).get('code')).toBe('single-use-code');
    expect(new URLSearchParams(String(requests[1].init.body)).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(String(requests[1].init.body)).get('refresh_token')).toBe('refresh-old');
  });
});

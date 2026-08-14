import { describe, expect, it } from 'vitest';
import {
  buildTradovateAuthorizationUrl,
  buildTradovateStateCookie,
  createTradovateOAuthState,
  decryptTradovateSecret,
  encryptTradovateSecret,
  exchangeTradovateAuthorizationCode,
  parseCookies,
  refreshTradovateAccessToken,
  verifyTradovateOAuthState,
} from '../server/tradovateOAuth';

const stateSecret = 'state-secret-that-is-definitely-longer-than-32-bytes';
const encryptionKey = Buffer.alloc(32, 7).toString('base64url');

describe('Tradovate OAuth primitives', () => {
  it('podepíše stav, sváže ho s uživatelem a odmítne změnu i expiraci', () => {
    const now = Date.UTC(2026, 7, 14, 10, 0, 0);
    const state = createTradovateOAuthState('user-123', stateSecret, now, 'nonce-1');
    expect(verifyTradovateOAuthState(state, stateSecret, now)).toMatchObject({ sub: 'user-123', nonce: 'nonce-1' });
    expect(() => verifyTradovateOAuthState(`${state}x`, stateSecret, now)).toThrow('signature');
    expect(() => verifyTradovateOAuthState(state, stateSecret, now + 11 * 60_000)).toThrow('expired');
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

  it('vymění code i refresh token form-encoded přes produkční endpoint', async () => {
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
      redirectUri: 'https://example.com/oauth/tradovate/callback', fetchImpl,
    });
    await refreshTradovateAccessToken({
      refreshToken: 'refresh-old', clientId: 'client', clientSecret: 'secret', fetchImpl,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('https://live.tradovateapi.com/auth/oauthtoken');
    expect(new URLSearchParams(String(requests[0].init.body)).get('grant_type')).toBe('authorization_code');
    expect(new URLSearchParams(String(requests[0].init.body)).get('code')).toBe('single-use-code');
    expect(new URLSearchParams(String(requests[1].init.body)).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(String(requests[1].init.body)).get('refresh_token')).toBe('refresh-old');
  });
});

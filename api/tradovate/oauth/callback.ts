import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { tradovateRestBaseUrl, type TradovateApiHosts } from '../../../lib/tradovateApiHosts.js';
import {
  clearTradovateStateCookie,
  exchangeTradovateAuthorizationCode,
  normalizeTradovateOAuthIdentity,
  parseCookies,
  TRADOVATE_OAUTH_COOKIE,
  tradovateOAuthResultLocation,
  verifyTradovateOAuthState,
  tradovateApiBaseUrl,
} from '../../../server/tradovateOAuth.js';
import {
  createTradovateAdminClient,
  readTradovateServerConfig,
  saveTradovateConnection,
} from '../../../server/tradovateOAuthStore.js';

const queryValue = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] ?? '' : value ?? '';

/**
 * `/auth/me` patří na live host (Lucid ho na svém demo hostu odmítá, sdílený demo host přesměruje 307).
 * Přesměrování se nenásleduje: token jde jen na hosty z odpovědi autentizace nebo na výchozí.
 */
const loadOAuthIdentity = async (accessToken: string, environment: 'demo' | 'live', apiHosts: TradovateApiHosts | null) => {
  const bases = [...new Set([tradovateRestBaseUrl('live', apiHosts), tradovateApiBaseUrl(environment, apiHosts)])];
  let lastStatus = 0;
  for (const base of bases) {
    const response = await fetch(`${base}/auth/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    lastStatus = response.status;
    if (!response.ok) continue;
    const body = await response.json() as Record<string, unknown>;
    if (typeof body?.errorText === 'string') { lastStatus = 422; continue; }
    return normalizeTradovateOAuthIdentity(body);
  }
  throw new Error(`oauth-identity-failed-${lastStatus}`);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', clearTradovateStateCookie());
  if (req.method !== 'GET') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const code = queryValue(req.query.code);
    const returnedState = queryValue(req.query.state);
    if (queryValue(req.query.error)) throw new Error('oauth-denied');
    if (!code || !returnedState) throw new Error('missing-code-or-state');
    const cookieState = parseCookies(req.headers.cookie).get(TRADOVATE_OAUTH_COOKIE);
    if (!cookieState || cookieState !== returnedState) throw new Error('state-cookie-mismatch');
    const claims = verifyTradovateOAuthState(returnedState, config.stateSecret);
    const token = await exchangeTradovateAuthorizationCode({
      code,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      environment: config.environment,
    });
    const identity = await loadOAuthIdentity(token.accessToken, config.environment, token.apiHosts ?? null);
    await saveTradovateConnection({
      db: createTradovateAdminClient(config),
      config,
      userId: claims.sub,
      token,
      connectionId: claims.connectionId ?? randomUUID(),
      tradovateUserId: identity.userId ?? null,
      tradovateEmail: identity.email ?? identity.name ?? null,
      organizationName: identity.organizationName ?? null,
    });
    return res.redirect(302, tradovateOAuthResultLocation('connected'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[tradovate-oauth-callback] Connection failed without exposing code/token:', message);
    return res.redirect(302, tradovateOAuthResultLocation('error', message === 'oauth-denied' ? 'denied' : 'callback-failed'));
  }
}

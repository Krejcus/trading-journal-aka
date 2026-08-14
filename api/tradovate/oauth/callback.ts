import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  clearTradovateStateCookie,
  exchangeTradovateAuthorizationCode,
  parseCookies,
  TRADOVATE_OAUTH_COOKIE,
  verifyTradovateOAuthState,
} from '../../../server/tradovateOAuth.js';
import {
  createTradovateAdminClient,
  readTradovateServerConfig,
  saveTradovateConnection,
} from '../../../server/tradovateOAuthStore.js';

const queryValue = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] ?? '' : value ?? '';

const resultLocation = (result: 'connected' | 'error', reason?: string): string => {
  const params = new URLSearchParams({ tradovate: result });
  if (reason) params.set('reason', reason);
  return `/?${params.toString()}`;
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
    });
    await saveTradovateConnection({
      db: createTradovateAdminClient(config),
      config,
      userId: claims.sub,
      token,
    });
    return res.redirect(302, resultLocation('connected'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[tradovate-oauth-callback] Connection failed without exposing code/token:', message);
    return res.redirect(302, resultLocation('error', message === 'oauth-denied' ? 'denied' : 'callback-failed'));
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  buildTradovateAuthorizationUrl,
  buildTradovateStateCookie,
  createTradovateOAuthState,
} from '../../../server/tradovateOAuth.js';
import { readTradovateServerConfig, requireSupabaseUserId } from '../../../server/tradovateOAuthStore.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const state = createTradovateOAuthState(userId, config.stateSecret);
    res.setHeader('Set-Cookie', buildTradovateStateCookie(state));
    return res.status(200).json({
      authorizationUrl: buildTradovateAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    console.error('[tradovate-oauth-start] Failed without exposing credentials:', message);
    return res.status(503).json({ error: 'tradovate-oauth-unavailable' });
  }
}

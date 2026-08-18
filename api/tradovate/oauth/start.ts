import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import {
  buildTradovateAuthorizationUrl,
  buildTradovateStateCookie,
  createTradovateOAuthState,
} from '../../../server/tradovateOAuth.js';
import {
  createTradovateAdminClient,
  readTradovateServerConfig,
  requireReconnectableTradovateConnection,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

const requestedConnectionId = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).connectionId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Capacitor appka vola tyto endpointy z capacitor://localhost — bez CORS
  // preflight odpovedi selze fetch jako 'Load failed'. Web je same-origin.
  if (handleNativeCors(req, res, ['GET', 'POST', 'DELETE'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const connectionId = requestedConnectionId(req.body);
    if (connectionId) {
      await requireReconnectableTradovateConnection({
        db: createTradovateAdminClient(config),
        userId,
        connectionId,
        environment: config.environment,
      });
    }
    const state = createTradovateOAuthState(userId, config.stateSecret, Date.now(), undefined, connectionId ?? randomUUID());
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

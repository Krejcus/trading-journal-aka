import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { tradovateApiBaseUrl } from '../../../server/tradovateOAuth.js';
import { loadTradovateAccountData } from '../../../server/tradovateAccountData.js';
import { probeTradovateHistoricalSync } from '../../../server/tradovateHistoricalProbe.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const connectionId = typeof req.body?.connectionId === 'string' ? req.body.connectionId : '';
    if (!connectionId) return res.status(400).json({ error: 'missing-connection-id' });
    const { accessToken } = await getValidTradovateAccessToken({
      db: createTradovateAdminClient(config),
      config,
      userId,
      connectionId,
    });
    const baseUrl = tradovateApiBaseUrl(config.environment);
    const [result, historicalSync] = await Promise.all([
      loadTradovateAccountData({ baseUrl, accessToken }),
      probeTradovateHistoricalSync({ environment: config.environment, accessToken }),
    ]);
    return res.status(200).json({
      connectionId,
      environment: config.environment,
      historicalSync,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    if (message === 'tradovate-not-connected' || message === 'tradovate-reauthorization-required') {
      return res.status(409).json({ error: message });
    }
    console.error('[tradovate-oauth-preflight] Read-only preflight failed:', message);
    return res.status(502).json({ error: 'tradovate-preflight-failed' });
  }
}

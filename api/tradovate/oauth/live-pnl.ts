import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { tradovateApiBaseUrl } from '../../../server/tradovateOAuth.js';
import { loadTradovateLivePnlTick, TradovateLivePnlError } from '../../../server/tradovateLivePnl.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const connectionId = typeof req.body?.connectionId === 'string' ? req.body.connectionId : '';
    if (!connectionId) return res.status(400).json({ error: 'missing-connection-id' });
    const contractCursor = typeof req.body?.contractCursor === 'number' ? req.body.contractCursor : 0;
    const { accessToken } = await getValidTradovateAccessToken({
      db: createTradovateAdminClient(config),
      config,
      userId,
      connectionId,
    });
    const tick = await loadTradovateLivePnlTick({
      baseUrl: tradovateApiBaseUrl(config.environment),
      accessToken,
      connectionId,
      environment: config.environment,
      contractCursor,
    });
    return res.status(200).json(tick);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    if (message === 'tradovate-not-connected' || message === 'tradovate-reauthorization-required') {
      return res.status(409).json({ error: message });
    }
    if (error instanceof TradovateLivePnlError && error.status === 429) {
      return res.status(429).json({ error: 'tradovate-rate-limited', retryAfterMs: 3_600_000 });
    }
    console.error('[tradovate-live-pnl] Read-only tick failed:', message);
    return res.status(502).json({ error: 'tradovate-live-pnl-failed' });
  }
}

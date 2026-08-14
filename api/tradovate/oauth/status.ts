import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  deleteTradovateConnection,
  getTradovateConnectionStatus,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'DELETE') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const db = createTradovateAdminClient(config);
    if (req.method === 'DELETE') {
      await deleteTradovateConnection(db, userId);
      return res.status(200).json({ connected: false });
    }
    return res.status(200).json(await getTradovateConnectionStatus(db, userId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    console.error('[tradovate-oauth-status] Failed:', message);
    return res.status(503).json({ error: 'tradovate-status-unavailable' });
  }
}

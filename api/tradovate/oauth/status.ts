import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  disconnectTradovateConnection,
  listTradovateConnectionStatuses,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Capacitor appka vola tyto endpointy z capacitor://localhost — bez CORS
  // preflight odpovedi selze fetch jako 'Load failed'. Web je same-origin.
  if (handleNativeCors(req, res, ['GET', 'POST', 'DELETE'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'DELETE') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const db = createTradovateAdminClient(config);
    if (req.method === 'DELETE') {
      const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : '';
      if (!connectionId) return res.status(400).json({ error: 'missing-connection-id' });
      await disconnectTradovateConnection(db, userId, connectionId);
      return res.status(200).json({ connected: false });
    }
    const connections = await listTradovateConnectionStatuses(db, userId, config.environment);
    return res.status(200).json({
      connected: connections.some(connection => connection.connected),
      environment: config.environment,
      connections,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    console.error('[tradovate-oauth-status] Failed:', message);
    return res.status(503).json({ error: 'tradovate-status-unavailable' });
  }
}

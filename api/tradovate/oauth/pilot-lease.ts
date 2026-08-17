import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  listTradovateConnectionStatuses,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { sealTradovatePilotLease } from '../../../server/tradovatePilotLease.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    if (config.environment !== 'demo') return res.status(409).json({ error: 'pilot-demo-only' });
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const connectionId = typeof req.body?.connectionId === 'string' ? req.body.connectionId.trim() : '';
    const publicKey = typeof req.body?.publicKey === 'string' ? req.body.publicKey.trim() : '';
    if (!connectionId || !publicKey) return res.status(400).json({ error: 'missing-pilot-lease-input' });
    const db = createTradovateAdminClient(config);
    const connection = (await listTradovateConnectionStatuses(db, userId, 'demo'))
      .find(item => item.id === connectionId && item.connected);
    if (!connection) return res.status(404).json({ error: 'tradovate-connection-not-found' });
    const token = await getValidTradovateAccessToken({
      db,
      config,
      userId,
      connectionId,
      minimumValidityMs: 35 * 60_000,
    });
    const issuedAt = new Date().toISOString();
    const envelope = sealTradovatePilotLease({
      version: 1,
      environment: 'demo',
      connectionId,
      ...(connection.tradovateEmail?.trim() ? { accountSpec: connection.tradovateEmail.trim() } : {}),
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      issuedAt,
    }, publicKey);
    return res.status(200).json({ envelope, expiresAt: token.expiresAt, issuedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    if (message.includes('public-key') || message.includes('PEM')) {
      return res.status(400).json({ error: 'invalid-pilot-public-key' });
    }
    console.error('[tradovate-pilot-lease] Failed without exposing token:', message);
    return res.status(502).json({ error: 'tradovate-pilot-lease-failed' });
  }
}

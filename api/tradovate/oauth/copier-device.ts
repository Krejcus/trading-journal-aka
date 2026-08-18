import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import {
  registerTradovateCopierDevice,
  revokeTradovateCopierDevice,
} from '../../../server/tradovateCopierDevice.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Capacitor appka vola tyto endpointy z capacitor://localhost — bez CORS
  // preflight odpovedi selze fetch jako 'Load failed'. Web je same-origin.
  if (handleNativeCors(req, res, ['GET', 'POST', 'DELETE'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method-not-allowed' });
  }
  try {
    const config = readTradovateServerConfig();
    if (config.environment !== 'demo') return res.status(409).json({ error: 'copier-device-demo-only' });
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const db = createTradovateAdminClient(config);
    if (req.method === 'DELETE') {
      const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const revoked = await revokeTradovateCopierDevice({ db, userId, deviceId });
      return revoked ? res.status(200).json({ revoked: true }) : res.status(404).json({ error: 'copier-device-not-found' });
    }
    await registerTradovateCopierDevice({
      db,
      userId,
      connectionId: typeof req.body?.connectionId === 'string' ? req.body.connectionId.trim() : '',
      deviceId: typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '',
      deviceSecret: typeof req.body?.deviceSecret === 'string' ? req.body.deviceSecret.trim() : '',
      publicKey: typeof req.body?.publicKey === 'string' ? req.body.publicKey.trim() : '',
      deviceName: typeof req.body?.deviceName === 'string' ? req.body.deviceName.trim() : '',
    });
    return res.status(201).json({ paired: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    if (message === 'tradovate-connection-not-found') return res.status(404).json({ error: message });
    if (message.startsWith('invalid-') || message.includes('public-key')) {
      return res.status(400).json({ error: message });
    }
    console.error('[tradovate-copier-device] Failed without exposing credentials:', message);
    return res.status(502).json({ error: 'copier-device-request-failed' });
  }
}

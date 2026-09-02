import type { VercelRequest, VercelResponse } from '@vercel/node';

import { authorizeMacCompanion } from '../../../server/macCompanionAuth.js';
import { macCompanionPairingStatus } from '../../../server/macCompanionPairing.js';
import { handleNativeCors } from '../../../server/nativeCors.js';
import {
  createSupabaseAdminClient,
  readSupabaseServerConfig,
} from '../../../server/supabaseServer.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readSupabaseServerConfig();
    const device = await authorizeMacCompanion({
      db: createSupabaseAdminClient(config),
      authorization: req.headers.authorization,
      allowUnpaired: true,
    });
    return res.status(200).json(macCompanionPairingStatus({
      deviceId: device.id,
      userId: device.userId,
      scope: device.scope,
      pairingExpiresAt: device.pairingExpiresAt,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'invalid-mac-companion-auth') {
      return res.status(401).json({ error: message });
    }
    if (message === 'pairing-expired') return res.status(410).json({ error: message });
    if (message.startsWith('missing-server-environment:')) {
      return res.status(500).json({ error: 'server-not-configured' });
    }
    console.error('[Mac Companion] Pairing status failed:', message);
    return res.status(503).json({ error: 'pairing-status-unavailable' });
  }
}

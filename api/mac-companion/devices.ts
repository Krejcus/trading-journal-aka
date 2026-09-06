import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  listMacCompanionDevices,
  renameMacCompanionDevice,
  revokeMacCompanionDevice,
} from '../../server/macCompanionPairing.js';
import { handleNativeCors } from '../../server/nativeCors.js';
import {
  createSupabaseAdminClient,
  readSupabaseServerConfig,
  requireSupabaseUserId,
} from '../../server/supabaseServer.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['GET', 'PATCH', 'DELETE'])) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'PATCH' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method-not-allowed' });
  }
  try {
    const config = readSupabaseServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const db = createSupabaseAdminClient(config);
    if (req.method === 'GET') {
      return res.status(200).json({ devices: await listMacCompanionDevices({ db, userId }) });
    }
    if (req.method === 'PATCH') {
      const device = await renameMacCompanionDevice({
        db,
        userId,
        deviceId: req.body?.deviceId,
        deviceName: req.body?.deviceName,
      });
      return device
        ? res.status(200).json({ device })
        : res.status(404).json({ error: 'mac-companion-device-not-found' });
    }
    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
    const revoked = await revokeMacCompanionDevice({ db, userId, deviceId });
    return revoked
      ? res.status(200).json({ revoked: true, deviceId })
      : res.status(404).json({ error: 'mac-companion-device-not-found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    if (message === 'invalid-mac-companion-device') {
      return res.status(400).json({ error: message });
    }
    if (message.startsWith('missing-server-environment:')) {
      return res.status(500).json({ error: 'server-not-configured' });
    }
    console.error('[Mac Companion] Device management failed:', message);
    return res.status(503).json({ error: 'mac-companion-device-request-failed' });
  }
}

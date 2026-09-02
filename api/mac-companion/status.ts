import type { VercelRequest, VercelResponse } from '@vercel/node';

import { authorizeMacCompanion } from '../../server/macCompanionAuth.js';
import { loadMacCompanionStatus } from '../../server/macCompanionStatus.js';
import { handleNativeCors } from '../../server/nativeCors.js';
import {
  createSupabaseAdminClient,
  readSupabaseServerConfig,
} from '../../server/supabaseServer.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readSupabaseServerConfig();
    const db = createSupabaseAdminClient(config);
    const device = await authorizeMacCompanion({
      db,
      authorization: req.headers.authorization,
    });
    if (!device.userId) return res.status(401).json({ error: 'invalid-mac-companion-auth' });
    return res.status(200).json(await loadMacCompanionStatus({ db, userId: device.userId }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'invalid-mac-companion-auth') {
      return res.status(401).json({ error: message });
    }
    if (message === 'copier-runtime-unavailable') {
      return res.status(503).json({ error: message });
    }
    if (message.startsWith('missing-server-environment:')) {
      return res.status(500).json({ error: 'server-not-configured' });
    }
    console.error('[Mac Companion] Status failed:', message);
    return res.status(503).json({ error: 'mac-companion-status-unavailable' });
  }
}

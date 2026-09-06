import type { VercelRequest, VercelResponse } from '@vercel/node';

import { handleNativeCors } from '../../../server/nativeCors.js';
import { confirmMacCompanionPairing } from '../../../server/macCompanionPairing.js';
import {
  createSupabaseAdminClient,
  readSupabaseServerConfig,
  requireSupabaseUserId,
} from '../../../server/supabaseServer.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readSupabaseServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const device = await confirmMacCompanionPairing({
      db: createSupabaseAdminClient(config),
      userId,
      pairingCode: req.body?.pairingCode,
    });
    return res.status(200).json({ paired: true, device });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    if (message === 'invalid-pairing-code') return res.status(400).json({ error: message });
    if (message === 'pairing-code-not-found') return res.status(404).json({ error: message });
    if (message.startsWith('missing-server-environment:')) {
      return res.status(500).json({ error: 'server-not-configured' });
    }
    console.error('[Mac Companion] Pairing confirmation failed:', message);
    return res.status(503).json({ error: 'pairing-confirm-unavailable' });
  }
}

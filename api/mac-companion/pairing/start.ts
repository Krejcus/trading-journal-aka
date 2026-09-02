import type { VercelRequest, VercelResponse } from '@vercel/node';

import { handleNativeCors } from '../../../server/nativeCors.js';
import { startMacCompanionPairing } from '../../../server/macCompanionPairing.js';
import {
  consumeMacCompanionPairingStartLimit,
  hashMacCompanionClientAddress,
  resolveMacCompanionClientAddress,
} from '../../../server/macCompanionRateLimit.js';
import {
  createSupabaseAdminClient,
  readSupabaseServerConfig,
} from '../../../server/supabaseServer.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readSupabaseServerConfig();
    const db = createSupabaseAdminClient(config);
    const clientAddress = resolveMacCompanionClientAddress({
      headers: req.headers,
      remoteAddress: req.socket?.remoteAddress,
      isVercel: Boolean(process.env.VERCEL),
    });
    const rateLimit = await consumeMacCompanionPairingStartLimit({
      db,
      clientAddressHash: hashMacCompanionClientAddress(
        clientAddress,
        config.supabaseServiceRoleKey,
      ),
    });
    if (!rateLimit.allowed) {
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      return res.status(429).json({
        error: 'pairing-start-rate-limited',
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }
    const result = await startMacCompanionPairing({
      db,
      contractVersion: req.body?.contractVersion,
      deviceId: req.body?.deviceId,
      deviceName: req.body?.deviceName,
      deviceSecretHash: req.body?.deviceSecretHash,
      pairingCodeHash: req.body?.pairingCodeHash,
    });
    const { created, ...body } = result;
    return res.status(created ? 201 : 200).json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'invalid-pairing-start') return res.status(400).json({ error: message });
    if (message === 'pairing-device-conflict' || message === 'pairing-code-conflict') {
      return res.status(409).json({ error: message });
    }
    if (message.startsWith('missing-server-environment:')) {
      return res.status(500).json({ error: 'server-not-configured' });
    }
    console.error('[Mac Companion] Pairing start failed:', message);
    return res.status(503).json({ error: 'pairing-start-unavailable' });
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authorizeTradovateCopierDevice } from '../../../server/tradovateCopierDevice.js';
import {
  claimTradovateCopierCommand, completeTradovateCopierCommand, enqueueTradovateCopierCommand,
  heartbeatTradovateCopierDevice, readTradovateCopierCommand, readTradovateCopierDeviceRuntime,
} from '../../../server/tradovateCopierCommandRelay.js';
import { createTradovateAdminClient, readTradovateServerConfig, requireSupabaseUserId } from '../../../server/tradovateOAuthStore.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Capacitor appka vola tyto endpointy z capacitor://localhost — bez CORS
  // preflight odpovedi selze fetch jako 'Load failed'. Web je same-origin.
  if (handleNativeCors(req, res, ['GET', 'POST', 'DELETE'])) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const config = readTradovateServerConfig();
    if (config.environment !== 'demo') return res.status(409).json({ error: 'copier-relay-demo-only' });
    const db = createTradovateAdminClient(config);
    const isDevice = req.headers.authorization?.startsWith('Device ');
    if (isDevice) {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
      const device = await authorizeTradovateCopierDevice({ db, authorization: req.headers.authorization });
      const action = String(req.body?.action ?? '');
      if (action === 'poll') {
        if (req.body?.status) await heartbeatTradovateCopierDevice({ db, deviceId: device.id, userId: device.userId, connectionId: device.connectionId, status: req.body.status });
        return res.status(200).json({ command: await claimTradovateCopierCommand({ db, deviceId: device.id }) });
      }
      if (action === 'complete') {
        const accepted = await completeTradovateCopierCommand({ db, deviceId: device.id, commandId: String(req.body?.commandId ?? ''), result: req.body?.result, error: typeof req.body?.error === 'string' ? req.body.error : undefined });
        return res.status(accepted ? 200 : 409).json({ accepted });
      }
      return res.status(400).json({ error: 'invalid-copier-relay-action' });
    }

    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const connectionId = String(req.method === 'GET' ? req.query.connectionId ?? '' : req.body?.connectionId ?? '').trim();
    if (!connectionId) return res.status(400).json({ error: 'missing-connection-id' });
    if (req.method === 'GET') {
      const commandId = typeof req.query.commandId === 'string' ? req.query.commandId : '';
      if (commandId) return res.status(200).json(await readTradovateCopierCommand({ db, userId, commandId }));
      return res.status(200).json(await readTradovateCopierDeviceRuntime({ db, userId, connectionId }));
    }
    if (req.method === 'POST') {
      return res.status(202).json(await enqueueTradovateCopierCommand({ db, userId, connectionId, command: req.body?.command, idempotencyKey: req.body?.idempotencyKey }));
    }
    return res.status(405).json({ error: 'method-not-allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('auth-token') || message === 'invalid-copier-device-auth') return res.status(401).json({ error: message });
    if (message.endsWith('not-found')) return res.status(404).json({ error: message });
    console.error('[copier-relay]', message);
    return res.status(502).json({ error: 'copier-relay-failed' });
  }
}

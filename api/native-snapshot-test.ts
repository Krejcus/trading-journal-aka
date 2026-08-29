import type { VercelRequest, VercelResponse } from '@vercel/node';

import { handleNativeCors } from '../server/nativeCors.js';
import { enqueueNativeSnapshotTest } from '../server/nativeSnapshotTest.js';
import {
  createTradovateAdminClient,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../server/tradovateOAuthStore.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,160}$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    if (config.environment !== 'demo') return res.status(409).json({ error: 'snapshot-test-demo-only' });
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const db = createTradovateAdminClient(config);
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string'
      ? req.body.idempotencyKey.trim()
      : '';
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return res.status(400).json({ error: 'snapshot-test-invalid-idempotency-key' });
    }

    // Bez aktivního nativního APNs tokenu nemá smysl budit TradingView ani
    // vytvářet testovací Storage objekt.
    const { data: nativeDevice, error: nativeDeviceError } = await db
      .from('native_push_subscriptions')
      .select('id')
      .eq('user_id', userId)
      .is('expired_at', null)
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (nativeDeviceError) throw new Error(`snapshot-test-device-query-failed: ${nativeDeviceError.message}`);
    if (!nativeDevice) return res.status(409).json({ error: 'snapshot-test-no-native-device' });

    const queued = await enqueueNativeSnapshotTest({ db, userId, idempotencyKey });
    try {
      await fetch(`${config.supabaseUrl}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.supabaseServiceRoleKey,
          Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        },
        body: JSON.stringify({
          messages: [{ topic: `copier-kick-${queued.deviceId}`, event: 'kick', payload: {} }],
        }),
        signal: AbortSignal.timeout(1_500),
      });
    } catch {
      // Poll do 750 ms je autoritativní fallback; realtime je jen latency hint.
    }
    return res.status(202).json({
      ok: true,
      queued: true,
      commandId: queued.id,
      message: 'Test snapshotu byl předán Mac workeru.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('auth-token')) return res.status(401).json({ error: message });
    if (message === 'snapshot-test-worker-unavailable'
      || message === 'snapshot-test-camera-not-ready') {
      return res.status(409).json({ error: message });
    }
    if (message === 'snapshot-test-rate-limit') return res.status(429).json({ error: message });
    console.error('[native-snapshot-test]', message);
    return res.status(502).json({ error: 'snapshot-test-failed' });
  }
}

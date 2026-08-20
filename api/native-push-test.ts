import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

import { sendApnsNotification, type ApnsDevice } from '../server/apns.js';
import { handleNativeCors } from '../server/nativeCors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['POST'])) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return res.status(500).json({ error: 'server-not-configured' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'missing-token' });
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser();
  if (userError || !userData.user) return res.status(401).json({ error: 'invalid-token' });

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.from('native_push_subscriptions')
    .select('id, device_token, environment, bundle_id')
    .eq('user_id', userData.user.id)
    .is('expired_at', null);
  if (error) return res.status(500).json({ error: 'devices-query-failed' });

  const devices = (data ?? []).map(row => ({
    id: row.id,
    deviceToken: row.device_token,
    environment: row.environment,
    bundleId: row.bundle_id,
  } as ApnsDevice));
  if (devices.length === 0) {
    return res.status(200).json({ sent: 0, devices: 0, message: 'Nativní iPhone ještě nemá uložený APNs token.' });
  }

  const stamp = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
  const results = await Promise.all(devices.map(async device => {
    const result = await sendApnsNotification(device, {
      title: '✅ APNs test doručení',
      body: `Server → zavřená AlphaTrade funguje. Odesláno ${stamp}.`,
      route: 'live',
      threadId: 'alphatrade-test',
      category: 'ALPHATRADE_GENERAL',
      interruptionLevel: 'time-sensitive',
      collapseId: 'alpha-native-push-test',
      badge: 1,
    });
    if (result.status === 'expired') {
      await db.from('native_push_subscriptions').update({
        expired_at: new Date().toISOString(),
        last_error: result.error ?? null,
      }).eq('id', device.id);
    }
    return { id: device.id, ...result };
  }));
  const sent = results.filter(result => result.status === 'sent').length;
  return res.status(200).json({ sent, devices: devices.length, time: stamp, results });
}

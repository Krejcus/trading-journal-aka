import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

import { handleNativeCors } from '../server/nativeCors.js';
import { normalizeNativeLiveActivityStartRegistration } from '../server/nativeLiveActivityRegistration.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['POST', 'DELETE'])) return;
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ error: 'method-not-allowed' });
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return res.status(500).json({ error: 'server-not-configured' });
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return res.status(401).json({ error: 'missing-token' });
  const registration = normalizeNativeLiveActivityStartRegistration(req.body);
  if (!registration) return res.status(400).json({ error: 'invalid-registration' });

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData.user) return res.status(401).json({ error: 'invalid-token' });
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const now = new Date().toISOString();

  if (req.method === 'DELETE') {
    const { error } = await db.from('native_live_activity_start_subscriptions').update({
      expires_at: now,
      updated_at: now,
    }).eq('user_id', userData.user.id)
      .eq('installation_id', registration.installationId);
    if (error) return res.status(500).json({ error: 'delete-failed' });
    return res.status(200).json({ ok: true });
  }

  const { error } = await db.from('native_live_activity_start_subscriptions').upsert({
    user_id: userData.user.id,
    installation_id: registration.installationId,
    push_token: registration.pushToken,
    environment: registration.environment,
    bundle_id: registration.bundleId,
    expires_at: null,
    last_error: null,
    updated_at: now,
  }, { onConflict: 'user_id,installation_id' });
  if (error) return res.status(500).json({ error: 'upsert-failed' });
  return res.status(200).json({ ok: true });
}

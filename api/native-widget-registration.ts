import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

import { handleNativeCors } from '../server/nativeCors.js';
import {
  hashNativeWidgetToken,
  NATIVE_WIDGET_BUNDLE_ID,
  normalizeNativeWidgetToken,
} from '../server/nativeWidgetRegistration.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['POST', 'DELETE'])) return;
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method-not-allowed' });
  }
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return res.status(500).json({ error: 'server-not-configured' });
  }
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return res.status(401).json({ error: 'missing-token' });
  const widgetToken = normalizeNativeWidgetToken(req.body?.widgetToken);
  if (!widgetToken) return res.status(400).json({ error: 'invalid-widget-token' });

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData.user) return res.status(401).json({ error: 'invalid-token' });

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tokenHash = hashNativeWidgetToken(widgetToken);
  const now = new Date().toISOString();
  if (req.method === 'DELETE') {
    const { error } = await db.from('native_widget_devices').update({
      expired_at: now,
      last_seen_at: now,
    }).eq('user_id', userData.user.id)
      .eq('token_hash', tokenHash)
      .eq('bundle_id', NATIVE_WIDGET_BUNDLE_ID);
    if (error) return res.status(500).json({ error: 'deactivate-failed' });
    return res.status(200).json({ ok: true });
  }

  const { error } = await db.from('native_widget_devices').upsert({
    user_id: userData.user.id,
    token_hash: tokenHash,
    bundle_id: NATIVE_WIDGET_BUNDLE_ID,
    platform: 'ios',
    last_seen_at: now,
    expired_at: null,
  }, { onConflict: 'token_hash,bundle_id' });
  if (error) return res.status(500).json({ error: 'upsert-failed' });
  return res.status(200).json({ ok: true });
}

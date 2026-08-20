import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

import { handleNativeCors } from '../server/nativeCors.js';
import {
  hashNativeWidgetToken,
  NATIVE_WIDGET_BUNDLE_ID,
  normalizeNativeWidgetPushRegistration,
  normalizeNativeWidgetToken,
} from '../server/nativeWidgetRegistration.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['POST'])) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: 'server-not-configured' });

  const authorization = req.headers.authorization;
  const accessToken = normalizeNativeWidgetToken(
    authorization?.startsWith('Widget ') ? authorization.slice('Widget '.length) : null,
  );
  if (!accessToken) return res.status(401).json({ error: 'invalid-widget-authorization' });
  const registration = normalizeNativeWidgetPushRegistration(req.body);
  if (!registration) return res.status(400).json({ error: 'invalid-widget-push-registration' });

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const now = new Date().toISOString();
  const { data: device, error: findError } = await db.from('native_widget_devices')
    .select('id')
    .eq('token_hash', hashNativeWidgetToken(accessToken))
    .eq('bundle_id', NATIVE_WIDGET_BUNDLE_ID)
    .is('expired_at', null)
    .maybeSingle();
  if (findError) return res.status(500).json({ error: 'widget-device-lookup-failed' });
  if (!device) return res.status(401).json({ error: 'unknown-widget-device' });

  const { error: updateError } = await db.from('native_widget_devices').update({
    widget_push_token: registration.deviceToken,
    widget_push_environment: registration.environment,
    widget_push_bundle_id: registration.bundleId,
    widget_push_enabled: registration.enabled,
    widget_kinds: registration.widgetKinds,
    widget_push_last_seen_at: now,
    widget_push_expired_at: null,
    widget_push_last_error: null,
  }).eq('id', device.id);
  if (updateError) return res.status(500).json({ error: 'widget-push-upsert-failed' });
  return res.status(200).json({ ok: true, enabled: registration.enabled });
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

import { handleNativeCors } from '../server/nativeCors.js';
import { loadNativeLiveActivityBrokerSnapshot } from '../server/nativeLiveActivityBrokerSnapshot.js';
import { liveActivityAccountIds, type NativeLiveActivityRuntimeRow } from '../server/nativeLiveActivityUpdater.js';
import { buildNativeWidgetRemoteSnapshot, type NativeWidgetCopierTradeRow } from '../server/nativeWidgetRemoteSnapshot.js';
import { hashNativeWidgetToken, NATIVE_WIDGET_BUNDLE_ID, normalizeNativeWidgetToken } from '../server/nativeWidgetRegistration.js';
import { listTradovateAccountProfiles } from '../server/tradovateAccountProfiles.js';
import { tradovateApiBaseUrl } from '../server/tradovateOAuth.js';
import { getValidTradovateAccessToken, readTradovateServerConfig } from '../server/tradovateOAuthStore.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method-not-allowed' });
  const match = /^Widget (.+)$/.exec(req.headers.authorization ?? '');
  const widgetToken = normalizeNativeWidgetToken(match?.[1]);
  if (!widgetToken) return res.status(401).json({ error: 'invalid-widget-token' });

  try {
    const config = readTradovateServerConfig();
    const db = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const tokenHash = hashNativeWidgetToken(widgetToken);
    const { data: device, error: deviceError } = await db.from('native_widget_devices')
      .select('id,user_id')
      .eq('token_hash', tokenHash)
      .eq('bundle_id', NATIVE_WIDGET_BUNDLE_ID)
      .is('expired_at', null)
      .maybeSingle<{ id: string; user_id: string }>();
    if (deviceError) throw new Error(`widget-device-query-failed: ${deviceError.message}`);
    if (!device) return res.status(401).json({ error: 'unknown-widget-token' });

    const { data: runtime, error: runtimeError } = await db.from('tradovate_copier_device_runtime')
      .select('device_id,user_id,connection_id,status,last_seen_at,started_at')
      .eq('user_id', device.user_id)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle<NativeLiveActivityRuntimeRow>();
    if (runtimeError) throw new Error(`widget-runtime-query-failed: ${runtimeError.message}`);
    if (!runtime) return res.status(503).json({ error: 'copier-runtime-unavailable' });
    const accountIds = liveActivityAccountIds(runtime);
    if (accountIds.length === 0) return res.status(503).json({ error: 'copier-accounts-unavailable' });

    const [{ accessToken }, tradesResult, profiles] = await Promise.all([
      getValidTradovateAccessToken({
        db,
        config,
        userId: device.user_id,
        connectionId: runtime.connection_id,
        minimumValidityMs: 180_000,
      }),
      db.from('tradovate_copier_trades')
        .select('trade_id,symbol,side,quantity,realized_pnl_usd,closed_at')
        .eq('user_id', device.user_id)
        .eq('connection_id', runtime.connection_id)
        .order('closed_at', { ascending: false })
        .limit(30),
      listTradovateAccountProfiles(db, device.user_id, config.environment),
    ]);
    if (tradesResult.error) throw new Error(`widget-trades-query-failed: ${tradesResult.error.message}`);
    const now = Date.now();
    const broker = await loadNativeLiveActivityBrokerSnapshot({
      baseUrl: tradovateApiBaseUrl(config.environment),
      accessToken,
      accountIds,
      now,
    });
    await db.from('native_widget_devices').update({ last_seen_at: new Date(now).toISOString() })
      .eq('id', device.id).is('expired_at', null);
    return res.status(200).json(buildNativeWidgetRemoteSnapshot({
      runtime,
      broker,
      trades: (tradesResult.data ?? []) as NativeWidgetCopierTradeRow[],
      profiles,
      now,
    }));
  } catch (error) {
    console.error('[Native Widget] Snapshot failed:', error instanceof Error ? error.message : String(error));
    return res.status(503).json({ error: 'widget-snapshot-unavailable' });
  }
}

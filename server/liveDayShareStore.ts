import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { normalizePublicLiveDayShare, type PublicLiveDayShare } from '../lib/liveDayShare.js';

export interface LiveDayShareRow {
  share_token: string;
  trade_date: string;
  owner_name: string;
  owner_avatar_url: string | null;
  summary: unknown;
  trades: number | null;
  losing_trades: number | null;
  theme: string;
  preview_path: string;
  created_at: string;
}

export function createLiveDayShareAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) throw new Error('live-day-share-server-not-configured');
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function resolveLiveDayShareOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.APP_URL || env.VITE_APP_URL || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function readPublicLiveDayShareRow(
  db: Pick<SupabaseClient, 'from'>,
  token: string,
): Promise<LiveDayShareRow | null> {
  const { data, error } = await db.from('live_day_shares')
    .select('share_token,trade_date,owner_name,owner_avatar_url,summary,trades,losing_trades,theme,preview_path,created_at')
    .eq('share_token', token)
    .is('revoked_at', null)
    .maybeSingle<LiveDayShareRow>();
  if (error) throw new Error(`live-day-share-query-failed: ${error.message}`);
  return data ?? null;
}

export function publicLiveDayShareFromRow(row: LiveDayShareRow): PublicLiveDayShare | null {
  return normalizePublicLiveDayShare({
    token: row.share_token,
    tradeDate: row.trade_date,
    owner: { name: row.owner_name, avatar: row.owner_avatar_url },
    summary: row.summary,
    trades: row.trades,
    losingTrades: row.losing_trades,
    theme: row.theme,
    createdAt: row.created_at,
  });
}

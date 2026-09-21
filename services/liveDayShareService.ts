import type { LiveDaySummary } from '../lib/liveDaySummary';
import {
  LIVE_DAY_SHARE_PREVIEW_BUCKET,
  LIVE_DAY_SHARE_TOKEN_PATTERN,
  normalizePublicLiveDayShare,
  publicLiveDayAvatar,
  publicLiveDaySummary,
  type LiveDayShareTheme,
  type PublicLiveDayShare,
} from '../lib/liveDayShare';
import { apiUrl, isNativeBuild } from '../utils/runtimeConfig';
import { supabase } from './supabase';

export interface CreateLiveDayShareInput {
  summary: LiveDaySummary;
  owner: { name: string; avatar?: string | null };
  tradeDate: string;
  trades: number | null;
  losingTrades: number | null;
  theme: LiveDayShareTheme;
  preview: Blob;
}

export interface CreatedLiveDayShare {
  url: string;
  snapshot: PublicLiveDayShare;
}

export function liveDayShareUrl(token: string): string {
  const path = `/day/${encodeURIComponent(token)}`;
  return isNativeBuild ? apiUrl(path) : new URL(path, window.location.origin).toString();
}

export async function createLiveDayShare(input: CreateLiveDayShareInput): Promise<CreatedLiveDayShare> {
  if (input.preview.type !== 'image/png' || input.preview.size < 1_000 || input.preview.size > 5_000_000) {
    throw new Error('Náhled karty se nepodařilo bezpečně připravit.');
  }
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (userError || !userId) throw new Error('Pro vytvoření odkazu se znovu přihlas.');

  const token = crypto.randomUUID();
  const previewPath = `${userId}/${token}.png`;
  const summary = publicLiveDaySummary(input.summary);
  const ownerName = input.owner.name.trim().slice(0, 100) || 'Trader';
  const ownerAvatar = publicLiveDayAvatar(input.owner.avatar);

  const upload = await supabase.storage.from(LIVE_DAY_SHARE_PREVIEW_BUCKET).upload(previewPath, input.preview, {
    contentType: 'image/png',
    cacheControl: '60',
    upsert: false,
  });
  if (upload.error) throw new Error(`Náhled se nepodařilo uložit: ${upload.error.message}`);

  try {
    const { data, error } = await supabase.from('live_day_shares').insert({
      owner_id: userId,
      share_token: token,
      trade_date: input.tradeDate,
      owner_name: ownerName,
      owner_avatar_url: ownerAvatar,
      summary,
      trades: input.trades,
      losing_trades: input.losingTrades,
      theme: input.theme,
      preview_path: previewPath,
    }).select('share_token,created_at').single();
    if (error || !data) throw new Error(error?.message || 'Snapshot se nepodařilo uložit.');

    const snapshot = normalizePublicLiveDayShare({
      token: data.share_token,
      tradeDate: input.tradeDate,
      owner: { name: ownerName, avatar: ownerAvatar },
      summary,
      trades: input.trades,
      losingTrades: input.losingTrades,
      theme: input.theme,
      createdAt: data.created_at,
    });
    if (!snapshot) throw new Error('Uložený snapshot má neplatný formát.');
    return { url: liveDayShareUrl(snapshot.token), snapshot };
  } catch (error) {
    await supabase.storage.from(LIVE_DAY_SHARE_PREVIEW_BUCKET).remove([previewPath]).catch(() => undefined);
    throw error;
  }
}

export async function loadPublicLiveDayShare(token: string, signal?: AbortSignal): Promise<PublicLiveDayShare | null> {
  if (!LIVE_DAY_SHARE_TOKEN_PATTERN.test(token)) return null;
  const response = await fetch(apiUrl(`/api/live-day-share/${encodeURIComponent(token)}?format=json`), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`live-day-share-read-${response.status}`);
  return normalizePublicLiveDayShare(await response.json());
}

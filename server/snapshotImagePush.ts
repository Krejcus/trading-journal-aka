import type { SupabaseClient } from '@supabase/supabase-js';
import { sendApnsNotification, type ApnsDevice } from './apns.js';
import {
  COPY_EVENTS_MARKER_KEY,
  copierSnapshotCollapseId,
  copyEventNotification,
  type CopierCopyEventRow,
} from './copierIncidentWatchdog.js';
import { loadTvAlertWebhookSettings, tvAlertNotification } from './tvAlertNotifications.js';
import type { CopierSnapshotInput } from './copierSnapshotStore.js';

interface ImagePushContent {
  title: string;
  body: string;
  collapseId: string;
  threadId: string;
}

const controllerStatus = (status: Record<string, unknown>): Record<string, unknown> => {
  const nested = status.controller;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : status;
};

export function findCopierSnapshotPushContent(
  status: Record<string, unknown>,
  input: Pick<CopierSnapshotInput, 'episodeId' | 'kind' | 'at' | 'symbol'>,
): ImagePushContent | null {
  if (input.kind === 'tv-alert') return null;
  const events = controllerStatus(status).recentCopyEvents;
  const event = Array.isArray(events) ? (events as CopierCopyEventRow[]).find(candidate => (
    candidate?.episodeId?.toLowerCase() === input.episodeId.toLowerCase()
    && candidate.kind === input.kind
    && Math.floor(candidate.at / 1_000) === Math.floor(input.at / 1_000)
  )) : undefined;
  const collapseId = copierSnapshotCollapseId({ episodeId: input.episodeId, kind: input.kind, at: input.at });
  if (!event) {
    const symbol = input.symbol.trim().toUpperCase();
    return {
      title: input.kind === 'entry' ? `Vstup zachycen · ${symbol}` : `Obchod uzavřen · ${symbol}`,
      body: input.kind === 'entry'
        ? 'Vstupní graf byl uložen do journalu.'
        : 'Výstupní graf byl uložen do journalu.',
      collapseId,
      threadId: 'alphatrade-copier-trades',
    };
  }
  return {
    ...copyEventNotification(event),
    collapseId,
    threadId: 'alphatrade-copier-trades',
  };
}

async function signedImageUrl(db: SupabaseClient, storagePath: string): Promise<string> {
  const { data, error } = await db.storage.from('copier-snapshots').createSignedUrl(storagePath, 60 * 60);
  if (error || !data?.signedUrl) throw new Error(`snapshot-signed-url-failed: ${error?.message ?? 'missing-url'}`);
  return data.signedUrl;
}

async function sendImagePushes(options: {
  db: SupabaseClient;
  userId: string;
  storagePath: string;
  content: ImagePushContent;
  deadlineAt?: number;
}): Promise<{ devices: number; sent: number }> {
  const remaining = () => options.deadlineAt == null ? 7_000 : options.deadlineAt - Date.now();
  if (remaining() < 100) return { devices: 0, sent: 0 };
  const { data, error } = await options.db.from('native_push_subscriptions')
    .select('id,device_token,environment,bundle_id')
    .eq('user_id', options.userId)
    .is('expired_at', null);
  if (error) throw new Error(`snapshot-push-devices-failed: ${error.message}`);
  const devices = (data ?? []).map(row => ({
    id: row.id,
    deviceToken: row.device_token,
    environment: row.environment,
    bundleId: row.bundle_id,
  } as ApnsDevice));
  const imageUrl = await signedImageUrl(options.db, options.storagePath);
  if (remaining() < 100) return { devices: devices.length, sent: 0 };
  const results = await Promise.all(devices.map(device => sendApnsNotification(device, {
    title: options.content.title,
    body: options.content.body,
    route: 'live',
    threadId: options.content.threadId,
    category: 'ALPHATRADE_TRADE',
    interruptionLevel: 'time-sensitive',
    collapseId: options.content.collapseId,
    mutableContent: true,
    imageUrl,
    timeoutMs: remaining(),
  })));
  const expiredAt = new Date().toISOString();
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].status !== 'expired') continue;
    await options.db.from('native_push_subscriptions').update({
      expired_at: expiredAt,
      last_error: results[index].error ?? null,
    }).eq('id', devices[index].id);
  }
  return { devices: devices.length, sent: results.filter(result => result.status === 'sent').length };
}

/**
 * Obrázek byl APNs přijat — posuň společnou hranici, aby textová záloha už
 * stejný ENTRY/EXIT neposlala. Read-before-upsert drží hranici monotónní i při
 * souběhu s minutovým watchdogem.
 */
export async function markCopierSnapshotNotificationSent(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: string;
  at: number;
}): Promise<void> {
  const { data, error } = await options.db.from('copier_alert_state')
    .select('detail')
    .eq('user_id', options.userId)
    .eq('device_id', options.deviceId)
    .eq('incident_key', COPY_EVENTS_MARKER_KEY)
    .maybeSingle<{ detail: string | null }>();
  if (error) throw new Error(`snapshot-marker-query-failed: ${error.message}`);
  const stored = Number(data?.detail ?? 0);
  if (Number.isFinite(stored) && stored >= options.at) return;
  const nowIso = new Date().toISOString();
  const { error: upsertError } = await options.db.from('copier_alert_state').upsert({
    user_id: options.userId,
    device_id: options.deviceId,
    incident_key: COPY_EVENTS_MARKER_KEY,
    active: false,
    detail: String(options.at),
    updated_at: nowIso,
    notified_at: nowIso,
  }, { onConflict: 'user_id,device_id,incident_key' });
  if (upsertError) throw new Error(`snapshot-marker-upsert-failed: ${upsertError.message}`);
}

export async function sendCopierSnapshotFollowUp(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: string;
  input: CopierSnapshotInput;
  storagePath: string;
}): Promise<{ devices: number; sent: number } | null> {
  if (options.input.kind === 'tv-alert') return null;
  const { data, error } = await options.db.from('tradovate_copier_device_runtime')
    .select('status').eq('device_id', options.deviceId)
    .maybeSingle<{ status: Record<string, unknown> }>();
  if (error) throw new Error(`snapshot-runtime-query-failed: ${error.message}`);
  const content = findCopierSnapshotPushContent(data?.status ?? {}, options.input);
  if (!content) return null;
  const result = await sendImagePushes({
    db: options.db,
    userId: options.userId,
    storagePath: options.storagePath,
    content,
    deadlineAt: options.input.notifyDeadlineAt,
  });
  if (result.sent > 0) {
    await markCopierSnapshotNotificationSent({
      db: options.db,
      userId: options.userId,
      deviceId: options.deviceId,
      at: options.input.at,
    });
  }
  return result;
}

export async function sendTvAlertSnapshotFollowUp(options: {
  db: SupabaseClient;
  userId: string;
  alertId: string;
  storagePath: string;
}): Promise<{ devices: number; sent: number } | null> {
  const settings = await loadTvAlertWebhookSettings({ db: options.db, userId: options.userId });
  if (!settings.alertsEnabled || !settings.imagesEnabled) return null;
  const { data, error } = await options.db.from('tv_alerts')
    .select('symbol,name,price,timeframe').eq('id', options.alertId).eq('user_id', options.userId)
    .maybeSingle<{ symbol: string; name: string; price: string | null; timeframe: string | null }>();
  if (error) throw new Error(`tv-alert-follow-up-query-failed: ${error.message}`);
  if (!data) return null;
  const content = tvAlertNotification(data);
  return sendImagePushes({
    db: options.db,
    userId: options.userId,
    storagePath: options.storagePath,
    content: {
      ...content,
      collapseId: `tvalert-${options.alertId}`,
      threadId: 'alphatrade-tv-alerts',
    },
  });
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendApnsNotification, type ApnsDevice } from './apns.js';
import {
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
  input: Pick<CopierSnapshotInput, 'episodeId' | 'kind' | 'at'>,
): ImagePushContent | null {
  if (input.kind === 'tv-alert') return null;
  const events = controllerStatus(status).recentCopyEvents;
  if (!Array.isArray(events)) return null;
  const event = (events as CopierCopyEventRow[]).find(candidate => (
    candidate?.episodeId?.toLowerCase() === input.episodeId.toLowerCase()
    && candidate.kind === input.kind
    && Math.floor(candidate.at / 1_000) === Math.floor(input.at / 1_000)
  ));
  if (!event) return null;
  return {
    ...copyEventNotification(event),
    collapseId: copierSnapshotCollapseId({ episodeId: input.episodeId, kind: input.kind, at: input.at }),
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
}): Promise<{ devices: number; sent: number }> {
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
  const results = await Promise.all(devices.map(device => sendApnsNotification(device, {
    title: options.content.title,
    body: options.content.body,
    route: 'live',
    threadId: options.content.threadId,
    category: 'ALPHATRADE_TRADE',
    interruptionLevel: 'active',
    collapseId: options.content.collapseId,
    mutableContent: true,
    imageUrl,
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
  const content = data ? findCopierSnapshotPushContent(data.status, options.input) : null;
  if (!content) return null;
  return sendImagePushes({ db: options.db, userId: options.userId, storagePath: options.storagePath, content });
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

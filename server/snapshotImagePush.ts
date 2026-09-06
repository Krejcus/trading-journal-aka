import type { SupabaseClient } from '@supabase/supabase-js';
import { sendApnsNotification, type ApnsDevice } from './apns.js';
import {
  copierSnapshotCollapseId,
  copyEventNotification,
  type CopierCopyEventRow,
} from './copierIncidentWatchdog.js';
import { loadTvAlertWebhookSettings, tvAlertNotification } from './tvAlertNotifications.js';
import type { CopierSnapshotInput } from './copierSnapshotStore.js';
import { copierEventDeliveryKey, drainNotificationDeliveries, enqueueNotificationDelivery } from './notificationDelivery.js';

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

function matchingSnapshotEvent(status: Record<string, unknown>, input: Pick<CopierSnapshotInput, 'episodeId' | 'kind' | 'at'>): CopierCopyEventRow | undefined {
  const events = controllerStatus(status).recentCopyEvents;
  const matches = Array.isArray(events) ? (events as CopierCopyEventRow[]).filter(candidate => (
    candidate?.episodeId?.toLowerCase() === input.episodeId.toLowerCase()
    && candidate.kind === input.kind && candidate.at === input.at
  )) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

export function findCopierSnapshotPushContent(
  status: Record<string, unknown>,
  input: Pick<CopierSnapshotInput, 'episodeId' | 'kind' | 'at' | 'symbol'>,
): ImagePushContent | null {
  if (input.kind === 'tv-alert') return null;
  const event = matchingSnapshotEvent(status, input);
  // Current workers only capture ENTRY/EXIT. A legacy SL image may correlate to
  // its exact move, but must never fabricate a second generic exit notification.
  if (input.kind === 'sl-moved' && !event) return null;
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
  if (options.input.notifyDeadlineAt != null && Date.now() >= options.input.notifyDeadlineAt) return null;
  const eventKey = copierEventDeliveryKey({ deviceId: options.deviceId, episodeId: options.input.episodeId,
    kind: options.input.kind, at: options.input.at,
    eventId: matchingSnapshotEvent(data?.status ?? {}, options.input)?.id });
  const targets = await options.db.from('native_push_subscriptions').select('id')
    .eq('user_id', options.userId).is('expired_at', null);
  if (targets.error) throw new Error(`snapshot-push-devices-failed: ${targets.error.message}`);
  for (const device of targets.data ?? []) {
    await enqueueNotificationDelivery({ db: options.db, userId: options.userId, eventKey, channel: 'apns',
      subscriptionId: device.id, payload: { ...content, route: 'live', category: 'ALPHATRADE_TRADE',
        interruptionLevel: 'time-sensitive', imageStoragePath: options.storagePath } });
  }
  // Never move the global cursor here: an image can overtake other unsent events.
  const delivered = await drainNotificationDeliveries({ db: options.db, userId: options.userId, channel: 'apns', eventKey });
  const result = { devices: targets.data?.length ?? 0, sent: delivered.sent };
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

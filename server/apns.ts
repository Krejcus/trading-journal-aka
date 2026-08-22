import { createPrivateKey, sign } from 'node:crypto';
import { connect } from 'node:http2';

export type ApnsEnvironment = 'development' | 'production';

export interface ApnsDevice {
  id: string;
  deviceToken: string;
  environment: ApnsEnvironment;
  bundleId: string;
}

export interface ApnsNotification {
  title: string;
  body: string;
  route?: string;
  threadId?: string;
  category?: string;
  collapseId?: string;
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive';
  badge?: number;
  /** Notification Service Extension downloads this URL before display. */
  imageUrl?: string;
  mutableContent?: boolean;
}

export interface ApnsLiveActivityContentState {
  status: string;
  headline: string;
  detail: string;
  pnlText: string;
  isPositive: boolean;
  progress: number;
  updatedAt: number;
  mode?: 'idle' | 'pending' | 'position';
  symbol?: string;
  side?: 'Long' | 'Short';
  quantity?: number;
  entryPrice?: number;
  currentPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  slTpProgress?: number;
  armExpiresAt?: number;
  followersTotal?: number;
  followersOk?: number;
}

export interface ApnsLiveActivityUpdate {
  state: ApnsLiveActivityContentState;
  event?: 'update' | 'end';
  staleAt?: number;
  dismissalAt?: number;
}

export interface ApnsLiveActivityStart {
  attributes: {
    sessionID: string;
    symbol: string;
  };
  state: ApnsLiveActivityContentState;
  alert: {
    title: string;
    body: string;
  };
  staleAt?: number;
}

export const buildApnsWidgetPayload = (): Record<string, unknown> => ({
  aps: { 'content-changed': true },
});

export interface ApnsResult {
  status: 'sent' | 'expired' | 'failed';
  statusCode?: number;
  apnsId?: string;
  error?: string;
}

interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
}

let cachedProviderToken: { token: string; createdAtSeconds: number; keyId: string; teamId: string } | null = null;

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

function readConfig(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const rawKey = process.env.APNS_PRIVATE_KEY?.trim();
  const encodedKey = process.env.APNS_PRIVATE_KEY_BASE64?.trim();
  let privateKey = rawKey?.replace(/\\n/g, '\n');
  if (!privateKey && encodedKey) {
    try {
      privateKey = Buffer.from(encodedKey, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  if (!keyId || !teamId || !privateKey) return null;
  return { keyId, teamId, privateKey };
}

function providerToken(config: ApnsConfig, nowSeconds = Math.floor(Date.now() / 1_000)): string {
  if (cachedProviderToken
    && cachedProviderToken.keyId === config.keyId
    && cachedProviderToken.teamId === config.teamId
    && nowSeconds - cachedProviderToken.createdAtSeconds < 50 * 60) {
    return cachedProviderToken.token;
  }

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: nowSeconds }));
  const signingInput = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  const token = `${signingInput}.${base64url(signature)}`;
  cachedProviderToken = { token, createdAtSeconds: nowSeconds, keyId: config.keyId, teamId: config.teamId };
  return token;
}

export function buildApnsPayload(notification: ApnsNotification): Record<string, unknown> {
  return {
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound: 'default',
      ...(notification.badge == null ? {} : { badge: Math.max(0, Math.floor(notification.badge)) }),
      ...(notification.threadId ? { 'thread-id': notification.threadId } : {}),
      ...(notification.category ? { category: notification.category } : {}),
      ...(notification.interruptionLevel ? { 'interruption-level': notification.interruptionLevel } : {}),
      ...(notification.mutableContent ? { 'mutable-content': 1 } : {}),
    },
    route: notification.route ?? 'dashboard',
    ...(notification.imageUrl ? { imageUrl: notification.imageUrl } : {}),
  };
}

/** ActivityKit payload keys intentionally follow Apple's exact spelling. */
export function buildApnsLiveActivityPayload(update: ApnsLiveActivityUpdate): Record<string, unknown> {
  const event = update.event ?? 'update';
  return {
    aps: {
      timestamp: Math.max(0, Math.floor(update.state.updatedAt)),
      event,
      'content-state': {
        ...update.state,
        progress: Math.min(1, Math.max(0, update.state.progress)),
      },
      ...(update.staleAt == null ? {} : { 'stale-date': Math.max(0, Math.floor(update.staleAt)) }),
      ...(event !== 'end' || update.dismissalAt == null
        ? {}
        : { 'dismissal-date': Math.max(0, Math.floor(update.dismissalAt)) }),
    },
  };
}

/** Exact ActivityKit push-to-start payload for AlphaTradeLiveActivityAttributes. */
export function buildApnsLiveActivityStartPayload(start: ApnsLiveActivityStart): Record<string, unknown> {
  return {
    aps: {
      timestamp: Math.max(0, Math.floor(start.state.updatedAt)),
      event: 'start',
      'content-state': {
        ...start.state,
        progress: Math.min(1, Math.max(0, start.state.progress)),
      },
      'attributes-type': 'AlphaTradeLiveActivityAttributes',
      attributes: {
        sessionID: start.attributes.sessionID,
        symbol: start.attributes.symbol,
      },
      alert: {
        title: start.alert.title,
        body: start.alert.body,
        sound: 'default',
      },
      'input-push-token': 1,
      ...(start.staleAt == null ? {} : { 'stale-date': Math.max(0, Math.floor(start.staleAt)) }),
    },
  };
}

const cleanCollapseId = (value: string | undefined): string | undefined => {
  const cleaned = value?.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
  return cleaned || undefined;
};

async function sendApnsRequest(options: {
  environment: ApnsEnvironment;
  deviceToken: string;
  topic: string;
  pushType: 'alert' | 'liveactivity' | 'widgets';
  priority: '5' | '10';
  expiration: number;
  collapseId?: string;
  payload: Record<string, unknown>;
}): Promise<ApnsResult> {
  const config = readConfig();
  if (!config) return { status: 'failed', error: 'missing-apns-config' };

  const host = options.environment === 'development'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
  let authToken: string;
  try {
    authToken = providerToken(config);
  } catch (error) {
    return { status: 'failed', error: `apns-provider-token: ${String(error).slice(0, 300)}` };
  }

  return new Promise<ApnsResult>((resolve) => {
    const client = connect(host);
    let settled = false;
    const finish = (result: ApnsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.close();
      resolve(result);
    };
    const timeout = setTimeout(() => {
      client.destroy();
      finish({ status: 'failed', error: 'apns-timeout' });
    }, 7_000);

    client.once('error', error => finish({ status: 'failed', error: String(error).slice(0, 300) }));
    const collapseId = cleanCollapseId(options.collapseId);
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${options.deviceToken}`,
      authorization: `bearer ${authToken}`,
      'apns-topic': options.topic,
      'apns-push-type': options.pushType,
      'apns-priority': options.priority,
      'apns-expiration': String(Math.max(0, Math.floor(options.expiration))),
      ...(collapseId ? { 'apns-collapse-id': collapseId } : {}),
    });

    let statusCode = 0;
    let apnsId: string | undefined;
    let responseBody = '';
    request.setEncoding('utf8');
    request.on('response', headers => {
      statusCode = Number(headers[':status'] ?? 0);
      apnsId = typeof headers['apns-id'] === 'string' ? headers['apns-id'] : undefined;
    });
    request.on('data', chunk => { responseBody += String(chunk); });
    request.on('error', error => finish({ status: 'failed', statusCode, error: String(error).slice(0, 300) }));
    request.on('end', () => {
      if (statusCode === 200) return finish({ status: 'sent', statusCode, apnsId });
      let reason = responseBody.slice(0, 300) || `APNs HTTP ${statusCode}`;
      try {
        const parsed = JSON.parse(responseBody) as { reason?: string };
        if (parsed.reason) reason = parsed.reason;
      } catch {
        // Keep the bounded raw response for diagnostics.
      }
      const expired = statusCode === 410
        || reason === 'BadDeviceToken'
        || reason === 'DeviceTokenNotForTopic'
        || reason === 'Unregistered';
      finish({ status: expired ? 'expired' : 'failed', statusCode, apnsId, error: reason });
    });
    request.end(JSON.stringify(options.payload));
  });
}

/** Send one alert directly to the native AlphaTrade app through APNs. */
export async function sendApnsNotification(
  device: ApnsDevice,
  notification: ApnsNotification,
): Promise<ApnsResult> {
  return sendApnsRequest({
    environment: device.environment,
    deviceToken: device.deviceToken,
    topic: device.bundleId,
    pushType: 'alert',
    priority: '10',
    expiration: Math.floor(Date.now() / 1_000) + 60 * 60,
    collapseId: notification.collapseId,
    payload: buildApnsPayload(notification),
  });
}

/** Send a silent remote update or end event to one existing ActivityKit activity. */
export async function sendApnsLiveActivityUpdate(
  device: ApnsDevice,
  update: ApnsLiveActivityUpdate,
): Promise<ApnsResult> {
  return sendApnsRequest({
    environment: device.environment,
    deviceToken: device.deviceToken,
    topic: `${device.bundleId}.push-type.liveactivity`,
    pushType: 'liveactivity',
    priority: '10',
    expiration: Math.floor(Date.now() / 1_000) + 5 * 60,
    collapseId: `liveactivity-${device.id}`,
    payload: buildApnsLiveActivityPayload(update),
  });
}

/** Create a new ActivityKit activity while the native app is not running. */
export async function sendApnsLiveActivityStart(
  device: ApnsDevice,
  start: ApnsLiveActivityStart,
): Promise<ApnsResult> {
  return sendApnsRequest({
    environment: device.environment,
    deviceToken: device.deviceToken,
    topic: `${device.bundleId}.push-type.liveactivity`,
    pushType: 'liveactivity',
    priority: '10',
    expiration: Math.floor(Date.now() / 1_000) + 5 * 60,
    collapseId: `liveactivity-start-${device.id}`,
    payload: buildApnsLiveActivityStartPayload(start),
  });
}

/**
 * Ask iOS 26 WidgetKit to reload all configured push-enabled timelines.
 * Priorita 5 je „power-friendly" a iOS smí doručení/reload odložit — živě
 * ověřeno: push přijat, widget zůstal starý. Urgentní změny (ARM/DISARM,
 * status) proto jedou s prioritou 10; úsporná 5 zůstává jen pro P&L refresh.
 */
export async function sendApnsWidgetUpdate(
  device: ApnsDevice,
  options: { urgent?: boolean } = {},
): Promise<ApnsResult> {
  return sendApnsRequest({
    environment: device.environment,
    deviceToken: device.deviceToken,
    topic: `${device.bundleId}.push-type.widgets`,
    pushType: 'widgets',
    priority: options.urgent ? '10' : '5',
    expiration: Math.floor(Date.now() / 1_000) + 15 * 60,
    collapseId: `widget-refresh-${device.id}`,
    payload: buildApnsWidgetPayload(),
  });
}

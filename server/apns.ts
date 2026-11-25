import { createPrivateKey, sign } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';

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
  /** Bounded request budget for latency-sensitive best-effort notifications. */
  timeoutMs?: number;
  /** Bez zvuku (upozornění na cenu s vypnutým zvukem); výchozí je `default`. */
  silent?: boolean;
  /** Soubor zvuku v balíčku appky (např. `alert_panic.wav`); výchozí je `default`. */
  sound?: string;
  /** Doplňková data pro akce notifikace (např. id upozornění). */
  data?: Record<string, string>;
  /**
   * `apns-expiration` v sekundách od teď; 0 = APNs notifikaci neuloží (doručí jen hned).
   * Výchozí 1 h. Upozornění na cenu posílá 0: uložená by vytlačila uloženou rizikovou
   * notifikaci kopírky (APNs drží jen poslední) a dorazila by pozdě.
   */
  expirationSeconds?: number;
  /** Poslat po drženém spojení k Applu a nechat ho otevřené (upozornění na cenu). */
  keepSession?: boolean;
}

export interface ApnsLiveActivityContentState {
  /** Upozornění na cenu (`server/priceAlertLiveActivity.ts`); jen zobrazení, úroveň uživatele. */
  priceAlertSymbol?: string;
  priceAlertLevelText?: string;
  priceAlertDirection?: string;
  priceAlertNote?: string;
  priceAlertAt?: number;
  status: string;
  headline: string;
  detail: string;
  pnlText: string;
  pnlLabel?: string;
  isPositive: boolean;
  progress: number;
  updatedAt: number;
  mode?: 'idle' | 'pending' | 'position' | 'summary';
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
  riskAtStopText?: string;
  /** Celé dolary pro hero číslo na zámku („+$145"); pnlText zůstává s centy. */
  pnlCompactText?: string;
  /** P&L při zásahu SL / TP napříč všemi účty skupiny („−$129", „+$231"). */
  stopPnlText?: string;
  targetPnlText?: string;
  /** Denní přehled pro obrazovky mimo pozici (po obchodu, zapnuto, shrnutí, cooldown, zámek). */
  dayTrades?: Array<{ pnl: number; exit: 'SL' | 'TP' | 'M'; closedAt: number }>;
  tradesToday?: number;
  losingTrades?: number;
  dayPnlText?: string;
  dayLossUsd?: number;
  maxLosingTrades?: number;
  dailyLossLimitUsd?: number;
  maxTrades?: number;
  armedAt?: number;
  sessionEndAt?: number;
  cooldownUntil?: number;
  dayLockUntil?: number;
  dayLockReason?: string;
}

export interface ApnsLiveActivityUpdate {
  state: ApnsLiveActivityContentState;
  event?: 'update' | 'end';
  /** Rozbalí Island (upozornění na cenu); bez zvuku, ten má běžná notifikace. */
  alert?: { title: string; body: string };
  staleAt?: number;
  dismissalAt?: number;
}

export interface ApnsLiveActivityStart {
  attributes: {
    sessionID: string;
    symbol: string;
    registrationToken?: string;
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
      ...(notification.silent ? {} : { sound: notification.sound ?? 'default' }),
      ...(notification.badge == null ? {} : { badge: Math.max(0, Math.floor(notification.badge)) }),
      ...(notification.threadId ? { 'thread-id': notification.threadId } : {}),
      ...(notification.category ? { category: notification.category } : {}),
      ...(notification.interruptionLevel ? { 'interruption-level': notification.interruptionLevel } : {}),
      ...(notification.mutableContent ? { 'mutable-content': 1 } : {}),
    },
    route: notification.route ?? 'dashboard',
    ...(notification.imageUrl ? { imageUrl: notification.imageUrl } : {}),
    ...(notification.data ?? {}),
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
      ...(update.alert && event !== 'end' ? { alert: { title: update.alert.title, body: update.alert.body } } : {}),
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
        ...(start.attributes.registrationToken ? { registrationToken: start.attributes.registrationToken } : {}),
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

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};
/**
 * Předem navázaná spojení k Applu (25. 11. 2026): navázání z Evropy stojí ~0,4 s, odeslání po hotovém spojení
 * jeden oběh. Spojení se otevře na začátku požadavku (`prewarmApns`), běží souběžně se zápisem spuštění a na konci
 * TÉHOŽ požadavku se zavře (`release`). Mezi požadavky se nic nedrží: uspaná funkce by se probudila s mrtvým
 * spojením a odeslání by čekalo na timeout. Používá je jen volání s `keepSession` (upozornění na cenu).
 */
const apnsSessions = new Map<string, ClientHttp2Session>();
let apnsHolders = 0;
function heldApnsSession(host: string): ClientHttp2Session | null {
  const cached = apnsSessions.get(host);
  return cached && !cached.closed && !cached.destroyed ? cached : null;
}
function openApnsSession(host: string): void {
  if (heldApnsSession(host)) return;
  const client = connect(host);
  apnsSessions.set(host, client);
  const drop = () => { if (apnsSessions.get(host) === client) apnsSessions.delete(host); };
  client.once('close', drop);
  client.once('goaway', drop);
  // Posluchač chyby musí existovat pořád: chyba nečinného spojení jinak shodí proces.
  client.on('error', drop);
}
const dropApnsSession = (host: string, client: ClientHttp2Session) => {
  if (apnsSessions.get(host) === client) apnsSessions.delete(host);
  try { client.destroy(); } catch { /* už zavřené */ }
};

/**
 * Začne navazovat spojení k Applu a vrátí `release`, které se MUSÍ zavolat na konci požadavku (finally).
 * Souběžné požadavky na téže instanci spojení sdílejí; zavře se, až ho pustí poslední. Nikdy nevyhodí.
 */
export function prewarmApns(): { release: () => void } {
  let released = false;
  let opened = false;
  try {
    if (readConfig()) {
      for (const host of Object.values(APNS_HOSTS)) openApnsSession(host);
      apnsHolders += 1;
      opened = true;
    }
  } catch { /* předehřátí je jen úspora času */ }
  return {
    release: () => {
      if (released || !opened) return;
      released = true;
      apnsHolders = Math.max(0, apnsHolders - 1);
      if (apnsHolders > 0) return;
      for (const [host, client] of [...apnsSessions]) {
        apnsSessions.delete(host);
        try { client.close(); } catch { /* už zavřené */ }
      }
    },
  };
}

interface ApnsRequestOptions {
  environment: ApnsEnvironment;
  deviceToken: string;
  topic: string;
  pushType: 'alert' | 'liveactivity' | 'widgets';
  priority: '5' | '10';
  expiration: number;
  collapseId?: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
  /** Použít předem navázané spojení tohoto požadavku, pokud existuje (viz `prewarmApns`). */
  keepSession?: boolean;
}

async function sendApnsRequest(options: ApnsRequestOptions): Promise<ApnsResult> {
  if (!options.keepSession) return sendApnsOnce(options, null);
  const host = APNS_HOSTS[options.environment === 'development' ? 'development' : 'production'];
  const held = heldApnsSession(host);
  if (!held) return sendApnsOnce(options, null);
  const first = await sendApnsOnce(options, held);
  // Předem navázané spojení selhalo dřív, než Apple odpověděl: jednou zkusit na vlastním čerstvém. Po vypršení
  // času se neopakuje (Apple mohl žádost přijmout a druhý pokus by se nevešel do rozpočtu požadavku).
  if (first.status === 'failed' && !first.statusCode && first.error !== 'apns-timeout') return sendApnsOnce(options, null);
  return first;
}

async function sendApnsOnce(options: ApnsRequestOptions, heldClient: ClientHttp2Session | null): Promise<ApnsResult> {
  const config = readConfig();
  if (!config) return { status: 'failed', error: 'missing-apns-config' };

  const host = APNS_HOSTS[options.environment === 'development' ? 'development' : 'production'];
  let authToken: string;
  try {
    authToken = providerToken(config);
  } catch (error) {
    return { status: 'failed', error: `apns-provider-token: ${String(error).slice(0, 300)}` };
  }

  return new Promise<ApnsResult>((resolve) => {
    const client = heldClient ?? connect(host);
    let settled = false;
    const onClientError = (error: unknown) => {
      // Chyba celého spojení: sdílené zahodit, ať ho nedostane další odeslání.
      if (heldClient) dropApnsSession(host, client);
      finish({ status: 'failed', error: String(error).slice(0, 300) });
    };
    const finish = (result: ApnsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Vlastní spojení se zavře (posluchač chyby na něm zůstává jako dřív); sdílené zavírá `release`.
      if (!heldClient) client.close();
      else client.off('error', onClientError);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      if (!heldClient) client.destroy();
      // Nejdřív výsledek (zničení spojení pošle streamu `close`, které by ho přebilo), pak sdílené spojení zahodit.
      finish({ status: 'failed', error: 'apns-timeout' });
      if (heldClient) dropApnsSession(host, client);
    }, Math.min(7_000, Math.max(100, options.timeoutMs ?? 7_000)));

    client.on('error', onClientError);
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
    // Zničené spojení pošle streamu jen `close` (žádné `error` ani `end`): bez toho by odeslání viselo do timeoutu.
    request.on('close', () => finish({ status: 'failed', statusCode, error: 'apns-stream-closed' }));
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
    expiration: notification.expirationSeconds === 0 ? 0
      : Math.floor(Date.now() / 1_000) + Math.max(1, Math.floor(notification.expirationSeconds ?? 60 * 60)),
    collapseId: notification.collapseId,
    payload: buildApnsPayload(notification),
    timeoutMs: notification.timeoutMs,
    keepSession: notification.keepSession === true,
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

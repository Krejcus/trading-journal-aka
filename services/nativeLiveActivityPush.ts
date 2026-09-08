import type { PluginListenerHandle } from '@capacitor/core';

import { apiUrl, isNativeBuild } from '../utils/runtimeConfig';
import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';
import { supabase } from './supabase';

const STORAGE_KEY = 'alphatrade-live-activity-registrations-v1';
const START_STORAGE_KEY = 'alphatrade-live-activity-push-to-start-v1';
const INSTALLATION_KEY = 'alphatrade-native-installation-id-v1';

interface ActivityRegistration {
  activityId: string;
  pushToken: string;
}

interface StartRegistration {
  installationId: string;
  pushToken: string;
}

let listeners: PluginListenerHandle[] = [];
let listeningUserId: string | null = null;
let listenerGeneration = 0;
const acceptedActivities = new Set<string>();
let acceptedStart = false;
const pendingPosts = new Set<Promise<Response>>();
const uncertainPosts = new Set<string>();

async function subscriptionFetch(url: string, init: RequestInit, token: string): Promise<Response> {
  const pending = fetch(url, init);
  const isPost = init.method === 'POST';
  if (isPost) pendingPosts.add(pending);
  try {
    const response = await pending;
    if (isPost && !response.ok) uncertainPosts.add(token);
    return response;
  } catch (error) {
    if (isPost) uncertainPosts.add(token);
    throw error;
  } finally {
    pendingPosts.delete(pending);
  }
}

/** A successful subscription makes the server the content/lifecycle owner. */
const REMOTE_MANAGED_KEY = 'alphatrade_native_live_activity_remote_managed';

const readRemoteManagedFlag = (): boolean => {
  try { return localStorage.getItem(REMOTE_MANAGED_KEY) === '1'; } catch { return false; }
};
const writeRemoteManagedFlag = (value: boolean): void => {
  try {
    if (value) localStorage.setItem(REMOTE_MANAGED_KEY, '1');
    else localStorage.removeItem(REMOTE_MANAGED_KEY);
  } catch { /* private mode */ }
};

/**
 * Server (tik + cron) je autoritou pro Live Activity, jakmile jednou přijal
 * registraci. Trvalý příznak brání tomu, aby lokální záložní sync po restartu
 * appky (než doběhne nová registrace) přepsal bohatší serverový obsah nebo
 * založil duplicitní aktivitu.
 */
export function isNativeLiveActivityRemoteManaged(): boolean {
  if (listeningUserId != null && (acceptedStart || acceptedActivities.size > 0)) return true;
  return isNativeBuild && readRemoteManagedFlag();
}

function loadRegistrations(): ActivityRegistration[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is ActivityRegistration => !!item
        && typeof item === 'object'
        && typeof (item as ActivityRegistration).activityId === 'string'
        && typeof (item as ActivityRegistration).pushToken === 'string')
      : [];
  } catch {
    return [];
  }
}

function saveRegistration(registration: ActivityRegistration): void {
  const current = loadRegistrations().filter(item => item.activityId !== registration.activityId);
  current.push(registration);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current.slice(-8)));
}

function registrationFor(activityId: string): ActivityRegistration | null {
  return loadRegistrations().find(item => item.activityId === activityId) ?? null;
}

function removeRegistration(activityId: string): void {
  const current = loadRegistrations();
  const next = current.filter(item => item.activityId !== activityId);
  if (next.length > 0) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  else localStorage.removeItem(STORAGE_KEY);
}

function installationId(): string {
  const existing = localStorage.getItem(INSTALLATION_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(INSTALLATION_KEY, created);
  return created;
}

function loadStartRegistration(): StartRegistration | null {
  try {
    const value = JSON.parse(localStorage.getItem(START_STORAGE_KEY) || 'null') as Partial<StartRegistration> | null;
    return value && typeof value.pushToken === 'string' && typeof value.installationId === 'string'
      ? { pushToken: value.pushToken, installationId: value.installationId }
      : null;
  } catch {
    return null;
  }
}

function saveStartRegistration(pushToken: string): StartRegistration {
  const registration = { installationId: installationId(), pushToken };
  localStorage.setItem(START_STORAGE_KEY, JSON.stringify(registration));
  return registration;
}

async function sendRegistration(
  registration: ActivityRegistration,
  method: 'POST' | 'DELETE',
  expectedUserId: string,
): Promise<boolean> {
  const epoch = listenerGeneration;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || session.user.id !== expectedUserId) return false;
  const environment = await alphaTradeNativePlugin.getPushEnvironment() as {
    environment: 'development' | 'production';
  };
  if (method === 'POST' && epoch !== listenerGeneration) return false;
  const response = await subscriptionFetch(apiUrl('/api/native-live-activity-subscription'), {
    method,
    signal: AbortSignal.timeout(8_000),
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...registration,
      environment: environment.environment,
      bundleId: 'app.alphatrade.native',
    }),
  }, registration.pushToken);
  if (response.ok && epoch === listenerGeneration && listeningUserId === expectedUserId) {
    if (method === 'POST') { acceptedActivities.add(registration.activityId); writeRemoteManagedFlag(true); }
    else acceptedActivities.delete(registration.activityId);
  }
  return response.ok;
}

async function sendStartRegistration(
  registration: StartRegistration,
  method: 'POST' | 'DELETE',
  expectedUserId: string,
): Promise<boolean> {
  const epoch = listenerGeneration;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || session.user.id !== expectedUserId) return false;
  const environment = await alphaTradeNativePlugin.getPushEnvironment() as {
    environment: 'development' | 'production';
  };
  if (method === 'POST' && epoch !== listenerGeneration) return false;
  const response = await subscriptionFetch(apiUrl('/api/native-live-activity-start-subscription'), {
    method,
    signal: AbortSignal.timeout(8_000),
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...registration,
      environment: environment.environment,
      bundleId: 'app.alphatrade.native',
    }),
  }, registration.pushToken);
  if (response.ok && epoch === listenerGeneration && listeningUserId === expectedUserId) {
    acceptedStart = method === 'POST';
    if (acceptedStart) writeRemoteManagedFlag(true);
  }
  return response.ok;
}

/** Register the ActivityKit push-token stream after the user is authenticated. */
export async function initializeNativeLiveActivityPush(userId: string): Promise<void> {
  if (!isNativeBuild) return;
  if (listeners.length > 0 && listeningUserId === userId) {
    await Promise.all(loadRegistrations().map(registration => sendRegistration(registration, 'POST', userId).catch(() => false)));
    const start = loadStartRegistration();
    if (start) await sendStartRegistration(start, 'POST', userId).catch(() => false);
    return;
  }
  const epoch = ++listenerGeneration;
  await Promise.all(listeners.map(listener => listener.remove()));
  if (epoch !== listenerGeneration) return;
  listeners = [];
  acceptedActivities.clear();
  acceptedStart = false;
  listeningUserId = userId;
  const pendingListeners = [
    await alphaTradeNativePlugin.addListener(
      'liveActivityPushToken',
      (registration: ActivityRegistration) => {
        if (epoch !== listenerGeneration || listeningUserId !== userId) return;
        // Persist first, then sync. A temporary endpoint/network failure must
        // not lose the only token emission for the lifetime of an activity.
        saveRegistration(registration);
        void sendRegistration(registration, 'POST', userId).then(ok => {
          if (!ok) console.warn('[Native Live Activity] Token registration was not accepted; it will retry.');
        }).catch(error => {
          console.warn('[Native Live Activity] Token registration failed:', error instanceof Error ? error.message : error);
        });
      },
    ) as PluginListenerHandle,
    await alphaTradeNativePlugin.addListener(
      'liveActivityEnded',
      ({ activityId }: { activityId: string }) => {
        if (epoch !== listenerGeneration || listeningUserId !== userId) return;
        acceptedActivities.delete(activityId);
        const registration = registrationFor(activityId);
        if (!registration) return;
        void sendRegistration(registration, 'DELETE', userId)
          .then(ok => { if (ok) removeRegistration(activityId); })
          .catch(error => {
            console.warn('[Native Live Activity] Token removal failed:', error instanceof Error ? error.message : error);
          });
      },
    ) as PluginListenerHandle,
    await alphaTradeNativePlugin.addListener(
      'liveActivityPushToStartToken',
      ({ pushToken }: { pushToken: string }) => {
        if (epoch !== listenerGeneration || listeningUserId !== userId) return;
        const registration = saveStartRegistration(pushToken);
        void sendStartRegistration(registration, 'POST', userId).then(ok => {
          if (!ok) console.warn('[Native Live Activity] Push-to-start registration was not accepted; it will retry.');
        }).catch(error => {
          console.warn('[Native Live Activity] Push-to-start registration failed:', error instanceof Error ? error.message : error);
        });
      },
    ) as PluginListenerHandle,
  ];
  if (epoch !== listenerGeneration) {
    await Promise.allSettled(pendingListeners.map(listener => listener.remove()));
    return;
  }
  listeners = pendingListeners;

  // Retry any token captured while the endpoint or network was unavailable.
  await Promise.all(loadRegistrations().map(registration =>
    sendRegistration(registration, 'POST', userId).catch(() => false)));
  const startRegistration = loadStartRegistration();
  if (startRegistration) await sendStartRegistration(startRegistration, 'POST', userId).catch(() => false);
}

export async function deactivateNativeLiveActivityPush(userId: string): Promise<{ revoked: boolean }> {
  writeRemoteManagedFlag(false);
  ++listenerGeneration;
  const registrationsInFlight = [...pendingPosts];
  listeningUserId = null;
  acceptedActivities.clear();
  acceptedStart = false;
  const registrations = loadRegistrations();
  const startRegistration = loadStartRegistration();
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(START_STORAGE_KEY);
  const removing = listeners;
  listeners = [];
  const localResults = await Promise.allSettled([
    ...removing.map(listener => listener.remove()),
    ...(isNativeBuild ? [alphaTradeNativePlugin.endLiveActivity()] : []),
  ]);
  await Promise.allSettled(registrationsInFlight);
  const results = await Promise.all([
    ...registrations.map(registration => sendRegistration(registration, 'DELETE', userId).catch(() => false)),
    ...(startRegistration ? [sendStartRegistration(startRegistration, 'DELETE', userId).catch(() => false)] : []),
  ]);
  const revoked = results.every(Boolean)
    && registrations.every(registration => !uncertainPosts.has(registration.pushToken))
    && (!startRegistration || !uncertainPosts.has(startRegistration.pushToken));
  if (!revoked) console.warn('[Native Live Activity] Local registrations were cleared; server revocation was not confirmed.');
  const localFailure = localResults.find(result => result.status === 'rejected');
  if (localFailure?.status === 'rejected') throw localFailure.reason;
  return { revoked };
}

export async function resetNativeLiveActivityPushListener(): Promise<void> {
  ++listenerGeneration;
  const removing = listeners;
  listeners = [];
  listeningUserId = null;
  acceptedActivities.clear();
  acceptedStart = false;
  await Promise.allSettled(removing.map(listener => listener.remove()));
}

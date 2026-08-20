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
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || session.user.id !== expectedUserId) return false;
  const environment = await alphaTradeNativePlugin.getPushEnvironment() as {
    environment: 'development' | 'production';
  };
  const response = await fetch(apiUrl('/api/native-live-activity-subscription'), {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...registration,
      environment: environment.environment,
      bundleId: 'app.alphatrade.native',
    }),
  });
  return response.ok;
}

async function sendStartRegistration(
  registration: StartRegistration,
  method: 'POST' | 'DELETE',
  expectedUserId: string,
): Promise<boolean> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || session.user.id !== expectedUserId) return false;
  const environment = await alphaTradeNativePlugin.getPushEnvironment() as {
    environment: 'development' | 'production';
  };
  const response = await fetch(apiUrl('/api/native-live-activity-start-subscription'), {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...registration,
      environment: environment.environment,
      bundleId: 'app.alphatrade.native',
    }),
  });
  return response.ok;
}

/** Register the ActivityKit push-token stream after the user is authenticated. */
export async function initializeNativeLiveActivityPush(userId: string): Promise<void> {
  if (!isNativeBuild) return;
  if (listeners.length > 0 && listeningUserId === userId) return;
  await Promise.all(listeners.map(listener => listener.remove()));
  listeners = [];
  listeningUserId = userId;
  listeners = [
    await alphaTradeNativePlugin.addListener(
      'liveActivityPushToken',
      (registration: ActivityRegistration) => {
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
        const registration = saveStartRegistration(pushToken);
        void sendStartRegistration(registration, 'POST', userId).then(ok => {
          if (!ok) console.warn('[Native Live Activity] Push-to-start registration was not accepted; it will retry.');
        }).catch(error => {
          console.warn('[Native Live Activity] Push-to-start registration failed:', error instanceof Error ? error.message : error);
        });
      },
    ) as PluginListenerHandle,
  ];

  // Retry any token captured while the endpoint or network was unavailable.
  await Promise.all(loadRegistrations().map(registration =>
    sendRegistration(registration, 'POST', userId).catch(() => false)));
  const startRegistration = loadStartRegistration();
  if (startRegistration) await sendStartRegistration(startRegistration, 'POST', userId).catch(() => false);
}

export async function deactivateNativeLiveActivityPush(userId: string): Promise<void> {
  const registrations = loadRegistrations();
  const startRegistration = loadStartRegistration();
  await Promise.all(registrations.map(registration =>
    sendRegistration(registration, 'DELETE', userId).catch(() => false)));
  if (startRegistration) await sendStartRegistration(startRegistration, 'DELETE', userId).catch(() => false);
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(START_STORAGE_KEY);
  await Promise.all(listeners.map(listener => listener.remove()));
  listeners = [];
  listeningUserId = null;
}

export async function resetNativeLiveActivityPushListener(): Promise<void> {
  await Promise.all(listeners.map(listener => listener.remove()));
  listeners = [];
  listeningUserId = null;
}

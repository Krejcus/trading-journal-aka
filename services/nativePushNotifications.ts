import { PushNotifications, type Token } from '@capacitor/push-notifications';
import type { PluginListenerHandle } from '@capacitor/core';

import { apiUrl, isNativeBuild } from '../utils/runtimeConfig';
import { navigateNativeShell } from '../utils/nativeShell';
import { supabase } from './supabase';
import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';

let listenerHandles: PluginListenerHandle[] = [];
let initialization: Promise<boolean> | null = null;
let initializedUserId: string | null = null;
let registeredToken: Token | null = null;

async function removeListenerHandles(): Promise<void> {
  await Promise.all(listenerHandles.map(handle => handle.remove()));
  listenerHandles = [];
}

async function registrationRequest(token: Token, method: 'POST' | 'DELETE', expectedUserId: string): Promise<boolean> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || session.user.id !== expectedUserId) return false;
  const environmentResult = await alphaTradeNativePlugin.getPushEnvironment() as {
    environment: 'development' | 'production';
  };
  const response = await fetch(apiUrl('/api/native-push-subscription'), {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      deviceToken: token.value,
      environment: environmentResult.environment,
      bundleId: 'app.alphatrade.native',
      appVersion: null,
      deviceModel: typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 120),
    }),
  });
  return response.ok;
}

/**
 * Register the installed native app with APNs and persist its token server-side.
 * The promise is shared so React rerenders never create duplicate listeners.
 */
export function initializeNativeRemoteNotifications(userId: string): Promise<boolean> {
  if (!isNativeBuild) return Promise.resolve(false);
  if (initialization && initializedUserId === userId) return initialization;
  initialization = (async () => {
    await removeListenerHandles();
    initializedUserId = userId;
    const current = await PushNotifications.checkPermissions();
    const permission = current.receive === 'granted'
      ? current.receive
      : (await PushNotifications.requestPermissions()).receive;
    if (permission !== 'granted') return false;

    let settleRegistration: (active: boolean) => void = () => undefined;
    const registrationResult = new Promise<boolean>(resolve => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, 15_000);
      settleRegistration = active => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(active);
      };
    });

    listenerHandles = [
      await PushNotifications.addListener('registration', token => {
        registeredToken = token;
        void registrationRequest(token, 'POST', userId)
          .then(settleRegistration)
          .catch(error => {
            console.warn('[Native APNs] Token registration failed:', error instanceof Error ? error.message : error);
            settleRegistration(false);
          });
      }),
      await PushNotifications.addListener('registrationError', error => {
        console.warn('[Native APNs] APNs registration failed:', error.error);
        settleRegistration(false);
      }),
      await PushNotifications.addListener('pushNotificationActionPerformed', action => {
        const route = action.notification.data?.route;
        navigateNativeShell(typeof route === 'string' ? route : 'dashboard');
      }),
    ];
    await PushNotifications.register();
    return registrationResult;
  })().catch(error => {
    initialization = null;
    initializedUserId = null;
    console.warn('[Native APNs] Initialization failed:', error instanceof Error ? error.message : error);
    return false;
  });
  return initialization;
}

export async function resetNativeRemoteNotificationListeners(): Promise<void> {
  await removeListenerHandles();
  initialization = null;
  initializedUserId = null;
}

/** Remove this installation from the signed-in user's server-side APNs registry. */
export async function deactivateNativeRemoteNotifications(userId: string): Promise<void> {
  const token = registeredToken;
  if (token) {
    try {
      await registrationRequest(token, 'DELETE', userId);
    } catch (error) {
      console.warn('[Native APNs] Token removal failed:', error instanceof Error ? error.message : error);
    }
  }
  registeredToken = null;
  await resetNativeRemoteNotificationListeners();
}

export async function sendNativeRemoteTestPush(): Promise<{
  ok: boolean;
  sent: number;
  devices: number;
  message?: string;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, sent: 0, devices: 0, message: 'Nejsi přihlášen.' };
  try {
    const response = await fetch(apiUrl('/api/native-push-test'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, sent: 0, devices: 0, message: result?.message || result?.error || `Chyba ${response.status}` };
    }
    return {
      ok: Number(result.sent) > 0,
      sent: Number(result.sent) || 0,
      devices: Number(result.devices) || 0,
      message: result.message,
    };
  } catch (error) {
    return {
      ok: false,
      sent: 0,
      devices: 0,
      message: error instanceof Error ? error.message : 'Požadavek selhal.',
    };
  }
}

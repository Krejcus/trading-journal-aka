import { PushNotifications, type Token } from '@capacitor/push-notifications';
import type { PluginListenerHandle } from '@capacitor/core';

import { apiUrl, isNativeBuild } from '../utils/runtimeConfig';
import { dispatchNativeNotificationAction } from './nativeNotifications';
import { supabase } from './supabase';
import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';

let listenerHandles: PluginListenerHandle[] = [];
let initialization: Promise<boolean> | null = null;
let initializedUserId: string | null = null;
let registeredToken: Token | null = null;
let generation = 0;
let cancelRegistrationWait: (() => void) | null = null;
const pendingTokenWrites = new Set<Promise<boolean>>();
const REGISTRATION_TIMEOUT_MS = 12_000;
const tokenStorageKey = (userId: string) => `alphatrade_native_apns_token_${userId}`;

function saveToken(userId: string, token: Token): void {
  try { localStorage.setItem(tokenStorageKey(userId), token.value); } catch { /* in-memory still available */ }
}

function storedToken(userId: string): Token | null {
  try {
    const value = localStorage.getItem(tokenStorageKey(userId));
    return value ? { value } : null;
  } catch { return null; }
}

async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs = REGISTRATION_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Native APNs request timed out')); }, timeoutMs);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function removeListenerHandles(): Promise<void> {
  const oldHandles = listenerHandles;
  listenerHandles = [];
  await Promise.allSettled(oldHandles.map(handle => handle.remove()));
}

async function registrationRequest(token: Token, method: 'POST' | 'DELETE', expectedUserId: string): Promise<boolean> {
  return bounded(async signal => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || session.user.id !== expectedUserId) return false;
    const environmentResult = await alphaTradeNativePlugin.getPushEnvironment() as {
      environment: 'development' | 'production';
    };
    if (signal.aborted) throw new Error('Native APNs request timed out');
    const response = await fetch(apiUrl('/api/native-push-subscription'), {
      method,
      signal,
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
  });
}

/**
 * Register the installed native app with APNs and persist its token server-side.
 * The promise is shared so React rerenders never create duplicate listeners.
 */
export function initializeNativeRemoteNotifications(userId: string): Promise<boolean> {
  if (!isNativeBuild) return Promise.resolve(false);
  if (initialization && initializedUserId === userId) return initialization;
  const epoch = ++generation;
  initializedUserId = userId;
  cancelRegistrationWait?.();
  const task = (async () => {
    await removeListenerHandles();
    if (epoch !== generation) return false;
    const current = await PushNotifications.checkPermissions();
    const permission = current.receive === 'granted'
      ? current.receive
      : (await PushNotifications.requestPermissions()).receive;
    if (epoch !== generation || permission !== 'granted') return false;

    let settleRegistration: (active: boolean) => void = () => undefined;
    const registrationResult = new Promise<boolean>(resolve => {
      let settled = false;
      const timeout = setTimeout(() => settleRegistration(false), 15_000);
      settleRegistration = active => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (epoch === generation) cancelRegistrationWait = null;
        resolve(active);
      };
      cancelRegistrationWait = () => settleRegistration(false);
    });
    const handles: PluginListenerHandle[] = [];
    try {
      handles.push(await PushNotifications.addListener('registration', token => {
        if (epoch !== generation) return;
        registeredToken = token;
        saveToken(userId, token);
        const write = registrationRequest(token, 'POST', userId);
        pendingTokenWrites.add(write);
        void write.finally(() => pendingTokenWrites.delete(write)).catch(() => undefined);
        void write
          .then(active => settleRegistration(epoch === generation && active))
          .catch(error => {
            console.warn('[Native APNs] Token registration failed:', error instanceof Error ? error.message : error);
            settleRegistration(false);
          });
      }));
      handles.push(await PushNotifications.addListener('registrationError', error => {
        if (epoch !== generation) return;
        console.warn('[Native APNs] APNs registration failed:', error.error);
        settleRegistration(false);
      }));
      handles.push(await PushNotifications.addListener('pushNotificationActionPerformed', action => {
        if (epoch !== generation) return;
        dispatchNativeNotificationAction({
          actionId: action.actionId, inputValue: action.inputValue, data: action.notification.data,
        });
      }));
      if (epoch !== generation) {
        await Promise.allSettled(handles.map(handle => handle.remove()));
        settleRegistration(false);
        return false;
      }
      listenerHandles = handles;
      await PushNotifications.register();
      return await registrationResult;
    } catch (error) {
      settleRegistration(false);
      await Promise.allSettled(handles.map(handle => handle.remove()));
      throw error;
    }
  })().catch(error => {
    console.warn('[Native APNs] Initialization failed:', error instanceof Error ? error.message : error);
    return false;
  }).finally(() => {
    // Cache only in-flight work. A foreground/Settings retry must recheck iOS
    // permission and persist the token again after denial or a transient outage.
    if (epoch === generation) initialization = null;
  });
  initialization = task;
  return task;
}

export async function resetNativeRemoteNotificationListeners(): Promise<void> {
  generation++;
  cancelRegistrationWait?.();
  cancelRegistrationWait = null;
  initialization = null;
  initializedUserId = null;
  await removeListenerHandles();
}

/** Local delivery is disabled even when remote revocation cannot be confirmed. */
export async function deactivateNativeRemoteNotifications(userId: string): Promise<void> {
  const token = registeredToken ?? storedToken(userId);
  // Invalidate callbacks before awaiting network work; an in-flight register
  // callback must not reattach the departing user's local listeners.
  await bounded(() => resetNativeRemoteNotificationListeners(), 3_000).catch(() => undefined);
  let revokeError: Error | null = null;
  try {
    // A token POST already dispatched before logout must finish before DELETE,
    // otherwise its late completion can recreate the just-revoked subscription.
    await Promise.allSettled([...pendingTokenWrites]);
    if (token && !await registrationRequest(token, 'DELETE', userId)) {
      revokeError = new Error('Odstranění APNs odběru na serveru nebylo potvrzené.');
    }
  } catch (error) {
    revokeError = error instanceof Error ? error : new Error('Odstranění APNs odběru selhalo.');
  } finally {
    registeredToken = null;
    try { localStorage.removeItem(tokenStorageKey(userId)); } catch { /* no-op */ }
    try { await bounded(() => PushNotifications.unregister()); }
    catch (error) { revokeError ??= error instanceof Error ? error : new Error('Vypnutí APNs na zařízení selhalo.'); }
  }
  if (revokeError) throw revokeError;
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

import { apiUrl, isNativeBuild } from '../utils/runtimeConfig';
import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';
import { supabase } from './supabase';

const STORAGE_KEY = 'alphatrade-native-widget-access-token-v1';
const OWNER_KEY = 'alphatrade-native-widget-owner-v1';
let generation = 0;
const pendingPosts = new Set<Promise<Response>>();
const uncertainPosts = new Set<string>();

const createToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const token = (): string => {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  const next = createToken();
  localStorage.setItem(STORAGE_KEY, next);
  return next;
};

async function registrationRequest(method: 'POST' | 'DELETE', userId: string, widgetToken: string): Promise<boolean> {
  const epoch = generation;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || session.user.id !== userId) return false;
  if (method === 'POST' && epoch !== generation) return false;
  const pending = fetch(apiUrl('/api/native-widget-registration'), {
    method,
    signal: AbortSignal.timeout(8_000),
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ widgetToken }),
  });
  if (method === 'POST') pendingPosts.add(pending);
  try {
    const response = await pending;
    if (method === 'POST' && !response.ok) uncertainPosts.add(widgetToken);
    return response.ok;
  } catch (error) {
    if (method === 'POST') uncertainPosts.add(widgetToken);
    throw error;
  } finally {
    pendingPosts.delete(pending);
  }
}

export async function initializeNativeWidgetRemote(userId: string): Promise<void> {
  if (!isNativeBuild) return;
  const epoch = ++generation;
  const previousOwner = localStorage.getItem(OWNER_KEY);
  if (previousOwner !== userId) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('alphatrade-native-widget-snapshot-v2');
    localStorage.setItem(OWNER_KEY, userId);
    await alphaTradeNativePlugin.clearWidgetAccessToken();
  }
  if (epoch !== generation) return;
  localStorage.setItem(OWNER_KEY, userId);
  const widgetToken = token();
  const accepted = await registrationRequest('POST', userId, widgetToken).catch(() => false);
  if (epoch !== generation || localStorage.getItem(STORAGE_KEY) !== widgetToken) return;
  if (accepted) {
    await alphaTradeNativePlugin.setWidgetAccessToken({ widgetToken });
    const snapshotJson = localStorage.getItem('alphatrade-native-widget-snapshot-v2');
    if (snapshotJson && epoch === generation) {
      await alphaTradeNativePlugin.updateWidgetSnapshot({ snapshotJson, widgetToken });
    }
  }
  else console.warn('[Native Widget] Background registration was not accepted; it will retry next launch.');
}

export async function deactivateNativeWidgetRemote(userId: string): Promise<{ revoked: boolean }> {
  if (!isNativeBuild) return { revoked: true };
  ++generation;
  const registrationsInFlight = [...pendingPosts];
  const widgetToken = localStorage.getItem(STORAGE_KEY);
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(OWNER_KEY);
  localStorage.removeItem('alphatrade-native-widget-snapshot-v2');
  // Invalidate the native identity before waiting for the network. Native
  // cleanup also clears its snapshot and registration signature atomically.
  await alphaTradeNativePlugin.clearWidgetAccessToken();
  // A DELETE before an in-flight POST can be undone by that POST. Wait for
  // bounded requests to settle, then make revocation the final server write.
  await Promise.allSettled(registrationsInFlight);
  const deleted = !widgetToken || await registrationRequest('DELETE', userId, widgetToken).catch(() => false);
  const revoked = deleted && (!widgetToken || !uncertainPosts.has(widgetToken));
  if (!revoked) console.warn('[Native Widget] Local access was cleared; server revocation was not confirmed.');
  return { revoked };
}

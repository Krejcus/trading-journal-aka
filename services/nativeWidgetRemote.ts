import { apiUrl, isNativeBuild } from '../utils/runtimeConfig';
import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';
import { supabase } from './supabase';

const STORAGE_KEY = 'alphatrade-native-widget-access-token-v1';

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
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || session.user.id !== userId) return false;
  const response = await fetch(apiUrl('/api/native-widget-registration'), {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ widgetToken }),
  });
  return response.ok;
}

export async function initializeNativeWidgetRemote(userId: string): Promise<void> {
  if (!isNativeBuild) return;
  const widgetToken = token();
  await alphaTradeNativePlugin.setWidgetAccessToken({ widgetToken });
  const accepted = await registrationRequest('POST', userId, widgetToken);
  if (!accepted) console.warn('[Native Widget] Background registration was not accepted; it will retry next launch.');
}

export async function deactivateNativeWidgetRemote(userId: string): Promise<void> {
  if (!isNativeBuild) return;
  const widgetToken = localStorage.getItem(STORAGE_KEY);
  if (widgetToken) await registrationRequest('DELETE', userId, widgetToken).catch(() => false);
  localStorage.removeItem(STORAGE_KEY);
  await alphaTradeNativePlugin.clearWidgetAccessToken();
}

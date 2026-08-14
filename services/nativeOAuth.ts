import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { supabase } from './supabase';
import { isNativeBuild } from '../utils/runtimeConfig';

export type NativeOAuthCallback =
  | { kind: 'ignore' }
  | { kind: 'error'; message: string }
  | { kind: 'code'; code: string };

export const NATIVE_OAUTH_RESULT_EVENT = 'alphatrade:native-oauth-result';

export interface NativeOAuthResultDetail {
  success: boolean;
  message?: string;
}

export function nativeOAuthErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/access denied|cancel|canceled|cancelled|denied by user/i.test(raw)) {
    return 'Přihlášení přes Google bylo zrušeno.';
  }
  if (/redirect|callback|url.*allow|not allowed/i.test(raw)) {
    return 'Google se nedokázal vrátit do AlphaTrade. Zkontroluj povolenou callback URL.';
  }
  return raw || 'Přihlášení přes Google se nepodařilo dokončit.';
}

function reportNativeOAuthResult(detail: NativeOAuthResultDetail): void {
  window.dispatchEvent(new CustomEvent<NativeOAuthResultDetail>(NATIVE_OAUTH_RESULT_EVENT, { detail }));
}

export function parseNativeOAuthCallback(url: string): NativeOAuthCallback {
  if (!url.startsWith('alphatrade-native://auth/callback')) return { kind: 'ignore' };

  const callback = new URL(url);
  const oauthError = callback.searchParams.get('error_description') || callback.searchParams.get('error');
  if (oauthError) return { kind: 'error', message: oauthError };

  const code = callback.searchParams.get('code');
  if (!code) return { kind: 'error', message: 'OAuth callback neobsahuje autorizační kód.' };
  return { kind: 'code', code };
}

/**
 * Complete Supabase PKCE callbacks delivered through the app's custom scheme.
 * Returns a cleanup function so the bridge can be lifecycle-managed in tests.
 */
export async function registerNativeOAuthCallback(): Promise<() => void> {
  if (!isNativeBuild) return () => {};

  const processedUrls = new Set<string>();
  const handleUrl = async (url: string): Promise<void> => {
    const callback = parseNativeOAuthCallback(url);
    if (callback.kind === 'ignore') return;
    if (processedUrls.has(url)) return;
    processedUrls.add(url);

    try {
      if (callback.kind === 'error') throw new Error(callback.message);

      const { error } = await supabase.auth.exchangeCodeForSession(callback.code);
      if (error) throw error;
      reportNativeOAuthResult({ success: true });
    } catch (error) {
      console.error('[Native OAuth] Callback failed:', error);
      reportNativeOAuthResult({ success: false, message: nativeOAuthErrorMessage(error) });
    } finally {
      await Browser.close().catch(() => undefined);
    }
  };

  // Register first so a callback arriving during startup cannot fall into the
  // gap between checking the launch URL and attaching the live listener.
  const listener = await App.addListener('appUrlOpen', ({ url }) => handleUrl(url));
  const launch = await App.getLaunchUrl();
  if (launch?.url) await handleUrl(launch.url);

  return () => {
    processedUrls.clear();
    void listener.remove();
  };
}

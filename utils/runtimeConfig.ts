const DEFAULT_NATIVE_API_ORIGIN = 'https://alphatrade-mentor-15.vercel.app';

/** Build-time flag. Native bundles use local assets but remote serverless APIs. */
export const isNativeBuild = import.meta.env.VITE_NATIVE_BUILD === 'true';

/** Resolve a Vercel API path without changing browser/PWA same-origin behavior. */
export function apiUrl(path: string): string {
  if (!path.startsWith('/')) return path;
  if (!isNativeBuild) return path;

  const origin = (import.meta.env.VITE_API_ORIGIN || DEFAULT_NATIVE_API_ORIGIN).replace(/\/$/, '');
  return `${origin}${path}`;
}

/** Supabase allow-list must contain this exact callback for native OAuth. */
export function authRedirectUrl(): string {
  if (isNativeBuild) {
    return import.meta.env.VITE_NATIVE_AUTH_REDIRECT || 'alphatrade-native://auth/callback';
  }
  return window.location.origin;
}


import { createClient } from '@supabase/supabase-js';
import { isNativeBuild } from '../utils/runtimeConfig';
import { createNativeSecureAuthStorage } from './nativeSecureStorage';
import { perfDuration, perfSlug } from '../lib/perfTrace';

/** Jen nativní měření: doba každého Supabase požadavku podle tabulky / RPC. */
const tracedFetch: typeof fetch = async (input, init) => {
    const startedAt = performance.now();
    try {
        return await fetch(input, init);
    } finally {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
        const name = path.startsWith('/rest/v1/rpc/') ? `sb-rpc-${path.slice(13)}`
            : path.startsWith('/rest/v1/') ? `sb-rest-${path.slice(9)}`
            : path.startsWith('/auth/v1/') ? `sb-auth-${path.slice(9)}`
            : path.startsWith('/storage/v1/') ? 'sb-storage'
            : 'sb-other';
        perfDuration(`net:${perfSlug(name)}:fetch`, performance.now() - startedAt);
    }
};

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
    console.error('CRITICAL ERROR: Supabase configuration is missing in the environment!');
}

// Safari-compatible storage adapter with fallback
const createSafariCompatibleStorage = () => {
    // Test if localStorage is available (Safari Private Mode blocks it)
    const testKey = '__storage_test__';
    try {
        localStorage.setItem(testKey, 'test');
        localStorage.removeItem(testKey);
        return localStorage; // localStorage works ✅
    } catch (e) {
        console.warn('[Safari Fix] localStorage blocked, using in-memory storage');

        // In-memory fallback for Safari private mode / blocked localStorage
        const memoryStorage: { [key: string]: string } = {};
        return {
            getItem: (key: string) => memoryStorage[key] || null,
            setItem: (key: string, value: string) => { memoryStorage[key] = value; },
            removeItem: (key: string) => { delete memoryStorage[key]; }
        } as Storage;
    }
};

export const supabase = createClient(
    supabaseUrl || 'https://placeholder.supabase.co',
    supabaseAnonKey || 'placeholder',
    {
        ...(isNativeBuild ? { global: { fetch: tracedFetch } } : {}),
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: !isNativeBuild,
            flowType: isNativeBuild ? 'pkce' : 'implicit',
            storageKey: 'alphatrade-auth-token',
            storage: isNativeBuild
                ? createNativeSecureAuthStorage(createSafariCompatibleStorage())
                : createSafariCompatibleStorage()
        }
    }
);


import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
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
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storageKey: 'alphatrade-auth-token',
            storage: createSafariCompatibleStorage()
        }
    }
);

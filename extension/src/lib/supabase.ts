import { createClient } from '@supabase/supabase-js';

// Chrome API global (extension context)
declare const chrome: any;

const SUPABASE_URL = "https://kopinlpdvjfgmvxydohk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzgxMzksImV4cCI6MjA4Mjk1NDEzOX0.qW_Gi9AkZSBAubuYsv3ITor8fGEqEl56d-oJcUtxW8M";

// Chrome Extension Storage Adapter (works in both content script and background)
const chromeStorageAdapter = {
    getItem: async (key: string) => {
        try {
            const result = await chrome.storage.local.get([key]);
            return result[key] || null;
        } catch (e) {
            console.error('[Extension] chrome.storage.local.get failed:', e);
            return null;
        }
    },
    setItem: async (key: string, value: string) => {
        try {
            await chrome.storage.local.set({ [key]: value });
        } catch (e) {
            console.error('[Extension] chrome.storage.local.set failed:', e);
        }
    },
    removeItem: async (key: string) => {
        try {
            await chrome.storage.local.remove([key]);
        } catch (e) {
            console.error('[Extension] chrome.storage.local.remove failed:', e);
        }
    }
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        storage: chromeStorageAdapter,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false
    }
});

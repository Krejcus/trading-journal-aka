import { useEffect, useState } from 'react';
import { createLocalPriceAlertStore, type PriceAlertStore } from '../lib/priceAlerts';
import { createServerPriceAlertStore } from './priceAlertServerStore';
import { supabase } from './supabase';

const localStorageOrNull = () => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

/**
 * Úložiště upozornění na cenu pro UI (2. 11. 2026): přihlášený uživatel = server (sdílené
 * PC ↔ telefon, hlídá Mac worker), jinak jen toto zařízení. Přihlášení/odhlášení store vymění.
 */
export function usePriceAlertStore(): PriceAlertStore {
  const [store, setStore] = useState<PriceAlertStore>(() => createLocalPriceAlertStore(localStorageOrNull()));
  useEffect(() => {
    let current: ReturnType<typeof createServerPriceAlertStore> | null = null;
    let owner: string | null = null;
    let disposed = false;
    const bind = (userId: string | null) => {
      if (disposed || userId === owner) return;
      owner = userId;
      current?.dispose();
      current = userId ? createServerPriceAlertStore({ client: supabase, userId, storage: localStorageOrNull() }) : null;
      setStore(current ?? createLocalPriceAlertStore(localStorageOrNull()));
    };
    void supabase.auth.getSession().then(({ data }) => bind(data.session?.user.id ?? null)).catch(() => undefined);
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => bind(session?.user.id ?? null));
    // Realtime v pozadí (iOS) nic nedoručí: po návratu a každou minutu stav znovu načíst.
    const refresh = () => { if (document.visibilityState === 'visible') void current?.refresh(); };
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      subscription.unsubscribe();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      current?.dispose();
    };
  }, []);
  return store;
}

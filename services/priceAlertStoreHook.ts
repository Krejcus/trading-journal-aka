import { useEffect, useState } from 'react';
import { createLocalPriceAlertStore, type PriceAlertStore } from '../lib/priceAlerts';
import { createServerPriceAlertStore } from './priceAlertServerStore';
import { supabase } from './supabase';

const localStorageOrNull = () => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

/**
 * Úložiště upozornění na cenu pro UI (2. 11. 2026): přihlášený uživatel = server (sdílené
 * PC ↔ telefon, hlídá Mac worker), jinak jen toto zařízení. Jeden store na přihlášeného
 * uživatele po celou dobu běhu appky (ne na jedno otevření grafu): fronta změn se dál
 * odesílá i po odchodu z grafu a události se po návratu nepřehrají znovu.
 */
type ServerStore = ReturnType<typeof createServerPriceAlertStore>;
let shared: { userId: string; store: ServerStore } | null = null;
let local: PriceAlertStore | null = null;
let started = false;
const listeners = new Set<(store: PriceAlertStore) => void>();

const localStore = () => (local ??= createLocalPriceAlertStore(localStorageOrNull()));
const currentStore = (): PriceAlertStore => shared?.store ?? localStore();

function bind(userId: string | null): void {
  if ((shared?.userId ?? null) === userId) return;
  shared?.store.dispose();
  shared = userId ? { userId, store: createServerPriceAlertStore({ client: supabase, userId, storage: localStorageOrNull() }) } : null;
  const store = currentStore();
  listeners.forEach(listener => listener(store));
}

function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  void supabase.auth.getSession().then(({ data }) => bind(data.session?.user.id ?? null)).catch(() => undefined);
  supabase.auth.onAuthStateChange((_event, session) => bind(session?.user.id ?? null));
  // Realtime v pozadí (iOS) nic nedoručí: po návratu a každou minutu stav znovu načíst.
  const refresh = () => { if (document.visibilityState === 'visible') void shared?.store.refresh(); };
  window.setInterval(refresh, 60_000);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
}

export function usePriceAlertStore(): PriceAlertStore {
  const [store, setStore] = useState<PriceAlertStore>(currentStore);
  useEffect(() => {
    start();
    listeners.add(setStore);
    setStore(currentStore());
    return () => { listeners.delete(setStore); };
  }, []);
  return store;
}

import { useEffect, useRef, useState } from 'react';
import { createLocalPriceAlertStore, freshPriceAlertEvents, type PriceAlert, type PriceAlertStore } from '../lib/priceAlerts';
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

/**
 * „Zapnout znovu“ z notifikace: appka se právě otevřela, úložiště se teprve načítá, takže
 * počká, až upozornění dorazí ze serveru. Když mezitím nedorazí, nic se nestane.
 */
export function rearmPriceAlertFromNotification(alertId: string, timeoutMs = 8_000): Promise<boolean> {
  start();
  return new Promise(resolve => {
    const startedAt = Date.now();
    const attempt = () => {
      const store = shared?.store;
      const known = store?.getState().alerts.some(alert => alert.id === alertId);
      if (store && known) { resolve(store.rearm?.(alertId) === true); return; }
      if (Date.now() - startedAt >= timeoutMs) { resolve(false); return; }
      window.setTimeout(attempt, 250);
    };
    attempt();
  });
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

/** Spuštění pro kartu a hlas (úroveň uživatele, nikdy cena trhu). */
export interface PriceAlertFiredEvent { id: string; alertId: string; at: number; price: number }

/**
 * Nově příchozí a čerstvá spuštění (telefon i PC). První načtení a výměna úložiště
 * (přihlášení) = staré události, jen si je zapamatuje.
 */
export function useFreshPriceAlertEvents(
  store: PriceAlertStore,
  events: readonly PriceAlertFiredEvent[],
  onFresh: (event: PriceAlertFiredEvent, alert: PriceAlert | null) => void,
): void {
  const seen = useRef<{ store: unknown; ids: Set<string> } | null>(null);
  const onFreshRef = useRef(onFresh);
  onFreshRef.current = onFresh;
  useEffect(() => {
    const known = seen.current?.store === store ? seen.current.ids : null;
    const { seen: ids, fresh } = freshPriceAlertEvents(known, events, Date.now());
    seen.current = { store, ids };
    for (const event of fresh) {
      onFreshRef.current(event, store.getState().alerts.find(item => item.id === event.alertId) ?? null);
    }
  }, [store, events]);
}

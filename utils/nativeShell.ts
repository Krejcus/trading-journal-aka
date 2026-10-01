/**
 * Most mezi webovou aplikací a nativním iOS shellem.
 *
 * Nativní `TabView` nahrazuje webovou `BottomNav`, takže shell potřebuje
 * způsob, jak přepnout sekci bez reloadu. Shell si sám přidá `?native=1`
 * a po načtení volá `window.__alphaTradeNative`.
 */

import { isNativeBuild } from './runtimeConfig';
import { alphaTradeNativePlugin } from '../services/alphaTradeNativePlugin';
import {
  normalizeNativeShellTabSlots,
  readStoredNativeShellTabSlots,
  writeStoredNativeShellTabSlots,
} from '../lib/nativeShellTabs';

/** Otevření hodnocení z nativní lišty, notifikace nebo zkratky. */
export interface NativeReviewRequest {
  /** Konkrétní obchod (např. z notifikace o zavřeném obchodu). */
  tradeId?: string;
  /** Poznámka napsaná přímo v notifikaci — předvyplní se do hodnocení. */
  note?: string;
}

export interface NativeShellBridge {
  navigate: (page: string) => void;
  review: (request?: NativeReviewRequest) => void;
  toggleWorld: () => void;
  refresh: () => void;
}

declare global {
  interface Window {
    __alphaTradeNative?: NativeShellBridge;
    __alphaTradePendingRoute?: string;
    __alphaTradePendingReview?: NativeReviewRequest;
  }
}

/** Běží aplikace uvnitř nativního shellu? */
export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  return isNativeBuild || new URLSearchParams(window.location.search).get('native') === '1';
}

/**
 * Ohlásí aktivní téma nativnímu shellu, aby tab bar nesvítil proti obsahu.
 * Mimo shell je to no-op.
 */
export function reportNativeShellTheme(theme: string): void {
  if (!isNativeShell()) return;
  void alphaTradeNativePlugin.setShellTheme({ theme }).catch(error => {
    console.warn('[Native shell] Theme sync failed:', error instanceof Error ? error.message : error);
  });
}

export function reportNativeRefreshComplete(success: boolean): void {
  if (!isNativeShell()) return;
  void alphaTradeNativePlugin.reportRefreshComplete({ success }).catch(error => {
    console.warn('[Native shell] Refresh completion failed:', error instanceof Error ? error.message : error);
  });
}

/** Udržuje nativní menu Více ve stejném LIVE/BACKTEST světě jako React. */
export function reportNativeShellWorld(world: 'live' | 'backtest'): void {
  if (!isNativeShell()) return;
  void alphaTradeNativePlugin.setShellWorld({ world }).catch(error => {
    console.warn('[Native shell] World sync failed:', error instanceof Error ? error.message : error);
  });
}

/**
 * Ohlásí aktivní stránku, aby nativní lišta zvýraznila skutečnou kartu (nebo
 * nic, když stránka žije jen v menu Více). Mimo shell je to no-op.
 */
export function reportNativeShellPage(page: string): void {
  if (!isNativeShell()) return;
  void alphaTradeNativePlugin.setShellPage({ page }).catch(error => {
    console.warn('[Native shell] Page sync failed:', error instanceof Error ? error.message : error);
  });
}

/**
 * Ohlásí, jestli je otevřené hodnocení: nativní lišta pak drží výběr na
 * Hodnotit a po zavření ho vrátí na stránku. Mimo shell je to no-op.
 */
export function reportNativeShellReview(open: boolean): void {
  if (!isNativeShell()) return;
  void alphaTradeNativePlugin.setShellReview({ open }).catch(error => {
    console.warn('[Native shell] Review sync failed:', error instanceof Error ? error.message : error);
  });
}

/** Počet obchodů k hodnocení — odznak na kartě Hodnotit. */
export function reportNativeShellReviewCount(count: number): void {
  if (!isNativeShell()) return;
  void alphaTradeNativePlugin.setShellReviewCount({ count: Math.max(0, Math.floor(count)) }).catch(error => {
    console.warn('[Native shell] Review count sync failed:', error instanceof Error ? error.message : error);
  });
}

/**
 * Načte volbu tří karet spodního menu. Autoritou je nativní UserDefaults;
 * když plugin není dostupný (web s `?native=1`), použije se lokální kopie.
 */
export async function loadNativeShellTabs(): Promise<string[]> {
  if (!isNativeShell()) return readStoredNativeShellTabSlots();
  try {
    const result = await alphaTradeNativePlugin.getShellTabs();
    const slots = normalizeNativeShellTabSlots(result?.slots);
    writeStoredNativeShellTabSlots(slots);
    return slots;
  } catch {
    return readStoredNativeShellTabSlots();
  }
}

/**
 * Uloží volbu karet do nativního shellu (lišta se přestaví okamžitě) i do
 * lokální kopie. Neplatný výběr se normalizuje na výchozí trojici.
 */
export async function saveNativeShellTabs(slots: readonly string[]): Promise<string[]> {
  const normalized = normalizeNativeShellTabSlots(slots);
  writeStoredNativeShellTabSlots(normalized);
  if (isNativeShell()) {
    await alphaTradeNativePlugin.setShellTabs({ slots: normalized });
  }
  return normalized;
}

/**
 * Zpřístupní navigaci nativnímu shellu. Vrací cleanup pro `useEffect`.
 * Mimo shell je to no-op, takže běžný web zůstává nedotčený.
 */
export function registerNativeShellBridge(bridge: NativeShellBridge): () => void {
  if (!isNativeShell()) return () => {};
  window.__alphaTradeNative = bridge;
  const pendingRoute = window.__alphaTradePendingRoute;
  if (pendingRoute) {
    delete window.__alphaTradePendingRoute;
    const pendingReview = window.__alphaTradePendingReview;
    delete window.__alphaTradePendingReview;
    window.setTimeout(() => {
      // `capture` je stará cesta (widgety a zkratky z doby ručního zápisu).
      if (pendingRoute === 'review' || pendingRoute === 'capture') bridge.review(pendingReview);
      else bridge.navigate(pendingRoute);
    }, 0);
  }
  return () => {
    if (window.__alphaTradeNative === bridge) delete window.__alphaTradeNative;
  };
}

export function navigateNativeShell(route: string): void {
  if (!isNativeShell()) return;
  if (window.__alphaTradeNative) {
    window.__alphaTradeNative.navigate(route);
  } else {
    window.__alphaTradePendingRoute = route;
  }
}

export function openNativeReview(request?: NativeReviewRequest): void {
  if (!isNativeShell()) return;
  if (window.__alphaTradeNative) {
    window.__alphaTradeNative.review(request);
  } else {
    window.__alphaTradePendingRoute = 'review';
    if (request) window.__alphaTradePendingReview = request;
  }
}

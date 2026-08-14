/**
 * Most mezi webovou aplikací a nativním iOS shellem.
 *
 * Nativní `TabView` nahrazuje webovou `BottomNav`, takže shell potřebuje
 * způsob, jak přepnout sekci bez reloadu. Shell si sám přidá `?native=1`
 * a po načtení volá `window.__alphaTradeNative`.
 */

import { isNativeBuild } from './runtimeConfig';
import type { NativeTradeDraft } from '../services/nativeCapabilities';
import { alphaTradeNativePlugin } from '../services/alphaTradeNativePlugin';

export interface NativeShellBridge {
  navigate: (page: string) => void;
  addTrade: (draft?: NativeTradeDraft) => void;
  toggleWorld: () => void;
  refresh: () => void;
}

declare global {
  interface Window {
    __alphaTradeNative?: NativeShellBridge;
    __alphaTradePendingRoute?: string;
    __alphaTradePendingTradeDraft?: NativeTradeDraft;
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
 * Zpřístupní navigaci nativnímu shellu. Vrací cleanup pro `useEffect`.
 * Mimo shell je to no-op, takže běžný web zůstává nedotčený.
 */
export function registerNativeShellBridge(bridge: NativeShellBridge): () => void {
  if (!isNativeShell()) return () => {};
  window.__alphaTradeNative = bridge;
  const pendingRoute = window.__alphaTradePendingRoute;
  if (pendingRoute) {
    delete window.__alphaTradePendingRoute;
    const pendingDraft = window.__alphaTradePendingTradeDraft;
    delete window.__alphaTradePendingTradeDraft;
    window.setTimeout(() => {
      if (pendingRoute === 'capture') bridge.addTrade(pendingDraft);
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

export function openNativeTradeCapture(draft?: NativeTradeDraft): void {
  if (!isNativeShell()) return;
  if (window.__alphaTradeNative) {
    window.__alphaTradeNative.addTrade(draft);
  } else {
    window.__alphaTradePendingRoute = 'capture';
    if (draft) window.__alphaTradePendingTradeDraft = draft;
  }
}

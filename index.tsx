import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { registerSW } from 'virtual:pwa-register';
import { UpdateBanner } from './components/UpdateBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { isNativeBuild } from './utils/runtimeConfig';
import { registerNativeOAuthCallback } from './services/nativeOAuth';
import { registerNativeNotificationActions } from './services/nativeNotifications';
import NativePrivacyGate from './components/NativePrivacyGate';

// iOS PWA (přidáno na plochu) detekce — `@media (display-mode: standalone)` je na
// iOS nespolehlivá, proto přidáme třídu i přes navigator.standalone (legacy iOS API).
// CSS pak vypne rozbitý backdrop-filter podle `.pwa-standalone`.
if (
  (window.navigator as any).standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches
) {
  document.documentElement.classList.add('pwa-standalone');
}

if (isNativeBuild) {
  // Full-bleed native canvas: fullscreen overlays may paint behind the iOS
  // status bar, while App applies safe-area padding to ordinary content.
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport && !viewport.content.includes('viewport-fit=cover')) {
    viewport.content = `${viewport.content}, viewport-fit=cover`;
  }
  document.documentElement.classList.add('native-shell');
  void registerNativeOAuthCallback().catch(error => {
    console.error('[Native bootstrap] OAuth callback registration failed:', error);
  });
  void registerNativeNotificationActions().catch(error => {
    console.error('[Native bootstrap] Notification action registration failed:', error);
  });
}

// Liquid-glass LUPA (backdrop-filter: url(#svg displacement)) funguje JEN v Chromiu —
// Safari i Firefox to nerenderují (WebKit bug #245510), navíc @supports test obelstí
// (přes -webkit- projde, ale nevykreslí → placatý header). navigator.userAgentData
// existuje pouze v Chromiu → spolehlivý proxy. Bez něj zůstane blur frosted fallback.
if ((navigator as any).userAgentData?.brands?.some((b: any) => /Chromium/i.test(b.brand))) {
  document.documentElement.classList.add('backdrop-svg-ok');
}

// State for update banner
let showUpdateBanner = false;
let updateSWCallback: ((reloadPage?: boolean) => Promise<void>) | null = null;
let forceUpdate = false;

// Register Service Worker for PWA offline support — JEN V PRODUKCI.
// V dev (vč. testu PWA na ploše přes LAN) SW jen kešuje a brání aktualizacím,
// takže ho nejen neregistrujeme, ale i odregistrujeme případný starý + smažeme cache.
let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;
if (import.meta.env.PROD && !isNativeBuild) {
  updateSW = registerSW({
    onNeedRefresh() {
      console.log('[PWA] New version available!');
      alert("K dispozici je nová verze aplikace. Aktualizuji...");
      updateSW?.(true);
    },
    onOfflineReady() {
      console.log('[PWA] App ready to work offline!');
    },
    onRegisteredSW(swUrl, registration) {
      console.log('[PWA] Service Worker registered:', swUrl);
      if (registration) {
        registration.update();
      }
    }
  });
} else if (!isNativeBuild) {
  // DEV: zabít existující service worker + vyčistit cache → PWA na ploše vždy svěží kód.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister());
    });
  }
  if ('caches' in window) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  }
}

const handleUpdate = () => {
  if (updateSWCallback) {
    updateSWCallback(true); // Reload page after update
  }
};

const handleDismiss = () => {
  showUpdateBanner = false;
  renderApp();
};

const renderApp = () => {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error("Could not find root element to mount to");
  }

  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary name="AppRoot">
        <UpdateBanner
          show={showUpdateBanner}
          onUpdate={handleUpdate}
          onDismiss={forceUpdate ? undefined : handleDismiss}
          forceUpdate={forceUpdate}
        />
        <App />
        <NativePrivacyGate />
      </ErrorBoundary>
    </React.StrictMode>
  );
};

// Initial render
renderApp();

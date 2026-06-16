import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { registerSW } from 'virtual:pwa-register';
import { UpdateBanner } from './components/UpdateBanner';
import { ErrorBoundary } from './components/ErrorBoundary';

// iOS PWA (přidáno na plochu) detekce — `@media (display-mode: standalone)` je na
// iOS nespolehlivá, proto přidáme třídu i přes navigator.standalone (legacy iOS API).
// CSS pak vypne rozbitý backdrop-filter podle `.pwa-standalone`.
if (
  (window.navigator as any).standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches
) {
  document.documentElement.classList.add('pwa-standalone');
}

// State for update banner
let showUpdateBanner = false;
let updateSWCallback: ((reloadPage?: boolean) => Promise<void>) | null = null;
let forceUpdate = false;

// Register Service Worker for PWA offline support — JEN V PRODUKCI.
// V dev (vč. testu PWA na ploše přes LAN) SW jen kešuje a brání aktualizacím,
// takže ho nejen neregistrujeme, ale i odregistrujeme případný starý + smažeme cache.
let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;
if (import.meta.env.PROD) {
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
} else {
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
      </ErrorBoundary>
    </React.StrictMode>
  );
};

// Initial render
renderApp();
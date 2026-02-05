import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { registerSW } from 'virtual:pwa-register';
import { UpdateBanner } from './components/UpdateBanner';
import { ErrorBoundary } from './components/ErrorBoundary';

// State for update banner
let showUpdateBanner = false;
let updateSWCallback: ((reloadPage?: boolean) => Promise<void>) | null = null;
let forceUpdate = false;

// Register Service Worker for PWA offline support
const updateSW = registerSW({
  onNeedRefresh() {
    console.log('[PWA] New version available!');
    alert("K dispozici je nová verze aplikace. Aktualizuji...");
    updateSW(true);
  },
  onOfflineReady() {
    console.log('[PWA] App ready to work offline!');
  },
  onRegisteredSW(swUrl, registration) {
    console.log('[PWA] Service Worker registered:', swUrl);
    if (registration) {
      // Force update if it's waiting
      registration.update();
    }
  }
});

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
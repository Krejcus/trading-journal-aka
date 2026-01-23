import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { registerSW } from 'virtual:pwa-register';
import { UpdateBanner } from './components/UpdateBanner';

// State for update banner
let showUpdateBanner = false;
let updateSWCallback: ((reloadPage?: boolean) => Promise<void>) | null = null;
let forceUpdate = false;

// Register Service Worker for PWA offline support
const updateSW = registerSW({
  onNeedRefresh() {
    console.log('[PWA] New version available!');

    // Check if force update is required (you can set this flag when deploying critical updates)
    // For now, we'll use soft update by default
    forceUpdate = false;

    showUpdateBanner = true;
    updateSWCallback = updateSW;

    // Trigger re-render
    renderApp();
  },
  onOfflineReady() {
    console.log('[PWA] App ready to work offline!');
  },
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
      <UpdateBanner
        show={showUpdateBanner}
        onUpdate={handleUpdate}
        onDismiss={forceUpdate ? undefined : handleDismiss}
        forceUpdate={forceUpdate}
      />
      <App />
    </React.StrictMode>
  );
};

// Initial render
renderApp();
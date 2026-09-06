import React, { useEffect, useState } from 'react';
import { App } from '@capacitor/app';
import { LockKeyhole } from 'lucide-react';
import { authenticateNativePrivacy, getNativePrivacyState } from '../services/nativeCapabilities';
import { createNativePrivacyController } from '../services/nativePrivacyController';
import { isNativeBuild } from '../utils/runtimeConfig';

export default function NativePrivacyGate() {
  const [controller] = useState(() => createNativePrivacyController({
    read: getNativePrivacyState, authenticate: authenticateNativePrivacy,
  }));
  const [state, setState] = useState(controller.state);
  useEffect(() => {
    if (!isNativeBuild) return;
    const unsubscribe = controller.subscribe(setState);
    const refresh = () => { void controller.refresh(); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    refresh();
    const listener = App.addListener('appStateChange', ({ isActive }) => { if (isActive) refresh(); });
    window.addEventListener('alphatrade:privacy-changed', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      unsubscribe();
      void listener.then(handle => handle.remove()).catch(() => undefined);
      window.removeEventListener('alphatrade:privacy-changed', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [controller]);
  if (!isNativeBuild || !state.locked) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="privacy-title" className="fixed inset-0 z-[10000] grid place-items-center bg-slate-950/95 px-6 text-center backdrop-blur-3xl">
      <div className="max-w-sm">
        <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-[28px] border border-blue-400/30 bg-blue-500/15 text-blue-400">
          <LockKeyhole size={36} />
        </div>
        <h1 id="privacy-title" className="text-xl font-black text-white">AlphaTrade je uzamčený</h1>
        <p className="mt-2 text-sm font-semibold text-slate-400">Finanční data jsou skrytá, dokud se neověří vlastník zařízení.</p>
        {state.error && <p role="status" className="mt-3 text-sm text-amber-300">Ověření se nepodařilo. Zkus ho zopakovat.</p>}
        <button type="button" disabled={state.busy} onClick={() => void controller.unlock()}
          className="mt-7 w-full rounded-2xl bg-blue-600 px-5 py-4 text-xs font-black uppercase tracking-widest text-white disabled:opacity-50">
          {state.busy ? 'Ověřuji…' : 'Odemknout přes Face ID nebo kód'}
        </button>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LockKeyhole } from 'lucide-react';

import { authenticateNativePrivacy, getNativePrivacyEnabled } from '../services/nativeCapabilities';
import { isNativeBuild } from '../utils/runtimeConfig';

export default function NativePrivacyGate() {
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const autoAttemptedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!isNativeBuild) return;
    const enabled = await getNativePrivacyEnabled().catch(() => false);
    setLocked(enabled);
  }, []);

  useEffect(() => {
    if (!isNativeBuild) return;
    void refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('alphatrade:privacy-changed', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('alphatrade:privacy-changed', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  useEffect(() => {
    if (!locked) {
      autoAttemptedRef.current = false;
      return;
    }
    if (busy || autoAttemptedRef.current) return;
    autoAttemptedRef.current = true;
    setBusy(true);
    void authenticateNativePrivacy()
      .then(success => { if (success) setLocked(false); })
      .finally(() => setBusy(false));
  }, [locked, busy]);

  if (!isNativeBuild || !locked) return null;

  return (
    <div className="fixed inset-0 z-[10000] grid place-items-center bg-slate-950/95 px-6 text-center backdrop-blur-3xl">
      <div className="max-w-sm">
        <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-[28px] border border-blue-400/30 bg-blue-500/15 text-blue-400 shadow-2xl shadow-blue-500/20">
          <LockKeyhole size={36} />
        </div>
        <h1 className="text-xl font-black text-white">AlphaTrade je uzamčený</h1>
        <p className="mt-2 text-sm font-semibold text-slate-400">Finanční data jsou skrytá, dokud se neověří vlastník zařízení.</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void authenticateNativePrivacy()
              .then(success => { if (success) setLocked(false); })
              .finally(() => setBusy(false));
          }}
          className="mt-7 w-full rounded-2xl bg-blue-600 px-5 py-4 text-xs font-black uppercase tracking-widest text-white disabled:opacity-50"
        >
          {busy ? 'Ověřuji…' : 'Odemknout přes Face ID'}
        </button>
      </div>
    </div>
  );
}

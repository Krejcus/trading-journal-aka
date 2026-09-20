import { useEffect, useState } from 'react';
import { COPIER_POWER_WARNING_DELAY_MS, readCopierPowerDisplay, writeCopierPowerDisplay } from '../lib/copierPowerDisplay';

/** Retention affects the label only; callers keep their real pending/action gates. */
export function useCopierPowerDisplay(key: string, connected: boolean, pending: boolean) {
  const [last, setLast] = useState(() => ({ key, connected: readCopierPowerDisplay(key)?.connected ?? null }));
  const [warningKey, setWarningKey] = useState<string | null>(null);
  const retained = last.key === key ? last.connected : readCopierPowerDisplay(key)?.connected ?? null;
  useEffect(() => {
    if (pending) {
      setLast(previous => previous.key === key ? previous : { key, connected: readCopierPowerDisplay(key)?.connected ?? null });
      return;
    }
    setLast({ key, connected });
    writeCopierPowerDisplay(key, connected);
  }, [key, connected, pending]);
  useEffect(() => {
    setWarningKey(null);
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resume = () => {
      clearTimeout(timer);
      setWarningKey(null);
      if (document.visibilityState !== 'hidden') {
        timer = setTimeout(() => setWarningKey(key), COPIER_POWER_WARNING_DELAY_MS);
      }
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
  }, [key, pending]);
  return { connected: pending ? retained : connected, warning: pending && warningKey === key };
}

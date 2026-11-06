import { useEffect, useRef, useState } from 'react';
import { isAppForeground, subscribeAppForeground } from '../lib/appForeground';
import { LIVE_RESUME_IDLE, LIVE_RESUME_MAX_MS, liveResumeOnForeground, liveResumeOnTick } from '../lib/liveResumeState';

/**
 * `true` od návratu z pozadí do první nové živé ceny (nejvýš `LIVE_RESUME_MAX_MS`). Jen zobrazení.
 * `tickAt` = kdy naposledy přišla cena panelu (`useLiveTicketQuote`); kanál se tu nečte přímo.
 */
export function useLiveResumeState(enabled: boolean, tickAt: number | null): boolean {
  const [resuming, setResuming] = useState(false);
  const stateRef = useRef(LIVE_RESUME_IDLE);
  const tickAtRef = useRef(tickAt);
  tickAtRef.current = tickAt;
  const apply = (next: typeof LIVE_RESUME_IDLE) => {
    stateRef.current = next;
    setResuming(next.resuming !== null);
  };
  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (!isAppForeground()) stateRef.current = liveResumeOnForeground(LIVE_RESUME_IDLE, false, Date.now());
    const offForeground = subscribeAppForeground(foreground => {
      apply(liveResumeOnForeground(stateRef.current, foreground, Date.now()));
      if (timer) clearTimeout(timer);
      // Trh může mlčet: konec značky nesmí záviset na další ceně.
      if (foreground) timer = setTimeout(() => apply(liveResumeOnTick(stateRef.current, Date.now(), tickAtRef.current)), LIVE_RESUME_MAX_MS + 50);
    });
    return () => {
      offForeground();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
  useEffect(() => {
    if (enabled) apply(liveResumeOnTick(stateRef.current, Date.now(), tickAt));
  }, [enabled, tickAt]);
  return enabled && resuming;
}

import { useEffect, useRef, useState } from 'react';
import { isAppForeground, subscribeAppForeground } from '../lib/appForeground';
import { LIVE_NO_PRICE_NOTICE_MS, liveNoPriceNotice, LIVE_RESUME_IDLE, LIVE_RESUME_MAX_MS, liveResumeOnForeground, liveResumeOnTick } from '../lib/liveResumeState';
import { cmeFuturesSessionOpen } from '../lib/cmeSession';
import { perfDuration } from '../lib/perfTrace';

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
    // Značka běžela už před zapnutím (`enabled` mezitím spadlo): pojistka 10 s musí platit dál.
    if (stateRef.current.resuming) timer = setTimeout(() => apply(liveResumeOnTick(stateRef.current, Date.now(), tickAtRef.current)), LIVE_RESUME_MAX_MS + 50);
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
    if (!enabled) return;
    const before = stateRef.current.resuming;
    const next = liveResumeOnTick(stateRef.current, Date.now(), tickAt);
    // Měření návratu z pozadí na iPhonu (nativní build trasuje vždy): od popředí k první nové ceně.
    if (before && !next.resuming && tickAt != null) perfDuration('live:resume:first-tick', tickAt - before.since);
    apply(next);
  }, [enabled, tickAt]);
  return enabled && resuming;
}

/** Nápis bez živé ceny: vlastní časovač, protože ztichlý kanál nic nepřekreslí. Výstup je jen text. */
export function useLiveNoPriceNotice(enabled: boolean, tickAt: number | null, resuming: boolean): boolean {
  const [notice, setNotice] = useState(false);
  const lastRef = useRef(Date.now());
  if (tickAt != null && tickAt > lastRef.current) lastRef.current = tickAt;
  const resumingRef = useRef(resuming);
  resumingRef.current = resuming;
  useEffect(() => {
    if (!enabled) { setNotice(false); return undefined; }
    lastRef.current = Math.max(lastRef.current, Date.now());
    const timer = setInterval(() => {
      if (!isAppForeground()) { setNotice(false); return; }
      const now = Date.now();
      const stale = now - lastRef.current >= LIVE_NO_PRICE_NOTICE_MS;
      setNotice(stale && liveNoPriceNotice({ lastPriceAt: lastRef.current, now, resuming: resumingRef.current, sessionOpen: cmeFuturesSessionOpen(now) }));
    }, 1_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return enabled && notice && !resuming;
}

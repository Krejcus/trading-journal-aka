import { useEffect, useRef } from 'react';
import { supabase } from '../services/supabase';
import { COPIER_STATUS_NUDGE_MAX_PER_MINUTE, COPIER_STATUS_NUDGE_MIN_SPACING_MS } from '../lib/copierStatusNudge';

/**
 * Budíček statusu (docs/LIVE_HOT_PATH_PLAN.md §5): worker po změně u brokera pošle
 * prázdnou zprávu a LIVE si hned přečte status běžnou cestou (`onNudge` = kick pollu,
 * s fencemi INV-FRESH-02). Zpráva nenese data, neposouvá čerstvost ani nic
 * neautorizuje (INV-RELAY-04, INV-FRESH-03); nejvýš 1 čtení za 250 ms a 60 za minutu.
 * Bez podpisu: podvržená zpráva umí jen vyvolat čtení navíc v těchto mezích.
 */
export function useCopierStatusNudge(topic: string | null, onNudge: () => void, enabled: () => boolean = () => true): void {
  const onNudgeRef = useRef(onNudge);
  onNudgeRef.current = onNudge;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    if (!topic) return undefined;
    let lastAt = 0;
    let timer: number | null = null;
    const recent: number[] = [];
    const fire = () => {
      timer = null;
      const now = Date.now();
      lastAt = now;
      // Mimo graf se nečte ani nepočítá do stropu (oponentura 30. 10.).
      if (!enabledRef.current()) return;
      while (recent.length && now - recent[0] > 60_000) recent.shift();
      if (recent.length >= COPIER_STATUS_NUDGE_MAX_PER_MINUTE) return;
      recent.push(now);
      onNudgeRef.current();
    };
    const nudge = () => {
      if (timer != null) return;
      const wait = lastAt + COPIER_STATUS_NUDGE_MIN_SPACING_MS - Date.now();
      if (wait <= 0) fire();
      else timer = window.setTimeout(fire, wait);
    };
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase.channel(topic, { config: { broadcast: { self: false, ack: false } } });
      channel.on('broadcast', { event: 'status' }, nudge);
      channel.subscribe();
    } catch {
      // Jen zrychlení zobrazení; poll jede dál.
    }
    return () => {
      if (timer != null) window.clearTimeout(timer);
      if (channel) void supabase.removeChannel(channel).catch(() => undefined);
    };
  }, [topic]);
}

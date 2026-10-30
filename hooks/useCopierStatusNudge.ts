import { useEffect, useRef } from 'react';
import { supabase } from '../services/supabase';
import { COPIER_STATUS_NUDGE_MAX_PER_MINUTE, COPIER_STATUS_NUDGE_MIN_SPACING_MS } from '../lib/copierStatusNudge';
import {
  COPIER_LIVE_EXPOSURE_EVENT, decryptCopierLiveExposure, type CopierLiveExposurePayload,
} from '../lib/copierLiveExposure';
import { perfDuration, perfMark } from '../lib/perfTrace';

/**
 * Budíček statusu (docs/LIVE_HOT_PATH_PLAN.md §5): worker po změně u brokera pošle
 * prázdnou zprávu a LIVE si hned přečte status běžnou cestou (`onNudge` = kick pollu,
 * s fencemi INV-FRESH-02). Zpráva nenese data, neposouvá čerstvost ani nic
 * neautorizuje (INV-RELAY-04, INV-FRESH-03); nejvýš 1 čtení za 250 ms a 60 za minutu.
 * Bez podpisu: podvržená zpráva umí jen vyvolat čtení navíc v těchto mezích.
 *
 * Expozice (F2a, §10): událost `exposure` nese zašifrovaný výřez stavu workeru; dešifruje
 * se vždy jen nejnovější čekající zpráva a předá se `onExposure` (jen zobrazení grafu).
 * Kick pollu nevyvolá. Bez klíče nebo se zavřeným grafem se ignoruje.
 */
export function useCopierStatusNudge(
  topic: string | null,
  onNudge: () => void,
  enabled: () => boolean = () => true,
  exposure?: {
    key: string | null;
    onExposure: (payload: CopierLiveExposurePayload, receivedAt: number, receivedPerformanceAt: number) => void;
  },
): void {
  const onNudgeRef = useRef(onNudge);
  onNudgeRef.current = onNudge;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onExposureRef = useRef(exposure?.onExposure);
  onExposureRef.current = exposure?.onExposure;
  // Klíč v refu: změna klíče při stejném tématu nesmí znovu otevřít kanál (realtime-js by
  // vrátil odcházející instanci a odběr by umřel, oponentura 30. 10.).
  const keyRef = useRef(exposure?.key ?? null);
  keyRef.current = exposure?.key ?? null;
  useEffect(() => {
    if (!topic) return undefined;
    let active = true;
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
    // Jeden slot: během dešifrování se drží jen nejnovější další zpráva.
    let decrypting = false;
    let latest: { envelope: unknown; receivedAt: number; receivedPerformanceAt: number } | null = null;
    const drain = async () => {
      const key = keyRef.current;
      if (decrypting || !key) return;
      decrypting = true;
      try {
        while (active && latest) {
          const next = latest;
          latest = null;
          const decryptStartedAt = performance.now();
          const payload = await decryptCopierLiveExposure(next.envelope, key, topic);
          perfDuration('live:exposure:decrypt', performance.now() - decryptStartedAt);
          if (active && payload && enabledRef.current()) {
            onExposureRef.current?.(payload, next.receivedAt, next.receivedPerformanceAt);
          }
        }
      } finally {
        decrypting = false;
      }
    };
    const exposureMessage = (message: { payload?: unknown }) => {
      if (!keyRef.current || !enabledRef.current()) return;
      perfMark('live:exposure:received');
      latest = { envelope: message?.payload, receivedAt: Date.now(), receivedPerformanceAt: performance.now() };
      void drain();
    };
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase.channel(topic, { config: { broadcast: { self: false, ack: false } } });
      channel.on('broadcast', { event: 'status' }, nudge);
      channel.on('broadcast', { event: COPIER_LIVE_EXPOSURE_EVENT }, exposureMessage);
      channel.subscribe();
    } catch {
      // Jen zrychlení zobrazení; poll jede dál.
    }
    return () => {
      active = false;
      latest = null;
      if (timer != null) window.clearTimeout(timer);
      if (channel) void supabase.removeChannel(channel).catch(() => undefined);
    };
  }, [topic]);
}

import { useEffect, useState } from 'react';
import { loadTradovateCopierRelayStatus } from '../services/tradovateOAuthConnection';
import { isAppForeground, subscribeAppForeground } from '../lib/appForeground';
import {
  createDisplayWorkerStatusReader,
  EMPTY_DISPLAY_WORKER_STATUS,
  type DisplayWorkerStatus,
} from '../lib/displayWorkerStatusReader';

/**
 * Stav workeru pro zobrazení mimo LIVE (graf deníku): čtení relaye po 2 s,
 * jen v popředí. Nic odsud neovládá kopírku ani nepovoluje příkaz
 * (INV-UI-02) — LIVE má vlastní poller s fencí a ACK pro ovládání.
 */

export const DISPLAY_WORKER_STATUS_POLL_MS = 2_000;

export type { DisplayWorkerStatus };

export function useDisplayWorkerStatus(connectionIds: readonly string[], enabled: boolean): DisplayWorkerStatus {
  const [state, setState] = useState<DisplayWorkerStatus>(EMPTY_DISPLAY_WORKER_STATUS);

  const idsKey = connectionIds.join('|');
  useEffect(() => {
    setState(EMPTY_DISPLAY_WORKER_STATUS);
    const ids = idsKey ? idsKey.split('|') : [];
    if (!enabled || ids.length === 0) return;
    const reader = createDisplayWorkerStatusReader({
      ids,
      load: loadTradovateCopierRelayStatus,
      now: Date.now,
      isForeground: isAppForeground,
      publish: setState,
    });
    void reader.read();
    const timer = window.setInterval(() => { void reader.read(); }, DISPLAY_WORKER_STATUS_POLL_MS);
    const unsubscribe = subscribeAppForeground(reader.setForeground);
    return () => {
      reader.stop();
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [idsKey, enabled]);

  return state;
}

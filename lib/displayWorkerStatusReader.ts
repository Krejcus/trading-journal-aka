import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';
import { copierRelayObservedAt, type CopierRelayStatusEnvelope } from './copierRelayStatusPoll';
import { isCopierStatusFresh } from './copierForegroundPoller';
import { shouldAcceptCopierStatus } from './copierStatusPollFence';

/**
 * Čtečka stavu workeru pro zobrazení mimo LIVE (graf deníku): jen GET relaye,
 * nic neovládá ani nepovoluje (INV-UI-02). Přijme jen čerstvý status živého
 * workeru a revize nikdy nejde zpět; jinak publikuje prázdný stav (pozice
 * pak jen z REST). Kanál ceny z TV v odpovědi se ignoruje (INV-UI-04).
 */

export interface DisplayWorkerStatus {
  status: LocalCopierAgentStatus | null;
  observedAt: number | null;
}

export const EMPTY_DISPLAY_WORKER_STATUS: DisplayWorkerStatus = { status: null, observedAt: null };

export interface DisplayWorkerStatusReader {
  read: () => Promise<void>;
  /** Odchod do pozadí zahodí rozpracované čtení; návrat čte hned znovu. */
  setForeground: (foreground: boolean) => void;
  stop: () => void;
}

export function createDisplayWorkerStatusReader(deps: {
  ids: readonly string[];
  load: (connectionId: string) => Promise<CopierRelayStatusEnvelope<LocalCopierAgentStatus> | null>;
  now: () => number;
  isForeground: () => boolean;
  publish: (state: DisplayWorkerStatus) => void;
}): DisplayWorkerStatusReader {
  let stopped = false;
  let inFlight = false;
  let rereadAfter = false;
  let generation = 0;
  let accepted: LocalCopierAgentStatus | null = null;
  // Připojení, přes které naposled odpověděl živý worker. Uživatel může mít
  // víc připojení (leader a followeři na jiném loginu) a relay pro jiné
  // vrátí starý runtime odpojeného zařízení — ten se nepřijme.
  let live: string | null = null;

  const read = async () => {
    if (stopped || !deps.isForeground()) return;
    if (inFlight) return;
    inFlight = true;
    const started = generation;
    const current = () => !stopped && generation === started;
    try {
      const order = live ? [live, ...deps.ids.filter(id => id !== live)] : deps.ids;
      for (const id of order) {
        let remote: CopierRelayStatusEnvelope<LocalCopierAgentStatus> | null;
        try { remote = await deps.load(id); } catch { if (!current()) return; continue; }
        if (!current()) return;
        const receivedAt = deps.now();
        const observedAt = remote ? copierRelayObservedAt(remote, receivedAt) : null;
        if (!remote?.status || !remote.connected || !isCopierStatusFresh(observedAt, receivedAt, true)) continue;
        if (!shouldAcceptCopierStatus(remote.status, accepted)) continue;
        live = id;
        accepted = remote.status;
        deps.publish({ status: remote.status, observedAt });
        return;
      }
      live = null;
      deps.publish(EMPTY_DISPLAY_WORKER_STATUS);
    } finally {
      inFlight = false;
      if (rereadAfter && !stopped) {
        rereadAfter = false;
        void read();
      }
    }
  };

  return {
    read,
    setForeground: foreground => {
      if (stopped) return;
      generation += 1;
      if (!foreground) {
        rereadAfter = false;
        deps.publish(EMPTY_DISPLAY_WORKER_STATUS);
        return;
      }
      if (inFlight) rereadAfter = true;
      else void read();
    },
    stop: () => {
      stopped = true;
      generation += 1;
    },
  };
}

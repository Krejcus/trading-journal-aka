import { isFreshFillTime } from './liveFillAnnouncer';

export type LiveExitAlertKind = 'sl' | 'tp';

export interface LiveExitAlertEvent {
  id: string;
  kind: string;
  at: number;
  exitReason?: 'sl' | 'tp' | 'manual';
}

export interface LiveExitAlertDetector {
  step(input: { now: number; active: boolean; events: readonly LiveExitAlertEvent[] | null | undefined }): LiveExitAlertKind | null;
}

const SEEN_MAX = 500;

/**
 * Zásah SL a TP z událostí workeru, tedy z plnění brokera, nikdy z ceny grafu.
 * Pozice může skončit dřív, než worker pozná ochrannou nohu: událost přijde jako
 * `manual` a stejné id se později opraví na SL/TP, proto se `manual` ještě sleduje.
 * První seznam a vše z doby vypnutí se jen zapamatuje, starší než 30 s mlčí.
 */
export function createLiveExitAlertDetector(): LiveExitAlertDetector {
  const seen = new Map<string, 'done' | 'waiting'>();
  let ready = false;
  const remember = (id: string, state: 'done' | 'waiting') => {
    seen.set(id, state);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
  };
  return {
    step({ now, active, events }) {
      if (!events) { ready = false; return null; }
      const silent = !active || !ready;
      let fired: { kind: LiveExitAlertKind; at: number } | null = null;
      for (const event of events) {
        if (event.kind !== 'exit' && event.kind !== 'flip') continue;
        const state = seen.get(event.id);
        if (state === 'done') continue;
        const reason = event.exitReason === 'sl' || event.exitReason === 'tp' ? event.exitReason : null;
        if (!reason) {
          remember(event.id, silent ? 'done' : 'waiting');
          continue;
        }
        remember(event.id, 'done');
        if (!silent && isFreshFillTime(event.at, now) && (!fired || event.at > fired.at)) fired = { kind: reason, at: event.at };
      }
      ready = active;
      return fired?.kind ?? null;
    },
  };
}

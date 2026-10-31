/**
 * Kdy graf backtestu požádá o starší historii. Dotaz spouští jen uživatel
 * (posun, kolečko, klik do grafu), nikdy programový pohyb záběru (start
 * replaye, obnova záběru po dotažení) — jinak by se historie stahovala sama
 * v kaskádě.
 */

/** Od kolika barů od levého okraje se historie dotahuje (rezerva na latenci). */
export const OLDER_HISTORY_LEFT_EDGE_BARS = 160;

export interface OlderHistoryGate {
  /** Uživatel od posledního dotazu sáhl na graf. */
  armed: boolean;
  /** První svíčka, pro kterou už dotaz odešel a ještě nedoběhl. */
  requestedBefore: number | null;
}

export const createOlderHistoryGate = (): OlderHistoryGate => ({ armed: false, requestedBefore: null });

/** Gesto uživatele v grafu. */
export function armOlderHistory(gate: OlderHistoryGate, _firstTime: number | undefined): void {
  // A pan during an outstanding read changes the view; it must not queue a
  // second page when the first prepend restores its temporary logical range.
  if (gate.requestedBefore !== null) return;
  gate.armed = true;
}

export function olderHistoryDue(gate: OlderHistoryGate, input: {
  fromLogical: number;
  windowStart: number;
  hasLoader: boolean;
  loading: boolean;
  firstTime: number | undefined;
}): boolean {
  return gate.armed
    && input.fromLogical < OLDER_HISTORY_LEFT_EDGE_BARS
    && input.windowStart === 0
    && input.hasLoader
    && !input.loading
    && input.firstTime !== undefined
    && input.firstTime !== gate.requestedBefore;
}

export function markOlderHistoryRequested(gate: OlderHistoryGate, firstTime: number): void {
  gate.armed = false;
  gate.requestedBefore = firstTime;
}

/**
 * Dotaz doběhl — s daty, bez nich i chybou. Další gesto smí žádat znovu:
 * dotaz, který první svíčku nezměnil (chyba, kus session uvnitř stejného
 * denního baru), by jinak historii zablokoval až do přestavění grafu.
 */
export function settleOlderHistory(gate: OlderHistoryGate): void {
  gate.armed = false;
  gate.requestedBefore = null;
}

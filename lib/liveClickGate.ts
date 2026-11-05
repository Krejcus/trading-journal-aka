/**
 * Jedno kliknutí = jeden příkaz (Filip 5. 11. 2026: žádné „Opravdu?“ v LIVE obchodování, „jsem
 * zvyklý z TradingView, že se nedoptává“). První klik odesílá hned. Zůstávají tři pojistky:
 * - sdílený zámek jednoho příkazu drží volající (běžící příkaz nic dalšího nepustí);
 * - dvojklik: týž klíč do 400 ms od předchozího kliku se spolkne, i když první příkaz už doběhl;
 *   bušení do tlačítka kotvu posouvá, další příkaz chce pauzu;
 * - změna nabídky: tlačítko, které do 1 s dostalo jiný význam (čekající vstup se vyplnil, holá
 *   pozice dostala SL/TP, změnil se počet), klik spolkne, ať neodejde jiná akce než viděná.
 * Nic tady neodesílá, brány při kliku řeší volající a worker vše ověří znovu (INV-UI-01).
 */

export const LIVE_DOUBLE_CLICK_MS = 400;
export const LIVE_ACTION_CHANGE_SWALLOW_MS = 1_000;

export interface LiveClickState { key: string; at: number }

/** Dvojklik: `send: false` pro týž klíč do `LIVE_DOUBLE_CLICK_MS` od předchozího kliku. */
export function liveRepeatClick(state: LiveClickState | null, key: string, now: number): { send: boolean; next: LiveClickState } {
  const elapsed = state && state.key === key ? now - state.at : Number.POSITIVE_INFINITY;
  return { send: !(elapsed >= 0 && elapsed < LIVE_DOUBLE_CLICK_MS), next: { key, at: now } };
}

/** Cíl kliku: klíč = akce + id cíle (+ tvar), `enabled` = teď smí (jinak `reason`). */
export interface LiveClickTarget {
  key: string;
  enabled: boolean;
  reason?: string | null;
}

export type LiveClickStep =
  /** Cíl už není (nabídka zmizela). */
  | { kind: 'missing' }
  /** Cíl je zablokovaný. */
  | { kind: 'blocked'; reason: string | null }
  /** Jiný příkaz letí pod sdíleným zámkem. */
  | { kind: 'busy' }
  /** Nabídka změnila význam do 1 s před klikem. */
  | { kind: 'changed' }
  /** Druhý klik dvojkliku. */
  | { kind: 'repeat' }
  /** Volající smí poslat právě jeden příkaz. */
  | { kind: 'send' };

export interface LiveClickGate {
  click: (target: LiveClickTarget | null | undefined, options?: { busy?: boolean }) => LiveClickStep;
  /** Cíle, které jsou teď vidět. První volání je jen výchozí stav, další změna klíče spustí 1 s. */
  sync: (targets: ReadonlyArray<LiveClickTarget | null | undefined>) => void;
}

export function createLiveClickGate(deps: { now?: () => number } = {}): LiveClickGate {
  const now = deps.now ?? Date.now;
  let last: LiveClickState | null = null;
  let shown: string | null = null;
  let changedAt = Number.NEGATIVE_INFINITY;
  return {
    click: (target, options) => {
      if (!target || !target.key) return { kind: 'missing' };
      if (!target.enabled) return { kind: 'blocked', reason: target.reason ?? null };
      if (options?.busy) return { kind: 'busy' };
      const at = now();
      if (at - changedAt < LIVE_ACTION_CHANGE_SWALLOW_MS) return { kind: 'changed' };
      const step = liveRepeatClick(last, target.key, at);
      last = step.next;
      return step.send ? { kind: 'send' } : { kind: 'repeat' };
    },
    sync: targets => {
      const next = targets.map(target => target?.key ?? '-').join('|');
      if (shown != null && next !== shown) changedAt = now();
      shown = next;
    },
  };
}

/** Text, když klik spolkla právě změněná nabídka. */
export const LIVE_ACTION_CHANGED_TEXT = 'Nabídka se právě změnila — zkontroluj ji a klikni znovu. Nic se neodeslalo.';

export type LiveMoveLeg = 'stopLoss' | 'takeProfit';
export const liveMoveKey = (leg: LiveMoveLeg, price: number): string => `${leg}:${price}`;

/**
 * Klik „Posunout → X“: odejde jen cena z tlačítka. Průměr se změnil pollem a záměr při kliku vyšel
 * jinak, nebo se cena změnila do 1 s před klikem = `changed`, nic neodejde.
 */
export function liveMoveClick(gate: LiveClickGate, leg: LiveMoveLeg, shownPrice: number | null | undefined, price: number): LiveClickStep {
  if (shownPrice !== price) return { kind: 'changed' };
  return gate.click({ key: liveMoveKey(leg, price), enabled: true });
}

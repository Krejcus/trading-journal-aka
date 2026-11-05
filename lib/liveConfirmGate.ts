/**
 * Dvoukrok destruktivních tlačítek C7/C8 (4. 11. 2026, oponentura UI kolo 1) jako čistý
 * stavový automat bez Reactu: × holé pozice v panelu PC, „Zavřít“ / Flatten v telefonní
 * liště pozice, „Zrušit čekající“ (PC lišta, telefon) i Dashboard „Zrušit“.
 *
 * Jediné pravidlo kroku je `liveConfirmClick` (2. klik se STEJNÝM klíčem 350 ms – 4 s od
 * PŘEDCHOZÍHO kliku; rychlejší klik kotvu posune, trojklik nic nepotvrdí). Stav drží automat
 * synchronně (ne React stav), takže dva kliky v jednom snímku nic nepošlou. Navíc:
 * - neaktivní cíl (blokace) rozběhnuté „Opravdu?“ zahodí a nic se neodešle;
 * - `sync` zahodí rozběhnuté potvrzení i BEZ kliku, když cíl s tímto klíčem zmizel nebo se
 *   zablokoval (vzor `useLiveCancelPendingAction`; INV-UI-01, INV-FRESH-03);
 * - `busy` (jiný příkaz letí pod sdíleným zámkem) nic neodešle a potvrzení nemění.
 * Nic tady neodesílá — volající pošle příkaz jen při kroku `send` (a worker vše ověří znovu).
 */
import { LIVE_CONFIRM_WINDOW_MS, liveConfirmAsking, liveConfirmClick, type LiveConfirmState } from './liveBareEntry';

/** Cíl dvoukroku: klíč = akce + id cíle (+ tvar), `enabled` = teď smí (jinak `reason`). */
export interface LiveConfirmTarget {
  key: string;
  enabled: boolean;
  reason?: string | null;
}

export type LiveConfirmGateStep =
  /** Cíl už není (nabídka zmizela) — rozběhnuté potvrzení zahozeno, nic se neodešle. */
  | { kind: 'missing' }
  /** Cíl je zablokovaný — rozběhnuté potvrzení zahozeno, nic se neodešle. */
  | { kind: 'blocked'; reason: string | null }
  /** Jiný příkaz letí pod sdíleným zámkem — nic se neodešle, potvrzení beze změny. */
  | { kind: 'busy' }
  /** První klik, jiný klíč nebo příliš rychlý klik — ukáže / drží „Opravdu?“. */
  | { kind: 'asking' }
  /** Druhý klik se stejným klíčem v okně — volající smí poslat právě jeden příkaz. */
  | { kind: 'send' };

export interface LiveConfirmGate {
  current: () => LiveConfirmState | null;
  asking: (key: string) => boolean;
  click: (target: LiveConfirmTarget | null | undefined, options?: { busy?: boolean }) => LiveConfirmGateStep;
  /** Cíle, které jsou teď vidět; potvrzení bez aktivního cíle se stejným klíčem zmizí. */
  sync: (targets: ReadonlyArray<LiveConfirmTarget | null | undefined>) => void;
  /** Okno 4 s uplynulo (časovač) — „Opravdu?“ zmizí. */
  expire: () => void;
  clear: () => void;
}

export function createLiveConfirmGate(deps: {
  /** Překreslení (React stav); automat sám je zdroj pravdy. */
  onChange?: (state: LiveConfirmState | null) => void;
  now?: () => number;
} = {}): LiveConfirmGate {
  const now = deps.now ?? Date.now;
  let state: LiveConfirmState | null = null;
  const set = (next: LiveConfirmState | null) => {
    if (next === state) return;
    state = next;
    deps.onChange?.(next);
  };
  return {
    current: () => state,
    asking: key => liveConfirmAsking(state, key, now()),
    click: (target, options) => {
      if (!target || !target.key) { set(null); return { kind: 'missing' }; }
      if (!target.enabled) { set(null); return { kind: 'blocked', reason: target.reason ?? null }; }
      if (options?.busy) return { kind: 'busy' };
      const step = liveConfirmClick(state, target.key, now());
      set(step.next);
      return step.send ? { kind: 'send' } : { kind: 'asking' };
    },
    sync: targets => {
      if (!state) return;
      const key = state.key;
      if (!targets.some(target => target != null && target.enabled && target.key === key)) set(null);
    },
    expire: () => {
      if (state && now() >= state.at + LIVE_CONFIRM_WINDOW_MS) set(null);
    },
    clear: () => set(null),
  };
}

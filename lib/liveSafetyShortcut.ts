import type { LiveSafetyAction, LiveSafetyTarget } from './liveSafetyAction';

/**
 * Bezpečnostní zkratka LIVE (U1 Shift+F na PC, U6 „Flatten…“ z notifikace) —
 * jen požadavek OTEVŘÍT existující potvrzovací dialog statické nouzové lišty
 * (`components/LiveSafetyControls.tsx`). Nic neprovádí: příkaz vzniká dál jen
 * potvrzením v dialogu lišty, tedy `onAction` → `runStaticSafetyAction` desku
 * se stejným `target` a týmž zámkem skupiny (`createFlattenGroupCoordinator`,
 * INV-UI-02, INV-BRAKE-01). OFF i Kill switch zůstávají na liště; Kill switch
 * zkratkou otevřít nejde.
 *
 * Jen v paměti, bez fronty: bez posluchače se nestane nic (požadavek nečeká, aby
 * dialog později nevyskočil sám). Doručuje se jedinému příjemci — naposledy
 * přihlášené liště — aby z jedné zkratky nikdy nebyly dva dialogy.
 */

/** Co smí zkratka otevřít: dialog Flatten All skupiny, nebo dialog OFF. */
export type LiveSafetyShortcutAction = Extract<LiveSafetyAction, 'flatten-group' | 'disarm'>;
export type LiveSafetyShortcutSource = 'hotkey' | 'native-intent';

export interface LiveSafetyShortcutRequest {
  action: LiveSafetyShortcutAction;
  source: LiveSafetyShortcutSource;
  at: number;
}
export type LiveSafetyShortcutListener = (request: LiveSafetyShortcutRequest) => void;

export interface LiveSafetyShortcutBus {
  /** Lišta se přihlásí k odběru; vrací odhlášení (opakované volání nic nedělá). */
  subscribe: (listener: LiveSafetyShortcutListener) => () => void;
  /**
   * Požadavek otevřít dialog. `true` = převzala ho lišta (dialog ale otevře jen
   * podle `liveSafetyShortcutConfirmation`), `false` = nikdo neposlouchá nebo
   * neplatný požadavek — integrace ukáže hlášku, nic dalšího se nestane.
   */
  request: (action: LiveSafetyShortcutAction, source: LiveSafetyShortcutSource, at?: number) => boolean;
  listening: () => boolean;
}

/** Požadavek starší než 60 s se zahodí (stejná platnost jako záměr z notifikace, U6). */
export const LIVE_SAFETY_SHORTCUT_MAX_AGE_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;
const SHORTCUT_ACTIONS: ReadonlySet<string> = new Set<LiveSafetyShortcutAction>(['flatten-group', 'disarm']);
const SHORTCUT_SOURCES: ReadonlySet<string> = new Set<LiveSafetyShortcutSource>(['hotkey', 'native-intent']);
const LABELS: Record<LiveSafetyShortcutAction, string> = { 'flatten-group': 'Flatten All', disarm: 'OFF' };

export const isLiveSafetyShortcutAction = (value: unknown): value is LiveSafetyShortcutAction => (
  typeof value === 'string' && SHORTCUT_ACTIONS.has(value)
);

export function createLiveSafetyShortcutBus(): LiveSafetyShortcutBus {
  // Registrace jako objekty: tatáž funkce přihlášená dvakrát se odhlašuje zvlášť.
  const registrations: Array<{ listener: LiveSafetyShortcutListener }> = [];
  return {
    subscribe(listener) {
      const registration = { listener };
      registrations.push(registration);
      return () => {
        const index = registrations.indexOf(registration);
        if (index >= 0) registrations.splice(index, 1);
      };
    },
    request(action, source, at = Date.now()) {
      if (!isLiveSafetyShortcutAction(action) || typeof source !== 'string' || !SHORTCUT_SOURCES.has(source) || !Number.isFinite(at)) return false;
      const receiver = registrations.at(-1);
      if (!receiver) return false;
      try {
        receiver.listener({ action, source, at });
        return true;
      } catch {
        return false;
      }
    },
    listening: () => registrations.length > 0,
  };
}

const defaultBus = createLiveSafetyShortcutBus();
/** Odběr pro `LiveSafetyControls` (jediná statická lišta). */
export const subscribeLiveSafetyShortcut = defaultBus.subscribe;
/** Shift+F (U1) a akce notifikace (U6): jen otevřít dialog lišty. */
export const requestLiveSafetyConfirmation = defaultBus.request;
export const liveSafetyShortcutListening = defaultBus.listening;

/** Co lišta v okamžiku požadavku ví (její vlastní stav, nic odvozeného z grafu). */
export interface LiveSafetyShortcutView {
  /** Cíl lišty (`target` z props) — Flatten se otevře přesně s ním. */
  target: LiveSafetyTarget | null;
  /** Dialog lišty je otevřený: zkratka ho nikdy nepřepíše (potvrzení OFF nesmí změnit na Flatten). */
  confirmationOpen: boolean;
  /** Akce lišty v letu (`inFlight`). */
  pending: readonly LiveSafetyAction[];
  /** Sdílený zámek Flatten skupiny (`flattenCoordinator.pending(target.id)`). */
  flattenPending: boolean;
}

export type LiveSafetyShortcutDecision =
  | { open: { action: LiveSafetyShortcutAction; target: LiveSafetyTarget | null } }
  | { ignored: string };

/**
 * Smí lišta na požadavek otevřít dialog? Výsledek je jen stav dialogu pro
 * `setConfirmation` — žádné volání akce. Flatten bez známé skupiny nic
 * neotevře; tlačítko lišty je v tu chvíli také vypnuté.
 */
export function liveSafetyShortcutConfirmation(
  request: LiveSafetyShortcutRequest,
  view: LiveSafetyShortcutView,
  now = Date.now(),
): LiveSafetyShortcutDecision {
  if (!isLiveSafetyShortcutAction(request.action)) return { ignored: 'Zkratka tuto bezpečnostní akci neotevírá.' };
  const age = now - request.at;
  if (!Number.isFinite(age) || age > LIVE_SAFETY_SHORTCUT_MAX_AGE_MS || age < -CLOCK_SKEW_MS) {
    return { ignored: 'Požadavek ze zkratky je starý — dialog se neotevřel.' };
  }
  const label = LABELS[request.action];
  if (view.confirmationOpen !== false) return { ignored: 'Potvrzovací dialog už je otevřený — zkratka ho nemění.' };
  if (view.pending.includes(request.action)) return { ignored: `${label} už běží — čekám na výsledek workeru.` };
  if (request.action === 'flatten-group') {
    if (!view.target) return { ignored: 'Flatten vyžaduje známou skupinu workeru — dialog se neotevřel. Pokud worker není dostupný, ověř a zavři pozice přímo u brokera.' };
    if (view.flattenPending !== false) return { ignored: 'Flatten skupiny už běží — čekám na výsledek workeru.' };
  }
  return { open: { action: request.action, target: view.target } };
}

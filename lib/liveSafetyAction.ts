import type { LocalCopierAgentCommandResult } from './localCopierAgentProtocol';
import type { TradovateLiveTab } from './tradovateLiveTab';
import { isCopierBrakeQueuedError } from './copierBrakeDelivery';

export type LiveSafetyAction = 'disarm' | 'kill-switch' | 'flatten-group';
export interface LiveSafetyTarget {
  id: string;
  name: string;
  accountIds: number[];
  observedAt: number | null;
  verified: boolean;
}

export interface FlattenGroupCoordinator {
  run: <T>(groupId: string, task: () => Promise<T>) => Promise<T>;
  pending: (groupId: string) => boolean;
  /** Běží Flatten kterékoli skupiny, z libovolného povrchu (Dashboard, lišta, Shift+F, telefon). */
  anyPending: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

/**
 * One full-group Flatten per group across every LIVE surface. A second caller
 * attaches to the real in-flight result instead of creating a second command.
 */
export function createFlattenGroupCoordinator(): FlattenGroupCoordinator {
  const inFlight = new Map<string, Promise<unknown>>();
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());
  return {
    run<T>(groupId: string, task: () => Promise<T>): Promise<T> {
      const current = inFlight.get(groupId);
      if (current) return current as Promise<T>;
      const request = Promise.resolve().then(task).finally(() => {
        if (inFlight.get(groupId) !== request) return;
        inFlight.delete(groupId);
        publish();
      });
      inFlight.set(groupId, request);
      publish();
      return request;
    },
    pending: groupId => inFlight.has(groupId),
    anyPending: () => inFlight.size > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export function liveSafetyTargetAge(target: LiveSafetyTarget, now = Date.now()): string {
  if (target.verified) return 'stav cíle ověřený';
  if (target.observedAt == null || !Number.isFinite(target.observedAt)) return 'stav cíle neověřený · stáří neznámé';
  const ageSeconds = Math.max(0, Math.floor((now - target.observedAt) / 1_000));
  const age = ageSeconds < 60 ? `${ageSeconds} s` : `${Math.floor(ageSeconds / 60)} min`;
  return `stav cíle neověřený · poslední stav před ${age}`;
}

export function liveSafetyFailureMessage(reason: unknown): string {
  const base = reason instanceof Error ? reason.message : 'Bezpečnostní akci se nepodařilo potvrdit.';
  return /výsledek neověřen/i.test(base)
    ? base
    : `${base} Výsledek neověřen; akce se neopakuje.`;
}

export function assertSameSafetyTarget(requested: LiveSafetyTarget | undefined, current: LiveSafetyTarget | null): asserts requested is LiveSafetyTarget {
  const members = (target: LiveSafetyTarget) => [...new Set(target.accountIds)].sort((a, b) => a - b).join(',');
  if (!requested || !current || requested.id !== current.id || members(requested) !== members(current)) {
    throw new Error('Skupina workeru nebo její účty se změnily, případně je nelze určit. Flatten nebyl odeslán; znovu ověř cílovou skupinu.');
  }
}

/** Never turn an ACK, pending close or partial flatten into a confirmed flat claim. */
export function liveSafetyReceipt(action: LiveSafetyAction, payload: LocalCopierAgentCommandResult, expectedTarget?: LiveSafetyTarget): string {
  if (action === 'disarm') {
    if (payload.status.controller.armed !== false) throw new Error('Worker nepotvrdil vypnutí kopírky.');
    return 'Worker potvrdil OFF. Kopírování je vypnuté; pozice to nezavírá.';
  }
  if (action === 'kill-switch') {
    if (payload.status.controller.killSwitch !== true) throw new Error('Worker nepotvrdil Kill switch.');
    return 'Worker potvrdil Kill switch. Běžné brokerové akce kopírky jsou zablokované; pozice to samo nezavírá.';
  }
  const result = payload.result;
  if (!result || result.type !== 'flatten') throw new Error('Chybí potvrzený výsledek Flatten. Ověř účty u brokera, než příkaz zopakuješ.');
  if (result.pending) return 'Worker přijal zavírání na pozadí. Flat stav zatím není potvrzený; sleduj účty u brokera.';
  if (expectedTarget && (result.accountIds.length === 0 || [...new Set(result.accountIds)].sort((a, b) => a - b).join(',') !== [...new Set(expectedTarget.accountIds)].sort((a, b) => a - b).join(','))) {
    throw new Error('Potvrzení Flatten nepokrývá všechny potvrzené účty skupiny. Ověř je u brokera.');
  }
  if (!result.flat || result.remainingPositionAccounts.length || result.workingOrderAccounts.length || result.failedAccounts?.length) {
    throw new Error('Flatten není potvrzený jako dokončený. Některé účty mají neověřený stav, otevřené pozice nebo pracovní příkazy; zkontroluj je u brokera.');
  }
  return `Flatten potvrzen: ${result.accountIds.length} účtů je flat a bez pracovních příkazů.`;
}

/** Stav slotu přehledu pro desk: líný chunk (načítá se / selhal) nebo pád v boundary. */
export type LiveOverviewSlotState = 'loading' | 'ready' | 'failed' | 'crashed';

/** `after-grace` = lišta až po prodlevě, ať při běžném startu neproblikne. */
export type LiveSafetyBarNeed = 'none' | 'after-grace' | 'now';

/** Prodleva nad stropem studeného odkrytí přehledu (2,5 s): běžný start lištu neukáže. */
export const LIVE_SAFETY_BAR_GRACE_MS = 3_000;

/**
 * Běžně lišta OFF / Kill / Flatten nikde není (Filip 5. 11. 2026, brzdy jsou na Dashboardu LIVE).
 * Tahle funkce říká, kdy Dashboard na obrazovce nejde dosáhnout, a lišta se proto vrátí (INV-UI-02).
 * Pořadí kopíruje větvení obsahu desku. Graf má vlastní OFF a cestu na Dashboard, Připojení
 * a ostatní záložky s daty mají cestu na Dashboard, proto `none`.
 */
export function liveSafetyBarNeed(input: {
  tab: TradovateLiveTab;
  chartCrashed: boolean;
  checkingConnection: boolean;
  requiresConnection: boolean;
  /** `!liveData || holdColdReveal`: místo přehledu je kostra. */
  coldHold: boolean;
  overviewSlot: LiveOverviewSlotState;
}): LiveSafetyBarNeed {
  if (input.tab === 'chart') return input.chartCrashed ? 'now' : 'none';
  if (input.tab === 'connections') return 'none';
  if (input.checkingConnection) return 'after-grace';
  if (input.requiresConnection) return 'now';
  if (input.coldHold) return 'after-grace';
  if (input.tab !== 'overview') return 'none';
  if (input.overviewSlot === 'failed' || input.overviewSlot === 'crashed') return 'now';
  return input.overviewSlot === 'loading' ? 'after-grace' : 'none';
}

/**
 * Prodleva po změně potřeby lišty: `none` ji vynuluje, `now` ji rovnou splní (co už je vidět,
 * nezmizí při přechodu `now` → `after-grace`), jinak běží dál.
 */
export const liveSafetyGraceAfterNeed = (need: LiveSafetyBarNeed, elapsed: boolean): boolean => (
  need === 'none' ? false : need === 'now' ? true : elapsed
);

export const liveSafetyBarVisible = (need: LiveSafetyBarNeed, graceElapsed: boolean): boolean => (
  need === 'now' || (need === 'after-grace' && graceElapsed)
);

/** Zapnutá kopírka maže starou hlášku o výsledku, chybu ale ne: nepotvrzená brzda musí zůstat vidět. */
export const liveSafetyNoticeClearedByArm = (notice: { tone: 'info' | 'error' }, copierArmed: boolean): boolean => (
  copierArmed && notice.tone !== 'error'
);

/** Hlášky z desku ve vlastních slotech: `notice` lišty je nepřepíše a nezvedá kvůli nim epochu. */
export type LiveSafetyNotice = { text: string; tone: 'info' | 'error'; at: number };
export const liveSafetyVisibleExternalNotices = (
  notices: ReadonlyArray<LiveSafetyNotice | null | undefined>,
  dismissed: ReadonlyArray<LiveSafetyNotice>,
  copierArmed: boolean,
): LiveSafetyNotice[] => notices.filter((notice): notice is LiveSafetyNotice => (
  notice != null && !dismissed.includes(notice) && !liveSafetyNoticeClearedByArm(notice, copierArmed)
));

/** Informace po 10 min zmizí, chyba brzdy zůstává do ×. */
export const liveSafetyNoticeExpires = (notice: { tone: 'info' | 'error' }): boolean => notice.tone !== 'error';

/** Text dialogu Flatten All. Lišta je schovaná pod dialogem, proto neověřený cíl říká dialog sám. */
export function liveSafetyFlattenMessage(target: LiveSafetyTarget | null, now = Date.now()): string {
  const base = `Zavřít pozice a zrušit pracovní příkazy ve skupině ${target?.name}? Zahrnuje leadera i všechny followery potvrzené skupiny (${target?.accountIds.length ?? 0} účtů). Názvy ani čísla účtů se v tomto dialogu nezobrazují. Rozsah vychází z posledního známého stavu workeru; jiné skupiny nejsou cílem.`;
  return target && !target.verified ? `${base} Pozor: ${liveSafetyTargetAge(target, now)}.` : base;
}

export type DashboardCommandLock = 'blocked' | 'acquire' | 'bypass';

/**
 * Zámek jednoho příkazu Dashboardu. Flatten All skupiny jím neprochází (INV-UI-02, INV-BRAKE-03):
 * při cizím držiteli jede mimo něj (`bypass`, zámek nebere ani neuvolňuje). Duplicitu hlídá
 * `flattenCoordinator` v desku, souběžný Flatten téhož Dashboardu zastaví `flattenRunning`.
 * Během Flattenu žádný jiný příkaz nezačne, ani když Flatten zámek nedrží.
 */
export function dashboardCommandLock(commandType: string, state: { busy: string | null; flattenRunning: boolean }): DashboardCommandLock {
  if (commandType === 'flatten-group') {
    if (state.flattenRunning) return 'blocked';
    return state.busy != null ? 'bypass' : 'acquire';
  }
  return state.busy != null || state.flattenRunning ? 'blocked' : 'acquire';
}

/** Potvrzovací dialog Dashboardu: Flatten All a OFF nezamyká cizí běžící příkaz. */
export function dashboardDialogBusy(action: { commandType?: string; busyExempt?: boolean } | null, state: { busy: string | null; flattenRunning: boolean }): boolean {
  if (action?.busyExempt) return false;
  return action?.commandType === 'flatten-group' ? state.flattenRunning : state.busy != null || state.flattenRunning;
}

/** Brzdy v menu ⋮. OFF jen když není prokazatelně vypnuto; Kill zamkne jen aktivní západka z ověřeného stavu. */
export function liveTopMenuBrakes(input: { hasDisarm: boolean; hasKill: boolean; provablyOff: boolean; killActive: boolean; stateVerifying: boolean }): { offerDisarm: boolean; killDisabled: boolean; killShownActive: boolean } {
  const killShownActive = input.killActive && !input.stateVerifying;
  return {
    offerDisarm: input.hasDisarm && !input.provablyOff,
    killDisabled: !input.hasKill || killShownActive,
    killShownActive,
  };
}

/**
 * Rearm po Flattenu smí nabídnout jen potvrzený flat výsledek. Lokální uložení bez adaptéru
 * ani zavírání na pozadí to nejsou (INV-UI-02, nikdy „potvrzeno“ bez výsledku workeru).
 */
export const flattenRearmAllowed = (result: unknown): boolean => {
  const flatten = result as { type?: unknown; flat?: unknown; pending?: unknown } | null | undefined;
  return flatten?.type === 'flatten' && flatten.flat === true && !flatten.pending;
};

/** Zapnutí se hlásí jen po výslovném potvrzení workeru, odmítnutý dialog vrací `false`. */
export const armTransitionConfirmed = (outcome: unknown): boolean => outcome === true;

/** Výsledek zapnutí nebo vypnutí, který by jinak zmizel: neznámý, pod dialogem Flatten, nebo bez přehledu. */
export const armOutcomeNeedsDeskNotice = (input: { rejected: boolean; yieldsToDialog: boolean; mounted: boolean }): boolean => (
  !input.rejected || input.yieldsToDialog || !input.mounted
);

/** Selhané zapnutí nesmí přepsat otevřený dialog Flatten All, chyba pak přijde toastem. */
export const armErrorYieldsToDialog = (action: { command?: { type: string } } | null): boolean => (
  action?.command?.type === 'flatten-group'
);

/**
 * Průvodce zapnutím: po vyřazení účtu smí ARM jít jen s živým záměrem. Zavření dialogu, odmontování
 * přehledu nebo dialog schovaný pod jiným záměr ruší, vyřazení doběhne a kopírka zůstane vypnutá.
 */
export const armBlockExclusionOutcome = (input: {
  mounted: boolean;
  intentGroupId: string | null;
  openGroupId: string | null;
  dialogCovered: boolean;
  groupId: string;
}): 'arm' | 'stay-off' => (
  input.mounted && !input.dialogCovered && input.intentGroupId === input.groupId && input.openGroupId === input.groupId
    ? 'arm'
    : 'stay-off'
);

/** OFF v menu ⋮: během zapínání na pozadí se nabízí i nad stavem „prokazatelně vypnuto“. */
export const copierOffVerifiedForMenu = (provablyOff: boolean, armFlowActive: boolean): boolean => (
  provablyOff && !armFlowActive
);

/**
 * Trasa příkazu Dashboardu. Flatten All skupiny je brzda: po kontrole cíle potvrzeného v dialogu
 * jde stejně jako z lišty a Shift+F (`brake` = `executeSafetyCommand`, poslední známá route a zámek
 * skupiny, INV-BRAKE-03), a to na ID skupiny WORKERU z potvrzeného cíle (knihovna může mít jiné).
 * Výsledek ověří `liveSafetyReceipt` a předá `onBrakeResult` do desku, takže přežije odmontování
 * přehledu. Všechno ostatní, i Flatten jednoho účtu, jde běžnou cestou.
 */
export async function routeDashboardCommand<Command extends { type: string }, Result extends LocalCopierAgentCommandResult>(
  command: Command,
  confirmedTarget: LiveSafetyTarget | null | undefined,
  deps: {
    currentTarget: () => LiveSafetyTarget | null;
    brake: (command: Command & { groupId: string }) => Promise<Result>;
    ordinary: (command: Command) => Promise<Result>;
    onBrakeResult?: (result: { tone: 'info' | 'error'; text: string }) => void;
  },
): Promise<Result> {
  if (command.type !== 'flatten-group') return deps.ordinary(command);
  try {
    const target = confirmedTarget ?? undefined;
    assertSameSafetyTarget(target, deps.currentTarget());
    const payload = await deps.brake({ ...command, groupId: target.id });
    const text = liveSafetyReceipt('flatten-group', payload, target);
    deps.onBrakeResult?.({ tone: 'info', text });
    return payload;
  } catch (reason) {
    deps.onBrakeResult?.({ tone: isCopierBrakeQueuedError(reason) ? 'info' : 'error', text: liveSafetyFailureMessage(reason) });
    throw reason;
  }
}

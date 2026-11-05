import type { LeaderOrderManageResult } from '../lib/leaderOrderManage';
import { liveBareCloseErrorNotice, liveBareCloseResultNotice, type LiveBareCloseOffer } from '../lib/liveBareCloseUi';
import { CANCEL_PENDING_NOT_SENT_PATTERN, cancelPendingSummary, type CancelPendingItemResult, type PendingOwnEntry } from '../lib/liveCancelPending';
import type { LiveCancelPendingView } from '../lib/liveCancelPendingUi';
import type { LiveConfirmGate } from '../lib/liveConfirmGate';
import type { BareLeaderTrade } from '../lib/manualBareClose';
import { LIVE_MANAGE_BUSY_TEXT, createLiveManageRun, type LiveManageNotice, type LiveManageOutcome, type LiveManageRunDeps } from './useLiveManageRunner';

/**
 * Běhy C7/C8 (4. 11. 2026) nad sdíleným zámkem jednoho příkazu (`busyRef` = tentýž zámek
 * jako čáry, zkratky a správa obrazovky). Bez Reactu a bez relaye: jediná cesta k brokerovi
 * je předaný deskový callback (`closeBareLeader` / `cancelPendingEntries`), nic se neopakuje.
 */

/**
 * C8 (4. 11. 2026): × zavřít vlastní holý Market bez SL/TP — PC čára, Shift+X, panel i telefon.
 * TÝŽ běh jako správa (`createLiveManageRun`: jeden příkaz naráz přes sdílený `busyRef`, právě
 * jedno volání, nic se neopakuje), jen jiné texty výsledku (`liveBareCloseResultNotice`:
 * neznámé = „Neověřeno — zkontroluj Tradovate“, nikdy „zavřeno“). `close` = deskový
 * `closeBareLeader`, který odešle JEN obchod, který uživatel viděl (`seen`), a jen když ho
 * čerstvý status pořád hlásí beze změny. Flatten tudy nikdy nejde (INV-UI-02).
 */
export function createLiveBareCloseRun(deps: Omit<LiveManageRunDeps, 'manage' | 'resultNotice' | 'errorNotice'> & {
  close: () => ((seen: BareLeaderTrade) => Promise<LeaderOrderManageResult>) | null | undefined;
}) {
  const { close, ...lock } = deps;
  return (seen: BareLeaderTrade): Promise<LiveManageOutcome> => createLiveManageRun({
    ...lock,
    manage: () => {
      const current = close();
      return current ? () => current(seen) : null;
    },
    resultNotice: (_action, result, at) => liveBareCloseResultNotice(result, at),
    errorNotice: liveBareCloseErrorNotice,
  })('close-position', seen.referencePrice);
}

/** Výsledek „Zrušit čekající“ (C7): `called` = desk dostal sadu (příkazy mohly odejít). */
export interface LiveCancelPendingOutcome {
  called: boolean;
  results: CancelPendingItemResult[];
  notice: LiveManageNotice;
}

/**
 * C7 (4. 11. 2026): „Zrušit čekající“ (PC lišta, telefon) i Dashboard „Zrušit“ — sdílený zámek
 * jednoho příkazu (`busyRef`, tentýž jako čáry a správa obrazovky), právě jedno volání desku
 * `cancel` se sadou, kterou uživatel viděl (desk ji porovná s čerstvým statusem a pošle N×
 * `cancel-entry`), výsledek po položkách (`cancelPendingSummary`: fill nikdy „zrušeno“). Nic se
 * neopakuje; výjimka mimo prokazatelně neodeslané vzory = výsledek neznámý.
 */
export function createLiveCancelPendingRun(deps: {
  cancel: () => ((entries: readonly PendingOwnEntry[]) => Promise<CancelPendingItemResult[]>) | null | undefined;
  busyRef: { current: boolean };
  setBusy?: (busy: boolean) => void;
  report: (notice: LiveManageNotice) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const finish = (notice: LiveManageNotice, called: boolean, results: CancelPendingItemResult[] = []): LiveCancelPendingOutcome => {
    deps.report(notice);
    return { called, results, notice };
  };
  return async (entries: readonly PendingOwnEntry[]): Promise<LiveCancelPendingOutcome> => {
    const cancel = deps.cancel();
    if (!cancel) return finish({ tone: 'bad', text: 'Zrušení čekajících z appky teď nejde — nic se neodeslalo.', at: now() }, false);
    if (entries.length === 0) return finish({ tone: 'warn', text: 'Nebylo co zrušit — nic se neodeslalo.', at: now() }, false);
    if (deps.busyRef.current) return finish({ tone: 'warn', text: LIVE_COMMAND_BUSY_TEXT, at: now() }, false);
    deps.busyRef.current = true;
    deps.setBusy?.(true);
    try {
      const results = await cancel(entries);
      const summary = cancelPendingSummary(results);
      return finish({ tone: summary.tone === 'error' ? 'bad' : summary.tone, text: summary.text, at: now() }, true, results);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'chyba';
      return finish(CANCEL_PENDING_NOT_SENT_PATTERN.test(message)
        ? { tone: 'bad', text: `Neodesláno: ${message.slice(0, 160)}`, at: now() }
        : { tone: 'warn', text: `Výsledek neznámý (${message.slice(0, 120)}) — zkontroluj leadera v Tradovate. Nic se neopakuje.`, at: now() }, true);
    } finally {
      deps.busyRef.current = false;
      deps.setBusy?.(false);
    }
  };
}

/** Text, když sdílený zámek drží jiný příkaz (stejný jako `createLiveManageRun`; nabízí Flatten mimo zámek). */
export const LIVE_COMMAND_BUSY_TEXT = LIVE_MANAGE_BUSY_TEXT;

/**
 * Jedno odeslání pod sdíleným zámkem jednoho příkazu (vstup a „Přidat SL/TP“ z panelu PC,
 * oponentura UI C7/C8 kolo 1): obsazený zámek = výjimka „nic se neodeslalo“ a `send` se
 * nezavolá; jinak zámek drží po dobu letu a uvolní ho i po výjimce. Nic se neopakuje.
 */
export async function runWithCommandLock<T>(lockRef: { current: boolean }, send: () => Promise<T>): Promise<T> {
  if (lockRef.current) throw new Error(LIVE_COMMAND_BUSY_TEXT);
  lockRef.current = true;
  try {
    return await send();
  } finally {
    lockRef.current = false;
  }
}

/**
 * Klik „Zrušit čekající“ / Dashboard „Zrušit“ (C7): krok dvoukroku přes `gate` (klíč = přesně
 * zobrazená sada), zablokovaný pohled = jen důvod a zahozené potvrzení, odeslání JEN při `send`
 * a jen sady z pohledu, na který uživatel klikl. Zámek a výsledek řeší `run`.
 */
export function createLiveCancelPendingClick(deps: {
  gate: LiveConfirmGate;
  run: (entries: readonly PendingOwnEntry[]) => Promise<LiveCancelPendingOutcome>;
  report: (notice: LiveManageNotice) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return (view: LiveCancelPendingView | null | undefined): Promise<LiveCancelPendingOutcome> | null => {
    const step = deps.gate.click(view);
    if (step.kind === 'blocked') {
      deps.report({ tone: 'bad', text: `${step.reason ?? 'Zrušit teď nejde.'} Nic se neodeslalo.`, at: now() });
      return null;
    }
    if (step.kind !== 'send' || !view) return null;
    return deps.run(view.entries);
  };
}

/**
 * Klik × holé pozice v panelu PC (C8): neaktivní nabídka = důvod a zahozené potvrzení; jiný
 * příkaz pod sdíleným zámkem (`busy`: zámek desku, vstup nebo attach panelu) = nic, potvrzení
 * beze změny; jinak dvoukrok s klíčem nabídky (akce + id cíle + tvar) a odeslání JEN při `send`
 * funkcí obrazovky `close` (tatáž jako × na čáře a Shift+X, sama drží sdílený zámek).
 */
export function createLiveBareClosePanelClick(deps: {
  gate: LiveConfirmGate;
  busy: () => boolean;
  close: () => ((entryOperationId: string) => Promise<LiveManageOutcome | null>) | null | undefined;
  report: (entryOperationId: string, notice: LiveManageNotice) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return (offer: LiveBareCloseOffer | null | undefined): Promise<LiveManageOutcome | null> | null => {
    const close = deps.close();
    const step = deps.gate.click(close ? offer : null, { busy: deps.busy() });
    if (!offer || !close) return null;
    const target = offer.trade.entryOperationId;
    if (step.kind === 'blocked') {
      deps.report(target, { tone: 'bad', text: `${step.reason ?? 'Zavřít teď nejde.'} Nic se neodeslalo.`, at: now() });
      return null;
    }
    if (step.kind === 'busy') {
      deps.report(target, { tone: 'warn', text: LIVE_COMMAND_BUSY_TEXT, at: now() });
      return null;
    }
    if (step.kind !== 'send') return null;
    return close(target);
  };
}

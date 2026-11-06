/**
 * Deskové odeslání správy leadera pro C7/C8 (4. 11. 2026, oponentura UI kolo 1) jako čistá
 * továrna bez Reactu — `TradovateLiveDesk` jen dodá reference (status, trasa relaye, relay).
 *
 * - `sendLeaderManage`: JEDINÉ relay odeslání správy leadera (`copy-command` →
 *   `manage-leader-order`) pro správu z čar a panelu, doplnění SL/TP, × holé pozice (C8)
 *   i „Zrušit čekající“ (C7). Nic se neopakuje; chybějící výsledek = výjimka (neznámé).
 * - `closeBareLeader` (C8): odejde JEN holý obchod, který uživatel viděl (`seen`), a jen když
 *   ho čerstvý neobnovený status s capability pořád hlásí beze změny (`sameBareTrade`).
 * - `cancelPendingEntries` (C7): odejde jen sada, kterou uživatel potvrdil, a jen když ji čerstvý
 *   status pořád hlásí (`cancelPendingSeenProblem`); N× `cancel-entry` jádra sekvenčně. Trasa relaye
 *   se zachytí JEDNOU před sekvencí (INV-TRAD-06, INV-RELAY-01): změní-li se uprostřed (dvě OAuth
 *   připojení, přepnutí připojení), zbytek se neodešle a je označen „Neodesláno“.
 * Worker vše ověří znovu (INV-UI-01/03) — tyhle brány jen zabrání odeslat něco, co uživatel neviděl.
 */
import { buildLeaderOrderManageCommand, type LeaderOrderManageCommand, type LeaderOrderManageResult } from './leaderOrderManage';
import { bareCloseManageFields, type BareLeaderTrade } from './manualBareClose';
import { cancelOwnPendingEntries, type CancelPendingItemResult, type PendingOwnEntry } from './liveCancelPending';
import { copierWorkerExecutionGroup, supportsCopierManualOrderCancelPending, supportsCopierManualOrderCloseBare } from './copierWorkerCapabilities';
import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';
import { sameBareTrade } from './liveBareCloseUi';
import { cancelPendingSeenProblem } from './liveCancelPendingUi';

export const LIVE_DESK_NOT_FRESH = 'Stav kopírky není čerstvě ověřený — nic se neodeslalo.';
export const LIVE_DESK_RELAY_MISSING = 'Změna jde jen přes relay — chybí připojení k workeru, nic se neodeslalo.';
export const LIVE_DESK_ROUTE_CHANGED = 'Relay trasa se během rušení změnila — nic se neodeslalo.';

export interface LiveDeskCommandDeps {
  /** `armStatusRef.current` v okamžiku odeslání (`fresh` = čerstvý a neobnovený). */
  status: () => { status: LocalCopierAgentStatus | null | undefined; fresh: boolean };
  /** Aktuální relay trasa (`previewRouteRef.current.relayConnectionId`). */
  relayId: () => string | null | undefined;
  /** Jediné relay odeslání (desk: relay klient, `{ type: 'copy-command', command }`). */
  relay: (relayId: string, command: LeaderOrderManageCommand) => Promise<unknown>;
  /** Po odeslání (rychlejší poll statusu). */
  afterSend?: () => void;
  /** Nové `manage:…` id pro každý příkaz. */
  newOperationId: () => string;
}

export function createLiveDeskCommands(deps: LiveDeskCommandDeps) {
  /** `relayId` = trasa zachycená volajícím (C7 sekvence); jinak aktuální. */
  const sendLeaderManage = async (command: LeaderOrderManageCommand, missing: string, relayId?: string | null): Promise<LeaderOrderManageResult> => {
    const route = relayId === undefined ? deps.relayId() : relayId;
    if (!route) throw new Error(LIVE_DESK_RELAY_MISSING);
    const response = await deps.relay(route, command);
    const result = (response as { result?: unknown } | null | undefined)?.result as LeaderOrderManageResult | undefined;
    deps.afterSend?.();
    if (!result || result.type !== 'leader-order-managed') throw new Error(missing);
    return result;
  };

  const closeBareLeader = async (seen: BareLeaderTrade): Promise<LeaderOrderManageResult> => {
    const current = deps.status();
    const executionGroup = copierWorkerExecutionGroup(current.status);
    if (!current.fresh || !executionGroup || executionGroup.leaderAccountId == null || !supportsCopierManualOrderCloseBare(current.status)) {
      throw new Error(LIVE_DESK_NOT_FRESH);
    }
    if (!sameBareTrade(current.status?.controller.bareLeaderTrade ?? null, seen)) throw new Error('Holá pozice se mezitím změnila — nic se neodeslalo.');
    const relayId = deps.relayId();
    if (!relayId) throw new Error('Zavření jde jen přes relay — chybí připojení k workeru, nic se neodeslalo.');
    const command = buildLeaderOrderManageCommand({
      groupId: executionGroup.id, operationId: deps.newOperationId(),
      leaderAccountId: executionGroup.leaderAccountId, ...bareCloseManageFields(seen),
    });
    return sendLeaderManage(command, 'Výsledek zavření chybí — zkontroluj leadera v Tradovate.', relayId);
  };

  const cancelPendingEntries = async (seen: readonly PendingOwnEntry[]): Promise<CancelPendingItemResult[]> => {
    const current = deps.status();
    const executionGroup = copierWorkerExecutionGroup(current.status);
    if (!current.fresh || !executionGroup || executionGroup.leaderAccountId == null || !supportsCopierManualOrderCancelPending(current.status)) {
      throw new Error(LIVE_DESK_NOT_FRESH);
    }
    const changed = cancelPendingSeenProblem(seen, current.status?.controller.pendingOwnEntries);
    if (changed) throw new Error(changed);
    const relayId = deps.relayId();
    if (!relayId) throw new Error('Zrušení jde jen přes relay — chybí připojení k workeru, nic se neodeslalo.');
    return cancelOwnPendingEntries({
      entries: seen, groupId: executionGroup.id, leaderAccountId: executionGroup.leaderAccountId,
      newOperationId: deps.newOperationId,
      send: async command => {
        if (deps.relayId() !== relayId) throw new Error(LIVE_DESK_ROUTE_CHANGED);
        return sendLeaderManage(command, 'Výsledek zrušení chybí — zkontroluj leadera v Tradovate.', relayId);
      },
    });
  };

  return { sendLeaderManage, closeBareLeader, cancelPendingEntries };
}

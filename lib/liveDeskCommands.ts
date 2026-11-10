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
import { liveBareLegFields, type LiveBareLegIntent } from './liveBareLeg';
import { cancelOwnPendingEntries, type CancelPendingItemResult, type PendingOwnEntry } from './liveCancelPending';
import { copierWorkerExecutionGroup, supportsCopierManualOrderCancelPending, supportsCopierManualOrderCloseBare, supportsCopierManualOrderSingleLeg, supportsCopierGroupLimitManage } from './copierWorkerCapabilities';
import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';
import { sameBareTrade } from './liveBareCloseUi';
import { cancelPendingSeenProblem } from './liveCancelPendingUi';
import { groupLimitCancelTrade, groupLimitCancelExpect, groupLimitCommandFields, groupLimitLegTrade, groupLimitPositionManageTrade, groupLimitSeenHash } from './groupLimitUi';
import { liveChartNotSent } from './liveChartNotSent';

const refuse = (message: string): never => {
  throw liveChartNotSent(message);
};

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

export interface LiveGroupLimitPositionInput {
  entryOperationId: string;
  symbol: string;
  groupLimitStateHash: string;
  action: 'close-position' | 'attach-brackets';
  stopLoss?: number;
  takeProfit?: number;
}

export function createLiveDeskCommands(deps: LiveDeskCommandDeps) {
  /** `relayId` = trasa zachycená volajícím (C7 sekvence); jinak aktuální. */
  const sendLeaderManage = async (command: LeaderOrderManageCommand, missing: string, relayId?: string | null): Promise<LeaderOrderManageResult> => {
    const route = relayId === undefined ? deps.relayId() : relayId;
    if (!route) refuse(LIVE_DESK_RELAY_MISSING);
    const response = await deps.relay(route, command);
    const result = (response as { result?: unknown } | null | undefined)?.result as LeaderOrderManageResult | undefined;
    deps.afterSend?.();
    if (!result || result.type !== 'leader-order-managed') throw new Error(missing);
    return result;
  };

  /** Group close/attach expect the sealed leader entry price, never the SL or current quote used by the solo UI. */
  const manageGroupLimitPosition = async (input: LiveGroupLimitPositionInput): Promise<LeaderOrderManageResult> => {
    const current = deps.status();
    const group = copierWorkerExecutionGroup(current.status);
    if (!current.fresh || !group || group.manualOnly === true || group.leaderAccountId == null
      || !supportsCopierGroupLimitManage(current.status)) refuse(LIVE_DESK_NOT_FRESH);
    const trade = groupLimitPositionManageTrade(current.status, input.entryOperationId, input.symbol);
    const leader = trade?.accounts.find(row => row.role === 'leader');
    if (!trade || trade.stateHash !== input.groupLimitStateHash || leader?.openQuantity == null || leader.entry?.price == null) {
      refuse('Stav pozice všech účtů se změnil — nic se neodeslalo.');
    }
    const command = buildLeaderOrderManageCommand({ groupId: group.id, operationId: deps.newOperationId(),
      leaderAccountId: group.leaderAccountId, entryOperationId: input.entryOperationId, symbol: input.symbol, action: input.action,
      expect: { price: leader.entry.price, quantity: leader.openQuantity }, ...groupLimitCommandFields(trade),
      ...(input.stopLoss != null ? { stopLoss: input.stopLoss } : {}), ...(input.takeProfit != null ? { takeProfit: input.takeProfit } : {}),
    });
    return sendLeaderManage(command, 'Výsledek skupiny chybí — zkontroluj účty v Tradovate.');
  };

  const closeBareLeader = async (seen: BareLeaderTrade): Promise<LeaderOrderManageResult> => {
    const current = deps.status();
    const executionGroup = copierWorkerExecutionGroup(current.status);
    if (!current.fresh || !executionGroup || executionGroup.leaderAccountId == null || !(supportsCopierManualOrderCloseBare(current.status) || supportsCopierGroupLimitManage(current.status))) {
      refuse(LIVE_DESK_NOT_FRESH);
    }
    if (groupLimitSeenHash(seen) && !supportsCopierGroupLimitManage(current.status)) refuse(LIVE_DESK_NOT_FRESH);
    const groupPath = executionGroup.manualOnly !== true && supportsCopierGroupLimitManage(current.status);
    const groupTrade = groupPath ? groupLimitPositionManageTrade(current.status, seen.entryOperationId, seen.symbol) : null;
    const freshTrade = groupPath ? groupLimitLegTrade(groupTrade) : current.status?.controller.bareLeaderTrade;
    if (!sameBareTrade(freshTrade, seen) || (groupPath && (!groupTrade || groupLimitSeenHash(seen) !== groupTrade.stateHash))) refuse(groupPath ? 'Holá pozice nebo stav účtů se mezitím změnily — nic se neodeslalo.' : 'Holá pozice se mezitím změnila — nic se neodeslalo.');
    const relayId = deps.relayId();
    if (!relayId) refuse('Zavření jde jen přes relay — chybí připojení k workeru, nic se neodeslalo.');
    const command = buildLeaderOrderManageCommand({
      groupId: executionGroup.id, operationId: deps.newOperationId(),
      leaderAccountId: executionGroup.leaderAccountId, ...bareCloseManageFields(seen),
      ...(groupTrade ? groupLimitCommandFields(groupTrade) : {}),
    });
    return sendLeaderManage(command, 'Výsledek zavření chybí — zkontroluj leadera v Tradovate.', relayId);
  };

  /** SL a TP po jedné: `seen` = obchod a nohy, které uživatel viděl. Rozhoduje worker. */
  const manageBareLeg = async (seen: BareLeaderTrade, intent: LiveBareLegIntent): Promise<LeaderOrderManageResult> => {
    const current = deps.status();
    const executionGroup = copierWorkerExecutionGroup(current.status);
    if (!current.fresh || !executionGroup || executionGroup.leaderAccountId == null || !(supportsCopierManualOrderSingleLeg(current.status) || supportsCopierGroupLimitManage(current.status))) {
      refuse(LIVE_DESK_NOT_FRESH);
    }
    if (groupLimitSeenHash(seen) && !supportsCopierGroupLimitManage(current.status)) refuse(LIVE_DESK_NOT_FRESH);
    const groupPath = executionGroup.manualOnly !== true && supportsCopierGroupLimitManage(current.status);
    const groupTrade = groupPath ? groupLimitPositionManageTrade(current.status, seen.entryOperationId, seen.symbol) : null;
    const freshTrade = groupPath ? groupLimitLegTrade(groupTrade) : current.status?.controller.bareLegTrade;
    if (!sameBareTrade(freshTrade, seen) || (groupPath && (!groupTrade || (intent.groupLimitStateHash ?? groupLimitSeenHash(seen)) !== groupTrade.stateHash))) refuse(groupPath ? 'Pozice nebo stav účtů se mezitím změnily — nic se neodeslalo.' : 'Pozice se mezitím změnila — nic se neodeslalo.');
    const relayId = deps.relayId();
    if (!relayId) refuse('Změna jde jen přes relay — chybí připojení k workeru, nic se neodeslalo.');
    const command = buildLeaderOrderManageCommand({
      groupId: executionGroup.id, operationId: deps.newOperationId(), leaderAccountId: executionGroup.leaderAccountId,
      entryOperationId: seen.entryOperationId, symbol: seen.symbol, ...liveBareLegFields(seen, intent),
      ...(groupTrade ? groupLimitCommandFields(groupTrade) : {}),
    });
    return sendLeaderManage(command, 'Výsledek změny chybí — zkontroluj leadera v Tradovate.', relayId);
  };

  const cancelPendingEntries = async (seen: readonly PendingOwnEntry[]): Promise<CancelPendingItemResult[]> => {
    const current = deps.status();
    const executionGroup = copierWorkerExecutionGroup(current.status);
    if (!current.fresh || !executionGroup || executionGroup.leaderAccountId == null || !supportsCopierManualOrderCancelPending(current.status)) {
      refuse(LIVE_DESK_NOT_FRESH);
    }
    const changed = cancelPendingSeenProblem(seen, current.status?.controller.pendingOwnEntries);
    if (changed) refuse(changed);
    const relayId = deps.relayId();
    if (!relayId) refuse('Zrušení jde jen přes relay — chybí připojení k workeru, nic se neodeslalo.');
    const requiredGroupPath = executionGroup.manualOnly !== true && supportsCopierGroupLimitManage(current.status);
    const initialGroupId = executionGroup.id;
    const initialLeaderId = executionGroup.leaderAccountId;
    return cancelOwnPendingEntries({
      entries: seen, groupId: executionGroup.id, leaderAccountId: executionGroup.leaderAccountId,
      newOperationId: deps.newOperationId,
      send: async command => {
        if (deps.relayId() !== relayId) refuse(LIVE_DESK_ROUTE_CHANGED);
        const latest = deps.status();
        const latestGroup = copierWorkerExecutionGroup(latest.status);
        if (!latest.fresh || latestGroup?.id !== initialGroupId || latestGroup.leaderAccountId !== initialLeaderId
          || (requiredGroupPath && !supportsCopierGroupLimitManage(latest.status))) refuse('Stav skupiny se během rušení změnil — nic se neodeslalo.');
        const groupPath = requiredGroupPath;
        const groupTrade = groupPath ? groupLimitCancelTrade(latest.status, command.entryOperationId, command.symbol) : null;
        if (groupPath && (!latest.fresh || !groupTrade)) refuse('Stav čekajícího příkazu se změnil — nic se neodeslalo.');
        const grouped = groupTrade ? buildLeaderOrderManageCommand({ ...command, ...groupLimitCommandFields(groupTrade), expect: groupLimitCancelExpect(groupTrade, command.expect.price) }) : command;
        return sendLeaderManage(grouped, 'Výsledek zrušení chybí — zkontroluj účty v Tradovate.', relayId);
      },
    });
  };

  return { sendLeaderManage, manageGroupLimitPosition, closeBareLeader, manageBareLeg, cancelPendingEntries };
}

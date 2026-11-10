import { LiveCommandNotSentError } from './liveCommandErrors';
import { supportsCopierGroupLimitBare, supportsCopierGroupLimitManage, supportsCopierGroupLimitMove } from './copierWorkerCapabilities';
import { GROUP_LIMIT_CONTRACT, GROUP_LIMIT_STATE_HASH_PATTERN, type GroupLimitCommandFields, type GroupLimitTradeState } from './groupLimitProtocol';
import type { BareLeaderTrade } from './manualBareClose';
import type { LeaderOrderManageCommand } from './leaderOrderManage';

interface GroupLimitUiStatus {
  capabilities?: readonly string[];
  group?: {
    id: string;
    leaderAccountId?: number | null;
    manualOnly?: boolean;
    followers: readonly { accountId: number; multiplier: number; enabled?: boolean; mode: string }[];
  } | null;
  controller?: { groupLimitTrades?: readonly GroupLimitTradeState[] };
}

export type LiveGroupLimitLegTrade = BareLeaderTrade & { groupLimitStateHash: string };
const quantity = (value: number) => Number.isSafeInteger(value) && value > 0;
const price = (value: number | null): value is number => value != null && Number.isFinite(value) && value > 0;
const terminal = (state: string) => ['filled', 'canceled', 'rejected'].includes(state);

/** The worker seals participants at entry. Excluded followers must not be invented from today's config. */
function groupLimitTrade(status: GroupLimitUiStatus | null | undefined, entryOperationId: string | null | undefined,
  symbol: string | null | undefined, permitPendingAction = false): GroupLimitTradeState | null {
  const group = status?.group;
  if (!group || group.manualOnly === true || group.leaderAccountId == null || !entryOperationId || !symbol) return null;
  const matches = status?.controller?.groupLimitTrades?.filter(trade => trade.groupId === group.id
    && trade.entryOperationId === entryOperationId && trade.symbol === symbol) ?? [];
  if (matches.length !== 1) return null;
  const trade = matches[0];
  if ((!permitPendingAction && trade.pendingOperationId) || !GROUP_LIMIT_STATE_HASH_PATTERN.test(trade.stateHash)
    || !trade.accounts.length || new Set(trade.accounts.map(row => row.accountId)).size !== trade.accounts.length) return null;
  const leader = trade.accounts.find(row => row.accountId === group.leaderAccountId);
  if (!leader || leader.role !== 'leader' || !quantity(leader.expectedQuantity)) return null;
  for (const row of trade.accounts) {
    const follower = group.followers.find(item => item.accountId === row.accountId);
    if (row.accountId !== group.leaderAccountId && !follower) return null;
    if (row.role !== (row.accountId === group.leaderAccountId ? 'leader' : 'follower')
      || !quantity(row.expectedQuantity)
      || ((!permitPendingAction || row.role === 'leader') && (row.verifiedAt == null || !Number.isFinite(row.verifiedAt)))) return null;
  }
  return trade;
}

/** Display eligibility only. The desk reselects from fresh status at click; the worker validates again. */
export function groupLimitPendingMoveTrade(status: GroupLimitUiStatus | null | undefined,
  entryOperationId: string | null | undefined, symbol: string | null | undefined): GroupLimitTradeState | null {
  if (!supportsCopierGroupLimitMove(status)) return null;
  const trade = groupLimitTrade(status, entryOperationId, symbol);
  if (!trade || trade.state !== 'pending') return null;
  for (const row of trade.accounts) {
    const { entry, stop, target } = row;
    if (row.state !== 'pending' || row.openQuantity !== 0 || row.issue || !entry || entry.state !== 'working'
      || entry.filledQuantity !== 0 || entry.quantity !== row.expectedQuantity || !entry.brokerOrderId || !price(entry.price)) return null;
    if (!stop && !target) { if (!supportsCopierGroupLimitBare(status)) return null; continue; } // Explicit bare LIMIT; never a bare Stop/Market projection.
    if (!stop || !target || stop.state !== 'pending' || target.state !== 'pending'
      || [stop, target].some(order => !order.brokerOrderId || order.quantity !== row.expectedQuantity || order.filledQuantity !== 0)
      || new Set([entry.brokerOrderId, stop.brokerOrderId, target.brokerOrderId]).size !== 3
      || !price(stop.price) || !price(target.price)
      || (trade.side === 'Buy' ? !(stop.price < entry.price && entry.price < target.price)
        : !(target.price < entry.price && entry.price < stop.price))) return null;
  }
  // A partially built protection set must not be presented as either a bare or protected complete group.
  if (new Set(trade.accounts.map(row => row.stop == null && row.target == null)).size !== 1) return null;
  return trade;
}

/** No working entry remainder may compete with newly placed protection. Verified flat members are a no-op. */
export function groupLimitPositionManageTrade(status: GroupLimitUiStatus | null | undefined,
  entryOperationId: string | null | undefined, symbol: string | null | undefined): GroupLimitTradeState | null {
  if (!supportsCopierGroupLimitManage(status)) return null;
  const trade = groupLimitTrade(status, entryOperationId, symbol);
  if (!trade || !['position', 'mixed'].includes(trade.state)) return null;
  for (const row of trade.accounts) {
    if (row.issue || !row.entry || !row.entry.brokerOrderId || row.entry.quantity !== row.expectedQuantity || !terminal(row.entry.state)
      || !Number.isSafeInteger(row.entry.filledQuantity) || row.entry.filledQuantity < 0
      || row.entry.filledQuantity > row.expectedQuantity) return null;
    if (row.state === 'flat' && row.openQuantity === 0) {
      if ([row.stop, row.target].some(leg => leg && !terminal(leg.state))) return null;
      continue;
    }
    if (row.state !== 'position' || !quantity(row.openQuantity ?? 0)
      || row.openQuantity! > row.entry.filledQuantity) return null;
    const ids = [row.entry.brokerOrderId];
    for (const leg of [row.stop, row.target]) {
      if (!leg) continue;
      if (leg.state !== 'working' || leg.quantity !== row.openQuantity || leg.filledQuantity !== 0
        || !leg.brokerOrderId || !price(leg.price)) return null;
      ids.push(leg.brokerOrderId);
    }
    if (new Set(ids).size !== ids.length) return null;
  }
  const leader = trade.accounts.find(row => row.role === 'leader');
  return leader?.state === 'position' && price(leader.entry?.price ?? null) ? trade : null;
}

/** Cancel is risk reducing: known own remainders may be canceled while a previous move is unresolved. */
export function groupLimitCancelTrade(status: GroupLimitUiStatus | null | undefined,
  entryOperationId: string | null | undefined, symbol: string | null | undefined): GroupLimitTradeState | null {
  if (!supportsCopierGroupLimitManage(status)) return null;
  const trade = groupLimitTrade(status, entryOperationId, symbol, true);
  if (!trade || !['pending', 'mixed', 'unknown'].includes(trade.state)) return null;
  const leader = trade.accounts.find(row => row.role === 'leader');
  return leader?.entry?.brokerOrderId && ['pending', 'working'].includes(leader.entry.state)
    && quantity(leader.entry.quantity) && Number.isSafeInteger(leader.entry.filledQuantity)
    && leader.entry.filledQuantity >= 0 && leader.entry.filledQuantity < leader.entry.quantity ? trade : null;
}

/** The quantity in manage payloads is always the actual leader quantity, never chart group totals. */
export function groupLimitLegTrade(trade: GroupLimitTradeState | null): LiveGroupLimitLegTrade | null {
  const leader = trade?.accounts.find(row => row.role === 'leader');
  if (!trade || !leader || !quantity(leader.openQuantity ?? 0) || !price(leader.entry?.price ?? null)) return null;
  return { entryOperationId: trade.entryOperationId, symbol: trade.symbol, side: trade.side,
    quantity: leader.openQuantity!, referencePrice: leader.entry!.price!, groupLimitStateHash: trade.stateHash,
    ...(leader.stop ? { hasStop: true } : {}), ...(leader.target ? { hasTarget: true } : {}) };
}

/** Keep group provenance own after historical OSO legs have been removed or replaced. */
export function groupLimitOwnManageEntry(status: GroupLimitUiStatus | null | undefined,
  symbol: string | null | undefined, side: 'long' | 'short' | null | undefined) {
  if (!symbol || !side) return null;
  const candidates = (status?.controller?.groupLimitTrades ?? []).map(trade => groupLimitPositionManageTrade(status, trade.entryOperationId, symbol))
    .filter((trade): trade is GroupLimitTradeState => trade != null && side === (trade.side === 'Buy' ? 'long' : 'short'));
  if (candidates.length !== 1) return null;
  const trade = candidates[0], leader = trade.accounts.find(row => row.role === 'leader')!;
  return { source: 'own' as const, entryOperationId: trade.entryOperationId, leaderEntryOrderId: leader.entry!.brokerOrderId,
    symbol: trade.symbol, side: trade.side, bare: leader.stop == null || leader.target == null, entryAvgPrice: null };
}

export function groupLimitSeenHash(trade: BareLeaderTrade): string | null {
  const value = (trade as Partial<LiveGroupLimitLegTrade>).groupLimitStateHash;
  return typeof value === 'string' && GROUP_LIMIT_STATE_HASH_PATTERN.test(value) ? value : null;
}

export function groupLimitCommandFields(trade: GroupLimitTradeState): GroupLimitCommandFields {
  return { groupLimitContract: GROUP_LIMIT_CONTRACT, groupLimitStateHash: trade.stateHash };
}

/** Zero-fill cancel keeps the existing wire shape: filledQuantity is present only for partial fills. */
export function groupLimitCancelExpect(trade: GroupLimitTradeState, seenPrice: number): LeaderOrderManageCommand['expect'] {
  const entry = trade.accounts.find(row => row.role === 'leader')?.entry;
  if (!entry || !quantity(entry.quantity) || !Number.isSafeInteger(entry.filledQuantity) || entry.filledQuantity < 0
    || entry.filledQuantity >= entry.quantity) throw new LiveCommandNotSentError('Čekající zbytek není ověřený — nic se neodeslalo.');
  return { price: seenPrice, quantity: entry.quantity, ...(entry.filledQuantity > 0 ? { filledQuantity: entry.filledQuantity } : {}) };
}

export { groupLimitOutcomeNotice } from './groupLimitUiNotice';

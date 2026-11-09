import type { GroupLimitAccountState, GroupLimitOrderState, GroupLimitTradeState } from '../lib/groupLimitProtocol';
import { copyGroupConfigHash } from '../lib/leaderEntryPreview';
import { stableHash64 } from './copierKeys';
import type { BrokerOrder } from './brokerPort';
import type { CopierManualEntryRecord, CopierState } from './copierEngine';
import { followerQuantity } from './copierEngine';
import type { OsoOutboxEntry } from './copierOsoOutbox';
import type { OutboxEntry } from './copierOutbox';
import type { CopyGroupConfig } from './liveCopyTrading';

/** Separate opt-in; never broadens the solo DEMO capability gates. */
export function groupLimitsEnabled(optIn: boolean, group: CopyGroupConfig | null): boolean {
  return optIn && !!group && group.enabled && group.localOnly === true && group.manualOnly !== true
    && group.leaderAccountId != null && group.followers.some(f => f.enabled !== false && f.mode !== 'off')
    && group.followers.filter(f => f.enabled !== false && f.mode !== 'off').every(f => f.mode === 'on-submit');
}

export interface GroupLimitMemberRecord {
  accountId: number;
  entryId: string;
  stopId?: string;
  targetId?: string;
  quantity: number;
  entryFrom: number;
  stopFrom?: number;
  targetFrom?: number;
  routeEpoch?: number;
  status: 'planned' | 'sending' | 'acknowledged' | 'unknown' | 'rejected' | 'not-sent';
  phase?: 'write-sending' | 'oco-acked' | 'target-canceled';
  tag?: string;
  oldLegId?: string;
  newStopId?: string;
  newTargetId?: string;
  reason?: string;
  openedAt?: number;
  closedAt?: number;
  filledQuantity?: number;
}

/** Stream proof can advance while a broker write awaits. ACK binding must never erase it. */
export function mergeGroupLimitMembers(current: readonly GroupLimitMemberRecord[] | undefined, updates: readonly GroupLimitMemberRecord[]): GroupLimitMemberRecord[] {
  return updates.map(member => {
    const latest = current?.find(saved => saved.accountId === member.accountId && saved.entryId === member.entryId);
    return { ...member,
      ...(latest?.closedAt != null ? { closedAt: latest.closedAt } : {}),
      ...(latest?.openedAt != null ? { openedAt: latest.openedAt } : {}),
      ...((latest?.filledQuantity != null || member.filledQuantity != null) ? { filledQuantity: Math.max(latest?.filledQuantity ?? 0, member.filledQuantity ?? 0) } : {}),
    };
  });
}

export interface GroupLimitProjectionInput {
  group: CopyGroupConfig;
  entry: CopierManualEntryRecord;
  state: CopierState;
  oso: Iterable<OsoOutboxEntry>;
  outbox: Iterable<OutboxEntry>;
  orders(accountId: number): ReadonlyMap<string, BrokerOrder> | undefined;
  net(accountId: number, symbol: string): number | null;
  observed(accountId: number, id: string): BrokerOrder['status'] | undefined;
  filled(accountId: number, id: string): number;
  route(accountId: number): number | undefined;
  verifiedAt: number | null;
  externalFence?: string;
  ownsPosition?(accountId: number, entryId: string, net: number): boolean;
  pendingOperationId?: string;
}

function orderState(order: BrokerOrder | undefined, id: string | undefined, quantity: number,
  status: BrokerOrder['status'] | undefined, filled: number): GroupLimitOrderState | null {
  if (!id) return null;
  const current = order?.status ?? status;
  return { brokerOrderId: id, quantity: order?.quantity ?? quantity,
    filledQuantity: Math.max(order?.filledQuantity ?? 0, filled),
    price: order ? (order.orderType === 'Stop' ? order.stopPrice : order.limitPrice) ?? null : null,
    state: current === 'pending' || current === 'working' || current === 'filled' || current === 'canceled' || current === 'rejected' ? current : 'unknown',
    ...(order?.sourceVersion != null ? { sourceVersion: order.sourceVersion } : {}) };
}

/** Only ACKs and exact persisted links grant ownership. Similar prices/qty never do. */
export function projectGroupLimitTrade(input: GroupLimitProjectionInput): GroupLimitTradeState | null {
  const { group, entry } = input;
  if (entry.status !== 'acknowledged' || entry.request.orderType !== 'Limit' || entry.scaleIn
    || !entry.entryBrokerOrderId || entry.request.accountId !== group.leaderAccountId) return null;
  const leaderId = entry.entryBrokerOrderId;
  const copies = [...input.oso].filter(copy => copy.leaderEntryOrderId === leaderId);
  const ordinaryCopies = [...input.outbox];
  const members = [
    { accountId: entry.request.accountId, role: 'leader' as const, quantity: entry.request.quantity,
      entryId: leaderId, stopId: entry.stopBrokerOrderId, targetId: entry.targetBrokerOrderId, mapped: true },
    ...group.followers.filter(f => entry.groupLimitParticipants
      ? entry.groupLimitParticipants.some(member => member.accountId === f.accountId)
      : f.enabled !== false && f.mode !== 'off').map(f => {
      const matching = copies.filter(copy => copy.request.accountId === f.accountId);
      const copy = matching.length === 1 ? matching[0] : undefined;
      const quantity = followerQuantity(entry.request.quantity, f.multiplier);
      if (entry.bare && entry.groupLimitContract === 1) {
        const ordinary = ordinaryCopies.filter(copy => copy.leaderOrderId === leaderId && copy.request.accountId === f.accountId);
        const bare = ordinary.length === 1 ? ordinary[0] : undefined;
        const link = (input.state.links.get(leaderId) ?? []).find(link => link.accountId === f.accountId && link.brokerOrderId === bare?.brokerOrderId && link.quantity === quantity);
        const saved = entry.groupLimitMembers?.find(member => member.accountId === f.accountId);
        return { accountId: f.accountId, role: 'follower' as const, quantity,
          entryId: bare?.brokerOrderId, stopId: saved?.stopId, targetId: saved?.targetId,
          mapped: bare?.status === 'acknowledged' && !!link && bare.request.quantity === quantity };
      }
      const exactLink = (leaderOrderId: string | undefined, id: string | undefined) => !!leaderOrderId && !!id
        && (input.state.links.get(leaderOrderId) ?? []).filter(link => link.accountId === f.accountId && link.brokerOrderId === id && link.quantity === quantity).length === 1;
      const managed = entry.groupLimitMembers?.find(member => member.accountId === f.accountId);
      return { accountId: f.accountId, role: 'follower' as const, quantity,
        entryId: copy?.entryBrokerOrderId, stopId: managed ? managed.stopId : copy?.firstBrokerOrderId, targetId: managed ? managed.targetId : copy?.secondBrokerOrderId,
        mapped: copy?.status === 'acknowledged' && copy.request.quantity === quantity
          && exactLink(leaderId, copy.entryBrokerOrderId)
          && exactLink(copy.leaderStopOrderId, copy.firstBrokerOrderId)
          && exactLink(copy.leaderTargetOrderId, copy.secondBrokerOrderId) };
    }),
  ];
  const accounts: GroupLimitAccountState[] = members.map(member => {
    const rows = input.orders(member.accountId);
    const make = (id: string | undefined) => orderState(id ? rows?.get(id) : undefined, id, member.quantity,
      id ? input.observed(member.accountId, id) : undefined, id ? input.filled(member.accountId, id) : 0);
    const ownEntry = make(member.entryId), stop = make(member.stopId), target = make(member.targetId);
    // Historical Limit order price for UI expectations; explicitly not a fill VWAP or risk price.
    if (ownEntry && ownEntry.price == null) ownEntry.price = entry.request.price ?? entry.request.referencePrice ?? null;
    const net = input.net(member.accountId, entry.request.symbol);
    const signed = entry.request.side === 'Buy' ? 1 : -1;
    const pending = ownEntry?.state === 'working' && ownEntry.filledQuantity === 0 && net === 0;
    const ownershipEnded = entry.closedAt != null || entry.groupLimitMembers?.find(saved => saved.accountId === member.accountId)?.closedAt != null;
    const position = !ownershipEnded && net != null && net * signed > 0 && ownEntry != null && ownEntry.filledQuantity >= Math.abs(net)
      && (input.ownsPosition?.(member.accountId, ownEntry.brokerOrderId, net) ?? true);
    const flat = net === 0 && ownEntry != null && ['canceled', 'filled', 'rejected'].includes(ownEntry.state)
      && ![stop, target].some(leg => leg?.state === 'pending' || leg?.state === 'working');
    const configValid = (entry.groupLimitConfigHash == null || entry.groupLimitConfigHash === copyGroupConfigHash(group)) && input.route(member.accountId) != null;
    return { accountId: member.accountId, role: member.role, expectedQuantity: member.quantity,
      openQuantity: net == null ? null : Math.abs(net), entry: ownEntry, stop, target,
      state: member.mapped && configValid ? pending ? 'pending' : position ? 'position' : flat ? 'flat' : 'unknown' : 'unknown',
      verifiedAt: input.verifiedAt, ...(!member.mapped || !configValid ? { issue: 'Chybí jednoznačné potvrzené kopie/bindingy nebo se změnila konfigurace.' } : {}) };
  });
  const states = new Set(accounts.map(account => account.state));
  const state: GroupLimitTradeState['state'] = states.has('unknown') ? 'unknown'
    : states.size > 1 ? 'mixed' : accounts[0]?.state ?? 'unknown';
  const stateHash = stableHash64(JSON.stringify([copyGroupConfigHash(group), input.externalFence ?? '', entry.operationId, entry.request.symbol, entry.request.side,
    accounts.map(({ verifiedAt: _time, ...account }) => [account, input.net(account.accountId, entry.request.symbol), input.route(account.accountId) ?? null]) ]));
  return { groupId: group.id, entryOperationId: entry.operationId, symbol: entry.request.symbol,
    side: entry.request.side, accounts, state, stateHash, ...(input.pendingOperationId ? { pendingOperationId: input.pendingOperationId } : {}) };
}

/** Complete prewrite shape check for every account, independently of leader-only UI. */
export function groupProtectedLimitMoveProblem(trade: GroupLimitTradeState,
  orders: (accountId: number) => ReadonlyMap<string, BrokerOrder> | undefined): string | null {
  if (trade.state !== 'pending') return 'Skupina nemá potvrzený nevyplněný Limit na všech účtech.';
  for (const account of trade.accounts) {
    const entry = account.entry && orders(account.accountId)?.get(account.entry.brokerOrderId);
    const stop = account.stop && orders(account.accountId)?.get(account.stop.brokerOrderId);
    const target = account.target && orders(account.accountId)?.get(account.target.brokerOrderId);
    const q = account.expectedQuantity;
    const side = trade.side === 'Buy' ? 'Sell' : 'Buy';
    if (!entry || !stop || !target || entry.orderType !== 'Limit' || entry.status !== 'working' || entry.side !== trade.side
      || stop.orderType !== 'Stop' || target.orderType !== 'Limit' || stop.status !== 'pending' || target.status !== 'pending'
      || stop.side !== side || target.side !== side || entry.symbol !== trade.symbol || stop.symbol !== trade.symbol || target.symbol !== trade.symbol
      || stop.parentOrderId !== entry.brokerOrderId || target.parentOrderId !== entry.brokerOrderId
      || [entry, stop, target].some(row => row.quantity !== q || row.filledQuantity !== 0)
      || entry.limitPrice == null || stop.stopPrice == null || target.limitPrice == null
      || account.openQuantity !== 0) return `Účet ${account.accountId}: vstup/nohy nebo flat stav nejsou jednoznačně potvrzené.`;
    const own = new Set([entry.brokerOrderId, stop.brokerOrderId, target.brokerOrderId]);
    if ([...(orders(account.accountId)?.values() ?? [])].some(row => (row.status === 'pending' || row.status === 'working') && !own.has(row.brokerOrderId))) {
      return `Účet ${account.accountId}: pracuje další příkaz.`;
    }
  }
  return null;
}

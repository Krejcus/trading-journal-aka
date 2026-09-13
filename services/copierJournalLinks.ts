import type { CopierSnapshot } from './copierStore';
import { journalObservation, type JournalObservation } from '../lib/tradovateJournalEvidence';

/** Only durable order identities, never the current configured follower count. */
export function copierJournalLinks(snapshot: CopierSnapshot, resolveLeader: (orderId: string) => { connectionId: string; accountId: number } | null, at: number): JournalObservation[] {
  const result: JournalObservation[] = [];
  const add = (leaderOrderId: string, accountId: number, orderId: string, role: string) => {
    const owner = resolveLeader(leaderOrderId);
    if (!owner) return;
    const leaderConnectionId = owner.connectionId;
    const leaderAccountId = owner.accountId;
    const observation = journalObservation('copylink', {
      id: `${leaderConnectionId}:${leaderOrderId}:${accountId}:${orderId}:${role}`,
      leaderConnectionId, leaderAccountId, leaderOrderId, accountId, orderId, role, status: 'linked',
    }, 'snapshot', 'Observed', at);
    if (observation) result.push(observation);
  };
  for (const [leaderOrderId, links] of snapshot.links) {
    const owner = resolveLeader(leaderOrderId);
    if (!owner) continue;
    add(leaderOrderId, owner.accountId, leaderOrderId, 'entry');
    for (const link of links) add(leaderOrderId, link.accountId, link.brokerOrderId, link.nativeOsoRole ?? 'entry');
  }
  for (const entry of [...(snapshot.bracketOutbox ?? []), ...(snapshot.osoOutbox ?? [])]) {
    const owner = resolveLeader(entry.leaderEntryOrderId);
    if (!owner) continue;
    const leaderAccountId = owner.accountId;
    add(entry.leaderEntryOrderId, leaderAccountId, entry.leaderEntryOrderId, 'entry');
    add(entry.leaderEntryOrderId, leaderAccountId, entry.leaderStopOrderId, 'stop');
    add(entry.leaderEntryOrderId, leaderAccountId, entry.leaderTargetOrderId, 'target');
    if (entry.firstBrokerOrderId) add(entry.leaderEntryOrderId, entry.request.accountId, entry.firstBrokerOrderId, entry.request.first.orderType === 'Limit' ? 'target' : 'stop');
    if (entry.secondBrokerOrderId) add(entry.leaderEntryOrderId, entry.request.accountId, entry.secondBrokerOrderId, entry.request.second.orderType === 'Limit' ? 'target' : 'stop');
  }
  return [...new Map(result.map(event => [event.entity.id, event])).values()];
}

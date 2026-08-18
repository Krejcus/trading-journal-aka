import type { BrokerOcoRequest, BrokerOrder } from './brokerPort';
import type { OutboxStatus } from './copierOutbox';

/**
 * Durable outbox pro jeden atomicky odeslaný OCO pár.
 *
 * Dva protective legy nesmí používat dva nezávislé placeOrder side effecty.
 * Po pádu/timeoutu se proto oba dohledávají jako jeden celek. Částečný nález
 * nikdy neopravujeme druhým příkazem: runtime se zavře a čeká na člověka.
 */
export interface BracketOutboxEntry {
  key: string;
  tag: string;
  leaderEntryOrderId: string;
  leaderStopOrderId: string;
  leaderTargetOrderId: string;
  leaderEventId: string;
  leaderSequence: number;
  request: BrokerOcoRequest;
  status: OutboxStatus;
  attempts: number;
  firstBrokerOrderId?: string;
  secondBrokerOrderId?: string;
  reason?: string;
  updatedAt: number;
}

export type BracketOutboxAction =
  | { type: 'send' }
  | { type: 'lookup'; firstTag: string; secondTag: string }
  | { type: 'skip'; reason: 'already-acknowledged' | 'rejected' | 'abandoned' | 'waived' };

export const secondBracketTag = (tag: string): string => `${tag}b`;

export function createBracketOutboxEntry(options: {
  key: string;
  tag: string;
  leaderEntryOrderId: string;
  leaderStopOrderId: string;
  leaderTargetOrderId: string;
  leaderEventId: string;
  leaderSequence: number;
  request: BrokerOcoRequest;
  now: number;
}): BracketOutboxEntry {
  return {
    ...options,
    status: 'planned',
    attempts: 0,
    updatedAt: options.now,
  };
}

export function nextBracketAction(entry: BracketOutboxEntry): BracketOutboxAction {
  switch (entry.status) {
    case 'acknowledged': return { type: 'skip', reason: 'already-acknowledged' };
    case 'rejected': return { type: 'skip', reason: 'rejected' };
    case 'abandoned': return { type: 'skip', reason: 'abandoned' };
    case 'waived': return { type: 'skip', reason: 'waived' };
    case 'sending':
    case 'unknown':
      return { type: 'lookup', firstTag: entry.tag, secondTag: secondBracketTag(entry.tag) };
    case 'planned':
    default:
      return { type: 'send' };
  }
}

export function markBracketSending(entry: BracketOutboxEntry, now: number): BracketOutboxEntry {
  return { ...entry, status: 'sending', attempts: entry.attempts + 1, updatedAt: now };
}

export function markBracketAcknowledged(
  entry: BracketOutboxEntry,
  firstBrokerOrderId: string,
  secondBrokerOrderId: string,
  now: number,
): BracketOutboxEntry {
  return {
    ...entry,
    status: 'acknowledged',
    firstBrokerOrderId,
    secondBrokerOrderId,
    updatedAt: now,
  };
}

export function markBracketUnknown(
  entry: BracketOutboxEntry,
  reason: string,
  now: number,
): BracketOutboxEntry {
  return { ...entry, status: 'unknown', reason, updatedAt: now };
}

export function markBracketRejected(
  entry: BracketOutboxEntry,
  reason: string,
  now: number,
): BracketOutboxEntry {
  return { ...entry, status: 'rejected', reason, updatedAt: now };
}

export function waiveBracketOutboxEntry(
  entry: BracketOutboxEntry,
  reason: string,
  now: number,
): BracketOutboxEntry {
  return { ...entry, status: 'waived', reason, updatedAt: now };
}

export function resolveBracketLookup(
  entry: BracketOutboxEntry,
  first: readonly BrokerOrder[],
  second: readonly BrokerOrder[],
  completeness: 'authoritative' | 'eventual',
  now: number,
): BracketOutboxEntry {
  if (first.length > 1 || second.length > 1) {
    return {
      ...entry,
      status: 'abandoned',
      reason: `duplicitní OCO lookup: first=${first.length}, second=${second.length}`,
      updatedAt: now,
    };
  }

  if (first.length === 1 && second.length === 1) {
    const rejected = first[0].status === 'rejected' || second[0].status === 'rejected';
    return rejected
      ? markBracketRejected(
          entry,
          first[0].rejectReason ?? second[0].rejectReason ?? 'OCO leg byl odmítnut',
          now,
        )
      : markBracketAcknowledged(entry, first[0].brokerOrderId, second[0].brokerOrderId, now);
  }

  if (completeness === 'eventual') {
    return markBracketUnknown(entry, 'OCO lookup zatím není autoritativní', now);
  }

  if (first.length !== second.length) {
    return {
      ...entry,
      status: 'abandoned',
      reason: `částečný OCO výsledek: first=${first.length}, second=${second.length}; ruční kontrola nutná`,
      updatedAt: now,
    };
  }

  // Autoritativně nenalezen ani jeden leg. Side effect nevznikl, ale nový
  // pokus přesto neprovádí recovery automaticky; musí znovu projít seriální
  // event cestou a všemi gate kontrolami.
  return { ...entry, status: 'planned', reason: 'OCO autoritativně nenalezeno', updatedAt: now };
}

export function stuckBracketEntries(entries: Iterable<BracketOutboxEntry>): BracketOutboxEntry[] {
  return [...entries].filter(entry =>
    entry.status === 'sending'
    || entry.status === 'unknown'
    || entry.status === 'rejected'
    || entry.status === 'abandoned');
}

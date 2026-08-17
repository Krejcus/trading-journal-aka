import type { BrokerOrder, BrokerOsoRequest } from './brokerPort';
import type { OutboxStatus } from './copierOutbox';

/** Durable outbox pro atomický čekající entry + SL + TP (`placeOSO`). */
export interface OsoOutboxEntry {
  key: string;
  tag: string;
  leaderEntryOrderId: string;
  leaderStopOrderId: string;
  leaderTargetOrderId: string;
  leaderEventId: string;
  leaderSequence: number;
  request: BrokerOsoRequest;
  status: OutboxStatus;
  attempts: number;
  entryBrokerOrderId?: string;
  firstBrokerOrderId?: string;
  secondBrokerOrderId?: string;
  reason?: string;
  updatedAt: number;
}

export type OsoOutboxAction =
  | { type: 'send' }
  | { type: 'lookup'; entryTag: string; firstTag: string; secondTag: string }
  | { type: 'skip'; reason: 'already-acknowledged' | 'rejected' | 'abandoned' | 'waived' };

export const firstOsoTag = (tag: string): string => `${tag}s`;
export const secondOsoTag = (tag: string): string => `${tag}t`;

export function createOsoOutboxEntry(options: Omit<OsoOutboxEntry, 'status' | 'attempts'>): OsoOutboxEntry {
  return { ...options, status: 'planned', attempts: 0 };
}

export function nextOsoAction(entry: OsoOutboxEntry): OsoOutboxAction {
  switch (entry.status) {
    case 'acknowledged': return { type: 'skip', reason: 'already-acknowledged' };
    case 'rejected': return { type: 'skip', reason: 'rejected' };
    case 'abandoned': return { type: 'skip', reason: 'abandoned' };
    case 'waived': return { type: 'skip', reason: 'waived' };
    case 'sending':
    case 'unknown':
      return {
        type: 'lookup', entryTag: entry.tag,
        firstTag: firstOsoTag(entry.tag), secondTag: secondOsoTag(entry.tag),
      };
    case 'planned':
    default: return { type: 'send' };
  }
}

export const markOsoSending = (entry: OsoOutboxEntry, now: number): OsoOutboxEntry => ({
  ...entry, status: 'sending', attempts: entry.attempts + 1, updatedAt: now,
});

export const markOsoUnknown = (entry: OsoOutboxEntry, reason: string, now: number): OsoOutboxEntry => ({
  ...entry, status: 'unknown', reason, updatedAt: now,
});

export const markOsoRejected = (entry: OsoOutboxEntry, reason: string, now: number): OsoOutboxEntry => ({
  ...entry, status: 'rejected', reason, updatedAt: now,
});

export const markOsoAcknowledged = (
  entry: OsoOutboxEntry,
  entryBrokerOrderId: string,
  firstBrokerOrderId: string,
  secondBrokerOrderId: string,
  now: number,
): OsoOutboxEntry => ({
  ...entry, status: 'acknowledged', entryBrokerOrderId, firstBrokerOrderId,
  secondBrokerOrderId, updatedAt: now,
});

export const waiveOsoOutboxEntry = (
  entry: OsoOutboxEntry, reason: string, now: number,
): OsoOutboxEntry => ({ ...entry, status: 'waived', reason, updatedAt: now });

/**
 * Recovery nikdy nedoplňuje chybějící část strategie. Buď jsou přesně všechny
 * tři objednávky, nebo runtime zůstane zavřený pro ruční kontrolu.
 */
export function resolveOsoLookup(
  entry: OsoOutboxEntry,
  entryOrders: readonly BrokerOrder[],
  firstOrders: readonly BrokerOrder[],
  secondOrders: readonly BrokerOrder[],
  completeness: 'authoritative' | 'eventual',
  now: number,
): OsoOutboxEntry {
  if (entryOrders.length > 1 || firstOrders.length > 1 || secondOrders.length > 1) {
    return {
      ...entry, status: 'abandoned', updatedAt: now,
      reason: `duplicitní OSO lookup: entry=${entryOrders.length}, first=${firstOrders.length}, second=${secondOrders.length}`,
    };
  }
  if (entryOrders.length === 1 && firstOrders.length === 1 && secondOrders.length === 1) {
    const rejected = [...entryOrders, ...firstOrders, ...secondOrders].find(order => order.status === 'rejected');
    return rejected
      ? markOsoRejected(entry, rejected.rejectReason ?? 'OSO objednávka byla odmítnuta', now)
      : markOsoAcknowledged(
          entry, entryOrders[0].brokerOrderId, firstOrders[0].brokerOrderId,
          secondOrders[0].brokerOrderId, now,
        );
  }
  if (completeness === 'eventual') {
    return markOsoUnknown(entry, 'OSO lookup zatím není autoritativní', now);
  }
  const total = entryOrders.length + firstOrders.length + secondOrders.length;
  if (total === 0) {
    return { ...entry, status: 'planned', reason: 'OSO autoritativně nenalezeno', updatedAt: now };
  }
  return {
    ...entry, status: 'abandoned', updatedAt: now,
    reason: `částečný OSO výsledek: entry=${entryOrders.length}, first=${firstOrders.length}, second=${secondOrders.length}; ruční kontrola nutná`,
  };
}

export function stuckOsoEntries(entries: Iterable<OsoOutboxEntry>): OsoOutboxEntry[] {
  return [...entries].filter(entry => (
    entry.status === 'sending' || entry.status === 'unknown'
    || entry.status === 'rejected' || entry.status === 'abandoned'
  ));
}

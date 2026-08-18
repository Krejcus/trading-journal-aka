import type { BrokerOrder, OrderType } from './brokerPort';

export type CancelStatus = 'planned' | 'sending' | 'unknown' | 'confirmed' | 'abandoned' | 'waived';

export interface CancelOutboxEntry {
  operation: 'cancel' | 'modify';
  key: string;
  leaderEventId: string;
  leaderSequence: number;
  accountId: number;
  brokerOrderId: string;
  changes?: { quantity: number; orderType: OrderType; limitPrice?: number; stopPrice?: number };
  status: CancelStatus;
  attempts: number;
  outcome?: BrokerOrder['status'];
  reason?: string;
  updatedAt: number;
}

export function createCancelEntry(
  key: string,
  leaderEventId: string,
  leaderSequence: number,
  accountId: number,
  brokerOrderId: string,
  now: number,
): CancelOutboxEntry {
  return { operation: 'cancel', key, leaderEventId, leaderSequence, accountId, brokerOrderId, status: 'planned', attempts: 0, updatedAt: now };
}

export function createModifyEntry(
  key: string,
  leaderEventId: string,
  leaderSequence: number,
  accountId: number,
  brokerOrderId: string,
  changes: { quantity: number; orderType: OrderType; limitPrice?: number; stopPrice?: number },
  now: number,
): CancelOutboxEntry {
  return {
    operation: 'modify', key, leaderEventId, leaderSequence, accountId, brokerOrderId,
    changes, status: 'planned', attempts: 0, updatedAt: now,
  };
}

export function markCancelSending(entry: CancelOutboxEntry, now: number): CancelOutboxEntry {
  return { ...entry, status: 'sending', attempts: entry.attempts + 1, updatedAt: now };
}

export function markCancelUnknown(entry: CancelOutboxEntry, reason: string, now: number): CancelOutboxEntry {
  return { ...entry, status: 'unknown', reason, updatedAt: now };
}

export function waiveCancelEntry(entry: CancelOutboxEntry, reason: string, now: number): CancelOutboxEntry {
  return { ...entry, status: 'waived', reason, updatedAt: now };
}

export function resolveCancelLookup(
  entry: CancelOutboxEntry,
  order: BrokerOrder | null,
  completeness: 'authoritative' | 'eventual',
  now: number,
): CancelOutboxEntry {
  if (!order) {
    return completeness === 'authoritative'
      ? { ...entry, status: 'abandoned', reason: 'objednávka podle brokerOrderId neexistuje', updatedAt: now }
      : markCancelUnknown(entry, 'prázdný lookup z eventual streamu', now);
  }
  if (entry.operation === 'modify') {
    if (order.status !== 'working') {
      return {
        ...entry, status: 'abandoned', outcome: order.status,
        reason: `modify nebyl potvrzen; objednávka skončila jako ${order.status}`, updatedAt: now,
      };
    }
    const changes = entry.changes;
    const matches = changes != null
      && order.quantity === changes.quantity
      && order.orderType === changes.orderType
      && order.limitPrice === changes.limitPrice
      && order.stopPrice === changes.stopPrice;
    return matches
      ? { ...entry, status: 'confirmed', outcome: 'working', reason: undefined, updatedAt: now }
      : markCancelUnknown(entry, entry.reason ?? 'změna zatím není potvrzena order streamem', now);
  }
  if (order.status === 'canceled') {
    return { ...entry, status: 'confirmed', outcome: 'canceled', reason: undefined, updatedAt: now };
  }
  if (order.status === 'filled' || order.status === 'rejected') {
    return {
      ...entry,
      status: 'abandoned',
      outcome: order.status,
      reason: `cancel nebyl potvrzen; objednávka skončila jako ${order.status}`,
      updatedAt: now,
    };
  }
  return markCancelUnknown(entry, entry.reason ?? 'cancel zatím není potvrzen order streamem', now);
}

export function stuckCancelEntries(entries: Iterable<CancelOutboxEntry>): CancelOutboxEntry[] {
  return [...entries].filter(entry =>
    entry.status === 'sending' || entry.status === 'unknown' || entry.status === 'abandoned');
}

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
  /**
   * Preflight operaci odmítl a na brokera NIC neodešlo. Takový `unknown`
   * pořád blokuje nový ARM (do reconciliation), ale nesmí blokovat nouzový
   * Flatten: neexistuje žádný nejistý side effect, který by Flatten mohl
   * zdvojit — a bez této výjimky by detekce cizího zásahu zablokovala
   * přesně to zavření, které sama vyvolala.
   */
  neverSent?: boolean;
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

/** Preflight odmítl operaci PŘED odesláním — viz `neverSent`. */
export function markCancelRefused(entry: CancelOutboxEntry, reason: string, now: number): CancelOutboxEntry {
  return { ...entry, status: 'unknown', reason, updatedAt: now, neverSent: true };
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
    if (order.status === 'canceled') {
      // Závod lifecycle při rychlém ručním ovládání: leader objednávku
      // mezitím zrušil a mirror cancelu jde vlastní cestou. Modify je
      // bezpředmětný no-op, ne integritní chyba.
      return {
        ...entry, status: 'confirmed', outcome: 'canceled',
        reason: 'modify bezpředmětný — objednávka už je zrušená', updatedAt: now,
      };
    }
    if (order.status !== 'working') {
      // `rejected` u Tradovate cancel-replace znamená, že objednávka ZEMŘELA
      // (cancel prošel, replace ne) — follower může být bez ochrany.
      // `filled` znamená změněnou pozici. Obojí je vážné a failuje zavřeně.
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
  if (order.status === 'rejected') {
    // Objednávka u brokera zemřela rejectem — cíl cancelu („nesmí být
    // working") je splněn. Trestat tohle fail-closedem vyrábělo falešné
    // vypnutí uprostřed obchodu (živý incident 2026-08-20).
    return {
      ...entry, status: 'confirmed', outcome: 'rejected',
      reason: 'cancel bezpředmětný — objednávka skončila jako rejected', updatedAt: now,
    };
  }
  if (order.status === 'filled') {
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

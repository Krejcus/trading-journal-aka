import type { BrokerOrderRequest } from './brokerPort';

/**
 * Outbox odeslaných objednávek.
 *
 * Existuje proto, že Tradovate NENÍ idempotentní. `customTag50` je jen
 * volitelné textové pole — broker podle něj druhou objednávku neodmítne.
 * Když se odeslání zvrtne v timeout, prosté zopakování by založilo druhý
 * obchod.
 *
 * Řešení je stavový záznam u každé objednávky. Po nejasném konci se NIKDY
 * neposílá znovu naslepo — nejdřív se prohledá order stream podle tagu
 * a teprve podle nálezu se rozhodne.
 *
 * Stavy:
 *   planned      – naplánováno, u brokera zatím nic
 *   sending      – odeslání běží; při pádu procesu zůstane viset tady
 *   unknown      – timeout nebo síťová chyba, osud objednávky neznámý
 *   acknowledged – broker potvrdil, známe orderId
 *   rejected     – broker odmítl, konečný stav
 *   abandoned    – vzdáno po vyčerpání pokusů, čeká na člověka
 */

export type OutboxStatus =
  | 'planned'
  | 'sending'
  | 'unknown'
  | 'acknowledged'
  | 'rejected'
  | 'abandoned'
  /** Operátor potvrdil, že položka se nemá automaticky opakovat. */
  | 'waived';

export interface OutboxEntry {
  /** Čitelný vnitřní klíč. */
  key: string;
  /** Krátký tag posílaný brokerovi — podle něj se dohledává po timeoutu. */
  tag: string;
  /**
   * Leader objednávka, ze které replikace vznikla. Drží se tu proto, aby
   * se po restartu a dohledání dala obnovit vazba pro případné zrušení.
   */
  leaderOrderId: string;
  /** Stabilní zdrojová událost a její pořadí pro restart recovery. */
  leaderEventId?: string;
  leaderSequence?: number;
  request: BrokerOrderRequest;
  /** Tato place order představuje přírůstek on-fill cíle followera. */
  tracksFillTarget?: boolean;
  status: OutboxStatus;
  /** Počet pokusů o odeslání. Chrání před nekonečnou smyčkou. */
  attempts: number;
  brokerOrderId?: string;
  reason?: string;
  updatedAt: number;
}

export type OutboxAction =
  | { type: 'send' }
  | { type: 'lookup'; tag: string }
  | { type: 'skip'; reason: OutboxSkipReason };

export type OutboxSkipReason = 'already-acknowledged' | 'rejected' | 'abandoned' | 'waived';

export const DEFAULT_MAX_ATTEMPTS = 3;

export function createOutboxEntry(
  key: string,
  tag: string,
  leaderOrderId: string,
  request: BrokerOrderRequest,
  now: number,
  tracksFillTarget = false,
  leaderEventId = key,
  leaderSequence = 0,
): OutboxEntry {
  return {
    key, tag, leaderOrderId, leaderEventId, leaderSequence, request, tracksFillTarget,
    status: 'planned', attempts: 0, updatedAt: now,
  };
}

/**
 * Co se s položkou smí udělat.
 *
 * Klíčové pravidlo: `sending` i `unknown` vedou na `lookup`, nikdy rovnou
 * na `send`. `sending` znamená, že proces spadl uprostřed odesílání — a to
 * je stejně nejistý stav jako timeout.
 */
export function nextAction(entry: OutboxEntry, maxAttempts = DEFAULT_MAX_ATTEMPTS): OutboxAction {
  switch (entry.status) {
    case 'acknowledged':
      return { type: 'skip', reason: 'already-acknowledged' };
    case 'rejected':
      return { type: 'skip', reason: 'rejected' };
    case 'abandoned':
      return { type: 'skip', reason: 'abandoned' };
    case 'waived':
      return { type: 'skip', reason: 'waived' };
    case 'sending':
    case 'unknown':
      return { type: 'lookup', tag: entry.tag };
    case 'planned':
    default:
      return entry.attempts >= maxAttempts
        ? { type: 'skip', reason: 'abandoned' }
        : { type: 'send' };
  }
}

export function markSending(entry: OutboxEntry, now: number): OutboxEntry {
  return { ...entry, status: 'sending', attempts: entry.attempts + 1, updatedAt: now };
}

export function markAcknowledged(entry: OutboxEntry, brokerOrderId: string, now: number): OutboxEntry {
  return { ...entry, status: 'acknowledged', brokerOrderId, updatedAt: now };
}

export function markRejected(entry: OutboxEntry, reason: string, now: number): OutboxEntry {
  return { ...entry, status: 'rejected', reason, updatedAt: now };
}

/** Timeout nebo síťová chyba — osud objednávky neznáme. */
export function markUnknown(entry: OutboxEntry, reason: string, now: number): OutboxEntry {
  return { ...entry, status: 'unknown', reason, updatedAt: now };
}

export function waiveOutboxEntry(entry: OutboxEntry, reason: string, now: number): OutboxEntry {
  return { ...entry, status: 'waived', reason, updatedAt: now };
}

/**
 * Vyhodnocení dohledávky u brokera.
 *
 * `found` = objednávka s tímhle tagem u brokera existuje. Když ne, je
 * bezpečné poslat znovu — ale jen pokud zbývá pokus. Jinak radši vzdát
 * a nechat to na člověku, než donekonečna zkoušet.
 */
export function resolveLookup(
  entry: OutboxEntry,
  found: { brokerOrderId: string; rejected?: boolean; reason?: string } | null,
  completeness: 'authoritative' | 'eventual',
  now: number,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): OutboxEntry {
  if (found) {
    return found.rejected
      ? markRejected(entry, found.reason ?? 'rejected by broker', now)
      : markAcknowledged(entry, found.brokerOrderId, now);
  }
  if (completeness !== 'authoritative') {
    return {
      ...entry,
      status: 'unknown',
      reason: 'prázdný lookup není autoritativní; retry je zakázaný',
      updatedAt: now,
    };
  }
  if (entry.attempts >= maxAttempts) {
    return { ...entry, status: 'abandoned', reason: 'nenalezeno u brokera po vyčerpání pokusů', updatedAt: now };
  }
  return { ...entry, status: 'planned', updatedAt: now };
}

/** Položky, které blokují další práci a čekají na člověka. */
export function stuckEntries(entries: Iterable<OutboxEntry>): OutboxEntry[] {
  return [...entries].filter(entry =>
    entry.status === 'sending'
    || entry.status === 'unknown'
    || entry.status === 'rejected'
    || entry.status === 'abandoned');
}

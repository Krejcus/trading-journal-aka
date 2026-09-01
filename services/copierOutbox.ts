import type { BrokerLiquidateResult, BrokerOrderRequest } from './brokerPort';

/**
 * Outbox odeslaných objednávek.
 *
 * Existuje proto, že Tradovate NENÍ idempotentní. `clOrdId` je jen
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

/** Pouze samostatný place/liquidate outbox smí skončit stavovým důkazem. */
export type PlaceOutboxStatus = OutboxStatus | 'confirmed-by-state';

export type LiquidationPhase =
  | 'submitting'
  | 'awaiting-state'
  | 'awaiting-cleanup'
  | 'confirmed-by-state';

export interface LiquidationAttemptEvidence {
  status: BrokerLiquidateResult['status'] | 'legacy-unknown';
  observedAt: number;
  brokerOrderId?: string;
  reason?: string;
}

export interface LiquidationConfirmationEvidence {
  kind: 'flat-no-active';
  accountId: number;
  symbol: string;
  netQuantity: 0;
  workingOrders: 0;
  observedAt: number;
  source: 'post-submit' | 'restart-recovery' | 'final-check';
  /** Stav je prokázaný, kauzalita konkrétního POSTu nikoli. */
  causality: 'not-proven';
}

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
  status: PlaceOutboxStatus;
  /** Počet pokusů o odeslání. Chrání před nekonečnou smyčkou. */
  attempts: number;
  brokerOrderId?: string;
  reason?: string;
  /** Obyčejné placeOrder položky pole nemají; legacy snapshoty zůstávají platné. */
  operationKind?: 'place-order' | 'liquidate-position';
  liquidationPhase?: LiquidationPhase;
  liquidationAttempt?: LiquidationAttemptEvidence;
  confirmationEvidence?: LiquidationConfirmationEvidence;
  updatedAt: number;
}

export type OutboxAction =
  | { type: 'send' }
  | { type: 'lookup'; tag: string }
  | { type: 'skip'; reason: OutboxSkipReason };

export type OutboxSkipReason =
  | 'already-acknowledged'
  | 'confirmed-by-state'
  | 'rejected'
  | 'abandoned'
  | 'waived';

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
    case 'confirmed-by-state':
      return { type: 'skip', reason: 'confirmed-by-state' };
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

export function markLiquidationSending(entry: OutboxEntry, now: number): OutboxEntry {
  return {
    ...markSending(entry, now),
    operationKind: 'liquidate-position',
    liquidationPhase: 'submitting',
  };
}

export function markLiquidationResult(
  entry: OutboxEntry,
  result: BrokerLiquidateResult,
  now: number,
): OutboxEntry {
  const attempt: LiquidationAttemptEvidence = {
    status: result.status,
    observedAt: now,
    ...('brokerOrderId' in result && result.brokerOrderId
      ? { brokerOrderId: result.brokerOrderId }
      : {}),
    ...('reason' in result ? { reason: result.reason } : {}),
  };
  const base: OutboxEntry = {
    ...entry,
    operationKind: 'liquidate-position',
    liquidationPhase: 'awaiting-state',
    liquidationAttempt: attempt,
    ...('brokerOrderId' in result && result.brokerOrderId
      ? { brokerOrderId: result.brokerOrderId }
      : {}),
    updatedAt: now,
  };
  if (result.status === 'rejected') return markRejected(base, result.reason, now);
  if (result.status === 'indeterminate') return markUnknown(base, result.reason, now);
  return markUnknown(
    base,
    result.status === 'already-flat'
      ? 'Broker před POSTem autoritativně potvrdil flat; čeká se na flat/no-active postkontrolu'
      : 'Liquidate odeslán; čeká se na autoritativní flat/no-active postkontrolu',
    now,
  );
}

export function markLiquidationAwaitingCleanup(entry: OutboxEntry, now: number): OutboxEntry {
  return {
    ...entry,
    status: 'unknown',
    operationKind: 'liquidate-position',
    liquidationPhase: 'awaiting-cleanup',
    reason: 'Pozice je flat; čeká se na dočištění aktivních příkazů a finální postkontrolu',
    updatedAt: now,
  };
}

export function markLiquidationConfirmedByState(
  entry: OutboxEntry,
  evidence: Omit<LiquidationConfirmationEvidence, 'kind' | 'netQuantity' | 'workingOrders' | 'causality'>,
): OutboxEntry {
  const liquidationAttempt = entry.liquidationAttempt ?? {
    status: 'legacy-unknown' as const,
    observedAt: entry.updatedAt,
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
  return {
    ...entry,
    status: 'confirmed-by-state',
    operationKind: 'liquidate-position',
    liquidationPhase: 'confirmed-by-state',
    liquidationAttempt,
    confirmationEvidence: {
      ...evidence,
      kind: 'flat-no-active',
      netQuantity: 0,
      workingOrders: 0,
      causality: 'not-proven',
    },
    reason: 'Autoritativně potvrzeno flat + žádný aktivní příkaz; kauzalita původního POSTu není tvrzená',
    updatedAt: evidence.observedAt,
  };
}

export function isLiquidationOutboxEntry(entry: OutboxEntry): boolean {
  return entry.operationKind === 'liquidate-position'
    || entry.leaderEventId?.startsWith('manual-flatten:') === true
    || entry.leaderOrderId.startsWith('manual-flatten:');
}

export function needsLiquidationStateRecovery(entry: OutboxEntry): boolean {
  if (!isLiquidationOutboxEntry(entry) || entry.status === 'confirmed-by-state') return false;
  return entry.status === 'sending'
    || entry.status === 'unknown'
    || entry.status === 'rejected'
    || (entry.status === 'planned' && entry.attempts > 0);
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

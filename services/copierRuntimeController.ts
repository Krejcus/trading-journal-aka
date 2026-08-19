import type { BrokerEvent, BrokerPort } from './brokerPort';
import { CopierLeaderEventSource } from './copierLeaderEventSource';
import { CopierBracketCorrelator, type LeaderBracketPair } from './copierBracketCorrelator';
import { CopierOsoCorrelator } from './copierOsoCorrelator';
import { stuckCancelEntries } from './copierCancelOutbox';
import { waiveCancelEntry } from './copierCancelOutbox';
import { stuckEntries, waiveOutboxEntry } from './copierOutbox';
import { stuckBracketEntries, waiveBracketOutboxEntry } from './copierBracketOutbox';
import { stuckOsoEntries, waiveOsoOutboxEntry } from './copierOsoOutbox';
import { applyResolved, type LeaderEvent } from './copierEngine';
import { createRiskGateContext, type RiskGateContext } from './copierRiskGate';
import {
  createCopierMetrics,
  createSerialCopierProcessor,
  recoverOutbox,
  runtimeFromSnapshot,
  type CopierAuditEntry,
  type CopierMetrics,
  type CopierRuntime,
} from './copierRunner';
import type { CopierStore } from './copierStore';
import { toSnapshot } from './copierStore';
import type { CopyGroupConfig } from './liveCopyTrading';
import { processManualFlatten, type ManualFlattenResult } from './copierManualActions';
import { createExposureCappedBroker } from './exposureCappedBroker';

export type CopierStuckOperationKind = 'place' | 'bracket' | 'oso' | 'cancel-or-modify';

export interface CopierStuckOperation {
  kind: CopierStuckOperationKind;
  key: string;
  status: 'sending' | 'unknown' | 'rejected' | 'abandoned';
  leaderSequence: number;
  updatedAt: number;
  reason?: string;
  accountId?: number;
  brokerOrderId?: string;
  operation?: 'cancel' | 'modify';
}

export interface CopierControllerStatus {
  started: boolean;
  armed: boolean;
  killSwitch: boolean;
  shadowMode: boolean;
  connected: boolean;
  reconciliationRequired: boolean;
  divergentAccounts: number[];
  workingOrderAccounts: number[];
  stuckOutbox: boolean;
  /** Bezpečný, redigovaný seznam položek čekajících na zásah operátora. */
  stuckOperations: CopierStuckOperation[];
  lastError: string | null;
  revision: number;
  lastSequence: number;
  entryCooldownUntil?: number;
  dayLockUntil?: number;
  dayLockReason?: string | null;
  /**
   * Kdy aktuální ARM vyprší (epoch ms); 0 = neARMováno. Klient z něj
   * plánuje deterministickou lokální notifikaci „ARM vypršel".
   */
  armExpiresAt?: number;
}

export interface CopierRuntimeController {
  /**
   * `ttlMs` omezí platnost tohoto ARM (typicky do konce broker session).
   * Bez něj platí výchozí TTL z risk gate. Expirace pozice nezavírá.
   */
  arm(options?: { shadowMode?: boolean; ttlMs?: number }): void;
  disarm(): void;
  /** Jednosměrná nouzová západka pro aktuální runtime session. */
  engageKillSwitch(reason?: string): void;
  /** Trvalý lock do zadaného času; restart workeru ho nesmí obejít. */
  lockUntil(until: number, reason: string): Promise<void>;
  /** Autoritativně porovná pozice a ověří, že nikde nezůstaly working orders. */
  reconcile(): Promise<{ divergentAccounts: number[]; workingOrderAccounts: number[] }>;
  updateGroup(group: CopyGroupConfig): void;
  /** Explicitní ruční Flatten jednoho účtu. Nikdy se nespouští automaticky. */
  flattenAccount(accountId: number, operationId: string): Promise<ManualFlattenResult>;
  /** Explicitní ruční Flatten leadera i všech followerů ve skupině. */
  flattenGroup(operationId: string): Promise<ManualFlattenResult>;
  /** Ruční uzavření nejasné operace; nikdy nic neposílá a vynutí novou reconciliation. */
  waiveStuckOperation(options: {
    kind: CopierStuckOperationKind;
    key: string;
    reason: string;
  }): Promise<void>;
  status(): CopierControllerStatus;
  waitForIdle(): Promise<void>;
  stop(): void;
}

export interface BootstrapCopierOptions {
  broker: BrokerPort;
  store: CopierStore;
  group: CopyGroupConfig;
  clock?: () => number;
  risk?: Partial<RiskGateContext>;
  onAudit?: (entries: readonly CopierAuditEntry[]) => void;
  onError?: (error: Error) => void;
  metrics?: CopierMetrics;
  /** Read-only observability hook; nesmí provádět broker side effect. */
  onLeaderEvent?: (event: LeaderEvent) => void;
  /** Read-only výstup detekovaného SL/TP páru; zatím nic neodesílá. */
  onBracketPair?: (pair: LeaderBracketPair) => void;
  maxConcurrentDispatches?: number;
  /** Krátké okno pro rozpoznání nativního čekajícího entry + SL/TP. */
  osoCorrelationWindowMs?: number;
  /** Pilot pojistka: kolik nových leader orderId smí jedna session přijmout. */
  maxLeaderOrders?: number;
  /**
   * Pilot pojistka pro test exekuce: po vyčerpání vstupního limitu dovolí
   * nejvýše jeden nový opačný order, který přesně zavírá známou leader pozici.
   * Bez aktuální Position entity nebo při větším množství failne zavřeně.
   */
  allowSingleFlatExit?: boolean;
  /** Testovatelná bounded read-only konfirmace ručního Flatten. */
  flattenConfirmationAttempts?: number;
  flattenConfirmationPollMs?: number;
  wait?: (ms: number) => Promise<void>;
}

const errorOf = (reason: unknown) => reason instanceof Error ? reason : new Error(String(reason));

function assertRuntimeGroup(group: CopyGroupConfig): void {
  if (!group.id.trim() || !group.name.trim()) throw new Error('Copy group musí mít id a název');
  if (!Number.isSafeInteger(group.leaderAccountId) || Number(group.leaderAccountId) <= 0) {
    throw new Error('Copy group musí mít platný leader účet');
  }
  if (!Array.isArray(group.followers) || group.followers.length === 0) {
    throw new Error('Copy group musí mít alespoň jeden follower účet');
  }
  const seen = new Set<number>();
  for (const follower of group.followers) {
    if (!Number.isSafeInteger(follower.accountId) || follower.accountId <= 0) {
      throw new Error('Follower accountId musí být kladné celé číslo');
    }
    if (follower.accountId === group.leaderAccountId) {
      throw new Error('Leader nemůže být zároveň follower');
    }
    if (seen.has(follower.accountId)) throw new Error('Follower účet je ve skupině vícekrát');
    seen.add(follower.accountId);
    if (follower.mode !== 'off' && follower.mode !== 'on-submit' && follower.mode !== 'on-fill') {
      throw new Error('Follower má neplatný replication mode');
    }
    if (!Number.isFinite(follower.multiplier) || follower.multiplier <= 0 || follower.multiplier > 100) {
      throw new Error('Follower multiplier musí být větší než 0 a nejvýše 100');
    }
    if (follower.maxContracts != null
      && (!Number.isSafeInteger(follower.maxContracts) || follower.maxContracts < 1)) {
      throw new Error('Follower maxContracts musí být kladné celé číslo');
    }
  }
}

/**
 * Bezpečný bootstrap jednoho copy group runtime.
 *
 * Pořadí je záměrné: load durable snapshot -> recover unknown side effects ->
 * teprve potom subscribe. Controller vždy startuje DISARMED + shadow.
 */
export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): Promise<CopierRuntimeController> {
  assertRuntimeGroup(options.group);
  const clock = options.clock ?? Date.now;
  let group = options.group;
  const broker = createExposureCappedBroker(
    options.broker,
    accountId => group.followers.find(item => item.accountId === accountId)?.maxContracts,
  );
  let runtime: CopierRuntime = runtimeFromSnapshot(await options.store.load());
  const metrics = options.metrics ?? createCopierMetrics();
  const recovered = await recoverOutbox({
    runtime,
    broker,
    clock,
    store: options.store,
    metrics,
  });
  runtime = recovered.runtime;
  if (recovered.audit.length > 0) options.onAudit?.(recovered.audit);

  const processor = createSerialCopierProcessor(runtime);
  const source = new CopierLeaderEventSource();
  const bracketCorrelator = new CopierBracketCorrelator();
  const osoCorrelator = new CopierOsoCorrelator(options.osoCorrelationWindowMs);
  let gate = createRiskGateContext({
    brokerEnvironment: broker.environment,
    expectedEnvironment: broker.environment,
    shadowMode: true,
    ...options.risk,
    armed: false,
    connected: false,
  });
  // Výchozí strop ARM z konfigurace gate; per-ARM ttl ho smí jen zkrátit.
  const defaultArmTtlMs = gate.armTtlMs;
  let stopped = false;
  let positionCheckComplete = false;
  let workingOrderAccounts = new Set<number>();
  let lastError: Error | null = null;
  let eventTail: Promise<void> = Promise.resolve();
  const admittedLeaderOrders = new Set<string>();
  const admittedFlatExitOrders = new Set<string>();
  const leaderPositions = new Map<string, number>();
  const positionsByAccount = new Map<number, Map<string, number>>();
  let cooldownPending = false;
  const pendingBracketTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingOsoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingOsoEvents = new Map<string, LeaderEvent>();
  const pendingOsoFlushes = new Map<string, Promise<void>>();
  const pendingOsoResolvers = new Map<string, () => void>();

  if (
    options.maxLeaderOrders != null
    && (!Number.isSafeInteger(options.maxLeaderOrders) || options.maxLeaderOrders <= 0)
  ) {
    throw new Error('maxLeaderOrders musí být kladné celé číslo');
  }

  const currentRuntime = () => processor.currentRuntime();
  const currentStuckOperations = (): CopierStuckOperation[] => {
    const current = currentRuntime();
    return [
      ...stuckEntries(current.outbox.values()).map(entry => ({
        kind: 'place' as const,
        key: entry.key,
        status: entry.status as CopierStuckOperation['status'],
        leaderSequence: entry.leaderSequence ?? 0,
        updatedAt: entry.updatedAt,
        reason: entry.reason,
        accountId: entry.request.accountId,
        brokerOrderId: entry.brokerOrderId,
      })),
      ...stuckBracketEntries(current.bracketOutbox.values()).map(entry => ({
        kind: 'bracket' as const,
        key: entry.key,
        status: entry.status as CopierStuckOperation['status'],
        leaderSequence: entry.leaderSequence,
        updatedAt: entry.updatedAt,
        reason: entry.reason,
        accountId: entry.request.accountId,
      })),
      ...stuckOsoEntries(current.osoOutbox.values()).map(entry => ({
        kind: 'oso' as const,
        key: entry.key,
        status: entry.status as CopierStuckOperation['status'],
        leaderSequence: entry.leaderSequence,
        updatedAt: entry.updatedAt,
        reason: entry.reason,
        accountId: entry.request.accountId,
      })),
      ...stuckCancelEntries(current.cancelOutbox.values()).map(entry => ({
        kind: 'cancel-or-modify' as const,
        key: entry.key,
        status: entry.status as CopierStuckOperation['status'],
        leaderSequence: entry.leaderSequence,
        updatedAt: entry.updatedAt,
        reason: entry.reason,
        accountId: entry.accountId,
        brokerOrderId: entry.brokerOrderId,
        operation: entry.operation,
      })),
    ].sort((left, right) => left.updatedAt - right.updatedAt || left.key.localeCompare(right.key));
  };
  const hasStuckOutbox = () => currentStuckOperations().length > 0;

  /**
   * Reject je konečný, známý výsledek bez nejasného side effectu. Během
   * aktuální session stále failne zavřeně, protože leader a follower se
   * nemuseli shodnout. Jakmile ale operátor spustí novou autoritativní
   * reconciliation a všechny účty jsou synchronní bez working příkazů,
   * starý reject už nesmí navždy blokovat další ARM.
   */
  const acknowledgeTerminalRejectsAfterReconciliation = async () => {
    await processor.mutate(async current => {
      const now = clock();
      const reason = (original?: string) => [
        'Konečný reject potvrzen následnou autoritativní reconciliation',
        original,
      ].filter(Boolean).join(': ');
      const outbox = new Map(current.outbox);
      const bracketOutbox = new Map(current.bracketOutbox);
      const osoOutbox = new Map(current.osoOutbox);
      let changed = false;

      for (const [key, entry] of outbox) {
        if (entry.status !== 'rejected') continue;
        outbox.set(key, waiveOutboxEntry(entry, reason(entry.reason), now));
        changed = true;
      }
      for (const [key, entry] of bracketOutbox) {
        if (entry.status !== 'rejected') continue;
        bracketOutbox.set(key, waiveBracketOutboxEntry(entry, reason(entry.reason), now));
        changed = true;
      }
      for (const [key, entry] of osoOutbox) {
        if (entry.status !== 'rejected') continue;
        osoOutbox.set(key, waiveOsoOutboxEntry(entry, reason(entry.reason), now));
        changed = true;
      }
      if (!changed) return current;

      const committed = await options.store.commit(
        toSnapshot(
          current.state,
          outbox.values(),
          current.cancelOutbox.values(),
          current.revision,
          bracketOutbox.values(),
          osoOutbox.values(),
        ),
        current.revision,
      );
      return {
        ...current,
        outbox,
        bracketOutbox,
        osoOutbox,
        revision: committed.revision,
      };
    });
  };

  const persistSafety = async (safety: CopierRuntime['state']['safety']) => {
    await processor.mutate(async current => {
      const state = { ...current.state, safety: { ...safety } };
      const committed = await options.store.commit(
        toSnapshot(
          state,
          current.outbox.values(),
          current.cancelOutbox.values(),
          current.revision,
          current.bracketOutbox.values(),
          current.osoOutbox.values(),
        ),
        current.revision,
      );
      return { ...current, state, revision: committed.revision };
    });
  };

  const groupIsFlat = () => [group.leaderAccountId, ...group.followers.map(item => item.accountId)]
    .filter((accountId): accountId is number => accountId != null)
    .every(accountId => [...(positionsByAccount.get(accountId)?.values() ?? [])]
      .every(quantity => quantity === 0));

  const maybeActivateCooldown = async (now: number, symbol: string) => {
    const cooldownMinutes = group.safety?.entryCooldownMinutes ?? 0;
    if (!cooldownPending || cooldownMinutes <= 0 || !groupIsFlat()) return;
    cooldownPending = false;
    const safety = {
      ...currentRuntime().state.safety,
      entryCooldownUntil: Math.max(
        currentRuntime().state.safety.entryCooldownUntil,
        now + cooldownMinutes * 60_000,
      ),
    };
    await persistSafety(safety);
    gate = { ...gate, armed: false };
    options.onAudit?.([{
      at: now,
      leaderEventId: `cooldown-${symbol}`,
      kind: 'blocked',
      reason: `entry-cooldown ${cooldownMinutes}min po potvrzeném zploštění celé skupiny`,
    }]);
  };

  const failClosed = (reason: unknown, failure: { transportLost?: boolean } = {}) => {
    lastError = errorOf(reason);
    gate = {
      ...gate,
      armed: false,
      ...(failure.transportLost ? { connected: false } : {}),
    };
    // Interní nejistota odzbrojí copier a vynutí novou autoritativní kontrolu,
    // ale nesmí předstírat fyzický disconnect. Živé spojení je potřeba právě
    // proto, aby mohly doběhnout risk-redukující cancely už známých objednávek.
    positionCheckComplete = false;
    if (failure.transportLost) source.connection(false);
    options.onError?.(lastError);
  };

  const failClosedOnCriticalAudit = (entries: readonly CopierAuditEntry[]) => {
    if (!gate.armed) return;
    const critical = entries.find(item => (
      item.kind === 'unknown'
      || item.kind === 'abandoned'
      || item.kind === 'rejected'
      || item.kind === 'cancel-failed'
      || item.kind === 'sequence-broken'
      || item.kind === 'blocked'
    ));
    if (!critical) return;
    failClosed(new Error(
      critical.reason
        ? `Copier fail-closed: ${critical.reason}`
        : `Copier fail-closed: ${critical.kind}`,
    ));
  };

  const flatten = async (accountIds: readonly number[], operationId: string) => {
    gate = { ...gate, armed: false };
    positionCheckComplete = false;
    if (gate.killSwitch) throw new Error('Flatten nelze spustit: kill switch je aktivní');
    if (!gate.connected) throw new Error('Flatten nelze spustit bez broker spojení');
    if (hasStuckOutbox()) throw new Error('Flatten nelze spustit: copier má nevyřešený outbox');
    let result: ManualFlattenResult | null = null;
    try {
      await processor.mutate(async current => {
        const processed = await processManualFlatten({
          runtime: current,
          broker,
          store: options.store,
          groupId: group.id,
          accountIds,
          operationId,
          clock,
          confirmationAttempts: options.flattenConfirmationAttempts,
          confirmationPollMs: options.flattenConfirmationPollMs,
          wait: options.wait,
        });
        result = processed.result;
        return processed.runtime;
      });
    } catch (error) {
      failClosed(error);
      throw error;
    }
    if (!result) throw new Error('Flatten nedokončil žádný výsledek');
    workingOrderAccounts = new Set(result.workingOrderAccounts);
    if (!result.flat) {
      const error = new Error(
        `Flatten čeká na reconciliation: positions=${result.remainingPositionAccounts.join(',') || 'none'} working=${result.workingOrderAccounts.join(',') || 'none'}`,
      );
      failClosed(error);
      throw error;
    }
    return result;
  };

  const settleOsoFlush = (entryOrderId: string) => {
    pendingOsoResolvers.get(entryOrderId)?.();
    pendingOsoResolvers.delete(entryOrderId);
    pendingOsoFlushes.delete(entryOrderId);
  };

  const flushStandaloneOsoEntry = async (entryOrderId: string) => {
    const timer = pendingOsoTimers.get(entryOrderId);
    if (timer) clearTimeout(timer);
    pendingOsoTimers.delete(entryOrderId);
    const pending = pendingOsoEvents.get(entryOrderId);
    pendingOsoEvents.delete(entryOrderId);
    osoCorrelator.release(entryOrderId);
    if (!pending || stopped) {
      settleOsoFlush(entryOrderId);
      return;
    }
    try {
      const result = await processor.process({
        event: pending,
        group,
        context: {
          ...gate,
          now: clock(),
          sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
          stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
        },
        broker,
        clock,
        store: options.store,
        metrics,
        maxConcurrentDispatches: options.maxConcurrentDispatches,
      });
      runtime = result.runtime;
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      failClosedOnCriticalAudit(result.audit);
    } catch (error) {
      failClosed(error);
    } finally {
      settleOsoFlush(entryOrderId);
    }
  };

  const handleBrokerEvent = async (event: BrokerEvent) => {
    if (stopped) return;
    const now = clock();
    if (event.type === 'heartbeat') {
      gate = { ...gate, lastHeartbeatAt: event.at };
      return;
    }
    if (event.type === 'error') {
      failClosed(event.error, { transportLost: true });
      return;
    }
    if (event.type === 'connection') {
      source.connection(event.connected);
      gate = {
        ...gate,
        connected: event.connected,
        lastHeartbeatAt: event.connected ? now : gate.lastHeartbeatAt,
        // Každý disconnect ruší ARM; reconnect ho nikdy sám neobnoví.
        armed: event.connected ? gate.armed : false,
      };
      if (event.connected && source.needsReconciliation()) positionCheckComplete = false;
      return;
    }
    if (event.type === 'position') {
      const accountPositions = positionsByAccount.get(event.position.accountId) ?? new Map<string, number>();
      accountPositions.set(event.position.symbol, event.position.netQuantity);
      positionsByAccount.set(event.position.accountId, accountPositions);
      if (event.position.accountId === group.leaderAccountId) {
        const previousNet = leaderPositions.get(event.position.symbol) ?? 0;
        leaderPositions.set(event.position.symbol, event.position.netQuantity);
        const cooldownMinutes = group.safety?.entryCooldownMinutes ?? 0;
        if (
          cooldownMinutes > 0
          && previousNet !== 0
          && event.position.netQuantity === 0
          && [...leaderPositions.values()].every(quantity => quantity === 0)
        ) {
          // Neodzbrojujeme jen podle leadera. U on-fill může jeho závěrečný
          // fill dorazit před follower pozicí; čekáme na autoritativní flat
          // celé skupiny, aby cooldown nezablokoval samotné zavření.
          cooldownPending = true;
        }
      }
      await maybeActivateCooldown(now, event.position.symbol);
      return;
    }
    if (group.leaderAccountId == null) return;
    const sequence = currentRuntime().state.lastSequence + 1;
    const leaderEvent = source.observe(event, group.leaderAccountId, sequence, now);
    if (!leaderEvent) return;
    options.onLeaderEvent?.(leaderEvent);
    const bracketPair = bracketCorrelator.observe(leaderEvent);
    const bracketEntryOrderId = bracketCorrelator.entryOrderIdForLeg(leaderEvent.orderId);
    if (leaderEvent.kind === 'submitted' && bracketEntryOrderId) {
      if (!bracketPair) {
        const result = await processor.record({ event: leaderEvent, group, clock, store: options.store });
        runtime = result.runtime;
        if (result.audit.length > 0) options.onAudit?.(result.audit);
        if (result.audit.some(item => item.kind === 'sequence-broken')) {
          failClosed(new Error('Protective leg přišel mimo pořadí'));
          return;
        }
        if (!pendingBracketTimers.has(bracketEntryOrderId)) {
          const timer = setTimeout(() => {
            pendingBracketTimers.delete(bracketEntryOrderId);
            if (!bracketCorrelator.hasPendingPair(bracketEntryOrderId)) return;
            options.onAudit?.([{
              at: clock(), leaderEventId: leaderEvent.id, kind: 'blocked',
              reason: 'incomplete-bracket-pair',
            }]);
            failClosed(new Error(`Bracket ${bracketEntryOrderId} nemá bezpečně spárovaný SL i TP`));
          }, bracketCorrelator.pendingTimeoutMs() + 250);
          pendingBracketTimers.set(bracketEntryOrderId, timer);
        }
        return;
      }

      const timer = pendingBracketTimers.get(bracketEntryOrderId);
      if (timer) clearTimeout(timer);
      pendingBracketTimers.delete(bracketEntryOrderId);
      options.onBracketPair?.(bracketPair);
      const result = await processor.processBracket({
        pair: bracketPair,
        event: leaderEvent,
        group,
        context: {
          ...gate,
          now,
          sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
          stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
        },
        broker,
        clock,
        store: options.store,
        metrics,
        maxConcurrentDispatches: options.maxConcurrentDispatches,
      });
      runtime = result.runtime;
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      if (result.audit.some(item => (
        item.kind === 'unknown'
        || item.kind === 'abandoned'
        || item.kind === 'blocked'
        || item.kind === 'rejected'
      ))) {
        failClosed(new Error('OCO bracket nebyl bezpečně potvrzen brokerem'));
      }
      return;
    }

    // Modify/cancel nesmí předběhnout entry, který čeká v krátkém OSO okně.
    // Nejdřív bezpečně dokončíme samostatné entry a až potom zpracujeme změnu.
    if (leaderEvent.kind !== 'submitted' && pendingOsoEvents.has(leaderEvent.orderId)) {
      await flushStandaloneOsoEntry(leaderEvent.orderId);
    }

    const osoObservation = osoCorrelator.observe(leaderEvent);
    if (osoObservation.kind === 'ambiguous') {
      options.onAudit?.([{
        at: now, leaderEventId: leaderEvent.id, kind: 'blocked', reason: osoObservation.reason,
      }]);
      failClosed(new Error(osoObservation.reason));
      return;
    }
    if (osoObservation.kind === 'entry') {
      // Nový nezávislý entry ukončuje inference okno předchozích entry. Ty už
      // nesmí zůstat za novým příkazem ani za případným session-limit blokem.
      for (const pendingEntryOrderId of [...pendingOsoEvents.keys()]) {
        if (pendingEntryOrderId !== leaderEvent.orderId) {
          await flushStandaloneOsoEntry(pendingEntryOrderId);
        }
      }
      if (
        options.maxLeaderOrders != null
        && !admittedLeaderOrders.has(leaderEvent.orderId)
        && admittedLeaderOrders.size >= options.maxLeaderOrders
      ) {
        options.onAudit?.([{
          at: now, leaderEventId: leaderEvent.id, kind: 'blocked', reason: 'leader-order-session-limit',
        }]);
        failClosed(new Error(`Pilot limit nových leader objednávek byl překročen (${options.maxLeaderOrders})`));
        return;
      }
      admittedLeaderOrders.add(leaderEvent.orderId);
      pendingOsoEvents.set(leaderEvent.orderId, leaderEvent);
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      let resolveFlush!: () => void;
      const flush = new Promise<void>(resolve => { resolveFlush = resolve; });
      pendingOsoFlushes.set(leaderEvent.orderId, flush);
      pendingOsoResolvers.set(leaderEvent.orderId, resolveFlush);
      const timer = setTimeout(() => {
        void flushStandaloneOsoEntry(leaderEvent.orderId);
      }, osoCorrelator.pendingWindowMs() + 50);
      pendingOsoTimers.set(leaderEvent.orderId, timer);
      return;
    }
    if (osoObservation.kind === 'leg') {
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      return;
    }
    if (osoObservation.kind === 'pair') {
      const pair = osoObservation.pair;
      const timer = pendingOsoTimers.get(pair.entryOrderId);
      if (timer) clearTimeout(timer);
      pendingOsoTimers.delete(pair.entryOrderId);
      pendingOsoEvents.delete(pair.entryOrderId);
      settleOsoFlush(pair.entryOrderId);
      const result = await processor.processOso({
        pair,
        event: leaderEvent,
        group,
        context: {
          ...gate,
          now,
          sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
          stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
        },
        broker,
        clock,
        store: options.store,
        metrics,
        maxConcurrentDispatches: options.maxConcurrentDispatches,
      });
      runtime = result.runtime;
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      if (result.audit.some(item => (
        item.kind === 'unknown' || item.kind === 'abandoned'
        || item.kind === 'blocked' || item.kind === 'rejected'
      ))) failClosed(new Error('OSO nebyl bezpečně potvrzen brokerem'));
      return;
    }
    if (leaderEvent.kind === 'submitted' && !admittedLeaderOrders.has(leaderEvent.orderId)) {
      if (
        options.maxLeaderOrders != null
        && admittedLeaderOrders.size >= options.maxLeaderOrders
      ) {
        const netPosition = leaderPositions.get(leaderEvent.symbol) ?? 0;
        const closesKnownPosition = options.allowSingleFlatExit === true
          && admittedFlatExitOrders.size === 0
          && Math.abs(netPosition) === leaderEvent.quantity
          && ((netPosition > 0 && leaderEvent.side === 'Sell')
            || (netPosition < 0 && leaderEvent.side === 'Buy'));
        if (closesKnownPosition) {
          admittedFlatExitOrders.add(leaderEvent.orderId);
        } else {
          const error = new Error(`Pilot limit nových leader objednávek byl překročen (${options.maxLeaderOrders})`);
          options.onAudit?.([{
            at: now,
            leaderEventId: leaderEvent.id,
            kind: 'blocked',
            reason: 'leader-order-session-limit',
          }]);
          failClosed(error);
          return;
        }
      } else {
        admittedLeaderOrders.add(leaderEvent.orderId);
      }
    }
    const result = await processor.process({
      event: leaderEvent,
      group,
      context: {
        ...gate,
        now,
        sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
        stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
      },
      broker,
      clock,
      store: options.store,
      metrics,
      maxConcurrentDispatches: options.maxConcurrentDispatches,
    });
    runtime = result.runtime;
    if (result.audit.length > 0) options.onAudit?.(result.audit);
    failClosedOnCriticalAudit(result.audit);
  };

  const unsubscribe = broker.subscribe(event => {
    eventTail = eventTail.then(() => handleBrokerEvent(event)).catch(failClosed);
  });

  return {
    arm({ shadowMode = false, ttlMs }: { shadowMode?: boolean; ttlMs?: number } = {}) {
      if (stopped) throw new Error('Copier runtime is stopped');
      if (gate.killSwitch) throw new Error('Copier nelze armovat: kill switch je aktivní');
      if (ttlMs != null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
        throw new Error('ARM TTL musí být kladný počet milisekund');
      }
      const now = clock();
      if (!gate.connected) throw new Error('Copier nelze armovat bez dokončeného broker syncu');
      if (source.needsReconciliation()) throw new Error('Po reconnectu je nutná kontrola pozic');
      const safety = currentRuntime().state.safety;
      if (!shadowMode && now < safety.dayLockUntil) {
        throw new Error(`ARM blokován denním lockem: ${safety.dayLockReason ?? 'risk lock'}`);
      }
      if (!shadowMode && now < safety.entryCooldownUntil) {
        const remainingMin = Math.ceil((safety.entryCooldownUntil - now) / 60_000);
        throw new Error(`ARM blokován anti-revenge cooldownem ještě ${remainingMin} min`);
      }
      if (!shadowMode && !positionCheckComplete) throw new Error('Před live dispatch je nutné potvrdit kontrolu pozic');
      if (hasStuckOutbox()) throw new Error('Copier má nevyřešený outbox');
      if (gate.divergentAccounts.size > 0) throw new Error('Pozice leader/follower se rozcházejí');
      if (workingOrderAccounts.size > 0) throw new Error('Před ARM musí být všechny účty bez pracovních příkazů');
      // Kratší z limitů vyhrává: session TTL nesmí ARM prodloužit za výchozí strop.
      const armTtlMs = ttlMs != null ? Math.min(ttlMs, defaultArmTtlMs) : defaultArmTtlMs;
      gate = { ...gate, armed: true, armedAt: now, now, shadowMode, armTtlMs };
    },
    disarm() {
      gate = { ...gate, armed: false };
    },
    engageKillSwitch(reason = 'Ruční nouzové zastavení') {
      if (stopped) return;
      lastError = new Error(reason.trim() || 'Ruční nouzové zastavení');
      // Kill switch se v této runtime session nedá odjistit. Nový bootstrap znovu
      // startuje DISARMED a stále vyžaduje reconciliation před ostrým ARM.
      gate = { ...gate, armed: false, killSwitch: true };
      positionCheckComplete = false;
      options.onError?.(lastError);
    },
    async lockUntil(until, reason) {
      if (!Number.isFinite(until) || until <= clock()) {
        throw new Error('Denní lock musí končit v budoucnosti');
      }
      const explanation = reason.trim();
      if (explanation.length < 3) throw new Error('Denní lock vyžaduje důvod');
      gate = { ...gate, armed: false };
      await persistSafety({
        ...currentRuntime().state.safety,
        dayLockUntil: until,
        dayLockReason: explanation,
      });
    },
    async reconcile() {
      if (!gate.connected) throw new Error('Kontrolu pozic nelze provést bez broker spojení');
      if (group.leaderAccountId == null) throw new Error('Copy group nemá leader účet');
      const accountIds = [group.leaderAccountId, ...group.followers.map(item => item.accountId)];
      const capabilities = await broker.listAccountCapabilities(accountIds);
      const byCapability = new Map(capabilities.map(item => [item.accountId, item]));
      const missing = accountIds.filter(accountId => !byCapability.has(accountId));
      const inactive = accountIds.filter(accountId => byCapability.get(accountId)?.active === false);
      const readOnlyFollowers = group.followers.filter(
        follower => byCapability.get(follower.accountId)?.canTrade === false,
      ).map(follower => follower.accountId);
      if (missing.length > 0 || inactive.length > 0 || readOnlyFollowers.length > 0) {
        gate = { ...gate, armed: false };
        positionCheckComplete = false;
        const details = [
          missing.length > 0 ? `missing=${missing.join(',')}` : '',
          inactive.length > 0 ? `inactive=${inactive.join(',')}` : '',
          readOnlyFollowers.length > 0 ? `readOnlyFollowers=${readOnlyFollowers.join(',')}` : '',
        ].filter(Boolean).join(' ');
        throw new Error(`OAuth/account preflight selhal: ${details}`);
      }
      const snapshots = await Promise.all(accountIds.map(async accountId => ({
        accountId,
        positions: await broker.listPositions(accountId),
        orders: await broker.listOrders(accountId),
      })));
      const byAccount = new Map(snapshots.map(item => [item.accountId, item]));
      positionsByAccount.clear();
      for (const snapshot of snapshots) {
        positionsByAccount.set(snapshot.accountId, new Map(
          snapshot.positions.map(item => [item.symbol, item.netQuantity]),
        ));
      }
      leaderPositions.clear();
      const reconciledLeaderPositions = new Map(
        (byAccount.get(group.leaderAccountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
      );
      for (const [symbol, quantity] of reconciledLeaderPositions) leaderPositions.set(symbol, quantity);
      const divergent = new Set<number>();
      workingOrderAccounts = new Set(
        snapshots.filter(item => item.orders.some(order => order.status === 'working')).map(item => item.accountId),
      );
      for (const follower of group.followers) {
        const followerPositions = new Map(
          (byAccount.get(follower.accountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
        );
        const symbols = new Set([...reconciledLeaderPositions.keys(), ...followerPositions.keys()]);
        for (const symbol of symbols) {
          const expected = Math.trunc((reconciledLeaderPositions.get(symbol) ?? 0) * follower.multiplier);
          if ((followerPositions.get(symbol) ?? 0) !== expected) {
            divergent.add(follower.accountId);
            break;
          }
        }
      }
      gate = { ...gate, divergentAccounts: divergent, sequenceBroken: false, armed: false };
      positionCheckComplete = divergent.size === 0 && workingOrderAccounts.size === 0;
      if (positionCheckComplete) {
        await acknowledgeTerminalRejectsAfterReconciliation();
        source.acknowledgeReconciliation();
      }
      return {
        divergentAccounts: [...divergent],
        workingOrderAccounts: [...workingOrderAccounts],
      };
    },
    updateGroup(nextGroup) {
      // Jakýkoli pokus o změnu konfigurace nejdřív zavře live dispatch.
      gate = { ...gate, armed: false };
      if (nextGroup.id !== group.id) throw new Error('Nelze změnit runtime na jinou copy group');
      assertRuntimeGroup(nextGroup);
      group = nextGroup;
      positionCheckComplete = false;
      source.requireReconciliation();
    },
    async flattenAccount(accountId, operationId) {
      const allowed = new Set([
        group.leaderAccountId as number,
        ...group.followers.map(follower => follower.accountId),
      ]);
      if (!allowed.has(accountId)) throw new Error('Účet není součástí této copy group');
      return flatten([accountId], operationId);
    },
    async flattenGroup(operationId) {
      if (group.leaderAccountId == null) throw new Error('Copy group nemá leader účet');
      return flatten(
        [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)],
        operationId,
      );
    },
    async waiveStuckOperation({ kind, key, reason }) {
      const explanation = reason.trim();
      if (explanation.length < 5) throw new Error('Ruční resolution vyžaduje konkrétní důvod');
      gate = { ...gate, armed: false };
      positionCheckComplete = false;
      await processor.mutate(async current => {
        const outbox = new Map(current.outbox);
        const bracketOutbox = new Map(current.bracketOutbox);
        const osoOutbox = new Map(current.osoOutbox);
        const cancelOutbox = new Map(current.cancelOutbox);
        let state = current.state;
        if (kind === 'place') {
          const entry = outbox.get(key);
          if (!entry || !stuckEntries([entry]).length) throw new Error('Place outbox položka není stuck');
          outbox.set(key, waiveOutboxEntry(entry, explanation, clock()));
          state = applyResolved(state, [entry.key], entry.leaderSequence ?? state.lastSequence);
        } else if (kind === 'bracket') {
          const entry = bracketOutbox.get(key);
          if (!entry || !stuckBracketEntries([entry]).length) {
            throw new Error('Bracket outbox položka není stuck');
          }
          bracketOutbox.set(key, waiveBracketOutboxEntry(entry, explanation, clock()));
          state = applyResolved(state, [entry.key], entry.leaderSequence);
        } else if (kind === 'oso') {
          const entry = osoOutbox.get(key);
          if (!entry || !stuckOsoEntries([entry]).length) {
            throw new Error('OSO outbox položka není stuck');
          }
          osoOutbox.set(key, waiveOsoOutboxEntry(entry, explanation, clock()));
          state = applyResolved(state, [entry.key], entry.leaderSequence);
        } else {
          const entry = cancelOutbox.get(key);
          if (!entry || !stuckCancelEntries([entry]).length) {
            throw new Error('Cancel/modify outbox položka není stuck');
          }
          cancelOutbox.set(key, waiveCancelEntry(entry, explanation, clock()));
          const lifecycleEntries = [...cancelOutbox.values()].filter(
            item => item.leaderEventId === entry.leaderEventId,
          );
          if (
            lifecycleEntries.length > 0
            && lifecycleEntries.every(item => item.status === 'confirmed' || item.status === 'waived')
          ) {
            state = applyResolved(state, [], entry.leaderSequence);
          }
        }
        const committed = await options.store.commit(
          toSnapshot(
            state,
            outbox.values(),
            cancelOutbox.values(),
            current.revision,
            bracketOutbox.values(),
            osoOutbox.values(),
          ),
          current.revision,
        );
        return { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, revision: committed.revision };
      });
    },
    status() {
      const current = currentRuntime();
      const stuckOperations = currentStuckOperations();
      return {
        started: !stopped,
        armed: gate.armed,
        killSwitch: gate.killSwitch,
        shadowMode: gate.shadowMode,
        connected: gate.connected,
        reconciliationRequired: source.needsReconciliation() || !positionCheckComplete,
        divergentAccounts: [...gate.divergentAccounts],
        workingOrderAccounts: [...workingOrderAccounts],
        stuckOutbox: stuckOperations.length > 0,
        stuckOperations,
        lastError: lastError?.message ?? null,
        revision: current.revision,
        lastSequence: current.state.lastSequence,
        entryCooldownUntil: current.state.safety.entryCooldownUntil,
        dayLockUntil: current.state.safety.dayLockUntil,
        dayLockReason: current.state.safety.dayLockReason ?? null,
        armExpiresAt: gate.armed && gate.armTtlMs > 0 ? gate.armedAt + gate.armTtlMs : 0,
      };
    },
    async waitForIdle() {
      while (true) {
        const observed = eventTail;
        await observed;
        const pendingFlushes = [...pendingOsoFlushes.values()];
        if (pendingFlushes.length > 0) await Promise.all(pendingFlushes);
        if (observed === eventTail && pendingOsoFlushes.size === 0) return;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      gate = { ...gate, armed: false, connected: false };
      for (const timer of pendingBracketTimers.values()) clearTimeout(timer);
      pendingBracketTimers.clear();
      for (const timer of pendingOsoTimers.values()) clearTimeout(timer);
      pendingOsoTimers.clear();
      pendingOsoEvents.clear();
      for (const entryOrderId of [...pendingOsoResolvers.keys()]) settleOsoFlush(entryOrderId);
      unsubscribe();
    },
  };
}

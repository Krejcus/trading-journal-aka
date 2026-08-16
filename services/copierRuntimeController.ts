import type { BrokerEvent, BrokerPort } from './brokerPort';
import { CopierLeaderEventSource } from './copierLeaderEventSource';
import { stuckCancelEntries } from './copierCancelOutbox';
import { waiveCancelEntry } from './copierCancelOutbox';
import { stuckEntries, waiveOutboxEntry } from './copierOutbox';
import { applyResolved } from './copierEngine';
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

export interface CopierControllerStatus {
  started: boolean;
  armed: boolean;
  shadowMode: boolean;
  connected: boolean;
  reconciliationRequired: boolean;
  divergentAccounts: number[];
  workingOrderAccounts: number[];
  stuckOutbox: boolean;
  lastError: string | null;
  revision: number;
  lastSequence: number;
}

export interface CopierRuntimeController {
  arm(options?: { shadowMode?: boolean }): void;
  disarm(): void;
  /** Autoritativně porovná pozice a ověří, že nikde nezůstaly working orders. */
  reconcile(): Promise<{ divergentAccounts: number[]; workingOrderAccounts: number[] }>;
  updateGroup(group: CopyGroupConfig): void;
  /** Ruční uzavření nejasné operace; nikdy nic neposílá a vynutí novou reconciliation. */
  waiveStuckOperation(options: {
    kind: 'place' | 'cancel-or-modify';
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
  maxConcurrentDispatches?: number;
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
  let runtime: CopierRuntime = runtimeFromSnapshot(await options.store.load());
  const metrics = options.metrics ?? createCopierMetrics();
  const recovered = await recoverOutbox({
    runtime,
    broker: options.broker,
    clock,
    store: options.store,
    metrics,
  });
  runtime = recovered.runtime;
  if (recovered.audit.length > 0) options.onAudit?.(recovered.audit);

  const processor = createSerialCopierProcessor(runtime);
  const source = new CopierLeaderEventSource();
  let gate = createRiskGateContext({
    brokerEnvironment: options.broker.environment,
    expectedEnvironment: options.broker.environment,
    shadowMode: true,
    ...options.risk,
    armed: false,
    connected: false,
  });
  let stopped = false;
  let positionCheckComplete = false;
  let workingOrderAccounts = new Set<number>();
  let lastError: Error | null = null;
  let eventTail: Promise<void> = Promise.resolve();

  const currentRuntime = () => processor.currentRuntime();
  const hasStuckOutbox = () => {
    const current = currentRuntime();
    return stuckEntries(current.outbox.values()).length > 0
      || stuckCancelEntries(current.cancelOutbox.values()).length > 0;
  };

  const failClosed = (reason: unknown) => {
    lastError = errorOf(reason);
    gate = { ...gate, armed: false, connected: false };
    options.onError?.(lastError);
  };

  const handleBrokerEvent = async (event: BrokerEvent) => {
    if (stopped) return;
    const now = clock();
    if (event.type === 'heartbeat') {
      gate = { ...gate, lastHeartbeatAt: event.at };
      return;
    }
    if (event.type === 'error') {
      failClosed(event.error);
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
    if (event.type === 'position') return;
    if (group.leaderAccountId == null) return;
    const sequence = currentRuntime().state.lastSequence + 1;
    const leaderEvent = source.observe(event, group.leaderAccountId, sequence, now);
    if (!leaderEvent) return;
    const result = await processor.process({
      event: leaderEvent,
      group,
      context: {
        ...gate,
        now,
        sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
        stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
      },
      broker: options.broker,
      clock,
      store: options.store,
      metrics,
      maxConcurrentDispatches: options.maxConcurrentDispatches,
    });
    runtime = result.runtime;
    if (result.audit.length > 0) options.onAudit?.(result.audit);
  };

  const unsubscribe = options.broker.subscribe(event => {
    eventTail = eventTail.then(() => handleBrokerEvent(event)).catch(failClosed);
  });

  return {
    arm({ shadowMode = false } = {}) {
      if (stopped) throw new Error('Copier runtime is stopped');
      const now = clock();
      if (!gate.connected) throw new Error('Copier nelze armovat bez dokončeného broker syncu');
      if (source.needsReconciliation()) throw new Error('Po reconnectu je nutná kontrola pozic');
      if (!shadowMode && !positionCheckComplete) throw new Error('Před live dispatch je nutné potvrdit kontrolu pozic');
      if (hasStuckOutbox()) throw new Error('Copier má nevyřešený outbox');
      if (gate.divergentAccounts.size > 0) throw new Error('Pozice leader/follower se rozcházejí');
      if (workingOrderAccounts.size > 0) throw new Error('Před ARM musí být všechny účty bez pracovních příkazů');
      gate = { ...gate, armed: true, armedAt: now, now, shadowMode };
    },
    disarm() {
      gate = { ...gate, armed: false };
    },
    async reconcile() {
      if (!gate.connected) throw new Error('Kontrolu pozic nelze provést bez broker spojení');
      if (group.leaderAccountId == null) throw new Error('Copy group nemá leader účet');
      const accountIds = [group.leaderAccountId, ...group.followers.map(item => item.accountId)];
      const capabilities = await options.broker.listAccountCapabilities(accountIds);
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
        positions: await options.broker.listPositions(accountId),
        orders: await options.broker.listOrders(accountId),
      })));
      const byAccount = new Map(snapshots.map(item => [item.accountId, item]));
      const leaderPositions = new Map(
        (byAccount.get(group.leaderAccountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
      );
      const divergent = new Set<number>();
      workingOrderAccounts = new Set(
        snapshots.filter(item => item.orders.some(order => order.status === 'working')).map(item => item.accountId),
      );
      for (const follower of group.followers) {
        const followerPositions = new Map(
          (byAccount.get(follower.accountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
        );
        const symbols = new Set([...leaderPositions.keys(), ...followerPositions.keys()]);
        for (const symbol of symbols) {
          const expected = Math.trunc((leaderPositions.get(symbol) ?? 0) * follower.multiplier);
          if ((followerPositions.get(symbol) ?? 0) !== expected) {
            divergent.add(follower.accountId);
            break;
          }
        }
      }
      gate = { ...gate, divergentAccounts: divergent, sequenceBroken: false, armed: false };
      positionCheckComplete = divergent.size === 0 && workingOrderAccounts.size === 0;
      if (positionCheckComplete) source.acknowledgeReconciliation();
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
    },
    async waiveStuckOperation({ kind, key, reason }) {
      const explanation = reason.trim();
      if (explanation.length < 5) throw new Error('Ruční resolution vyžaduje konkrétní důvod');
      gate = { ...gate, armed: false };
      positionCheckComplete = false;
      await processor.mutate(async current => {
        const outbox = new Map(current.outbox);
        const cancelOutbox = new Map(current.cancelOutbox);
        let state = current.state;
        if (kind === 'place') {
          const entry = outbox.get(key);
          if (!entry || !stuckEntries([entry]).length) throw new Error('Place outbox položka není stuck');
          outbox.set(key, waiveOutboxEntry(entry, explanation, clock()));
          state = applyResolved(state, [entry.key], entry.leaderSequence ?? state.lastSequence);
        } else {
          const entry = cancelOutbox.get(key);
          if (!entry || !stuckCancelEntries([entry]).length) {
            throw new Error('Cancel/modify outbox položka není stuck');
          }
          cancelOutbox.set(key, waiveCancelEntry(entry, explanation, clock()));
          state = applyResolved(state, [], entry.leaderSequence);
        }
        const committed = await options.store.commit(
          toSnapshot(state, outbox.values(), cancelOutbox.values(), current.revision),
          current.revision,
        );
        return { state, outbox, cancelOutbox, revision: committed.revision };
      });
    },
    status() {
      const current = currentRuntime();
      return {
        started: !stopped,
        armed: gate.armed,
        shadowMode: gate.shadowMode,
        connected: gate.connected,
        reconciliationRequired: source.needsReconciliation() || !positionCheckComplete,
        divergentAccounts: [...gate.divergentAccounts],
        workingOrderAccounts: [...workingOrderAccounts],
        stuckOutbox: hasStuckOutbox(),
        lastError: lastError?.message ?? null,
        revision: current.revision,
        lastSequence: current.state.lastSequence,
      };
    },
    async waitForIdle() {
      let observed: Promise<void>;
      do {
        observed = eventTail;
        await observed;
      } while (observed !== eventTail);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      gate = { ...gate, armed: false, connected: false };
      unsubscribe();
    },
  };
}

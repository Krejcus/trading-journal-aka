import type { BrokerEvent, BrokerPort } from './brokerPort';
import {
  applyResolved,
  applyLeaderProgress,
  applyFollowerFillResolution,
  classifySequence,
  linkFollowerOrder,
  planCancel,
  planModify,
  planReplication,
  type CopierState,
  type LeaderEvent,
  type ReplicationPlan,
} from './copierEngine';
import {
  createOutboxEntry,
  markAcknowledged,
  markRejected,
  markSending,
  markUnknown,
  nextAction,
  resolveLookup,
  stuckEntries,
  type OutboxEntry,
} from './copierOutbox';
import {
  createCancelEntry,
  createModifyEntry,
  markCancelSending,
  markCancelUnknown,
  resolveCancelLookup,
  stuckCancelEntries,
  type CancelOutboxEntry,
} from './copierCancelOutbox';
import { evaluateRiskGate, haltReason, type RiskGateContext } from './copierRiskGate';
import { snapshotToState, toSnapshot, type CopierSnapshot, type CopierStore } from './copierStore';
import type { CopyGroupConfig } from './liveCopyTrading';

/**
 * Spojuje jádro copieru, outbox, risk gate a brokera do jedné cesty.
 *
 * Tohle je jediné místo, odkud se smí volat `placeOrder()`. Jádro plánuje,
 * gate rozhoduje, outbox hlídá nejasné konce a runner odesílá a commituje.
 *
 * Nejdůležitější pravidlo celého souboru: po timeoutu se NIKDY neposílá
 * znovu naslepo. Tradovate není idempotentní, takže slepý retry je druhý
 * obchod. Nejasná položka jde do stavu `unknown` a řeší ji `recoverOutbox()`.
 */

export type CopierAuditKind =
  | 'skipped'
  | 'blocked'
  | 'shadow'
  | 'dispatched'
  | 'rejected'
  | 'unknown'
  | 'recovered'
  | 'abandoned'
  | 'canceled'
  | 'modified'
  | 'cancel-failed'
  | 'sequence-broken';

export interface CopierAuditEntry {
  at: number;
  leaderEventId: string;
  kind: CopierAuditKind;
  accountId?: number;
  key?: string;
  brokerOrderId?: string;
  reason?: string;
}

export interface LatencySample {
  key: string;
  tag: string;
  eventReceivedAt: number;
  accountId: number;
  /** Od přijetí leader události po zahájení odesílání. */
  queueMs: number;
  /** Od zahájení odesílání po odpověď brokera. */
  brokerMs: number;
  /** Od přijetí leader události po potvrzení objednávky. */
  totalMs: number;
  /** user/syncrequest potvrdil existenci order entity. */
  orderAcceptedMs?: number;
  firstFillMs?: number;
  terminalMs?: number;
}

interface LifecycleObservation {
  orderAcceptedAt?: number;
  firstFillAt?: number;
  terminalAt?: number;
}

export interface CopierMetrics {
  dispatched: number;
  rejected: number;
  /** Objednávky s neznámým osudem — ty nejnebezpečnější. */
  unknown: number;
  /** Dohledané po timeoutu. */
  recovered: number;
  /** Nalezené duplicitní objednávky u brokera. Musí zůstat na nule. */
  duplicatesFound: number;
  abandoned: number;
  samples: LatencySample[];
  /** Interní buffer pro eventy, které mohou dorazit před REST odpovědí. */
  lifecycleByTag: Map<string, LifecycleObservation>;
}

export function createCopierMetrics(): CopierMetrics {
  return {
    dispatched: 0,
    rejected: 0,
    unknown: 0,
    recovered: 0,
    duplicatesFound: 0,
    abandoned: 0,
    samples: [],
    lifecycleByTag: new Map(),
  };
}

export function observeBrokerEvent(metrics: CopierMetrics, event: BrokerEvent, observedAt: number): void {
  if (event.type !== 'order' && event.type !== 'fill') return;
  const tag = event.type === 'order' ? event.order.tag : event.fill.tag;
  if (!tag) return;
  const current = metrics.lifecycleByTag.get(tag) ?? {};
  if (event.type === 'order') {
    current.orderAcceptedAt ??= observedAt;
    if (event.order.status !== 'working') current.terminalAt ??= observedAt;
  } else {
    current.firstFillAt ??= observedAt;
  }
  metrics.lifecycleByTag.set(tag, current);
  const sample = metrics.samples.find(item => item.tag === tag);
  if (sample) applyLifecycleTimes(sample, current);
}

function applyLifecycleTimes(sample: LatencySample, observation: LifecycleObservation): void {
  if (observation.orderAcceptedAt != null) sample.orderAcceptedMs = observation.orderAcceptedAt - sample.eventReceivedAt;
  if (observation.firstFillAt != null) sample.firstFillMs = observation.firstFillAt - sample.eventReceivedAt;
  if (observation.terminalAt != null) sample.terminalMs = observation.terminalAt - sample.eventReceivedAt;
}

export function attachCopierMetrics(
  broker: BrokerPort,
  metrics: CopierMetrics,
  clock: () => number,
): () => void {
  return broker.subscribe(event => observeBrokerEvent(metrics, event, clock()));
}

/** Percentil z naměřených hodnot. Prázdný vstup vrací 0. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export interface CopierRuntime {
  state: CopierState;
  outbox: Map<string, OutboxEntry>;
  cancelOutbox: Map<string, CancelOutboxEntry>;
  revision: number;
}

export function createRuntime(
  state: CopierState,
  outbox: Iterable<OutboxEntry> = [],
  cancelOutbox: Iterable<CancelOutboxEntry> = [],
  revision = 0,
): CopierRuntime {
  return {
    state,
    outbox: new Map([...outbox].map(entry => [entry.key, entry])),
    cancelOutbox: new Map([...cancelOutbox].map(entry => [entry.key, entry])),
    revision,
  };
}

export function runtimeFromSnapshot(snapshot: CopierSnapshot): CopierRuntime {
  return createRuntime(
    snapshotToState(snapshot),
    snapshot.outbox,
    snapshot.cancelOutbox,
    snapshot.revision,
  );
}

async function persistRuntime(
  store: CopierStore | undefined,
  state: CopierState,
  outbox: Map<string, OutboxEntry>,
  cancelOutbox: Map<string, CancelOutboxEntry>,
  revision: number,
): Promise<number> {
  if (!store) return revision;
  const committed = await store.commit(
    toSnapshot(state, outbox.values(), cancelOutbox.values(), revision),
    revision,
  );
  return committed.revision;
}

export interface ProcessLeaderEventOptions {
  event: LeaderEvent;
  group: CopyGroupConfig;
  runtime: CopierRuntime;
  context: RiskGateContext;
  broker: BrokerPort;
  /** Deterministické hodiny pro audit a měření latence. */
  clock: () => number;
  store?: CopierStore;
  metrics?: CopierMetrics;
  /** Lokální ochrana API; followery se stále překrývají, ale bez neomezeného fan-outu. */
  maxConcurrentDispatches?: number;
}

export interface CopierRunResult {
  runtime: CopierRuntime;
  plan: ReplicationPlan;
  audit: CopierAuditEntry[];
  metrics: CopierMetrics;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(items.length || 1, Math.floor(limit) || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

/**
 * Zpracuje jednu leader událost.
 *
 * Followery odesílá souběžně — kdyby se posílaly za sebou, poslednímu by
 * se do latence započítalo čekání na předchozí a měření by lhalo.
 */
export async function processLeaderEvent(
  options: ProcessLeaderEventOptions,
): Promise<CopierRunResult> {
  const { event, group, runtime, context, broker, clock, store } = options;
  const metrics = options.metrics ?? createCopierMetrics();
  const audit: CopierAuditEntry[] = [];
  const outbox = new Map(runtime.outbox);
  const cancelOutbox = new Map(runtime.cancelOutbox);
  let state = runtime.state;
  let revision = runtime.revision;

  const verdict = classifySequence(event.sequence, state.lastSequence);
  if (verdict === 'duplicate') {
    // Jen záznam do auditu — zpracování pokračuje. Kdyby se tady skončilo,
    // nešel by dokončit pokus, který minule spadl na timeout: `lastSequence`
    // už je posunutá, ale objednávka odeslaná není. Idempotenci hlídají
    // klíče replikace a outbox, ne pořadí ve streamu.
    audit.push({ at: clock(), leaderEventId: event.id, kind: 'skipped', reason: 'duplicate-sequence' });
  }

  const sequenceBroken = verdict === 'gap' || verdict === 'out-of-order';
  if (sequenceBroken) {
    audit.push({ at: clock(), leaderEventId: event.id, kind: 'sequence-broken', reason: verdict });
  }

  // Zrušení u leadera se řeší zvlášť — není to odvozená objednávka, ale
  // příkaz na konkrétní `brokerOrderId`, který známe z vazeb.
  const cancels = planCancel(event, state);
  const modifications = planModify(event, state, group);
  const commands = [
    ...cancels.map(command => ({ ...command, operation: 'cancel' as const })),
    ...modifications.map(command => ({ ...command, operation: 'modify' as const })),
  ];
  if (commands.length > 0) {
    const commandHalt = haltReason({
      ...context,
      sequenceBroken: context.sequenceBroken || sequenceBroken,
      stuckOutbox: context.stuckOutbox
        || stuckEntries(outbox.values()).length > 0
        || stuckCancelEntries(cancelOutbox.values()).some(entry => entry.leaderEventId !== event.id),
    });
    if (commandHalt || (broker.environment === 'live' && !store)) {
      const reason = commandHalt ?? 'durable-store-required';
      for (const command of commands) {
        audit.push({
          at: clock(), leaderEventId: event.id, kind: 'blocked', accountId: command.accountId,
          key: command.key, brokerOrderId: command.brokerOrderId, reason,
        });
      }
      return {
        runtime: { state, outbox, cancelOutbox, revision },
        plan: { leaderEventId: event.id, orders: [], skipped: [] }, audit, metrics,
      };
    }
    const sendableKeys = new Set<string>();
    const sending = commands.map(command => {
      const existing = cancelOutbox.get(command.key);
      const entry = existing ?? (command.operation === 'cancel'
        ? createCancelEntry(
            command.key, event.id, event.sequence, command.accountId, command.brokerOrderId, clock(),
          )
        : createModifyEntry(
            command.key,
            event.id,
            event.sequence,
            command.accountId,
            command.brokerOrderId,
            {
              quantity: command.quantity,
              orderType: command.orderType,
              ...(command.limitPrice != null ? { limitPrice: command.limitPrice } : {}),
              ...(command.stopPrice != null ? { stopPrice: command.stopPrice } : {}),
            },
            clock(),
          ));
      if (entry.status !== 'planned') return entry;
      sendableKeys.add(entry.key);
      return markCancelSending(entry, clock());
    });
    for (const entry of sending) cancelOutbox.set(entry.key, entry);
    // Write-ahead: `sending` musí být trvale uložené PŘED side effectem.
    if (sendableKeys.size > 0) {
      revision = await persistRuntime(store, state, outbox, cancelOutbox, revision);
    }

    await Promise.all(sending.map(async entry => {
      if (!sendableKeys.has(entry.key)) return;
      try {
        if (entry.operation === 'cancel') {
          await broker.cancelOrder(entry.accountId, entry.brokerOrderId);
        } else if (entry.changes) {
          await broker.modifyOrder(entry.accountId, entry.brokerOrderId, entry.changes);
        }
        cancelOutbox.set(entry.key, markCancelUnknown(entry, 'čeká na potvrzení order streamem', clock()));
      } catch (error) {
        cancelOutbox.set(entry.key, markCancelUnknown(
          entry,
          error instanceof Error ? error.message : String(error),
          clock(),
        ));
      }
    }));

    // HTTP/command ack není potvrzení zrušení. Ověříme stav objednávky.
    let allConfirmed = true;
    for (const entry of [...cancelOutbox.values()].filter(item => item.leaderEventId === event.id)) {
      const lookup = await broker.findOrderById(entry.accountId, entry.brokerOrderId);
      const resolved = resolveCancelLookup(entry, lookup.order, lookup.completeness, clock());
      cancelOutbox.set(entry.key, resolved);
      if (resolved.status === 'confirmed') {
        audit.push({
          at: clock(), leaderEventId: event.id,
          kind: entry.operation === 'cancel' ? 'canceled' : 'modified', accountId: entry.accountId,
          key: entry.key, brokerOrderId: entry.brokerOrderId,
        });
      } else {
        allConfirmed = false;
        audit.push({
          at: clock(), leaderEventId: event.id, kind: 'cancel-failed', accountId: entry.accountId,
          key: entry.key, brokerOrderId: entry.brokerOrderId, reason: resolved.reason,
        });
      }
    }
    if (allConfirmed) state = applyResolved(state, [], event.sequence);
    revision = await persistRuntime(store, state, outbox, cancelOutbox, revision);
    return {
      runtime: { state, outbox, cancelOutbox, revision },
      plan: { leaderEventId: event.id, orders: [], skipped: [] },
      audit,
      metrics,
    };
  }

  const plan = planReplication(event, group, state);
  for (const skip of plan.skipped) {
    audit.push({
      at: clock(),
      leaderEventId: event.id,
      kind: 'skipped',
      accountId: skip.followerAccountId,
      reason: skip.reason,
    });
  }

  const effectiveContext: RiskGateContext = {
    ...context,
    sequenceBroken: context.sequenceBroken || sequenceBroken,
    stuckOutbox: context.stuckOutbox
      || stuckEntries(outbox.values()).length > 0
      || stuckCancelEntries(cancelOutbox.values()).length > 0,
  };

  const byTag = new Map(plan.orders.map(order => [order.request.tag, order]));
  const decision = evaluateRiskGate(plan.orders.map(order => order.request), effectiveContext);

  for (const item of decision.blocked) {
    audit.push({
      at: clock(),
      leaderEventId: event.id,
      kind: 'blocked',
      accountId: item.request.accountId,
      key: byTag.get(item.request.tag)?.key,
      reason: item.reason,
    });
  }

  if (!decision.dispatch) {
    for (const request of decision.allowed) {
      audit.push({
        at: clock(),
        leaderEventId: event.id,
        kind: 'shadow',
        accountId: request.accountId,
        key: byTag.get(request.tag)?.key,
      });
    }
    // Sekvence a kumulativní fill progress patří k leader streamu, ne k
    // broker side effectu. Posouvají se i v shadow režimu a u událostí, pro
    // které žádný follower nemá odpovídající mód. Replikované klíče se
    // samozřejmě nezapisují.
    if (context.shadowMode || (plan.orders.length === 0 && decision.blocked.length === 0)) {
      state = applyLeaderProgress(state, event, group);
      state = applyResolved(state, [], event.sequence);
      revision = await persistRuntime(store, state, outbox, cancelOutbox, revision);
    }
    return { runtime: { state, outbox, cancelOutbox, revision }, plan, audit, metrics };
  }

  if (broker.environment === 'live' && !store) {
    for (const request of decision.allowed) {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'blocked', accountId: request.accountId,
        key: byTag.get(request.tag)?.key, reason: 'durable-store-required',
      });
    }
    return { runtime: { state, outbox, cancelOutbox, revision }, plan, audit, metrics };
  }

  state = applyLeaderProgress(state, event, group);

  const dispatchable: Array<{
    request: (typeof decision.allowed)[number];
    entry: OutboxEntry;
    startedAt: number;
  }> = [];
  const resolvedKeys: string[] = [];
  for (const request of decision.allowed) {
      const planned = byTag.get(request.tag);
      if (!planned) continue;

      let entry =
        outbox.get(planned.key) ??
        createOutboxEntry(
          planned.key,
          request.tag,
          event.orderId,
          request,
          clock(),
          event.kind === 'filled'
            && group.followers.some(follower =>
              follower.accountId === request.accountId && follower.mode === 'on-fill'),
          event.id,
          event.sequence,
        );
      const action = nextAction(entry);

      if (action.type === 'skip') {
        if (entry.status === 'acknowledged' || entry.status === 'rejected') resolvedKeys.push(entry.key);
        continue;
      }
      if (action.type === 'lookup') {
        continue;
      }

      const startedAt = clock();
      entry = markSending(entry, startedAt);
      outbox.set(entry.key, entry);
      dispatchable.push({ request, entry, startedAt });
  }

  // Skutečný write-ahead: celý batch `sending` je durable před prvním
  // placeOrder(). Pád od tohoto okamžiku vede po restartu na lookup, ne retry.
  if (dispatchable.length > 0) {
    revision = await persistRuntime(store, state, outbox, cancelOutbox, revision);
  }

  const results = await mapWithConcurrency(
    dispatchable,
    options.maxConcurrentDispatches ?? 4,
    async ({ request, entry: initialEntry, startedAt }) => {
      let entry = initialEntry;
      try {
        const ack = await broker.placeOrder(request);
        const ackAt = clock();

        if (!ack.accepted) {
          if (!ack.definitive) {
            metrics.unknown += 1;
            entry = markUnknown(entry, ack.rejectReason ?? 'nejednoznačná odpověď brokera', ackAt);
            return {
              entry,
              resolvedKey: null,
              audit: {
                at: ackAt, leaderEventId: event.id, kind: 'unknown' as CopierAuditKind,
                accountId: request.accountId, key: entry.key, reason: entry.reason,
              },
            };
          }
          metrics.rejected += 1;
          entry = markRejected(entry, ack.rejectReason ?? 'rejected', ackAt);
          return {
            entry,
            resolvedKey: entry.key,
            audit: {
              at: ackAt,
              leaderEventId: event.id,
              kind: 'rejected' as CopierAuditKind,
              accountId: request.accountId,
              key: entry.key,
              brokerOrderId: ack.brokerOrderId,
              reason: ack.rejectReason,
            },
          };
        }

        metrics.dispatched += 1;
        const sample: LatencySample = {
          key: entry.key,
          tag: request.tag,
          eventReceivedAt: event.receivedAt,
          accountId: request.accountId,
          queueMs: startedAt - event.receivedAt,
          brokerMs: ackAt - startedAt,
          totalMs: ackAt - event.receivedAt,
        };
        const observation = metrics.lifecycleByTag.get(request.tag);
        if (observation) applyLifecycleTimes(sample, observation);
        metrics.samples.push(sample);
        entry = markAcknowledged(entry, ack.brokerOrderId, ackAt);
        return {
          entry,
          resolvedKey: entry.key,
          audit: {
            at: ackAt,
            leaderEventId: event.id,
            kind: 'dispatched' as CopierAuditKind,
            accountId: request.accountId,
            key: entry.key,
            brokerOrderId: ack.brokerOrderId,
          },
        };
      } catch (error) {
        // Nevíme, jestli objednávka dorazila. Retry by mohl založit druhý
        // obchod, takže tady končíme a osud se dohledá zvlášť.
        const failedAt = clock();
        metrics.unknown += 1;
        entry = markUnknown(entry, error instanceof Error ? error.message : String(error), failedAt);
        return {
          entry,
          resolvedKey: null,
          audit: {
            at: failedAt,
            leaderEventId: event.id,
            kind: 'unknown' as CopierAuditKind,
            accountId: request.accountId,
            key: entry.key,
            reason: entry.reason,
          },
        };
      }
    },
  );

  for (const result of results) {
    outbox.set(result.entry.key, result.entry);
    if (result.resolvedKey) resolvedKeys.push(result.resolvedKey);
    if (result.audit) audit.push(result.audit);
    if (result.entry.status === 'acknowledged' && result.entry.brokerOrderId) {
      if (result.entry.tracksFillTarget) {
        state = applyFollowerFillResolution(
          state,
          result.entry.leaderOrderId,
          result.entry.request.accountId,
          result.entry.request.quantity,
        );
      }
      state = linkFollowerOrder(state, event.orderId, {
        key: result.entry.key,
        accountId: result.entry.request.accountId,
        brokerOrderId: result.entry.brokerOrderId,
        quantity: result.entry.request.quantity,
        ...(result.entry.request.limitPrice != null ? { limitPrice: result.entry.request.limitPrice } : {}),
        ...(result.entry.request.stopPrice != null ? { stopPrice: result.entry.request.stopPrice } : {}),
      });
    }
  }

  state = applyResolved(state, resolvedKeys, event.sequence);
  revision = await persistRuntime(store, state, outbox, cancelOutbox, revision);
  const runtimeNext: CopierRuntime = { state, outbox, cancelOutbox, revision };

  return { runtime: runtimeNext, plan, audit, metrics };
}

export interface RecoverOutboxOptions {
  runtime: CopierRuntime;
  broker: BrokerPort;
  clock: () => number;
  store?: CopierStore;
  metrics?: CopierMetrics;
}

/**
 * Dohledá objednávky s neznámým osudem.
 *
 * Tohle musí proběhnout po každém restartu a po každém timeoutu, dřív než
 * se pošle cokoli dalšího. Pro každou nejasnou položku se u brokera
 * hledají objednávky s jejím tagem:
 *  - nalezena jedna  → potvrzeno, hotovo
 *  - nalezeno víc    → duplicita, kterou musí vyřešit člověk
 *  - nenalezena nic  → retry jen po autoritativním synchronizačním výsledku
 */
export async function recoverOutbox(options: RecoverOutboxOptions): Promise<CopierRunResult> {
  const { runtime, broker, clock, store } = options;
  const metrics = options.metrics ?? createCopierMetrics();
  const audit: CopierAuditEntry[] = [];
  const outbox = new Map(runtime.outbox);
  const cancelOutbox = new Map(runtime.cancelOutbox);
  let state = runtime.state;
  let revision = runtime.revision;
  const resolvedKeys: string[] = [];

  for (const entry of [...outbox.values()]) {
    const action = nextAction(entry);
    if (action.type !== 'lookup') continue;

    const lookup = await broker.findOrdersByTag(entry.request.accountId, entry.tag);
    const found = lookup.orders;
    const at = clock();

    if (found.length > 1) {
      metrics.duplicatesFound += 1;
      const abandoned: OutboxEntry = {
        ...entry,
        status: 'abandoned',
        reason: `u brokera nalezeno ${found.length} objednávek se stejným tagem`,
        updatedAt: at,
      };
      outbox.set(entry.key, abandoned);
      audit.push({
        at,
        leaderEventId: '',
        kind: 'abandoned',
        accountId: entry.request.accountId,
        key: entry.key,
        reason: abandoned.reason,
      });
      continue;
    }

    const match = found[0];
    const resolved = resolveLookup(
      entry,
      match
        ? {
            brokerOrderId: match.brokerOrderId,
            ...(match.status === 'rejected' ? { rejected: true } : {}),
            ...(match.rejectReason ? { reason: match.rejectReason } : {}),
          }
        : null,
      lookup.completeness,
      at,
    );
    outbox.set(entry.key, resolved);

    if (resolved.status === 'acknowledged' || resolved.status === 'rejected') {
      metrics.recovered += 1;
      resolvedKeys.push(resolved.key);
      if (resolved.status === 'acknowledged' && resolved.brokerOrderId) {
        if (resolved.tracksFillTarget) {
          state = applyFollowerFillResolution(
            state,
            resolved.leaderOrderId,
            resolved.request.accountId,
            resolved.request.quantity,
          );
        }
        // Bez obnovení vazby by dohledaná objednávka zůstala nezrušitelná.
        state = linkFollowerOrder(state, resolved.leaderOrderId, {
          key: resolved.key,
          accountId: resolved.request.accountId,
          brokerOrderId: resolved.brokerOrderId,
          quantity: resolved.request.quantity,
          ...(resolved.request.limitPrice != null ? { limitPrice: resolved.request.limitPrice } : {}),
          ...(resolved.request.stopPrice != null ? { stopPrice: resolved.request.stopPrice } : {}),
        });
      }
      audit.push({
        at,
        leaderEventId: '',
        kind: 'recovered',
        accountId: entry.request.accountId,
        key: entry.key,
        ...(resolved.brokerOrderId ? { brokerOrderId: resolved.brokerOrderId } : {}),
        reason: resolved.status,
      });
    } else if (resolved.status === 'abandoned') {
      metrics.abandoned += 1;
      audit.push({
        at,
        leaderEventId: '',
        kind: 'abandoned',
        accountId: entry.request.accountId,
        key: entry.key,
        ...(resolved.reason ? { reason: resolved.reason } : {}),
      });
    } else {
      audit.push({
        at,
        leaderEventId: '',
        kind: 'recovered',
        accountId: entry.request.accountId,
        key: entry.key,
        reason: resolved.status === 'planned'
          ? 'autoritativně nenalezeno, smí se poslat znovu'
          : resolved.reason,
      });
    }
  }

  for (const entry of [...cancelOutbox.values()]) {
    if (entry.status !== 'sending' && entry.status !== 'unknown') continue;
    const lookup = await broker.findOrderById(entry.accountId, entry.brokerOrderId);
    const at = clock();
    const resolved = resolveCancelLookup(entry, lookup.order, lookup.completeness, at);
    cancelOutbox.set(entry.key, resolved);
    if (resolved.status === 'confirmed') {
      state = applyResolved(state, [], resolved.leaderSequence);
      metrics.recovered += 1;
      audit.push({
        at,
        leaderEventId: resolved.leaderEventId,
        kind: resolved.operation === 'cancel' ? 'canceled' : 'modified',
        accountId: resolved.accountId,
        key: resolved.key, brokerOrderId: resolved.brokerOrderId, reason: 'confirmed-after-recovery',
      });
    } else if (resolved.status === 'abandoned') {
      metrics.abandoned += 1;
      audit.push({
        at, leaderEventId: resolved.leaderEventId, kind: 'abandoned', accountId: resolved.accountId,
        key: resolved.key, brokerOrderId: resolved.brokerOrderId, reason: resolved.reason,
      });
    }
  }

  const recoveredSequence = Math.max(
    state.lastSequence,
    ...[...outbox.values()]
      .filter(entry => resolvedKeys.includes(entry.key))
      .map(entry => entry.leaderSequence ?? state.lastSequence),
  );
  state = applyResolved(state, resolvedKeys, recoveredSequence);
  revision = await persistRuntime(store, state, outbox, cancelOutbox, revision);

  return {
    runtime: { state, outbox, cancelOutbox, revision },
    plan: { leaderEventId: '', orders: [], skipped: [] },
    audit,
    metrics,
  };
}

/**
 * Přehraje záznam leader událostí.
 *
 * Používá se v testech i pro shadow porovnání proti TradeCopii: stejný
 * vstup musí dát stejný výstup, jinak není copier deterministický.
 */
export async function replayLeaderEvents(
  events: readonly LeaderEvent[],
  options: Omit<ProcessLeaderEventOptions, 'event'>,
): Promise<CopierRunResult> {
  let runtime = options.runtime;
  const audit: CopierAuditEntry[] = [];
  const metrics = options.metrics ?? createCopierMetrics();
  let plan: ReplicationPlan = { leaderEventId: '', orders: [], skipped: [] };

  for (const event of events) {
    const result = await processLeaderEvent({ ...options, event, runtime, metrics });
    runtime = result.runtime;
    plan = result.plan;
    audit.push(...result.audit);
  }

  return { runtime, plan, audit, metrics };
}

/**
 * Jediný vstup pro živý stream. Události stejné runtime zpracovává striktně
 * sériově, takže dva callbacky WebSocketu nemohou závodit o stejný snapshot.
 * CAS ve store zůstává druhá obranná vrstva proti druhému procesu/VPS.
 */
export function createSerialCopierProcessor(initialRuntime: CopierRuntime) {
  let runtime = initialRuntime;
  let tail: Promise<void> = Promise.resolve();

  return {
    process(options: Omit<ProcessLeaderEventOptions, 'runtime'>): Promise<CopierRunResult> {
      const run = tail.then(() => processLeaderEvent({ ...options, runtime }));
      tail = run.then(result => {
        runtime = result.runtime;
      }, () => undefined);
      return run;
    },
    mutate(operation: (current: CopierRuntime) => Promise<CopierRuntime>): Promise<CopierRuntime> {
      const run = tail.then(() => operation(runtime));
      tail = run.then(next => {
        runtime = next;
      }, () => undefined);
      return run;
    },
    currentRuntime(): CopierRuntime {
      return runtime;
    },
  };
}

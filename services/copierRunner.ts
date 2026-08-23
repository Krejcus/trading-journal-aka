import type { BrokerEvent, BrokerOcoRequest, BrokerOrderRequest, BrokerOsoRequest, BrokerPort } from './brokerPort';
import {
  applyResolved,
  applyLeaderProgress,
  applyFollowerFillResolution,
  classifySequence,
  followerQuantity,
  linkFollowerOrder,
  planCancel,
  planModify,
  planReplication,
  type CopierState,
  type FollowerOrderLink,
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
  waiveCancelEntry,
  type CancelOutboxEntry,
} from './copierCancelOutbox';
import {
  createBracketOutboxEntry,
  markBracketAcknowledged,
  markBracketRejected,
  markBracketSending,
  markBracketUnknown,
  nextBracketAction,
  resolveBracketLookup,
  secondBracketTag,
  stuckBracketEntries,
  type BracketOutboxEntry,
} from './copierBracketOutbox';
import type { LeaderBracketPair } from './copierBracketCorrelator';
import {
  createOsoOutboxEntry,
  markOsoAcknowledged,
  markOsoRejected,
  markOsoSending,
  markOsoUnknown,
  nextOsoAction,
  resolveOsoLookup,
  stuckOsoEntries,
  type OsoOutboxEntry,
} from './copierOsoOutbox';
import type { LeaderOsoPair } from './copierOsoCorrelator';
import { brokerTag } from './copierKeys';
import {
  cancelLifecycleHaltReason,
  evaluateRiskGate,
  haltReason,
  type RiskGateContext,
} from './copierRiskGate';
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
  bracketOutbox: Map<string, BracketOutboxEntry>;
  osoOutbox: Map<string, OsoOutboxEntry>;
  cancelOutbox: Map<string, CancelOutboxEntry>;
  /** Ephemeral synthetic links used only to validate modify/cancel during shadow. Never persisted. */
  shadowLinks?: Map<string, readonly FollowerOrderLink[]>;
  revision: number;
}

export function createRuntime(
  state: CopierState,
  outbox: Iterable<OutboxEntry> = [],
  cancelOutbox: Iterable<CancelOutboxEntry> = [],
  revision = 0,
  bracketOutbox: Iterable<BracketOutboxEntry> = [],
  osoOutbox: Iterable<OsoOutboxEntry> = [],
): CopierRuntime {
  return {
    state,
    outbox: new Map([...outbox].map(entry => [entry.key, entry])),
    bracketOutbox: new Map([...bracketOutbox].map(entry => [entry.key, entry])),
    osoOutbox: new Map([...osoOutbox].map(entry => [entry.key, entry])),
    cancelOutbox: new Map([...cancelOutbox].map(entry => [entry.key, entry])),
    shadowLinks: new Map(),
    revision,
  };
}

function waiveSupersededModifications(
  cancelOutbox: Map<string, CancelOutboxEntry>,
  confirmedCancel: CancelOutboxEntry,
  clock: () => number,
): void {
  if (confirmedCancel.operation !== 'cancel') return;
  for (const [key, prior] of cancelOutbox) {
    if (
      prior.operation === 'modify'
      && prior.accountId === confirmedCancel.accountId
      && prior.brokerOrderId === confirmedCancel.brokerOrderId
      && stuckCancelEntries([prior]).length > 0
    ) {
      cancelOutbox.set(key, waiveCancelEntry(
        prior,
        `nahrazeno potvrzeným cancellem ${confirmedCancel.key}`,
        clock(),
      ));
    }
  }
}

export function runtimeFromSnapshot(snapshot: CopierSnapshot): CopierRuntime {
  return createRuntime(
    snapshotToState(snapshot),
    snapshot.outbox,
    snapshot.cancelOutbox,
    snapshot.revision,
    snapshot.bracketOutbox ?? [],
    snapshot.osoOutbox ?? [],
  );
}

async function persistRuntime(
  store: CopierStore | undefined,
  state: CopierState,
  outbox: Map<string, OutboxEntry>,
  cancelOutbox: Map<string, CancelOutboxEntry>,
  bracketOutbox: Map<string, BracketOutboxEntry>,
  osoOutbox: Map<string, OsoOutboxEntry>,
  revision: number,
): Promise<number> {
  if (!store) return revision;
  const committed = await store.commit(
    toSnapshot(
      state, outbox.values(), cancelOutbox.values(), revision,
      bracketOutbox.values(), osoOutbox.values(),
    ),
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
  /**
   * Odložené zpracování už ZAZNAMENANÉ události (OSO inference okno).
   * Sekvence události byla platná v okamžiku observe a mezitím ji legitimně
   * posunuly její vlastní legy nebo nesouvisející lifecycle — `out-of-order`
   * tady není rozbitý stream, ale očekávaný replay. Idempotenci hlídají
   * replikační klíče a outbox, ne pořadí (živý pád 2026-08-20 17:04Z:
   * lone-leg posunul počítadlo a flush entry shodil copier).
   */
  deferredReplay?: boolean;
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

export interface ProcessBracketPairOptions {
  pair: LeaderBracketPair;
  /** Druhý protective leg, kterým byl pár dokončen. */
  event: LeaderEvent;
  group: CopyGroupConfig;
  runtime: CopierRuntime;
  context: RiskGateContext;
  broker: BrokerPort;
  clock: () => number;
  store?: CopierStore;
  metrics?: CopierMetrics;
  maxConcurrentDispatches?: number;
}

/**
 * Zapíše leader událost bez broker side effectu. Používá se pro první
 * protective leg, který musí počkat na druhý leg OCO páru.
 */
export async function recordLeaderEventOnly(
  options: Pick<ProcessLeaderEventOptions, 'event' | 'group' | 'runtime' | 'clock' | 'store'>,
): Promise<CopierRunResult> {
  const { event, group, runtime, clock, store } = options;
  const audit: CopierAuditEntry[] = [];
  const verdict = classifySequence(event.sequence, runtime.state.lastSequence);
  if (verdict === 'gap' || verdict === 'out-of-order') {
    audit.push({ at: clock(), leaderEventId: event.id, kind: 'sequence-broken', reason: verdict });
    return {
      runtime,
      plan: { leaderEventId: event.id, orders: [], skipped: [] },
      audit,
      metrics: createCopierMetrics(),
    };
  }
  let state = applyLeaderProgress(runtime.state, event, group);
  state = applyResolved(state, [], event.sequence);
  const revision = await persistRuntime(
    store,
    state,
    runtime.outbox,
    runtime.cancelOutbox,
    runtime.bracketOutbox,
    runtime.osoOutbox,
    runtime.revision,
  );
  return {
    runtime: { ...runtime, state, revision },
    plan: { leaderEventId: event.id, orders: [], skipped: [] },
    audit,
    metrics: createCopierMetrics(),
  };
}

/** Odesílá protective SL+TP výhradně přes jeden nativní OCO side effect. */
export async function processBracketPair(options: ProcessBracketPairOptions): Promise<CopierRunResult> {
  const { pair, event, group, runtime, context, broker, clock, store } = options;
  const metrics = options.metrics ?? createCopierMetrics();
  const audit: CopierAuditEntry[] = [];
  const outbox = new Map(runtime.outbox);
  const bracketOutbox = new Map(runtime.bracketOutbox);
  const osoOutbox = new Map(runtime.osoOutbox);
  const cancelOutbox = new Map(runtime.cancelOutbox);
  let shadowLinks = new Map(runtime.shadowLinks ?? []);
  let state = runtime.state;
  let revision = runtime.revision;
  const verdict = classifySequence(event.sequence, state.lastSequence);
  const sequenceBroken = verdict === 'gap' || verdict === 'out-of-order';
  if (sequenceBroken) {
    audit.push({ at: clock(), leaderEventId: event.id, kind: 'sequence-broken', reason: verdict });
    return {
      runtime: { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, shadowLinks, revision },
      plan: { leaderEventId: event.id, orders: [], skipped: [] }, audit, metrics,
    };
  }

  state = applyLeaderProgress(state, event, group);
  const jobs = group.followers.flatMap(follower => {
    if (follower.mode === 'off') {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'skipped', accountId: follower.accountId,
        reason: 'follower-disabled',
      });
      return [];
    }
    if (follower.mode !== 'on-submit') {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'blocked', accountId: follower.accountId,
        reason: 'bracket-on-fill-not-supported',
      });
      return [];
    }
    // MaxContracts se nesmi aplikovat tichym zkracenim mnozstvi. Plny
    // prepocitany prikaz overi exposure-capped broker tesne pred side effectem.
    const quantity = followerQuantity(pair.quantity, follower.multiplier);
    if (quantity <= 0) {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'skipped', accountId: follower.accountId,
        reason: 'scaled-quantity-zero',
      });
      return [];
    }
    const key = `br:${group.id}:${pair.entryOrderId}:${follower.accountId}`;
    const tag = brokerTag('cp', group.id, `bracket:${pair.entryOrderId}`, follower.accountId);
    const request: BrokerOcoRequest = {
      tag,
      accountId: follower.accountId,
      symbol: pair.symbol,
      quantity,
      first: { side: pair.side, orderType: 'Stop', stopPrice: pair.stopPrice },
      second: { side: pair.side, orderType: 'Limit', limitPrice: pair.targetPrice },
    };
    const gateRequests: BrokerOrderRequest[] = [
      {
        tag, accountId: follower.accountId, symbol: pair.symbol, side: pair.side,
        quantity, orderType: 'Stop', stopPrice: pair.stopPrice,
      },
      {
        tag: secondBracketTag(tag), accountId: follower.accountId, symbol: pair.symbol, side: pair.side,
        quantity, orderType: 'Limit', limitPrice: pair.targetPrice,
      },
    ];
    return [{ follower, key, tag, request, gateRequests }];
  });

  const dispatchable: Array<{
    key: string;
    request: BrokerOcoRequest;
    entry: BracketOutboxEntry;
    startedAt: number;
  }> = [];
  const resolvedKeys: string[] = [];
  // Posuzuj bezpečnost proti stavu před začátkem celé fan-out dávky.
  // Nové `sending` položky dřívějších followerů stejné dávky nejsou stuck.
  const hadUnsafeOutboxAtBatchStart = context.stuckOutbox
    || stuckEntries(outbox.values()).length > 0
    || stuckBracketEntries(bracketOutbox.values()).length > 0
    || stuckOsoEntries(osoOutbox.values()).length > 0
    || stuckCancelEntries(cancelOutbox.values()).length > 0;

  for (const job of jobs) {
    const decision = evaluateRiskGate(job.gateRequests, {
      ...context,
      sequenceBroken: context.sequenceBroken || sequenceBroken,
      stuckOutbox: hadUnsafeOutboxAtBatchStart,
    });
    if (decision.blocked.length > 0 || decision.allowed.length !== 2) {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'blocked', accountId: job.follower.accountId,
        key: job.key, reason: decision.haltReason ?? decision.blocked[0]?.reason ?? 'oco-gate-blocked',
      });
      continue;
    }
    if (!decision.dispatch) {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'shadow', accountId: job.follower.accountId,
        key: job.key, reason: 'native-oco',
      });
      if (context.shadowMode) {
        const stopState = linkFollowerOrder({ ...state, links: shadowLinks }, pair.stopOrderId, {
          key: `${job.key}:stop`, accountId: job.follower.accountId,
          brokerOrderId: `shadow:${job.key}:stop`, quantity: job.request.quantity,
          stopPrice: pair.stopPrice,
        });
        const targetState = linkFollowerOrder(
          { ...state, links: stopState.links },
          pair.targetOrderId,
          {
            key: `${job.key}:target`, accountId: job.follower.accountId,
            brokerOrderId: `shadow:${job.key}:target`, quantity: job.request.quantity,
            limitPrice: pair.targetPrice,
          },
        );
        shadowLinks = new Map(targetState.links);
      }
      continue;
    }
    if (!broker.placeOco) {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'blocked', accountId: job.follower.accountId,
        key: job.key, reason: 'broker-native-oco-required',
      });
      continue;
    }
    let entry = bracketOutbox.get(job.key) ?? createBracketOutboxEntry({
      key: job.key,
      tag: job.tag,
      leaderEntryOrderId: pair.entryOrderId,
      leaderStopOrderId: pair.stopOrderId,
      leaderTargetOrderId: pair.targetOrderId,
      leaderEventId: event.id,
      leaderSequence: event.sequence,
      request: job.request,
      now: clock(),
    });
    const action = nextBracketAction(entry);
    if (action.type === 'skip') {
      if (entry.status === 'acknowledged' || entry.status === 'rejected') resolvedKeys.push(entry.key);
      continue;
    }
    if (action.type === 'lookup') continue;
    const startedAt = clock();
    entry = markBracketSending(entry, startedAt);
    bracketOutbox.set(entry.key, entry);
    dispatchable.push({ key: job.key, request: job.request, entry, startedAt });
  }

  if (dispatchable.length > 0) {
    revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);
  }

  const results = await mapWithConcurrency(
    dispatchable,
    options.maxConcurrentDispatches ?? 4,
    async item => {
      let entry = item.entry;
      try {
        const ack = await broker.placeOco!(item.request);
        const at = clock();
        if (!ack.accepted) {
          entry = ack.definitive
            ? markBracketRejected(entry, ack.rejectReason ?? 'OCO rejected', at)
            : markBracketUnknown(entry, ack.rejectReason ?? 'nejednoznačná OCO odpověď', at);
          return { entry, at };
        }
        entry = markBracketAcknowledged(
          entry,
          ack.firstBrokerOrderId,
          ack.secondBrokerOrderId,
          at,
        );
        return { entry, at };
      } catch (error) {
        const at = clock();
        entry = markBracketUnknown(
          entry,
          error instanceof Error ? error.message : String(error),
          at,
        );
        return { entry, at };
      }
    },
  );

  for (const result of results) {
    const entry = result.entry;
    bracketOutbox.set(entry.key, entry);
    if (
      entry.status === 'acknowledged'
      && entry.firstBrokerOrderId
      && entry.secondBrokerOrderId
    ) {
      metrics.dispatched += 2;
      resolvedKeys.push(entry.key);
      state = linkFollowerOrder(state, entry.leaderStopOrderId, {
        key: `${entry.key}:stop`, accountId: entry.request.accountId,
        brokerOrderId: entry.firstBrokerOrderId, quantity: entry.request.quantity,
        stopPrice: entry.request.first.stopPrice,
      });
      state = linkFollowerOrder(state, entry.leaderTargetOrderId, {
        key: `${entry.key}:target`, accountId: entry.request.accountId,
        brokerOrderId: entry.secondBrokerOrderId, quantity: entry.request.quantity,
        limitPrice: entry.request.second.limitPrice,
      });
      audit.push({
        at: result.at, leaderEventId: event.id, kind: 'dispatched', accountId: entry.request.accountId,
        key: entry.key, brokerOrderId: `${entry.firstBrokerOrderId},${entry.secondBrokerOrderId}`,
        reason: 'native-oco',
      });
    } else if (entry.status === 'rejected') {
      metrics.rejected += 1;
      resolvedKeys.push(entry.key);
      audit.push({
        at: result.at, leaderEventId: event.id, kind: 'rejected', accountId: entry.request.accountId,
        key: entry.key, reason: entry.reason,
      });
    } else {
      metrics.unknown += 1;
      audit.push({
        at: result.at, leaderEventId: event.id, kind: 'unknown', accountId: entry.request.accountId,
        key: entry.key, reason: entry.reason,
      });
    }
  }

  state = applyResolved(state, resolvedKeys, event.sequence);
  revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);
  return {
    runtime: { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, shadowLinks, revision },
    plan: { leaderEventId: event.id, orders: [], skipped: [] },
    audit,
    metrics,
  };
}

export interface ProcessOsoPairOptions extends Omit<ProcessBracketPairOptions, 'pair'> {
  pair: LeaderOsoPair;
}

/** Odesílá čekající entry + SL + TP jediným nativním placeOSO side effectem. */
export async function processOsoPair(options: ProcessOsoPairOptions): Promise<CopierRunResult> {
  const { pair, event, group, runtime, context, broker, clock, store } = options;
  const metrics = options.metrics ?? createCopierMetrics();
  const audit: CopierAuditEntry[] = [];
  const outbox = new Map(runtime.outbox);
  const bracketOutbox = new Map(runtime.bracketOutbox);
  const osoOutbox = new Map(runtime.osoOutbox);
  const cancelOutbox = new Map(runtime.cancelOutbox);
  let shadowLinks = new Map(runtime.shadowLinks ?? []);
  let state = runtime.state;
  let revision = runtime.revision;
  const verdict = classifySequence(event.sequence, state.lastSequence);
  if (verdict === 'gap' || verdict === 'out-of-order') {
    audit.push({ at: clock(), leaderEventId: event.id, kind: 'sequence-broken', reason: verdict });
    return {
      runtime: { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, shadowLinks, revision },
      plan: { leaderEventId: event.id, orders: [], skipped: [] }, audit, metrics,
    };
  }
  state = applyLeaderProgress(state, event, group);

  const dispatchable: OsoOutboxEntry[] = [];
  const resolvedKeys: string[] = [];
  // Stejné pravidlo jako u OCO: sourozenci v jedné atomické dávce se
  // navzájem neblokují, ale starší nevyřešený outbox blokuje všechny.
  const hadUnsafeOutboxAtBatchStart = context.stuckOutbox
    || stuckEntries(outbox.values()).length > 0
    || stuckBracketEntries(bracketOutbox.values()).length > 0
    || stuckOsoEntries(osoOutbox.values()).length > 0
    || stuckCancelEntries(cancelOutbox.values()).length > 0;
  for (const follower of group.followers) {
    if (follower.mode === 'off') continue;
    if (follower.mode !== 'on-submit') {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'blocked', accountId: follower.accountId,
        reason: 'oso-on-fill-not-supported',
      });
      continue;
    }
    // MaxContracts se nesmi aplikovat tichym zkracenim mnozstvi. Plny
    // prepocitany prikaz overi exposure-capped broker tesne pred side effectem.
    const quantity = followerQuantity(pair.quantity, follower.multiplier);
    if (quantity <= 0) {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'skipped', accountId: follower.accountId,
        reason: 'scaled-quantity-zero',
      });
      continue;
    }
    const key = `oso:${group.id}:${pair.entryOrderId}:${follower.accountId}`;
    const tag = brokerTag('cp', group.id, `oso:${pair.entryOrderId}`, follower.accountId);
    const request: BrokerOsoRequest = {
      tag, accountId: follower.accountId, symbol: pair.symbol, side: pair.entrySide,
      quantity, orderType: pair.entryOrderType,
      ...(pair.entryLimitPrice != null ? { limitPrice: pair.entryLimitPrice } : {}),
      ...(pair.entryStopPrice != null ? { stopPrice: pair.entryStopPrice } : {}),
      first: { side: pair.entrySide === 'Buy' ? 'Sell' : 'Buy', orderType: 'Stop', stopPrice: pair.stopPrice },
      second: { side: pair.entrySide === 'Buy' ? 'Sell' : 'Buy', orderType: 'Limit', limitPrice: pair.targetPrice },
    };
    const gateRequests: BrokerOrderRequest[] = [
      request,
      { tag: `${tag}s`, accountId: follower.accountId, symbol: pair.symbol, side: request.first.side,
        quantity, orderType: 'Stop', stopPrice: pair.stopPrice },
      { tag: `${tag}t`, accountId: follower.accountId, symbol: pair.symbol, side: request.second.side,
        quantity, orderType: 'Limit', limitPrice: pair.targetPrice },
    ];
    const decision = evaluateRiskGate(gateRequests, {
      ...context,
      stuckOutbox: hadUnsafeOutboxAtBatchStart,
    });
    if (decision.blocked.length > 0 || decision.allowed.length !== 3) {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'blocked', accountId: follower.accountId,
        key, reason: decision.haltReason ?? decision.blocked[0]?.reason ?? 'oso-gate-blocked',
      });
      continue;
    }
    if (!decision.dispatch) {
      audit.push({ at: clock(), leaderEventId: event.id, kind: 'shadow', accountId: follower.accountId, key, reason: 'native-oso' });
      if (context.shadowMode) {
        const links: Array<[string, FollowerOrderLink]> = [
          [pair.entryOrderId, { key: `${key}:entry`, accountId: follower.accountId, brokerOrderId: `shadow:${key}:entry`, quantity, limitPrice: pair.entryLimitPrice, stopPrice: pair.entryStopPrice }],
          [pair.stopOrderId, { key: `${key}:stop`, accountId: follower.accountId, brokerOrderId: `shadow:${key}:stop`, quantity, stopPrice: pair.stopPrice }],
          [pair.targetOrderId, { key: `${key}:target`, accountId: follower.accountId, brokerOrderId: `shadow:${key}:target`, quantity, limitPrice: pair.targetPrice }],
        ];
        for (const [leaderOrderId, link] of links) {
          const linked = linkFollowerOrder({ ...state, links: shadowLinks }, leaderOrderId, link);
          shadowLinks = new Map(linked.links);
        }
      }
      continue;
    }
    if (!broker.placeOso) {
      audit.push({ at: clock(), leaderEventId: event.id, kind: 'blocked', accountId: follower.accountId, key, reason: 'broker-native-oso-required' });
      continue;
    }
    let entry = osoOutbox.get(key) ?? createOsoOutboxEntry({
      key, tag, leaderEntryOrderId: pair.entryOrderId, leaderStopOrderId: pair.stopOrderId,
      leaderTargetOrderId: pair.targetOrderId, leaderEventId: event.id,
      leaderSequence: event.sequence, request, updatedAt: clock(),
    });
    const action = nextOsoAction(entry);
    if (action.type === 'skip') {
      if (entry.status === 'acknowledged' || entry.status === 'rejected') resolvedKeys.push(entry.key);
      continue;
    }
    if (action.type === 'lookup') continue;
    entry = markOsoSending(entry, clock());
    osoOutbox.set(key, entry);
    dispatchable.push(entry);
  }

  if (dispatchable.length > 0) {
    revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);
  }
  const results = await mapWithConcurrency(dispatchable, options.maxConcurrentDispatches ?? 4, async initial => {
    let entry = initial;
    try {
      const ack = await broker.placeOso!(entry.request);
      const at = clock();
      entry = ack.accepted
        ? markOsoAcknowledged(entry, ack.entryBrokerOrderId, ack.firstBrokerOrderId, ack.secondBrokerOrderId, at)
        : ack.definitive
          ? markOsoRejected(entry, ack.rejectReason ?? 'OSO rejected', at)
          : markOsoUnknown(entry, ack.rejectReason ?? 'nejednoznačná OSO odpověď', at);
      return { entry, at };
    } catch (error) {
      const at = clock();
      return { entry: markOsoUnknown(entry, error instanceof Error ? error.message : String(error), at), at };
    }
  });

  for (const { entry, at } of results) {
    osoOutbox.set(entry.key, entry);
    if (entry.status === 'acknowledged' && entry.entryBrokerOrderId && entry.firstBrokerOrderId && entry.secondBrokerOrderId) {
      metrics.dispatched += 3;
      resolvedKeys.push(entry.key);
      state = linkFollowerOrder(state, entry.leaderEntryOrderId, {
        key: `${entry.key}:entry`, accountId: entry.request.accountId, brokerOrderId: entry.entryBrokerOrderId,
        quantity: entry.request.quantity, limitPrice: entry.request.limitPrice, stopPrice: entry.request.stopPrice,
      });
      state = linkFollowerOrder(state, entry.leaderStopOrderId, {
        key: `${entry.key}:stop`, accountId: entry.request.accountId, brokerOrderId: entry.firstBrokerOrderId,
        quantity: entry.request.quantity, stopPrice: entry.request.first.stopPrice,
      });
      state = linkFollowerOrder(state, entry.leaderTargetOrderId, {
        key: `${entry.key}:target`, accountId: entry.request.accountId, brokerOrderId: entry.secondBrokerOrderId,
        quantity: entry.request.quantity, limitPrice: entry.request.second.limitPrice,
      });
      audit.push({ at, leaderEventId: event.id, kind: 'dispatched', accountId: entry.request.accountId, key: entry.key,
        brokerOrderId: `${entry.entryBrokerOrderId},${entry.firstBrokerOrderId},${entry.secondBrokerOrderId}`, reason: 'native-oso' });
    } else if (entry.status === 'rejected') {
      metrics.rejected += 1;
      resolvedKeys.push(entry.key);
      audit.push({ at, leaderEventId: event.id, kind: 'rejected', accountId: entry.request.accountId, key: entry.key, reason: entry.reason });
    } else {
      metrics.unknown += 1;
      audit.push({ at, leaderEventId: event.id, kind: 'unknown', accountId: entry.request.accountId, key: entry.key, reason: entry.reason });
    }
  }
  state = applyResolved(state, resolvedKeys, event.sequence);
  revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);
  return {
    runtime: { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, shadowLinks, revision },
    plan: { leaderEventId: event.id, orders: [], skipped: [] }, audit, metrics,
  };
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
  const bracketOutbox = new Map(runtime.bracketOutbox);
  const osoOutbox = new Map(runtime.osoOutbox);
  const cancelOutbox = new Map(runtime.cancelOutbox);
  let shadowLinks = new Map(runtime.shadowLinks ?? []);
  let state = runtime.state;
  let revision = runtime.revision;

  const verdict = classifySequence(event.sequence, state.lastSequence);
  const deferredReplay = options.deferredReplay === true && verdict === 'out-of-order';
  if (verdict === 'duplicate' || deferredReplay) {
    // Jen záznam do auditu — zpracování pokračuje. Kdyby se tady skončilo,
    // nešel by dokončit pokus, který minule spadl na timeout: `lastSequence`
    // už je posunutá, ale objednávka odeslaná není. Idempotenci hlídají
    // klíče replikace a outbox, ne pořadí ve streamu. Deferred replay je
    // totéž pro událost odloženou OSO inference oknem.
    audit.push({
      at: clock(), leaderEventId: event.id, kind: 'skipped',
      reason: deferredReplay ? 'deferred-replay-sequence' : 'duplicate-sequence',
    });
  }

  const sequenceBroken = verdict === 'gap' || (verdict === 'out-of-order' && !deferredReplay);
  if (sequenceBroken) {
    audit.push({ at: clock(), leaderEventId: event.id, kind: 'sequence-broken', reason: verdict });
  }

  // Zrušení u leadera se řeší zvlášť — není to odvozená objednávka, ale
  // příkaz na konkrétní `brokerOrderId`, který známe z vazeb.
  // Po restartu controller záměrně startuje v SHADOW/DISARMED. Reálné vazby
  // z durable store ale stále představují pracovní follower objednávky. Když
  // leader takovou objednávku ukončí, musíme použít právě durable link a cancel
  // dokončit; shadow mapa slouží jen událostem, které nikdy broker side effect
  // neměly.
  const durableCancels = planCancel(event, state, group);
  const planningState = context.shadowMode && durableCancels.length === 0
    ? { ...state, links: shadowLinks }
    : state;
  const cancels = planCancel(event, planningState, group);
  const modifications = planModify(event, planningState, group);
  const commands = [
    ...cancels.map(command => ({ ...command, operation: 'cancel' as const })),
    ...modifications.map(command => ({ ...command, operation: 'modify' as const })),
  ];
  if (commands.length > 0) {
    const isTerminalCancel = durableCancels.length > 0 && modifications.length === 0;
    // Výjimka „risk-redukující cancel projde vždy" má chránit před osiřelou
    // čekající objednávkou — tam zrušení expozici snižuje. Ochranná noha
    // (SL/TP) nad otevřenou kopií je ale přesný opak: jejím zrušením zůstane
    // pozice nechráněná a odzbrojená kopírka náhradu poslat nesmí. Taková
    // musí projít plnou branou, aby ji kill switch a DISARM zastavily.
    const protectiveLegIds = new Set<string>();
    for (const entry of bracketOutbox.values()) {
      protectiveLegIds.add(entry.leaderStopOrderId);
      protectiveLegIds.add(entry.leaderTargetOrderId);
    }
    const commandHalt = isTerminalCancel && !protectiveLegIds.has(event.orderId)
      ? cancelLifecycleHaltReason(context)
      : haltReason({
          ...context,
          sequenceBroken: context.sequenceBroken || sequenceBroken,
          stuckOutbox: context.stuckOutbox
            || stuckEntries(outbox.values()).length > 0
            || stuckBracketEntries(bracketOutbox.values()).length > 0
            || stuckOsoEntries(osoOutbox.values()).length > 0
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
        runtime: { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, shadowLinks, revision },
        plan: { leaderEventId: event.id, orders: [], skipped: [] }, audit, metrics,
      };
    }
    if (context.shadowMode && !isTerminalCancel) {
      for (const command of commands) {
        audit.push({
          at: clock(), leaderEventId: event.id, kind: 'shadow', accountId: command.accountId,
          key: command.key, brokerOrderId: command.brokerOrderId, reason: command.operation,
        });
      }
      if (event.kind === 'canceled' || event.kind === 'rejected') {
        shadowLinks.delete(event.orderId);
      } else if (event.kind === 'replaced') {
        shadowLinks.set(event.orderId, (shadowLinks.get(event.orderId) ?? []).map(link => {
          const modification = modifications.find(item => item.accountId === link.accountId);
          return modification ? {
            ...link,
            quantity: modification.quantity,
            ...(modification.limitPrice != null ? { limitPrice: modification.limitPrice } : {}),
            ...(modification.stopPrice != null ? { stopPrice: modification.stopPrice } : {}),
          } : link;
        }));
      }
      state = applyLeaderProgress(state, event, group);
      state = applyResolved(state, [], event.sequence);
      revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);
      return {
        runtime: { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, shadowLinks, revision },
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
      revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);
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
        waiveSupersededModifications(cancelOutbox, resolved, clock);
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
    revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);
    return {
      runtime: { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, shadowLinks, revision },
      plan: { leaderEventId: event.id, orders: [], skipped: [] },
      audit,
      metrics,
    };
  }

  const plan = planReplication(event, group, state);
  for (const skip of plan.skipped) {
    // U on-submit režimu je následný leader fill očekávaná lifecycle událost,
    // ne chyba konfigurace. Sekvenci/progress níže stále zpracujeme, jen
    // nezaplevelujeme audit falešným alarmem.
    if (skip.reason === 'mode-mismatch' && event.kind === 'filled') continue;
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
      || stuckBracketEntries(bracketOutbox.values()).length > 0
      || stuckOsoEntries(osoOutbox.values()).length > 0
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
      const planned = byTag.get(request.tag);
      audit.push({
        at: clock(),
        leaderEventId: event.id,
        kind: 'shadow',
        accountId: request.accountId,
        key: planned?.key,
      });
      if (context.shadowMode && planned) {
        const shadowState = linkFollowerOrder({ ...state, links: shadowLinks }, event.orderId, {
          key: planned.key,
          accountId: request.accountId,
          brokerOrderId: `shadow:${planned.key}`,
          quantity: request.quantity,
          ...(request.limitPrice != null ? { limitPrice: request.limitPrice } : {}),
          ...(request.stopPrice != null ? { stopPrice: request.stopPrice } : {}),
        });
        shadowLinks = new Map(shadowState.links);
      }
    }
    // Sekvence a kumulativní fill progress patří k leader streamu, ne k
    // broker side effectu. Posouvají se i v shadow režimu a u událostí, pro
    // které žádný follower nemá odpovídající mód. Replikované klíče se
    // samozřejmě nezapisují.
    if (context.shadowMode || (plan.orders.length === 0 && decision.blocked.length === 0)) {
      state = applyLeaderProgress(state, event, group);
      state = applyResolved(state, [], event.sequence);
      revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);
    }
    return { runtime: { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, shadowLinks, revision }, plan, audit, metrics };
  }

  if (broker.environment === 'live' && !store) {
    for (const request of decision.allowed) {
      audit.push({
        at: clock(), leaderEventId: event.id, kind: 'blocked', accountId: request.accountId,
        key: byTag.get(request.tag)?.key, reason: 'durable-store-required',
      });
    }
    return { runtime: { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, shadowLinks, revision }, plan, audit, metrics };
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
    revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);
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
  revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);
  const runtimeNext: CopierRuntime = { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, shadowLinks, revision };

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
  const bracketOutbox = new Map(runtime.bracketOutbox);
  const osoOutbox = new Map(runtime.osoOutbox);
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

  for (const entry of [...bracketOutbox.values()]) {
    const action = nextBracketAction(entry);
    if (action.type !== 'lookup') continue;
    const [firstLookup, secondLookup] = await Promise.all([
      broker.findOrdersByTag(entry.request.accountId, action.firstTag),
      broker.findOrdersByTag(entry.request.accountId, action.secondTag),
    ]);
    const completeness = firstLookup.completeness === 'authoritative'
      && secondLookup.completeness === 'authoritative'
      ? 'authoritative' as const
      : 'eventual' as const;
    const at = clock();
    const resolved = resolveBracketLookup(
      entry,
      firstLookup.orders,
      secondLookup.orders,
      completeness,
      at,
    );
    bracketOutbox.set(entry.key, resolved);
    if (
      resolved.status === 'acknowledged'
      && resolved.firstBrokerOrderId
      && resolved.secondBrokerOrderId
    ) {
      metrics.recovered += 1;
      resolvedKeys.push(resolved.key);
      state = linkFollowerOrder(state, resolved.leaderStopOrderId, {
        key: `${resolved.key}:stop`,
        accountId: resolved.request.accountId,
        brokerOrderId: resolved.firstBrokerOrderId,
        quantity: resolved.request.quantity,
        stopPrice: resolved.request.first.stopPrice,
      });
      state = linkFollowerOrder(state, resolved.leaderTargetOrderId, {
        key: `${resolved.key}:target`,
        accountId: resolved.request.accountId,
        brokerOrderId: resolved.secondBrokerOrderId,
        quantity: resolved.request.quantity,
        limitPrice: resolved.request.second.limitPrice,
      });
      audit.push({
        at,
        leaderEventId: resolved.leaderEventId,
        kind: 'recovered',
        accountId: resolved.request.accountId,
        key: resolved.key,
        brokerOrderId: `${resolved.firstBrokerOrderId},${resolved.secondBrokerOrderId}`,
        reason: 'oco',
      });
    } else if (resolved.status === 'abandoned' || resolved.status === 'rejected') {
      metrics.abandoned += 1;
      audit.push({
        at,
        leaderEventId: resolved.leaderEventId,
        kind: 'abandoned',
        accountId: resolved.request.accountId,
        key: resolved.key,
        reason: resolved.reason ?? resolved.status,
      });
    } else {
      audit.push({
        at,
        leaderEventId: resolved.leaderEventId,
        kind: 'recovered',
        accountId: resolved.request.accountId,
        key: resolved.key,
        reason: resolved.reason ?? resolved.status,
      });
    }
  }

  for (const entry of [...osoOutbox.values()]) {
    const action = nextOsoAction(entry);
    if (action.type !== 'lookup') continue;
    const [entryLookup, firstLookup, secondLookup] = await Promise.all([
      broker.findOrdersByTag(entry.request.accountId, action.entryTag),
      broker.findOrdersByTag(entry.request.accountId, action.firstTag),
      broker.findOrdersByTag(entry.request.accountId, action.secondTag),
    ]);
    const completeness = entryLookup.completeness === 'authoritative'
      && firstLookup.completeness === 'authoritative'
      && secondLookup.completeness === 'authoritative'
      ? 'authoritative' as const
      : 'eventual' as const;
    const at = clock();
    const resolved = resolveOsoLookup(
      entry, entryLookup.orders, firstLookup.orders, secondLookup.orders, completeness, at,
    );
    osoOutbox.set(entry.key, resolved);
    if (
      resolved.status === 'acknowledged'
      && resolved.entryBrokerOrderId
      && resolved.firstBrokerOrderId
      && resolved.secondBrokerOrderId
    ) {
      metrics.recovered += 1;
      resolvedKeys.push(resolved.key);
      state = linkFollowerOrder(state, resolved.leaderEntryOrderId, {
        key: `${resolved.key}:entry`, accountId: resolved.request.accountId,
        brokerOrderId: resolved.entryBrokerOrderId, quantity: resolved.request.quantity,
        limitPrice: resolved.request.limitPrice, stopPrice: resolved.request.stopPrice,
      });
      state = linkFollowerOrder(state, resolved.leaderStopOrderId, {
        key: `${resolved.key}:stop`, accountId: resolved.request.accountId,
        brokerOrderId: resolved.firstBrokerOrderId, quantity: resolved.request.quantity,
        stopPrice: resolved.request.first.stopPrice,
      });
      state = linkFollowerOrder(state, resolved.leaderTargetOrderId, {
        key: `${resolved.key}:target`, accountId: resolved.request.accountId,
        brokerOrderId: resolved.secondBrokerOrderId, quantity: resolved.request.quantity,
        limitPrice: resolved.request.second.limitPrice,
      });
      audit.push({
        at, leaderEventId: resolved.leaderEventId, kind: 'recovered',
        accountId: resolved.request.accountId, key: resolved.key,
        brokerOrderId: `${resolved.entryBrokerOrderId},${resolved.firstBrokerOrderId},${resolved.secondBrokerOrderId}`,
        reason: 'oso',
      });
    } else if (resolved.status === 'abandoned' || resolved.status === 'rejected') {
      metrics.abandoned += 1;
      audit.push({
        at, leaderEventId: resolved.leaderEventId, kind: 'abandoned',
        accountId: resolved.request.accountId, key: resolved.key,
        reason: resolved.reason ?? resolved.status,
      });
    } else {
      audit.push({
        at, leaderEventId: resolved.leaderEventId, kind: 'recovered',
        accountId: resolved.request.accountId, key: resolved.key,
        reason: resolved.reason ?? resolved.status,
      });
    }
  }

  const recoveredLifecycleEvents = new Map<string, number>();
  for (const entry of [...cancelOutbox.values()]) {
    if (entry.status !== 'sending' && entry.status !== 'unknown') continue;
    recoveredLifecycleEvents.set(entry.leaderEventId, entry.leaderSequence);
    const lookup = await broker.findOrderById(entry.accountId, entry.brokerOrderId);
    const at = clock();
    const resolved = resolveCancelLookup(entry, lookup.order, lookup.completeness, at);
    cancelOutbox.set(entry.key, resolved);
    if (resolved.status === 'confirmed') {
      waiveSupersededModifications(cancelOutbox, resolved, clock);
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

  // Jedna leader lifecycle událost může mít cancel/modify pro více followerů.
  // Sekvence je hotová až tehdy, když jsou bezpečně uzavřené všechny její
  // větve. Posun po prvním potvrzeném followerovi by po restartu skryl druhý
  // účet ve stavu unknown/abandoned a dovolil zpracovat další leader event.
  for (const [leaderEventId, leaderSequence] of recoveredLifecycleEvents) {
    const entries = [...cancelOutbox.values()].filter(entry => entry.leaderEventId === leaderEventId);
    if (
      entries.length > 0
      && entries.every(entry => entry.status === 'confirmed' || entry.status === 'waived')
    ) {
      state = applyResolved(state, [], leaderSequence);
    }
  }

  const recoveredSequence = Math.max(
    state.lastSequence,
    ...[...outbox.values()]
      .filter(entry => resolvedKeys.includes(entry.key))
      .map(entry => entry.leaderSequence ?? state.lastSequence),
  );
  state = applyResolved(state, resolvedKeys, recoveredSequence);
  revision = await persistRuntime(store, state, outbox, cancelOutbox, bracketOutbox, osoOutbox, revision);

  return {
    runtime: { state, outbox, bracketOutbox, osoOutbox, cancelOutbox, revision },
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
    processBracket(options: Omit<ProcessBracketPairOptions, 'runtime'>): Promise<CopierRunResult> {
      const run = tail.then(() => processBracketPair({ ...options, runtime }));
      tail = run.then(result => {
        runtime = result.runtime;
      }, () => undefined);
      return run;
    },
    processOso(options: Omit<ProcessOsoPairOptions, 'runtime'>): Promise<CopierRunResult> {
      const run = tail.then(() => processOsoPair({ ...options, runtime }));
      tail = run.then(result => {
        runtime = result.runtime;
      }, () => undefined);
      return run;
    },
    record(options: Omit<Parameters<typeof recordLeaderEventOnly>[0], 'runtime'>): Promise<CopierRunResult> {
      const run = tail.then(() => recordLeaderEventOnly({ ...options, runtime }));
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

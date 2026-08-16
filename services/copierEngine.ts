import type { BrokerOrderRequest, BrokerPosition, OrderSide, OrderType } from './brokerPort';
import { brokerTag, replicationKey } from './copierKeys';
import type { CopyGroupConfig, CopyReplicationMode } from './liveCopyTrading';

/**
 * Deterministické jádro replikace.
 *
 * Čistá funkce: (leader událost + konfigurace + stav) → plán objednávek.
 * Nic neodesílá, nesahá na síť, nečte čas. Díky tomu se dá celý copier
 * otestovat přehráním záznamu událostí a po restartu dojít ke stejnému
 * výsledku.
 *
 * Odesílání řeší runner až poté, co plán projde `evaluateRiskGate()`.
 */

export type LeaderEventKind = 'submitted' | 'filled' | 'replaced' | 'canceled' | 'rejected';

export interface LeaderEvent {
  /**
   * Stabilní identifikátor události u leadera. Vstupuje do klíče replikace,
   * takže ho nesmí generovat příjemce — musí přijít od brokera.
   */
  id: string;
  /**
   * Identita OBJEDNÁVKY, ne události. Několik událostí (submitted, filled,
   * canceled) sdílí stejné `orderId` — bez něj nejde zrušení leadera spárovat
   * s objednávkami, které z něj u followerů vznikly.
   */
  orderId: string;
  kind: LeaderEventKind;
  accountId: number;
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  /** Pořadí ve streamu leadera. Kontroluje ho `classifySequence()`. */
  sequence: number;
  /** Kdy událost dorazila k nám. Základ pro měření replikační latence. */
  receivedAt: number;
  /** U fill eventu kumulativní cumQty leader objednávky. */
  cumulativeQuantity?: number;
}

/** Plánovaná objednávka i s vnitřním klíčem, pod kterým ji vede outbox. */
export interface PlannedOrder {
  key: string;
  request: BrokerOrderRequest;
}

export type SkipReason =
  | 'group-disabled'
  | 'not-leader-account'
  | 'follower-off'
  | 'follower-is-leader'
  | 'mode-mismatch'
  | 'already-replicated'
  | 'stale-cumulative-fill'
  | 'zero-quantity';

export interface SkippedReplication {
  followerAccountId: number;
  reason: SkipReason;
}

export interface ReplicationPlan {
  leaderEventId: string;
  orders: PlannedOrder[];
  skipped: SkippedReplication[];
}

/** Follower objednávka vzniklá z konkrétní leader objednávky. */
export interface FollowerOrderLink {
  key: string;
  accountId: number;
  brokerOrderId: string;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
}

export interface CopierState {
  /**
   * Klíče replikací, které jsou u brokera vyřízené (potvrzené nebo
   * odmítnuté). Po restartu se načítá z persistentního outboxu.
   */
  replicated: ReadonlySet<string>;
  /**
   * Vazba leader objednávka → follower objednávky. Bez ní by zrušení
   * u leadera nemělo co zrušit na druhé straně.
   */
  links: ReadonlyMap<string, readonly FollowerOrderLink[]>;
  /** Nejvyšší zpracovaná `sequence` leader streamu. */
  lastSequence: number;
  /** Poslední známé cumQty leader objednávek. */
  leaderCumQty: ReadonlyMap<string, number>;
  /** Již naplánovaný kumulativní cíl pro followera. */
  followerFillTargets: ReadonlyMap<string, number>;
}

export function createCopierState(
  replicated: Iterable<string> = [],
  lastSequence = 0,
  links: Iterable<[string, readonly FollowerOrderLink[]]> = [],
  leaderCumQty: Iterable<[string, number]> = [],
  followerFillTargets: Iterable<[string, number]> = [],
): CopierState {
  return {
    replicated: new Set(replicated),
    lastSequence,
    links: new Map(links),
    leaderCumQty: new Map(leaderCumQty),
    followerFillTargets: new Map(followerFillTargets),
  };
}

const fillTargetKey = (leaderOrderId: string, followerAccountId: number) =>
  `${leaderOrderId}:${followerAccountId}`;

export function applyLeaderProgress(
  state: CopierState,
  event: LeaderEvent,
  _group: CopyGroupConfig,
): CopierState {
  if (event.kind !== 'filled') return state;
  const cumulative = event.cumulativeQuantity ?? event.quantity;
  const previous = state.leaderCumQty.get(event.orderId) ?? 0;
  if (cumulative < previous) return state;
  const leaderCumQty = new Map(state.leaderCumQty);
  leaderCumQty.set(event.orderId, cumulative);
  return { ...state, leaderCumQty };
}

export function applyFollowerFillResolution(
  state: CopierState,
  leaderOrderId: string,
  followerAccountId: number,
  quantity: number,
): CopierState {
  const followerFillTargets = new Map(state.followerFillTargets);
  const key = fillTargetKey(leaderOrderId, followerAccountId);
  followerFillTargets.set(key, (followerFillTargets.get(key) ?? 0) + quantity);
  return { ...state, followerFillTargets };
}

/** Zapíše vazbu na follower objednávku, kterou broker potvrdil. */
export function linkFollowerOrder(
  state: CopierState,
  leaderOrderId: string,
  link: FollowerOrderLink,
): CopierState {
  const links = new Map(state.links);
  const current = links.get(leaderOrderId) ?? [];
  if (current.some(item => item.key === link.key)) return state;
  links.set(leaderOrderId, [...current, link]);
  return { ...state, links };
}

export interface CancelCommand {
  key: string;
  accountId: number;
  brokerOrderId: string;
}

export interface ModifyCommand extends CancelCommand {
  quantity: number;
  orderType: OrderType;
  limitPrice?: number;
  stopPrice?: number;
}

export function planModify(
  event: LeaderEvent,
  state: CopierState,
  group: CopyGroupConfig,
): ModifyCommand[] {
  if (event.kind !== 'replaced') return [];
  const links = state.links.get(event.orderId) ?? [];
  return links.flatMap(link => {
    const follower = group.followers.find(item => item.accountId === link.accountId);
    if (!follower || follower.mode !== 'on-submit') return [];
    const quantity = followerQuantity(event.quantity, follower.multiplier);
    if (quantity <= 0) return [];
    return [{
      key: `mx:${link.key}:${event.id}`,
      accountId: link.accountId,
      brokerOrderId: link.brokerOrderId,
      quantity,
      orderType: event.orderType,
      ...(event.limitPrice != null ? { limitPrice: event.limitPrice } : {}),
      ...(event.stopPrice != null ? { stopPrice: event.stopPrice } : {}),
    }];
  });
}

/**
 * Zrušení follower objednávek po zrušení u leadera.
 *
 * Vychází z `links`, ne z přepočtu — rušit se dá jen to, co u brokera
 * skutečně existuje a čí `brokerOrderId` známe.
 */
export function planCancel(event: LeaderEvent, state: CopierState): CancelCommand[] {
  if (event.kind !== 'canceled' && event.kind !== 'rejected') return [];
  const links = state.links.get(event.orderId) ?? [];
  return links.map(link => ({
    key: `cx:${link.key}`,
    accountId: link.accountId,
    brokerOrderId: link.brokerOrderId,
  }));
}

/**
 * Zaokrouhlení množství pro followera.
 *
 * Vždy dolů. Multiplier 0,3 na jednom kontraktu dá nulu, a nula znamená
 * neodeslat — což je správně. Zaokrouhlení nahoru by na malém prop účtu
 * tiše zvětšilo riziko.
 */
export function followerQuantity(leaderQuantity: number, multiplier: number): number {
  if (!Number.isFinite(leaderQuantity) || !Number.isFinite(multiplier)) return 0;
  return Math.max(0, Math.floor(leaderQuantity * multiplier));
}

export type SequenceVerdict = 'expected' | 'duplicate' | 'gap' | 'out-of-order';

/**
 * Kontrola pořadí ve streamu.
 *
 * Mezera znamená, že nám utekla událost — a to je stav, kdy se nesmí
 * pokračovat, protože nevíme, co leader mezitím udělal. Runner na `gap`
 * i `out-of-order` reaguje zastavením, ne přeskočením.
 */
export function classifySequence(sequence: number, lastSequence: number): SequenceVerdict {
  if (sequence === lastSequence + 1) return 'expected';
  if (sequence <= lastSequence) return sequence === lastSequence ? 'duplicate' : 'out-of-order';
  return 'gap';
}

function modeAccepts(mode: CopyReplicationMode, kind: LeaderEventKind): boolean {
  if (mode === 'off') return false;
  if (mode === 'on-submit') return kind === 'submitted';
  return kind === 'filled';
}

/**
 * Spočítá, co by se mělo odeslat na followery.
 *
 * `canceled` a `rejected` události plán nevytvářejí — zrušení repliky je
 * samostatný příkaz navázaný na konkrétní `brokerOrderId`, ne odvozená
 * objednávka. Řeší ho `planCancel()`.
 */
export function planReplication(
  event: LeaderEvent,
  group: CopyGroupConfig,
  state: CopierState,
): ReplicationPlan {
  const plan: ReplicationPlan = { leaderEventId: event.id, orders: [], skipped: [] };

  if (!group.enabled) {
    for (const follower of group.followers) {
      plan.skipped.push({ followerAccountId: follower.accountId, reason: 'group-disabled' });
    }
    return plan;
  }

  if (group.leaderAccountId == null || event.accountId !== group.leaderAccountId) {
    for (const follower of group.followers) {
      plan.skipped.push({ followerAccountId: follower.accountId, reason: 'not-leader-account' });
    }
    return plan;
  }

  for (const follower of group.followers) {
    const skip = (reason: SkipReason) =>
      plan.skipped.push({ followerAccountId: follower.accountId, reason });

    if (follower.accountId === group.leaderAccountId) {
      skip('follower-is-leader');
      continue;
    }
    if (follower.mode === 'off') {
      skip('follower-off');
      continue;
    }
    if (!modeAccepts(follower.mode, event.kind)) {
      skip('mode-mismatch');
      continue;
    }

    const key = replicationKey('cp', group.id, event.id, follower.accountId);
    if (state.replicated.has(key)) {
      skip('already-replicated');
      continue;
    }

    let quantity = followerQuantity(event.quantity, follower.multiplier);
    if (event.kind === 'filled' && follower.mode === 'on-fill') {
      const cumulative = event.cumulativeQuantity ?? event.quantity;
      const previousCumulative = state.leaderCumQty.get(event.orderId) ?? 0;
      if (cumulative < previousCumulative) {
        skip('stale-cumulative-fill');
        continue;
      }
      const previousTarget = state.followerFillTargets.get(
        fillTargetKey(event.orderId, follower.accountId),
      ) ?? 0;
      quantity = followerQuantity(cumulative, follower.multiplier) - previousTarget;
    }
    if (quantity <= 0) {
      skip('zero-quantity');
      continue;
    }

    plan.orders.push({
      key,
      request: {
        tag: brokerTag('cp', group.id, event.id, follower.accountId),
        accountId: follower.accountId,
        symbol: event.symbol,
        side: event.side,
        quantity,
        orderType: event.orderType,
        ...(event.limitPrice != null ? { limitPrice: event.limitPrice } : {}),
        ...(event.stopPrice != null ? { stopPrice: event.stopPrice } : {}),
      },
    });
  }

  return plan;
}

/**
 * Zapíše vyřízené replikace do stavu.
 *
 * Volá se jen pro klíče, u kterých outbox dospěl ke konečnému stavu
 * (potvrzeno nebo odmítnuto). Nejasné konce se sem nesmí dostat — ty
 * musí zůstat v outboxu k dohledání.
 */
export function applyResolved(
  state: CopierState,
  resolvedKeys: readonly string[],
  sequence: number,
): CopierState {
  const replicated = new Set(state.replicated);
  for (const key of resolvedKeys) replicated.add(key);
  return { ...state, replicated, lastSequence: Math.max(state.lastSequence, sequence) };
}

/**
 * Plán na srovnání leader → follower pozice.
 *
 * POZOR: tohle se NESMÍ volat automaticky při detekci divergence. Když se
 * pozice rozejdou, znamená to, že model reality je rozbitý — a to je
 * okamžik, kdy má systém zastavit, ne obchodovat. Funkce existuje pro
 * ruční „srovnej to" s explicitním potvrzením uživatele.
 */
export function planReconciliation(
  groupId: string,
  leaderPosition: BrokerPosition,
  followerPosition: BrokerPosition,
  multiplier: number,
  reconciliationId: string,
): PlannedOrder | null {
  const target = Math.trunc(leaderPosition.netQuantity * multiplier);
  const delta = target - followerPosition.netQuantity;
  if (delta === 0) return null;

  return {
    key: replicationKey('rc', groupId, reconciliationId, followerPosition.accountId),
    request: {
      tag: brokerTag('rc', groupId, reconciliationId, followerPosition.accountId),
      accountId: followerPosition.accountId,
      symbol: leaderPosition.symbol,
      side: delta > 0 ? 'Buy' : 'Sell',
      quantity: Math.abs(delta),
      orderType: 'Market',
    },
  };
}

/** Zavření celé pozice účtu — pro Flatten. */
export function planFlatten(
  groupId: string,
  position: BrokerPosition,
  flattenId: string,
): PlannedOrder | null {
  if (position.netQuantity === 0) return null;
  return {
    key: replicationKey('fl', groupId, flattenId, position.accountId),
    request: {
      tag: brokerTag('fl', groupId, flattenId, position.accountId),
      accountId: position.accountId,
      symbol: position.symbol,
      side: position.netQuantity > 0 ? 'Sell' : 'Buy',
      quantity: Math.abs(position.netQuantity),
      orderType: 'Market',
    },
  };
}

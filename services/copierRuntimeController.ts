import type { BrokerEvent, BrokerFill, BrokerPort } from './brokerPort';
import { msUntilTradovateSessionEnd } from './copierArmSession';
import { pointValueUsd } from './futuresContractSpecs';
import type { CopierClosedTrade, CopierDailyStats } from './copierEngine';
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
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from './liveCopyTrading';
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
  /** Celá skupina je podle lokálně známých pozic flat (vhodný moment pro údržbu). */
  groupFlat?: boolean;
  entryCooldownUntil?: number;
  dayLockUntil?: number;
  dayLockReason?: string | null;
  /**
   * Kdy aktuální ARM vyprší (epoch ms); 0 = neARMováno. Klient z něj
   * plánuje deterministickou lokální notifikaci „ARM vypršel".
   */
  armExpiresAt?: number;
  /** Stabilní začátek aktuální ARM session pro deduplikaci systémových surface. */
  armedAt?: number;
  /**
   * Posledních pár vstupů/exitů leadera (přechody přes flat) pro trade
   * notifikace. Server je čte z heartbeat statusu, appka z pollu.
   */
  recentCopyEvents?: CopierCopyEvent[];
  /** Výsledek posledního auto-flatten (expirace ARM / fail-closed / reconnect); jen tento běh. */
  autoClose?: CopierAutoClose | null;
  /**
   * Connection recovery podle stavu: po výpadku jsou kopie SYNCHRONNÍ
   * s leaderem, drží se s brackety a čekají na jediný klik ARM.
   */
  resumeOffer?: { at: number } | null;
  /** Redigované denní risk počítadlo leadera pro UI a watchdog. */
  dailyStats?: {
    sessionEndAt: number;
    realizedPnlUsd: number;
    losingTrades: number;
    unpricedSymbols: string[];
    recentClosedTrades?: CopierClosedTrade[];
  } | null;
}

export interface CopierAutoClose {
  at: number;
  operationId: string;
  /** Co zavření spustilo: expirace ARM, fail-closed za live ARM, nebo osiřelé kopie po výpadku. */
  trigger: 'arm-expiry' | 'fail-closed' | 'reconnect';
  scope: 'followers' | 'group';
  accountIds: number[];
  flat: boolean;
  canceledOrders: number;
  submittedClosures: number;
  error?: string;
}

export interface CopierCopyEvent {
  /** Monotónní v rámci běhu procesu (epoch ms + pořadí). */
  id: string;
  at: number;
  kind:
    | 'entry' | 'scale-in' | 'scale-out' | 'exit' | 'flip'
    // Order lifecycle: čekající vstup zadán/zrušen/posunut, SL/TP nastaveny
    // a posuny ochranných nohou. Vše až PO potvrzeném dispatchi kopií.
    | 'order-placed' | 'bracket-placed' | 'order-canceled' | 'order-moved'
    | 'sl-moved' | 'tp-moved';
  symbol: string;
  /** Long/Short podle znaménka pozice PO události (u exitu PŘED ní). */
  side: 'Long' | 'Short';
  quantity: number;
  followers: number;
  /** Cena čekajícího vstupu / nová úroveň u *-moved. */
  price?: number;
  stopPrice?: number;
  targetPrice?: number;
  /** Jak se pozice zavřela — podle orderId závěrečného fillu leadera. */
  exitReason?: 'sl' | 'tp' | 'manual';
  /** Realizovaný P&L uzavřeného obchodu leadera v USD (známe-li point value). */
  pnlUsd?: number;
  /** Potenciální P&L na úrovni `price` u *-moved (vs. průměrný vstup). */
  levelPnlUsd?: number;
  /** Potenciální P&L na SL/TP úrovni u order/bracket-placed (risk/reward). */
  stopPnlUsd?: number;
  targetPnlUsd?: number;
}

export interface CopierRuntimeController {
  /**
   * `ttlMs` omezí platnost tohoto ARM (typicky do konce broker session).
   * Bez něj platí výchozí TTL z risk gate. Expirace odzbrojí a podle
   * `safety.armExpiryFlatten` risk-redukčně zavře otevřené kopie.
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
  /**
   * Okamžitá notifikační cesta: zavolá se hned po přidání trade eventu do
   * deníku. Pilot přes ni šťouchne relay, aby server poslal push bez čekání
   * na minutový cron (dedup marker sdílí obě cesty).
   */
  onCopyEvent?: (event: CopierCopyEvent) => void;
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
  flattenAccountConcurrency?: number;
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
  /** Deník vstupů/exitů pro notifikace; jen poslední položky, jen tento běh. */
  const recentCopyEvents: CopierCopyEvent[] = [];
  let copyEventCounter = 0;
  /** Leader ochranné nohy (SL/TP) podle brokerOrderId — pro atribuci exitu
   *  a odfiltrování šumu (OCO auto-cancel druhé nohy po výstupu). */
  const leaderStopOrderIds = new Set<string>();
  const leaderTargetOrderIds = new Set<string>();
  /** Poslední leader fill per symbol — spojí flat přechod s objednávkou. */
  const lastLeaderFillOrderId = new Map<string, string>();

  /** Čekající vstup per symbol — referenční cena pro potenciální P&L,
   *  dokud fill nezaloží skutečný lot. */
  const plannedEntryBySymbol = new Map<string, { price: number; signedQuantity: number }>();
  const rememberPlannedEntry = (symbol: string, price: number, signedQuantity: number) => {
    plannedEntryBySymbol.set(symbol, { price, signedQuantity });
    while (plannedEntryBySymbol.size > 50) {
      const oldest = plannedEntryBySymbol.keys().next().value as string | undefined;
      if (oldest == null) break;
      plannedEntryBySymbol.delete(oldest);
    }
  };

  /** Potenciální P&L dané cenové úrovně vůči průměrnému vstupu (nebo
   *  plánovanému vstupu u nevyplněné objednávky). */
  const levelPnl = (symbol: string, level: number | undefined): { levelPnlUsd: number } | null => {
    if (level == null) return null;
    const pv = pointValueUsd(symbol);
    if (pv == null) return null;
    const lot = currentRuntime().state.safety.dailyStats?.openLots
      .find(item => item.symbol === symbol && item.netQuantity !== 0);
    if (lot) {
      return {
        levelPnlUsd: (level - lot.avgPrice) * Math.sign(lot.netQuantity) * Math.abs(lot.netQuantity) * pv,
      };
    }
    const planned = plannedEntryBySymbol.get(symbol);
    if (planned && planned.signedQuantity !== 0) {
      return {
        levelPnlUsd: (level - planned.price) * Math.sign(planned.signedQuantity) * Math.abs(planned.signedQuantity) * pv,
      };
    }
    return null;
  };

  /** Lifecycle notifikace jen při plně čistém dispatchi — částečný úspěch
   *  (dispatched + rejected/unknown) končí fail-closed a nesmí tvrdit opak. */
  const auditCleanDispatch = (audit: readonly CopierAuditEntry[], kind: 'dispatched' | 'canceled' | 'modified') =>
    audit.some(item => item.kind === kind)
    && !audit.some(item => item.kind === 'unknown' || item.kind === 'abandoned'
      || item.kind === 'rejected' || item.kind === 'blocked' || item.kind === 'cancel-failed');

  const rememberProtectiveLeg = (stopOrderId: string, targetOrderId: string) => {
    leaderStopOrderIds.add(stopOrderId);
    leaderTargetOrderIds.add(targetOrderId);
    // Pojistka: sety nesmí růst bez limitu (Set iteruje v pořadí vložení).
    for (const set of [leaderStopOrderIds, leaderTargetOrderIds]) {
      while (set.size > 300) {
        const oldest = set.values().next().value as string | undefined;
        if (oldest == null) break;
        set.delete(oldest);
      }
    }
  };

  const pushCopyEvent = (
    kind: CopierCopyEvent['kind'],
    symbol: string,
    side: 'Long' | 'Short',
    quantity: number,
    at: number,
    extra: Partial<Pick<CopierCopyEvent, 'price' | 'stopPrice' | 'targetPrice' | 'exitReason' | 'pnlUsd'>> = {},
  ): void => {
    // Tažení SL/TP v platformě generuje sérii modify — držíme jen poslední.
    if ((kind === 'sl-moved' || kind === 'tp-moved' || kind === 'order-moved')
      && recentCopyEvents.length > 0) {
      const last = recentCopyEvents[recentCopyEvents.length - 1];
      if (last.kind === kind && last.symbol === symbol) recentCopyEvents.pop();
    }
    copyEventCounter += 1;
    const copyEvent: CopierCopyEvent = {
      id: `${at}-${copyEventCounter}`,
      at, kind, symbol, side, quantity,
      followers: group.followers.filter(follower => follower.mode !== 'off').length,
      ...extra,
    };
    recentCopyEvents.push(copyEvent);
    if (recentCopyEvents.length > 20) recentCopyEvents.shift();
    options.onCopyEvent?.(copyEvent);
  };

  const recordCopyEvent = (previousNet: number, nextNet: number, symbol: string, at: number): void => {
    if (previousNet === nextNet) return;
    const exitExtra = (): Partial<CopierCopyEvent> => {
      const lastFill = lastLeaderFillOrderId.get(symbol);
      // Fill tracking (trackLeaderFill) běží PŘED position eventem a P&L
      // uzavřeného obchodu už leží v durable recentClosedTrades.
      const closed = currentRuntime().state.safety.dailyStats?.recentClosedTrades
        ?.find(trade => trade.symbol === symbol);
      const exitReason: 'sl' | 'tp' | 'manual' = lastFill && leaderStopOrderIds.has(lastFill)
        ? 'sl'
        : lastFill && leaderTargetOrderIds.has(lastFill) ? 'tp' : 'manual';
      // Vyplněná noha už svoji roli splnila — bez úklidu by sety rostly
      // o jednu položku na každý uzavřený obchod až do restartu.
      if (lastFill) {
        leaderStopOrderIds.delete(lastFill);
        leaderTargetOrderIds.delete(lastFill);
      }
      return {
        exitReason,
        ...(closed?.realizedPnlUsd != null ? { pnlUsd: closed.realizedPnlUsd } : {}),
      };
    };
    if (previousNet === 0 && nextNet !== 0) {
      plannedEntryBySymbol.delete(symbol);
      pushCopyEvent('entry', symbol, nextNet > 0 ? 'Long' : 'Short', Math.abs(nextNet), at);
    } else if (previousNet !== 0 && nextNet === 0) {
      pushCopyEvent('exit', symbol, previousNet > 0 ? 'Long' : 'Short', Math.abs(previousNet), at, exitExtra());
    } else if (Math.sign(previousNet) !== Math.sign(nextNet)) {
      pushCopyEvent('flip', symbol, nextNet > 0 ? 'Long' : 'Short', Math.abs(nextNet), at, exitExtra());
    } else if (Math.abs(nextNet) > Math.abs(previousNet)) {
      pushCopyEvent('scale-in', symbol, nextNet > 0 ? 'Long' : 'Short', Math.abs(nextNet - previousNet), at);
    } else if (Math.abs(nextNet) < Math.abs(previousNet)) {
      pushCopyEvent('scale-out', symbol, previousNet > 0 ? 'Long' : 'Short', Math.abs(previousNet - nextNet), at);
    }
  };
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
  /** Důvod čekajícího auto day-locku; zamyká se až po zploštění skupiny. */
  let dayLockPendingReason: string | null = null;
  /**
   * Symboly, jejichž obchod běžel už před startem počítadla (restart workeru
   * uprostřed pozice). Bez známé průměrné ceny by se P&L spočítal špatně —
   * takový obchod se do denního limitu nepočítá, dokud symbol není flat.
   */
  const untrackedTradeSymbols = new Set<string>();
  let lastAutoClose: CopierAutoClose | null = null;
  let autoCloseInFlight = false;
  /** Po reconnectu/bootu se má rozhodnout o osudu otevřených kopií. */
  let pendingConnectionRecovery = false;
  let recoveryInFlight = false;
  let bootRecoveryChecked = false;
  let lastResumeOffer: { at: number } | null = null;
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
   * Operace, u kterých NEVÍME, co u brokera existuje (`sending`/`unknown`).
   * Jen ty smí blokovat Flatten: nouzové zavření pozice je risk-snižující
   * akce a nesmí čekat na papírování kolem `rejected` operací — reject je
   * konečný, známý stav, broker prokazatelně nic nevytvořil. (Živý případ:
   * maxContracts odmítl OSO, pět rejected položek pak zablokovalo Flatten
   * uprostřed otevřené pozice.) ARM dál blokuje každá stuck položka.
   */
  const hasBrokerUncertainOutbox = () => currentStuckOperations()
    .some(operation => operation.status === 'sending' || operation.status === 'unknown');

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
      const cancelOutbox = new Map(current.cancelOutbox);
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
      // Abandoned cancel/modify je také terminálně známý stav (objednávka
      // skončila mimo naši kontrolu). Čistá reconciliation právě potvrdila
      // synchronní pozice — případný `filled` outcome by ji rozbil a sem
      // bychom se nedostali. Stará položka pak nesmí navždy blokovat ARM.
      for (const [key, entry] of cancelOutbox) {
        if (entry.status !== 'abandoned') continue;
        cancelOutbox.set(key, waiveCancelEntry(entry, reason(entry.reason), now));
        changed = true;
      }
      if (!changed) return current;

      const committed = await options.store.commit(
        toSnapshot(
          current.state,
          outbox.values(),
          cancelOutbox.values(),
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
        cancelOutbox,
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

  const hasFollowerExposure = () => group.followers.some(follower =>
    [...(positionsByAccount.get(follower.accountId)?.values() ?? [])].some(quantity => quantity !== 0));

  /** Durable stopa „za živého ARM existují kopie" — podklad boot recovery. */
  const syncLiveCopyExposureFlag = async (reason: 'update' | 'clear') => {
    const stored = currentRuntime().state.safety.liveCopyOpenSince;
    if (reason === 'clear' || groupIsFlat()) {
      if (stored == null) return;
      const { liveCopyOpenSince: _cleared, ...rest } = currentRuntime().state.safety;
      await persistSafety(rest);
      return;
    }
    if (stored != null) return;
    if (!(gate.armed && !gate.shadowMode && hasFollowerExposure())) return;
    await persistSafety({ ...currentRuntime().state.safety, liveCopyOpenSince: clock() });
  };

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

  const emptyDailyStats = (at: number): CopierDailyStats => ({
    sessionEndAt: at + msUntilTradovateSessionEnd(at),
    realizedPnlUsd: 0,
    losingTrades: 0,
    openLots: [],
    recentClosedTrades: [],
    unpricedSymbols: [],
  });

  /** Mutovatelná kopie statistik aktuální session; po 17:00 CT začíná nový den. */
  const currentDailyStats = (at: number): CopierDailyStats => {
    const stored = currentRuntime().state.safety.dailyStats;
    if (!stored || at >= stored.sessionEndAt) return emptyDailyStats(at);
    return {
      ...stored,
      openLots: stored.openLots.map(lot => ({ ...lot })),
      recentClosedTrades: stored.recentClosedTrades?.map(trade => ({ ...trade })) ?? [],
      unpricedSymbols: [...stored.unpricedSymbols],
    };
  };

  /**
   * Denní read-only ledger z leader fillů (avg-cost matching per symbol).
   * Běží vždy, aby uzavřené copier obchody a P&L přežily restart a mohly
   * napájet widgety. Risk limity jsou pouze volitelní konzumenti; při jejich
   * překročení se day-lock stále aktivuje až po zploštění celé skupiny.
   */
  const trackLeaderFill = async (fill: BrokerFill, now: number) => {
    const limitUsd = group.safety?.dailyLossLimitUsd ?? 0;
    const maxLosing = group.safety?.dailyMaxLosingTrades ?? 0;
    const at = fill.filledAt > 0 ? fill.filledAt : now;
    const stored = currentRuntime().state.safety.dailyStats;
    if (stored && at >= stored.sessionEndAt) untrackedTradeSymbols.clear();
    const stats = currentDailyStats(at);

    const preNet = leaderPositions.get(fill.symbol) ?? 0;
    const hasLot = stats.openLots.some(lot => lot.symbol === fill.symbol);
    if (!hasLot && preNet !== 0 && !untrackedTradeSymbols.has(fill.symbol)) {
      untrackedTradeSymbols.add(fill.symbol);
      options.onAudit?.([{
        at: now, leaderEventId: `daily-risk-${fill.symbol}`, kind: 'blocked',
        reason: `denní počítadlo: obchod ${fill.symbol} běžel před startem počítadla, do limitu se nepočítá`,
      }]);
    }
    if (untrackedTradeSymbols.has(fill.symbol)) return;

    const pv = pointValueUsd(fill.symbol);
    if (pv == null && limitUsd > 0 && !stats.unpricedSymbols.includes(fill.symbol)) {
      stats.unpricedSymbols.push(fill.symbol);
      options.onAudit?.([{
        at: now, leaderEventId: `daily-risk-${fill.symbol}`, kind: 'blocked',
        reason: `denní USD limit nezná hodnotu bodu pro ${fill.symbol}; USD ztráta z tohoto symbolu se nepočítá`,
      }]);
    }

    let lot = stats.openLots.find(item => item.symbol === fill.symbol);
    let remaining = fill.side === 'Buy' ? fill.quantity : -fill.quantity;
    if (lot && Math.sign(lot.netQuantity) !== Math.sign(remaining)) {
      const closing = Math.min(Math.abs(remaining), Math.abs(lot.netQuantity));
      const points = (fill.price - lot.avgPrice) * Math.sign(lot.netQuantity) * closing;
      lot.tradePnlPoints += points;
      if (pv != null) {
        lot.tradePnlUsd += points * pv;
        stats.realizedPnlUsd += points * pv;
      }
      const closingSide = lot.side ?? (lot.netQuantity > 0 ? 'Long' : 'Short');
      const closingQuantity = lot.maxQuantity ?? Math.abs(lot.netQuantity);
      lot.netQuantity += Math.sign(remaining) * closing;
      remaining -= Math.sign(remaining) * closing;
      if (lot.netQuantity === 0) {
        if (lot.tradePnlPoints < 0) stats.losingTrades += 1;
        const closedTrade: CopierClosedTrade = {
          id: fill.fillId,
          symbol: fill.symbol,
          side: closingSide,
          quantity: closingQuantity,
          realizedPnlUsd: pv == null ? null : lot.tradePnlUsd,
          followerCount: group.followers.filter(follower => follower.mode !== 'off').length,
          openedAt: lot.openedAt ?? null,
          closedAt: at,
          exitReason: leaderStopOrderIds.has(fill.brokerOrderId)
            ? 'sl'
            : leaderTargetOrderIds.has(fill.brokerOrderId) ? 'tp' : 'manual',
          avgEntryPrice: lot.avgPrice,
          avgExitPrice: fill.price,
        };
        stats.recentClosedTrades = [
          closedTrade,
          ...(stats.recentClosedTrades ?? []).filter(trade => trade.id !== closedTrade.id),
        ].slice(0, 20);
        stats.openLots = stats.openLots.filter(item => item !== lot);
        lot = undefined;
      }
    }
    if (remaining !== 0) {
      if (!lot) {
        stats.openLots.push({
          symbol: fill.symbol, netQuantity: remaining, avgPrice: fill.price,
          tradePnlUsd: 0, tradePnlPoints: 0,
          openedAt: at,
          side: remaining > 0 ? 'Long' : 'Short',
          maxQuantity: Math.abs(remaining),
        });
      } else {
        const total = Math.abs(lot.netQuantity) + Math.abs(remaining);
        lot.avgPrice = (Math.abs(lot.netQuantity) * lot.avgPrice + Math.abs(remaining) * fill.price) / total;
        lot.netQuantity += remaining;
        lot.maxQuantity = Math.max(lot.maxQuantity ?? 0, Math.abs(lot.netQuantity));
      }
    }

    await persistSafety({ ...currentRuntime().state.safety, dailyStats: stats });

    if (dayLockPendingReason) return;
    if (limitUsd > 0 && stats.realizedPnlUsd <= -limitUsd) {
      dayLockPendingReason = `denní ztráta ${Math.abs(Math.round(stats.realizedPnlUsd))} USD dosáhla limitu ${limitUsd} USD`;
    } else if (maxLosing > 0 && stats.losingTrades >= maxLosing) {
      dayLockPendingReason = `${stats.losingTrades}. ztrátový obchod dne (limit ${maxLosing})`;
    }
    if (dayLockPendingReason) {
      options.onAudit?.([{
        at: now, leaderEventId: 'auto-day-lock', kind: 'blocked',
        reason: `auto day-lock čeká na flat: ${dayLockPendingReason}`,
      }]);
    }
  };

  /** Zamkne den do konce broker session — až když je celá skupina flat. */
  const maybeEngageDayLock = async (now: number) => {
    if (!dayLockPendingReason || !groupIsFlat()) return;
    const reason = `auto day-lock: ${dayLockPendingReason}`;
    dayLockPendingReason = null;
    const until = now + msUntilTradovateSessionEnd(now);
    gate = { ...gate, armed: false };
    await persistSafety({
      ...currentRuntime().state.safety,
      dayLockUntil: Math.max(currentRuntime().state.safety.dayLockUntil, until),
      dayLockReason: reason,
    });
    options.onAudit?.([{
      at: now, leaderEventId: 'auto-day-lock', kind: 'blocked', reason,
    }]);
  };

  const failClosed = (reason: unknown, failure: { transportLost?: boolean } = {}) => {
    const wasLiveArmed = gate.armed && !gate.shadowMode;
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
    // Fail-closed uprostřed živého obchodu nesmí nechat kopie viset bez
    // dozoru (živý incident: rejected modify zabil follower SL a exit
    // leadera o 9 s později už byl blokovaný). Bez transportu zavřít nejde
    // a kill switch je explicitní freeze — obojí kryje jen notifikace.
    if (wasLiveArmed && !failure.transportLost && !gate.killSwitch) {
      scheduleAutoClose('fail-closed');
    }
    if (wasLiveArmed && failure.transportLost && hasFollowerExposure()) {
      // Bez transportu zavírat nejde — rozhodne se po reconnectu podle stavu.
      pendingConnectionRecovery = true;
    }
  };

  /**
   * Naplánuje risk-redukující zavření kopií na konec event fronty. Jednorázové
   * per epizoda: selhání zavření volá failClosed už odzbrojené (wasLiveArmed
   * = false), takže se smyčka nikdy neroztočí.
   */
  const scheduleAutoClose = (trigger: 'fail-closed') => {
    if (autoCloseInFlight || stopped) return;
    autoCloseInFlight = true;
    const seed = clock();
    eventTail = eventTail
      .then(async () => {
        try {
          await autoFlattenCopies(trigger, seed);
        } finally {
          autoCloseInFlight = false;
        }
      })
      .catch(reason => {
        autoCloseInFlight = false;
        failClosed(reason);
      });
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
    if (hasBrokerUncertainOutbox()) {
      throw new Error('Flatten nelze spustit: objednávka s nejistým osudem u brokera (sending/unknown) čeká na dohledání');
    }
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
          accountConcurrency: options.flattenAccountConcurrency,
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
      const failed = result.accounts.filter(account => !account.ok);
      const detail = failed
        .map(account => `${account.accountId} (${account.error ?? 'účet není autoritativně flat'})`)
        .join(', ');
      const error = new Error(
        `Flatten selhal: zavřeno ${result.accounts.length - failed.length}/${result.accounts.length} účtů; selhaly ${detail || 'neznámé účty'}`,
      );
      failClosed(error);
      throw error;
    }
    return result;
  };

  /**
   * Risk-redukující zavření kopií — jediná automatická broker akce copieru.
   * Ruší working příkazy a zavírá pozice k nule; nikdy nezvětší |pozici|
   * ani neotočí směr (planFlatten). Spouští ji expirace ARM a fail-closed
   * za živého ARM. Bez lokálně známé expozice se nic neposílá — výpadek na
   * hranici session nesmí vyrábět falešné FAIL-CLOSED poplachy z flattenu
   * naprázdno (working day-orders ruší burza sama).
   */
  const autoFlattenCopies = async (trigger: CopierAutoClose['trigger'], seed: number) => {
    const scope = group.safety?.armExpiryFlatten ?? DEFAULT_COPY_GROUP_SAFETY.armExpiryFlatten;
    if (scope === 'off' || group.leaderAccountId == null || gate.killSwitch) return;
    const accountIds = scope === 'group'
      ? [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)]
      : group.followers.map(follower => follower.accountId);
    const hasExposure = accountIds.some(accountId =>
      [...(positionsByAccount.get(accountId)?.values() ?? [])].some(quantity => quantity !== 0));
    if (!hasExposure) return;
    const operationId = `auto-close:${trigger}:${seed}`;
    const at = clock();
    try {
      const result = await flatten(accountIds, operationId);
      lastAutoClose = {
        at, operationId, trigger, scope, accountIds, flat: result.flat,
        canceledOrders: result.canceledOrders, submittedClosures: result.submittedClosures,
      };
      options.onAudit?.([{
        at: clock(), leaderEventId: operationId, kind: 'blocked',
        reason: `auto-close (${trigger}, ${scope}): zrušeno ${result.canceledOrders} příkazů, zavřeno ${result.submittedClosures} pozic`,
      }]);
      if (result.flat) await syncLiveCopyExposureFlag('clear');
    } catch (error) {
      lastAutoClose = {
        at, operationId, trigger, scope, accountIds, flat: false,
        canceledOrders: 0, submittedClosures: 0, error: errorOf(error).message,
      };
      failClosed(new Error(`Auto-close kopií (${trigger}) selhal: ${errorOf(error).message}`));
    }
  };

  /**
   * Connection recovery „podle stavu": po obnovení spojení (nebo po bootu
   * s durable stopou živých kopií) se autoritativně ověří účty.
   * Synchronní kopie s otevřeným leaderem se DRŽÍ (brackety je chrání)
   * a čeká se na jediný klik ARM; osiřelé nebo rozjeté kopie se
   * risk-redukčně zavřou. Nikdy se sám neARMuje.
   */
  const runConnectionRecovery = async () => {
    if (!pendingConnectionRecovery || stopped) return;
    pendingConnectionRecovery = false;
    const scope = group.safety?.armExpiryFlatten ?? DEFAULT_COPY_GROUP_SAFETY.armExpiryFlatten;
    if (scope === 'off' || gate.killSwitch || group.leaderAccountId == null) return;
    if (!gate.connected) {
      pendingConnectionRecovery = true;
      return;
    }
    const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let reconciliation: { divergentAccounts: number[]; workingOrderAccounts: number[] } | null = null;
    for (let attempt = 0; attempt < 5 && !stopped; attempt += 1) {
      if (attempt > 0) await wait(2_000);
      if (!gate.connected) {
        pendingConnectionRecovery = true;
        return;
      }
      try {
        reconciliation = await performReconciliation();
        break;
      } catch {
        // Spojení je čerstvé — pár pokusů, pak poctivé přiznání níže.
      }
    }
    if (!reconciliation) {
      failClosed(new Error(
        'Po obnovení spojení se nepodařilo ověřit stav účtů — kopie zůstávají chráněné brackety, zkontroluj Tradovate',
      ));
      return;
    }
    if (!hasFollowerExposure()) {
      await syncLiveCopyExposureFlag('clear');
      return;
    }
    const leaderOpen = [...(positionsByAccount.get(group.leaderAccountId)?.values() ?? [])]
      .some(quantity => quantity !== 0);
    if (leaderOpen && reconciliation.divergentAccounts.length === 0) {
      lastResumeOffer = { at: clock() };
      options.onAudit?.([{
        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
        reason: 'connection-recovery: kopie jsou synchronní s leaderem — drženy, čeká se na ruční ARM',
      }]);
      return;
    }
    await autoFlattenCopies('reconnect', clock());
  };

  const scheduleConnectionRecovery = () => {
    if (recoveryInFlight || stopped) return;
    recoveryInFlight = true;
    eventTail = eventTail
      .then(async () => {
        try {
          await runConnectionRecovery();
        } finally {
          recoveryInFlight = false;
        }
      })
      .catch(reason => {
        recoveryInFlight = false;
        failClosed(reason);
      });
  };

  /**
   * Expirace ARM nesmí nechat kopie viset bez dozoru. Vyhodnocuje se
   * event-driven (heartbeat chodí každé ~2,5 s) proti injektovaným hodinám,
   * takže je plně deterministická. Shadow ARM nikdy nic neposílá, ani při
   * expiraci.
   */
  const maybeHandleArmExpiry = async (now: number) => {
    if (stopped || !gate.armed || gate.armTtlMs <= 0) return;
    if (now - gate.armedAt <= gate.armTtlMs) return;
    const armedAt = gate.armedAt;
    const wasShadow = gate.shadowMode;
    gate = { ...gate, armed: false };
    options.onAudit?.([{
      at: now, leaderEventId: `arm-expiry-${armedAt}`, kind: 'blocked',
      reason: 'arm-expired: ARM TTL vypršel, copier se odzbrojil',
    }]);
    if (wasShadow || autoCloseInFlight) return;
    autoCloseInFlight = true;
    try {
      await autoFlattenCopies('arm-expiry', armedAt);
    } finally {
      autoCloseInFlight = false;
    }
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
    const loneLegCount = osoCorrelator.pendingLegCount(entryOrderId);
    osoCorrelator.release(entryOrderId);
    if (!pending || stopped) {
      settleOsoFlush(entryOrderId);
      return;
    }
    // Entry s jediným protective legem se nesmí tiše zkopírovat bez ochrany
    // (leg se samostatně nikdy neodesílá). Jasný fail-closed místo tiché
    // díry v ochraně — a místo dřívějšího kryptického `out-of-order` pádu.
    if (loneLegCount > 0) {
      options.onAudit?.([{
        at: clock(), leaderEventId: pending.id, kind: 'blocked',
        reason: `oso-lone-leg: entry má ${loneLegCount} ochranný příkaz bez druhého do ${osoCorrelator.pendingWindowMs()} ms`,
      }]);
      failClosed(new Error(
        `Entry ${entryOrderId} dorazil jen s jedním ochranným příkazem (SL bez TP, nebo TP dorazil pozdě). `
        + 'Entry nebyl zkopírován — zadej SL i TP společně.',
      ));
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
        // Událost byla zaznamenaná v pořadí; mezitím ji směly předběhnout
        // nesouvisející lifecycle eventy. Viz ProcessLeaderEventOptions.
        deferredReplay: true,
      });
      runtime = result.runtime;
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      failClosedOnCriticalAudit(result.audit);
      if (pending.kind === 'submitted'
        && (pending.orderType === 'Limit' || pending.orderType === 'Stop' || pending.orderType === 'StopLimit')
        && auditCleanDispatch(result.audit, 'dispatched')) {
        const pendingEntryPrice = pending.limitPrice ?? pending.stopPrice;
        if (pendingEntryPrice != null) {
          rememberPlannedEntry(pending.symbol, pendingEntryPrice, (pending.side === 'Buy' ? 1 : -1) * pending.quantity);
        }
        pushCopyEvent('order-placed', pending.symbol,
          pending.side === 'Buy' ? 'Long' : 'Short', pending.quantity, clock(), {
            ...(pendingEntryPrice != null ? { price: pendingEntryPrice } : {}),
          });
      }
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
      await maybeHandleArmExpiry(now);
      return;
    }
    if (event.type === 'error') {
      failClosed(event.error, { transportLost: true });
      return;
    }
    if (event.type === 'connection') {
      // Výpadek za živého ARM s otevřenými kopiemi → po reconnectu se
      // rozhodne „podle stavu" (držet synchronní / zavřít osiřelé).
      if (!event.connected && gate.armed && !gate.shadowMode && hasFollowerExposure()) {
        pendingConnectionRecovery = true;
      }
      source.connection(event.connected);
      gate = {
        ...gate,
        connected: event.connected,
        lastHeartbeatAt: event.connected ? now : gate.lastHeartbeatAt,
        // Každý disconnect ruší ARM; reconnect ho nikdy sám neobnoví.
        armed: event.connected ? gate.armed : false,
      };
      if (event.connected && source.needsReconciliation()) positionCheckComplete = false;
      if (event.connected) {
        // Boot po pádu: durable stopa říká, že kopie vznikly za živého ARM.
        if (!bootRecoveryChecked) {
          bootRecoveryChecked = true;
          if (currentRuntime().state.safety.liveCopyOpenSince != null) pendingConnectionRecovery = true;
        }
        if (pendingConnectionRecovery) scheduleConnectionRecovery();
      }
      return;
    }
    await maybeHandleArmExpiry(now);
    if (event.type === 'position') {
      const accountPositions = positionsByAccount.get(event.position.accountId) ?? new Map<string, number>();
      accountPositions.set(event.position.symbol, event.position.netQuantity);
      positionsByAccount.set(event.position.accountId, accountPositions);
      if (event.position.accountId === group.leaderAccountId) {
        const previousNet = leaderPositions.get(event.position.symbol) ?? 0;
        leaderPositions.set(event.position.symbol, event.position.netQuantity);
        // Obchod rozjetý před startem počítadla skončil — další vstup na
        // tomto symbolu se už do denního limitu počítá normálně.
        if (event.position.netQuantity === 0) untrackedTradeSymbols.delete(event.position.symbol);
        // Redigovaný deník změn pozice pro notifikace. Ring buffer čte server
        // z heartbeat statusu a appka z pollu; nevykonává žádnou broker akci.
        recordCopyEvent(previousNet, event.position.netQuantity, event.position.symbol, now);
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
      await maybeEngageDayLock(now);
      await maybeActivateCooldown(now, event.position.symbol);
      await syncLiveCopyExposureFlag('update');
      if (lastResumeOffer && groupIsFlat()) lastResumeOffer = null;
      return;
    }
    if (event.type === 'fill' && event.fill.accountId === group.leaderAccountId) {
      // Atribuce exitu (SL/TP/ručně): flat přechod se páruje s objednávkou
      // posledního fillu daného symbolu.
      lastLeaderFillOrderId.set(event.fill.symbol, event.fill.brokerOrderId);
      // Denní risk počítadlo čte leader filly; event pak normálně pokračuje
      // do leader event source (on-fill replikace se nemění).
      await trackLeaderFill(event.fill, now);
      // Kryje pořadí, kdy flat position event předběhl závěrečný fill.
      await maybeEngageDayLock(now);
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
      } else {
        rememberProtectiveLeg(bracketPair.stopOrderId, bracketPair.targetOrderId);
        if (auditCleanDispatch(result.audit, 'dispatched')) {
          const stopPotential = levelPnl(bracketPair.symbol, bracketPair.stopPrice);
          const targetPotential = levelPnl(bracketPair.symbol, bracketPair.targetPrice);
          pushCopyEvent('bracket-placed', bracketPair.symbol,
            bracketPair.side === 'Buy' ? 'Short' : 'Long', bracketPair.quantity, now, {
              stopPrice: bracketPair.stopPrice, targetPrice: bracketPair.targetPrice,
              ...(stopPotential ? { stopPnlUsd: stopPotential.levelPnlUsd } : {}),
              ...(targetPotential ? { targetPnlUsd: targetPotential.levelPnlUsd } : {}),
            });
        }
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
      ))) {
        failClosed(new Error('OSO nebyl bezpečně potvrzen brokerem'));
      } else {
        rememberProtectiveLeg(pair.stopOrderId, pair.targetOrderId);
        if (auditCleanDispatch(result.audit, 'dispatched')) {
          const entryPrice = pair.entryLimitPrice ?? pair.entryStopPrice;
          const direction = pair.entrySide === 'Buy' ? 1 : -1;
          const pv = pointValueUsd(pair.symbol);
          if (entryPrice != null) {
            rememberPlannedEntry(pair.symbol, entryPrice, direction * pair.quantity);
          }
          pushCopyEvent('order-placed', pair.symbol,
            pair.entrySide === 'Buy' ? 'Long' : 'Short', pair.quantity, now, {
              ...(entryPrice != null ? { price: entryPrice } : {}),
              stopPrice: pair.stopPrice, targetPrice: pair.targetPrice,
              ...(pv != null && entryPrice != null
                ? {
                  stopPnlUsd: (pair.stopPrice - entryPrice) * direction * pair.quantity * pv,
                  targetPnlUsd: (pair.targetPrice - entryPrice) * direction * pair.quantity * pv,
                }
                : {}),
            });
        }
      }
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

    // Order lifecycle notifikace (po potvrzeném mirroru na followerech).
    const eventSide: 'Long' | 'Short' = leaderEvent.side === 'Sell' ? 'Short' : 'Long';
    if (leaderEvent.kind === 'canceled'
      && auditCleanDispatch(result.audit, 'canceled')) {
      const isProtective = leaderStopOrderIds.delete(leaderEvent.orderId)
        // OCO auto-cancel druhé nohy po SL/TP hitu je šum — nenotifikuje se.
        || leaderTargetOrderIds.delete(leaderEvent.orderId);
      if (!isProtective) {
        plannedEntryBySymbol.delete(leaderEvent.symbol);
        pushCopyEvent('order-canceled', leaderEvent.symbol, eventSide, leaderEvent.quantity, now);
      }
    } else if (leaderEvent.kind === 'replaced'
      && auditCleanDispatch(result.audit, 'modified')) {
      // Ochranná noha je technicky opačný příkaz (SL longu = Sell), ale
      // uživatel drží POZICI — notifikace hlásí směr pozice, ne nohy.
      const positionSide: 'Long' | 'Short' = eventSide === 'Long' ? 'Short' : 'Long';
      if (leaderStopOrderIds.has(leaderEvent.orderId)) {
        pushCopyEvent('sl-moved', leaderEvent.symbol, positionSide, leaderEvent.quantity, now, {
          ...(leaderEvent.stopPrice != null ? { price: leaderEvent.stopPrice } : {}),
          ...(levelPnl(leaderEvent.symbol, leaderEvent.stopPrice) ?? {}),
        });
      } else if (leaderTargetOrderIds.has(leaderEvent.orderId)) {
        pushCopyEvent('tp-moved', leaderEvent.symbol, positionSide, leaderEvent.quantity, now, {
          ...(leaderEvent.limitPrice != null ? { price: leaderEvent.limitPrice } : {}),
          ...(levelPnl(leaderEvent.symbol, leaderEvent.limitPrice) ?? {}),
        });
      } else {
        const movedPrice = leaderEvent.limitPrice ?? leaderEvent.stopPrice;
        // Posun čekajícího entry mění referenci pro potenciální P&L SL/TP.
        if (movedPrice != null && plannedEntryBySymbol.has(leaderEvent.symbol)) {
          rememberPlannedEntry(leaderEvent.symbol, movedPrice,
            (leaderEvent.side === 'Sell' ? -1 : 1) * leaderEvent.quantity);
        }
        pushCopyEvent('order-moved', leaderEvent.symbol, eventSide, leaderEvent.quantity, now, {
          ...(movedPrice != null ? { price: movedPrice } : {}),
        });
      }
    }
  };

  /** Autoritativní reconciliation — sdílí ji veřejné API i connection recovery. */
  const performReconciliation = async (): Promise<{ divergentAccounts: number[]; workingOrderAccounts: number[] }> => {
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
      const snapshots = await Promise.all(accountIds.map(async accountId => {
        const [positions, orders] = await Promise.all([
          broker.listPositions(accountId),
          broker.listOrders(accountId),
        ]);
        return { accountId, positions, orders };
      }));
      const byAccount = new Map(snapshots.map(item => [item.accountId, item]));
      positionsByAccount.clear();
      for (const snapshot of snapshots) {
        positionsByAccount.set(snapshot.accountId, new Map(
          snapshot.positions.map(item => [item.symbol, item.netQuantity]),
        ));
      }
      leaderPositions.clear();
      // Atribuce SL/TP exitů přežije restart: ochranné nohy leadera se
      // obnoví z autoritativních working orderů (mají parent/OCO vazbu).
      for (const order of byAccount.get(group.leaderAccountId)?.orders ?? []) {
        if (order.status !== 'working') continue;
        if (order.parentOrderId == null && order.ocoId == null && order.linkedOrderId == null) continue;
        if (order.orderType === 'Stop' || order.orderType === 'StopLimit') {
          leaderStopOrderIds.add(order.brokerOrderId);
        } else if (order.orderType === 'Limit') {
          leaderTargetOrderIds.add(order.brokerOrderId);
        }
      }
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
      lastResumeOffer = null;
    },
    disarm() {
      gate = { ...gate, armed: false };
      lastResumeOffer = null;
      // Ruční DISARM = vědomé „drž pozice" — boot recovery je nesmí zavřít.
      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
    },
    engageKillSwitch(reason = 'Ruční nouzové zastavení') {
      if (stopped) return;
      lastError = new Error(reason.trim() || 'Ruční nouzové zastavení');
      // Kill switch se v této runtime session nedá odjistit. Nový bootstrap znovu
      // startuje DISARMED a stále vyžaduje reconciliation před ostrým ARM.
      gate = { ...gate, armed: false, killSwitch: true };
      positionCheckComplete = false;
      lastResumeOffer = null;
      pendingConnectionRecovery = false;
      // Kill switch = explicitní freeze; žádná pozdější automatika.
      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
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
      return performReconciliation();
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
        groupFlat: groupIsFlat(),
        entryCooldownUntil: current.state.safety.entryCooldownUntil,
        dayLockUntil: current.state.safety.dayLockUntil,
        dayLockReason: current.state.safety.dayLockReason ?? null,
        armExpiresAt: gate.armed && gate.armTtlMs > 0 ? gate.armedAt + gate.armTtlMs : 0,
        armedAt: gate.armed ? gate.armedAt : 0,
        recentCopyEvents: [...recentCopyEvents],
        autoClose: lastAutoClose ? { ...lastAutoClose, accountIds: [...lastAutoClose.accountIds] } : null,
        resumeOffer: lastResumeOffer ? { ...lastResumeOffer } : null,
        dailyStats: current.state.safety.dailyStats
          ? {
            sessionEndAt: current.state.safety.dailyStats.sessionEndAt,
            realizedPnlUsd: current.state.safety.dailyStats.realizedPnlUsd,
            losingTrades: current.state.safety.dailyStats.losingTrades,
            recentClosedTrades: current.state.safety.dailyStats.recentClosedTrades?.map(trade => ({ ...trade })) ?? [],
            unpricedSymbols: [...current.state.safety.dailyStats.unpricedSymbols],
          }
          : null,
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

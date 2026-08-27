import {
  isOpenOrderStatus,
  type BrokerEvent,
  type BrokerFill,
  type BrokerOrder,
  type BrokerPort,
} from './brokerPort';
import { msUntilTradovateSessionEnd } from './copierArmSession';
import { pointValueUsd } from './futuresContractSpecs';
import {
  createCopierState,
  updateFollowerLinkQuantity,
  type CopierAccountEligibility,
  type CopierClosedTrade,
  type CopierDailyStats,
} from './copierEngine';
import { CopierLeaderEventSource } from './copierLeaderEventSource';
import { CopierBracketCorrelator, type LeaderBracketPair } from './copierBracketCorrelator';
import { CopierOsoCorrelator } from './copierOsoCorrelator';
import { stuckCancelEntries } from './copierCancelOutbox';
import { waiveCancelEntry } from './copierCancelOutbox';
import { markRejected as markOutboxRejected, stuckEntries, waiveOutboxEntry } from './copierOutbox';
import { stuckBracketEntries, waiveBracketOutboxEntry } from './copierBracketOutbox';
import { stuckOsoEntries, waiveOsoOutboxEntry } from './copierOsoOutbox';
import { applyResolved, type LeaderEvent } from './copierEngine';
import { createRiskGateContext, type RiskGateContext } from './copierRiskGate';
import {
  createCopierMetrics,
  createRuntime,
  createSerialCopierProcessor,
  recoverOutbox,
  runtimeFromSnapshot,
  type CopierAuditEntry,
  type CopierMetrics,
  type CopierRuntime,
  assertedFollowerQuantity,
} from './copierRunner';
import type { CopierStore } from './copierStore';
import { toSnapshot } from './copierStore';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from './liveCopyTrading';
import { processManualFlatten, type ManualFlattenResult } from './copierManualActions';
import { createExposureCappedBroker } from './exposureCappedBroker';

export type CopierStuckOperationKind = 'place' | 'bracket' | 'oso' | 'cancel-or-modify';

/**
 * Způsobilost účtu k NOVÝM vstupům. Oddělená od broker connection statusu
 * (ten nese per-účet live tečka v UI) i od poslední execution události.
 * 'disconnected' tu záměrně není — odpojení je vlastnost spojení, ne účtu.
 */
export type { CopierAccountEligibility, CopierAccountEligibilityState } from './copierEngine';

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
  /** Odchylky způsobilosti účtů (active se nevykazuje). */
  accountEligibility?: CopierAccountEligibility[];
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

export interface CopierAccountEligibilityExclusion {
  accountId: number;
  state: 'dll-locked' | 'breached';
  reason: string;
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
  /** ID otevřené obchodní epizody; volitelné kvůli starším statusům. */
  episodeId?: string;
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
  /**
   * Zpřísní eligibility podle čerstvého LIVE broker snapshotu. Tato cesta
   * umí pouze vyřazovat účty; `active` se obnovuje výhradně reconciliací.
   */
  applyAccountEligibilityExclusions(exclusions: readonly CopierAccountEligibilityExclusion[]): Promise<void>;
  /** Autoritativně porovná pozice a ověří, že nikde nezůstaly working orders. */
  reconcile(): Promise<{ divergentAccounts: number[]; workingOrderAccounts: number[] }>;
  /**
   * Autoritativně ověří jediný účet u brokera bez změny execution skupiny.
   * Je to čistě read-only cesta pro ruční reaktivaci po skončené DLL session.
   */
  verifyAccountEligibility(accountId: number): Promise<CopierAccountEligibility>;
  /**
   * Bezpečně změní leader epochu. Vyžaduje flat + bez working příkazů na
   * všech routovatelných účtech sjednocené staré a nové topologie. Známý
   * vyřazený follower (BREACHED/DLL/unverifiable), který už není v OAuth,
   * smí být pouze odpojen; leader a aktivní účty zůstávají vždy povinné.
   * Zahodí pouze order-lifecycle stav předchozího leadera a nikdy neposílá
   * brokerový příkaz.
   */
  reconfigureGroup(group: CopyGroupConfig): Promise<void>;
  /**
   * Bezpečně vybere jinou uloženou skupinu jako jedinou execution skupinu.
   * Vždy založí novou durable epochu a končí DISARMED.
   */
  activateGroup(group: CopyGroupConfig): Promise<void>;
  /** Synchronní změna follower/risk konfigurace při nezměněném leaderovi. */
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
  /** Injektovatelné pouze pro deterministické testy statistického episode ID. */
  episodeIdFactory?: () => string;
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
  /**
   * Bounded okno pro spárování follower position 0→nonzero s konkrétním
   * broker fill eventem. Po vypršení následuje autoritativní read-only
   * kontrola; nikdy nejde o autorizaci k automatickému zavření nejasné pozice.
   */
  followerTransitionCorrelationWindowMs?: number;
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
  options.broker.setCriticalAccounts?.([group.leaderAccountId]);
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
  let bracketCorrelator = new CopierBracketCorrelator();
  let osoCorrelator = new CopierOsoCorrelator(options.osoCorrelationWindowMs);
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
  // ── Account eligibility ────────────────────────────────────────────────
  // Oddělená vrstva od connection statusu a od poslední execution události.
  // Drží jen odchylky od 'active'; účet bez záznamu je způsobilý.
  const accountEligibility = new Map<number, CopierAccountEligibility>(
    (runtime.state.safety.accountEligibility ?? []).map(entry => [entry.accountId, {
      ...entry,
      ...(entry.lastExecution ? { lastExecution: { ...entry.lastExecution } } : {}),
    }]),
  );
  let persistEligibility = async (): Promise<void> => undefined;
  const DLL_REASON_PATTERN = /daily\s*loss|loss\s*limit|\bdll\b/i;
  const BREACH_REASON_PATTERN = /breach|trailing\s*(max\s*)?drawdown|account\s*(disabled|locked|suspended)/i;
  const setEligibility = (accountId: number, next: CopierAccountEligibility) => {
    // Breach je trvalý a nesmí ho přepsat slabší klasifikace téhož streamu;
    // odemyká ho jedině autoritativní reaktivace v reconciliaci.
    const current = accountEligibility.get(accountId);
    if (current?.state === 'breached' && next.state !== 'breached' && next.state !== 'active') return;
    accountEligibility.set(accountId, next);
  };
  const recordAccountRejection = async (order: BrokerOrder, at: number) => {
    const reason = order.rejectReason?.trim() || 'broker odmítl příkaz';
    const lastExecution = {
      kind: 'rejected' as const, reason, symbol: order.symbol, brokerOrderId: order.brokerOrderId, at,
    };
    const current = accountEligibility.get(order.accountId);
    if (BREACH_REASON_PATTERN.test(reason)) {
      setEligibility(order.accountId, {
        accountId: order.accountId, state: 'breached', reason, at, lastExecution,
      });
      await persistEligibility();
      return;
    }
    if (DLL_REASON_PATTERN.test(reason)) {
      setEligibility(order.accountId, {
        accountId: order.accountId, state: 'dll-locked', reason, at, lastExecution,
        // Hranice obchodní session v době locku: po jejím přejetí se stav
        // NEuvolní časem, jen přejde do 'unverifiable' a čeká na ověření.
        // Bez denních statistik se hranice odvodí ze session kalendáře.
        lockSessionEndAt: currentRuntime().state.safety.dailyStats?.sessionEndAt
          ?? (at + msUntilTradovateSessionEnd(at)),
      });
      await persistEligibility();
      return;
    }
    // Neurčitý reject: jen execution událost, eligibility se nemění.
    setEligibility(order.accountId, {
      accountId: order.accountId,
      state: current?.state ?? 'active',
      reason: current?.reason,
      at: current?.at ?? at,
      lockSessionEndAt: current?.lockSessionEndAt,
      lastExecution,
    });
    await persistEligibility();
  };
  /** DLL po začátku nové session nesmí zůstat odemčený ani zamčený „časem“. */
  const rollEligibilityToNewSession = (now: number): boolean => {
    let changed = false;
    for (const [accountId, entry] of accountEligibility) {
      if (
        entry.state === 'dll-locked'
        && entry.lockSessionEndAt != null
        && entry.lockSessionEndAt > 0
        && now >= entry.lockSessionEndAt
      ) {
        accountEligibility.set(accountId, {
          ...entry, state: 'unverifiable', at: now,
          reason: 'DLL session skončila — čeká na autoritativní ověření u brokera',
        });
        changed = true;
      }
    }
    return changed;
  };
  const eligibilityAt = (entry: CopierAccountEligibility, now: number): CopierAccountEligibility => (
    entry.state === 'dll-locked'
      && entry.lockSessionEndAt != null
      && entry.lockSessionEndAt > 0
      && now >= entry.lockSessionEndAt
      ? {
        ...entry,
        state: 'unverifiable',
        at: now,
        reason: 'DLL session skončila — čeká na autoritativní ověření u brokera',
      }
      : entry
  );
  const currentIneligibleAccounts = (): ReadonlyMap<number, string> => {
    const now = clock();
    const ineligible = new Map<number, string>();
    for (const [accountId, stored] of accountEligibility) {
      const entry = eligibilityAt(stored, now);
      if (entry.state !== 'active') {
        ineligible.set(accountId, `${entry.state}: ${entry.reason ?? 'bez důvodu'}`);
      }
    }
    return ineligible;
  };

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
    const episodeKind = kind === 'entry' || kind === 'scale-in' || kind === 'exit'
      || kind === 'flip' || kind === 'sl-moved' || kind === 'tp-moved';
    const openEpisodeId = currentRuntime().state.safety.dailyStats?.openLots
      .find(lot => lot.symbol === symbol)?.episodeId;
    const closedEpisodeId = currentRuntime().state.safety.dailyStats?.recentClosedTrades
      ?.find(trade => trade.symbol === symbol)?.episodeId;
    const episodeId = episodeKind ? (openEpisodeId ?? closedEpisodeId) : undefined;
    const copyEvent: CopierCopyEvent = {
      id: `${at}-${copyEventCounter}`,
      at, kind, symbol, side, quantity,
      followers: group.followers.filter(follower => follower.mode !== 'off').length,
      ...(episodeId ? { episodeId } : {}),
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
  /**
   * Mez na auto-close v jedné fail-closed epizodě. Flatten bez reduce-only
   * podpory venue teoreticky umí přestřelit (externí zavření mezi čtením
   * pozice a odesláním) a detektor otočení by pak plánoval další close —
   * konvergence je pravděpodobná, ale nesmí být nekonečná. Po vyčerpání
   * zbývá DISARMED stav, audit a notifikace; reset až úspěšným flat/ARM.
   */
  const AUTO_CLOSE_MAX_ATTEMPTS_PER_EPISODE = 3;
  let autoCloseEpisodeAttempts = 0;
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
  type FollowerFillRole = 'copied-entry' | 'protective';
  interface RecentFollowerFillCause {
    role: FollowerFillRole;
    sign: 1 | -1;
    brokerOrderId: string;
    observedAt: number;
  }
  interface PendingFollowerTransition {
    accountId: number;
    symbol: string;
    netQuantity: number;
    timer: ReturnType<typeof setTimeout>;
  }
  const recentFollowerFillCauses = new Map<string, RecentFollowerFillCause>();
  const pendingFollowerTransitions = new Map<string, PendingFollowerTransition>();
  const followerTransitionCorrelationWindowMs = options.followerTransitionCorrelationWindowMs ?? 2_000;

  if (!Number.isFinite(followerTransitionCorrelationWindowMs) || followerTransitionCorrelationWindowMs < 1) {
    throw new Error('followerTransitionCorrelationWindowMs musí být kladné číslo');
  }

  if (
    options.maxLeaderOrders != null
    && (!Number.isSafeInteger(options.maxLeaderOrders) || options.maxLeaderOrders <= 0)
  ) {
    throw new Error('maxLeaderOrders musí být kladné celé číslo');
  }

  /**
   * Nohy prokazatelně vyřízené u brokera. Zapisuje se až po autoritativním
   * ověření — dřívější zápis dělal z pojistky jednorázový pokus: selhaný
   * cancel se tvářil jako hotový a už se nikdy neopakoval.
   */
  const sweptProtectiveLegs = new Set<string>();
  /** Rušení právě běží; brání smyčce cancel → position event → cancel. */
  const sweepingProtectiveLegs = new Set<string>();
  /**
   * Sweep běží uvnitř serializovaného event tailu — jeden zaseknutý REST
   * request bez deadlinu by držel celý order stream (a s ním i detektor
   * otočení). V testech s injektovaným `wait` se deadline vypíná: fake
   * timers by z něj udělaly okamžitý timeout a testy řídí zdržení samy.
   */
  const SWEEP_CALL_DEADLINE_MS = 1_500;
  /** Horní mez skutečně pracovních noh v jedné okamžité sweep dávce. */
  const SWEEP_MAX_LEGS_PER_CALL = 6;
  const withSweepDeadline = async <T>(work: Promise<T>): Promise<T> => {
    if (options.wait) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`deadline ${SWEEP_CALL_DEADLINE_MS} ms`)), SWEEP_CALL_DEADLINE_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  /**
   * Kauzalita podle přesného broker orderId. Historické znaménko ochranných
   * nohou nestačí: po restartu v durable outboxu zůstávají staré strategie a
   * nová legitimní long kopie pak může vypadat jako fill staré Buy ochrany.
   */
  const followerFillRole = (accountId: number, brokerOrderId: string): FollowerFillRole | null => {
    const runtime = currentRuntime();
    for (const entry of runtime.osoOutbox.values()) {
      if (entry.request.accountId !== accountId) continue;
      if (entry.entryBrokerOrderId === brokerOrderId) return 'copied-entry';
      if (entry.firstBrokerOrderId === brokerOrderId || entry.secondBrokerOrderId === brokerOrderId) {
        return 'protective';
      }
    }
    for (const entry of runtime.bracketOutbox.values()) {
      if (entry.request.accountId !== accountId) continue;
      if (entry.firstBrokerOrderId === brokerOrderId || entry.secondBrokerOrderId === brokerOrderId) {
        return 'protective';
      }
    }
    for (const entry of runtime.outbox.values()) {
      if (entry.request.accountId === accountId && entry.brokerOrderId === brokerOrderId) {
        return 'copied-entry';
      }
    }
    return null;
  };
  const sweepFollowerProtectiveLegs = async (
    accountId: number,
    symbol: string,
    at: number,
    hint: {
      /** Přesná ochranná noha, jejíž fill způsobil přechod do flat. */
      protectiveFillBrokerOrderId?: string;
      /** Čerstvý autoritativní snapshot z reconciliation, je-li už načtený. */
      authoritativeWorkingOrderIds?: ReadonlySet<string>;
    } = {},
  ) => {
    const runtime = currentRuntime();
    const protectiveEntries = [...runtime.bracketOutbox.values(), ...runtime.osoOutbox.values()]
      .filter(entry => entry.request.accountId === accountId && entry.request.symbol === symbol);
    const allProtectiveLegIds = new Set<string>();
    for (const entry of protectiveEntries) {
      if (entry.request.accountId !== accountId) continue;
      // Flat na MNQ nesmí zrušit ochranu stále otevřeného NQ na stejném
      // účtu — sweep je pojistka jedné epizody, ne úklid celého účtu.
      if (entry.request.symbol !== symbol) continue;
      for (const brokerOrderId of [entry.firstBrokerOrderId, entry.secondBrokerOrderId]) {
        if (brokerOrderId) allProtectiveLegIds.add(brokerOrderId);
      }
    }

    let episodeLegIds: string[] | null = null;
    if (hint.protectiveFillBrokerOrderId) {
      const exactEntry = protectiveEntries.find(entry => (
        entry.firstBrokerOrderId === hint.protectiveFillBrokerOrderId
        || entry.secondBrokerOrderId === hint.protectiveFillBrokerOrderId
      ));
      if (exactEntry) {
        episodeLegIds = [exactEntry.firstBrokerOrderId, exactEntry.secondBrokerOrderId]
          .filter((brokerOrderId): brokerOrderId is string => Boolean(brokerOrderId));
      }
    }

    const failSweep = (reason: string, brokerOrderId?: string) => {
      options.onAudit?.([{
        at,
        leaderEventId: `flat-sweep-${accountId}-${brokerOrderId ?? symbol}`,
        accountId,
        ...(brokerOrderId ? { brokerOrderId } : {}),
        kind: 'cancel-failed',
        reason,
      }]);
      failClosed(new Error(`Flat sweep nedokončen — účet ${accountId} ${symbol}: ${reason}`));
      scheduleAutoClose('fail-closed');
    };

    let workingOrderIds = hint.authoritativeWorkingOrderIds;
    try {
      if (!episodeLegIds && !workingOrderIds) {
        const orders = await withSweepDeadline(broker.listOrders(accountId));
        workingOrderIds = new Set(
          orders
            .filter(order => order.symbol === symbol && isOpenOrderStatus(order.status))
            .map(order => order.brokerOrderId),
        );
      }
    } catch (error) {
      failSweep(`autoritativní výběr pracovních noh selhal: ${errorOf(error).message}`);
      return;
    }

    // Přesný protective fill dovoluje sáhnout jen na jeho vlastní epizodu.
    // Když fill předběhne position event a přesné ID ještě nemáme, bereme
    // pouze ID, která broker v čerstvém snapshotu opravdu hlásí jako working.
    // Durable terminální historie sama o sobě nikdy není kandidát na cancel.
    const legs = (episodeLegIds ?? [...allProtectiveLegIds].filter(id => workingOrderIds?.has(id)))
      .filter(brokerOrderId => (
        !sweptProtectiveLegs.has(brokerOrderId)
        && !sweepingProtectiveLegs.has(brokerOrderId)
      ));
    const cappedLegs = legs.slice(0, SWEEP_MAX_LEGS_PER_CALL);
    for (const brokerOrderId of cappedLegs) sweepingProtectiveLegs.add(brokerOrderId);
    // Souběžně: incidentní okno bylo 980 ms a sekvenční rušení do něj
    // přidávalo jeden round-trip za každou nohu navíc.
    const failures: string[] = [];
    await Promise.all(cappedLegs.map(async brokerOrderId => {
      const leaderEventId = `flat-sweep-${accountId}-${brokerOrderId}`;
      try {
        // Cancel chyba sama o sobě nerozhoduje (noha už mohla být terminální);
        // rozhoduje autoritativní lookup NÍŽE. Jediný inline pokus: retry
        // smyčka tady držela event stream ~15 s, eskalace je rychlejší.
        await withSweepDeadline(broker.cancelOrder(accountId, brokerOrderId)).catch(() => undefined);
        const lookup = await withSweepDeadline(broker.findOrderById(accountId, brokerOrderId));
        const outcome = lookup.order?.status;
        if (outcome != null && isOpenOrderStatus(outcome)) {
          throw new Error(`noha po cancellu stále aktivní (${outcome})`);
        }
        if (!lookup.order && lookup.completeness !== 'authoritative') {
          // Eventual prázdno není důkaz neexistence — nesmí se zapsat
          // jako zameteno (portová díra z review, bod 14).
          throw new Error('lookup bez autoritativní odpovědi');
        }
        sweptProtectiveLegs.add(brokerOrderId);
        options.onAudit?.([{
          at, leaderEventId, accountId, brokerOrderId,
          // Audit podle skutečného výsledku: vyplněná ani rejectnutá noha
          // se nesmí vydávat za zrušenou.
          kind: outcome === 'filled' ? 'filled' : outcome === 'rejected' ? 'rejected' : 'canceled',
          reason: outcome === 'filled'
            ? 'follower flat — ochranná noha se mezitím vyplnila'
            : outcome === 'rejected'
              ? 'follower flat — ochranná noha skončila rejectem'
              : 'follower flat — ochranná noha zrušena okamžitě',
        }]);
        // Zrušená noha činí bezpředmětnými i rozletěné modify na ni — bez
        // waivu by stale `unknown` navždy blokoval ruční Flatten (review 13).
        if (outcome !== 'filled') {
          await processor.mutate(async current => {
            const cancelOutbox = new Map(current.cancelOutbox);
            for (const [key, entry] of cancelOutbox) {
              if (
                entry.operation === 'modify'
                && entry.brokerOrderId === brokerOrderId
                && (entry.status === 'unknown' || entry.status === 'sending')
              ) {
                cancelOutbox.set(key, waiveCancelEntry(entry, 'nahrazeno flat sweep cancelem', clock()));
              }
            }
            return { ...current, cancelOutbox };
          }).catch(() => undefined);
        }
      } catch (error) {
        failures.push(brokerOrderId);
        // Neúspěch se NEZAHAZUJE: noha zůstává nezametená a selhání jde
        // do auditu i eskalace, ne do ticha.
        options.onAudit?.([{
          at, leaderEventId, accountId, brokerOrderId, kind: 'cancel-failed',
          reason: `flat sweep neuspěl: ${error instanceof Error ? error.message : String(error)}`,
        }]);
      } finally {
        sweepingProtectiveLegs.delete(brokerOrderId);
      }
    }));
    if (failures.length > 0) {
      failSweep(`${failures.length} ochranných noh nebylo autoritativně ukončeno`);
      return;
    }

    try {
      // Úspěch sweepu neurčuje počet položek v outboxu, ale brokerův stav PO
      // zásahu. Tím historie zůstává auditovatelná a přestává být falešnou
      // příčinou DISARMu.
      const [positions, orders] = await Promise.all([
        withSweepDeadline(broker.listPositions(accountId)),
        withSweepDeadline(broker.listOrders(accountId)),
      ]);
      const netQuantity = positions.find(position => position.symbol === symbol)?.netQuantity ?? 0;
      const workingProtectiveIds = orders
        .filter(order => (
          order.symbol === symbol
          && isOpenOrderStatus(order.status)
          && allProtectiveLegIds.has(order.brokerOrderId)
        ))
        .map(order => order.brokerOrderId);
      if (netQuantity !== 0) {
        throw new Error(`broker stále hlásí pozici ${netQuantity}`);
      }
      if (legs.length > cappedLegs.length || workingProtectiveIds.length > 0) {
        throw new Error(
          `broker stále hlásí ${workingProtectiveIds.length || legs.length - cappedLegs.length} pracovních ochranných noh`,
        );
      }

      const resolvedIds = new Set(episodeLegIds ?? cappedLegs);
      for (const brokerOrderId of allProtectiveLegIds) {
        const brokerOrder = orders.find(order => order.brokerOrderId === brokerOrderId);
        if (!brokerOrder || !isOpenOrderStatus(brokerOrder.status)) sweptProtectiveLegs.add(brokerOrderId);
      }
      // Po autoritativním důkazu flat + zero-working jsou pending cancel/modify
      // přesně těchto noh bezpředmětné. Durable historii nemažeme; jen ji
      // terminálně označíme, aby později neblokovala ARM jako stuck outbox.
      if (resolvedIds.size > 0) {
        await processor.mutate(async current => {
          const cancelOutbox = new Map(current.cancelOutbox);
          for (const [key, entry] of cancelOutbox) {
            if (
              resolvedIds.has(entry.brokerOrderId)
              && (entry.status === 'unknown' || entry.status === 'sending')
            ) {
              cancelOutbox.set(key, waiveCancelEntry(
                entry,
                'autoritativně potvrzený flat + žádná pracovní ochranná noha',
                clock(),
              ));
            }
          }
          return { ...current, cancelOutbox };
        });
      }
    } catch (error) {
      failSweep(`postkontrola selhala: ${errorOf(error).message}`);
    }
  };

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
  // `neverSent` unknown je preflight odmítnutí — na brokera nic neodešlo,
  // takže Flatten nemá co zdvojit. Blokovat jím nouzové zavření by
  // znamenalo, že detekce cizího zásahu zablokuje vlastní reakci na sebe.
  // Nový ARM tyhle záznamy blokují dál (currentStuckOperations je nese).
  const brokerUncertainInRuntime = (runtime: CopierRuntime) =>
    [...runtime.cancelOutbox.values()].some(entry =>
      (entry.status === 'sending' || entry.status === 'unknown') && !entry.neverSent)
    || [...runtime.outbox.values()].some(entry => entry.status === 'sending' || entry.status === 'unknown')
    || [...runtime.bracketOutbox.values()].some(entry => entry.status === 'sending' || entry.status === 'unknown')
    || [...runtime.osoOutbox.values()].some(entry => entry.status === 'sending' || entry.status === 'unknown');
  const hasBrokerUncertainOutbox = () => brokerUncertainInRuntime(currentRuntime());

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

  persistEligibility = async () => {
    await persistSafety({
      ...currentRuntime().state.safety,
      accountEligibility: [...accountEligibility.values()].map(entry => ({
        ...entry,
        ...(entry.lastExecution ? { lastExecution: { ...entry.lastExecution } } : {}),
      })),
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
          ...(lot.episodeId ? { episodeId: lot.episodeId } : {}),
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
          episodeId: options.episodeIdFactory?.() ?? globalThis.crypto.randomUUID(),
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

  const failClosed = (
    reason: unknown,
    failure: {
      transportLost?: boolean;
      autoClose?: boolean;
      reconcileAfterTerminalFill?: boolean;
    } = {},
  ) => {
    const wasLiveArmed = gate.armed && !gate.shadowMode;
    lastError = errorOf(reason);
    gate = {
      ...gate,
      armed: false,
      shadowMode: true,
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
    if (wasLiveArmed && !failure.transportLost && !gate.killSwitch && failure.autoClose !== false) {
      scheduleAutoClose('fail-closed', {
        reconcileAfterTerminalFill: failure.reconcileAfterTerminalFill === true,
      });
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
  const scheduleAutoClose = (
    trigger: 'fail-closed',
    recovery: { reconcileAfterTerminalFill?: boolean } = {},
  ) => {
    if (autoCloseInFlight || stopped) return;
    autoCloseInFlight = true;
    const seed = clock();
    eventTail = eventTail
      .then(async () => {
        try {
          await autoFlattenCopies(trigger, seed);
          if (recovery.reconcileAfterTerminalFill && gate.connected && !gate.killSwitch) {
            try {
              const reconciliation = await performReconciliation();
              const clean = reconciliation.divergentAccounts.length === 0
                && reconciliation.workingOrderAccounts.length === 0
                && !hasStuckOutbox();
              options.onAudit?.([{
                at: clock(),
                leaderEventId: `terminal-fill-reconciliation:${seed}`,
                kind: clean ? 'recovered' : 'blocked',
                reason: clean
                  ? 'modify skončil filled; následná autoritativní reconciliation potvrdila synchronní flat/no-active stav'
                  : 'modify skončil filled; následná autoritativní reconciliation nepotvrdila bezpečný synchronní stav',
              }]);
            } catch (error) {
              options.onAudit?.([{
                at: clock(),
                leaderEventId: `terminal-fill-reconciliation:${seed}`,
                kind: 'blocked',
                reason: `modify skončil filled; následná autoritativní reconciliation selhala: ${errorOf(error).message}`,
              }]);
            }
          }
        } finally {
          autoCloseInFlight = false;
        }
      })
      .catch(reason => {
        autoCloseInFlight = false;
        failClosed(reason);
      });
  };

  const followerTransitionKey = (accountId: number, symbol: string) => `${accountId}:${symbol}`;

  const clearPendingFollowerTransition = (key: string) => {
    const pending = pendingFollowerTransitions.get(key);
    if (pending) clearTimeout(pending.timer);
    pendingFollowerTransitions.delete(key);
  };

  const failOnExactProtectiveReversal = (
    accountId: number,
    symbol: string,
    netQuantity: number,
    brokerOrderId: string,
  ) => {
    failClosed(new Error(
      `Copier fail-closed: ochranná noha ${brokerOrderId} otevřela followerovi ${accountId} `
      + `neobjednanou pozici ${netQuantity} na ${symbol}, zatímco leader je flat`,
    ));
    // Když už byl runtime odzbrojený jinou chybou, failClosed další auto-close
    // nenaplánuje. Přesně prokázaný fill naší ochranné nohy je ale nový,
    // risk-zvyšující fakt a musí se zploštit i v takové epizodě.
    scheduleAutoClose('fail-closed');
  };

  const verifyPendingFollowerTransition = async (key: string) => {
    const pending = pendingFollowerTransitions.get(key);
    if (!pending || stopped) return;
    pendingFollowerTransitions.delete(key);

    const localFollowerNet = positionsByAccount.get(pending.accountId)?.get(pending.symbol) ?? 0;
    if (localFollowerNet === 0) return;

    const localLeaderNet = leaderPositions.get(pending.symbol) ?? 0;
    if (localLeaderNet !== 0 && Math.sign(localLeaderNet) === Math.sign(localFollowerNet)) return;

    const cause = recentFollowerFillCauses.get(key);
    if (
      cause
      && cause.sign === Math.sign(localFollowerNet)
      && clock() - cause.observedAt <= followerTransitionCorrelationWindowMs
    ) {
      recentFollowerFillCauses.delete(key);
      if (cause.role === 'copied-entry') return;
      failOnExactProtectiveReversal(
        pending.accountId, pending.symbol, localFollowerNet, cause.brokerOrderId,
      );
      return;
    }

    try {
      // Po krátkém kauzálním okně rozhoduje broker, ne pořadí lokálního
      // websocket streamu. Čtení je autoritativní a nic u brokera nemění.
      const [leaderSnapshot, followerSnapshot] = await Promise.all([
        broker.listPositions(group.leaderAccountId),
        broker.listPositions(pending.accountId),
      ]);
      const brokerLeaderNet = leaderSnapshot.find(item => item.symbol === pending.symbol)?.netQuantity ?? 0;
      const brokerFollowerNet = followerSnapshot.find(item => item.symbol === pending.symbol)?.netQuantity ?? 0;

      leaderPositions.set(pending.symbol, brokerLeaderNet);
      const followerPositions = positionsByAccount.get(pending.accountId) ?? new Map<string, number>();
      followerPositions.set(pending.symbol, brokerFollowerNet);
      positionsByAccount.set(pending.accountId, followerPositions);

      if (brokerFollowerNet === 0) return;
      if (brokerLeaderNet !== 0 && Math.sign(brokerLeaderNet) === Math.sign(brokerFollowerNet)) return;

      // Bez přesného fill orderId nevíme, zda jde o cizí pozici, opožděný
      // legitimní vstup, nebo ztracenou událost. Automatický market close by
      // byl neodůvodněný side effect — bezpečně odzbrojíme a eskalujeme.
      failClosed(new Error(
        `Copier fail-closed: follower ${pending.accountId} má autoritativně pozici ${brokerFollowerNet} `
        + `na ${pending.symbol}, leader ${brokerLeaderNet}; příčinu nelze bezpečně přiřadit ke konkrétnímu fillu`,
      ), { autoClose: false });
    } catch (error) {
      failClosed(new Error(
        `Copier fail-closed: autoritativní kontrola přechodu followera ${pending.accountId} `
        + `na ${pending.symbol} selhala: ${errorOf(error).message}`,
      ), { autoClose: false });
    }
  };

  const scheduleFollowerTransitionVerification = (
    accountId: number,
    symbol: string,
    netQuantity: number,
  ) => {
    const key = followerTransitionKey(accountId, symbol);
    clearPendingFollowerTransition(key);
    const timer = setTimeout(() => {
      eventTail = eventTail
        .then(() => verifyPendingFollowerTransition(key))
        .catch(reason => failClosed(reason, { autoClose: false }));
    }, followerTransitionCorrelationWindowMs);
    pendingFollowerTransitions.set(key, { accountId, symbol, netQuantity, timer });
  };

  const rememberFollowerFillCause = (fill: BrokerFill, observedAt: number) => {
    const role = followerFillRole(fill.accountId, fill.brokerOrderId);
    if (!role) return;
    const key = followerTransitionKey(fill.accountId, fill.symbol);
    const sign = fill.side === 'Buy' ? 1 : -1;
    const cause: RecentFollowerFillCause = {
      role, sign, brokerOrderId: fill.brokerOrderId, observedAt,
    };
    recentFollowerFillCauses.set(key, cause);

    const pending = pendingFollowerTransitions.get(key);
    if (!pending || Math.sign(pending.netQuantity) !== sign) return;
    clearPendingFollowerTransition(key);
    recentFollowerFillCauses.delete(key);
    if (role === 'protective') {
      failOnExactProtectiveReversal(
        pending.accountId, pending.symbol, pending.netQuantity, fill.brokerOrderId,
      );
    }
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
    const lifecycle = critical.key
      ? currentRuntime().cancelOutbox.get(critical.key)
      : undefined;
    const reconcileAfterTerminalFill = critical.kind === 'cancel-failed'
      && lifecycle?.operation === 'modify'
      && lifecycle.status === 'abandoned'
      && lifecycle.outcome === 'filled';
    failClosed(new Error(
      critical.reason
        ? `Copier fail-closed: ${critical.reason}`
        : `Copier fail-closed: ${critical.kind}`,
    ), { reconcileAfterTerminalFill });
  };

  const flatten = async (accountIds: readonly number[], operationId: string) => {
    gate = { ...gate, armed: false };
    positionCheckComplete = false;
    // Flatten je poslední risk-redukční brzda. Kill switch, shozený WS gate
    // ani starý sending/unknown outbox nesmí zabránit ani pokusu o čerstvou
    // autoritativní REST likvidaci. Skutečný transport/rate-limit/broker
    // reject se projeví per-account výsledkem a nikdy se nevydává za flat.
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
    if (autoCloseEpisodeAttempts >= AUTO_CLOSE_MAX_ATTEMPTS_PER_EPISODE) {
      options.onAudit?.([{
        at: clock(), leaderEventId: `auto-close-limit:${trigger}:${seed}`, kind: 'blocked',
        reason: `auto-close vyčerpal ${AUTO_CLOSE_MAX_ATTEMPTS_PER_EPISODE} pokusů v epizodě — nutný ruční zásah`,
      }]);
      return;
    }
    autoCloseEpisodeAttempts += 1;
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
      if (result.flat) {
        autoCloseEpisodeAttempts = 0;
        await syncLiveCopyExposureFlag('clear');
      }
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
      lastResumeOffer = null;
      options.onAudit?.([{
        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
        reason: 'connection-recovery: kopie jsou synchronní s leaderem — drženy DISARMED, ARM je blokovaný do flat',
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
      if (gate.armed) {
        failClosed(new Error(
          `Entry ${entryOrderId} dorazil jen s jedním ochranným příkazem (SL bez TP, nebo TP dorazil pozdě). `
          + 'Entry nebyl zkopírován — zadej SL i TP společně.',
        ));
      }
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
          ineligibleAccounts: currentIneligibleAccounts(),
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
      // Plánovaná obměna socketu výpadek nehlásí, aby nedělala falešné
      // poplachy — jenže v mezeře mezi zavřením a resyncem mohl leader
      // stihnout celý tržní příkaz a ten se pak nezkopíruje. Při zavírání
      // by se ale zkopíroval a follower by otevřel opačnou pozici. Po
      // obnově proto vždy vynutíme kontrolu pozic; když jsou účty
      // synchronní, ARM pokračuje a uživatel nic nepozná.
      if (event.connected && (source.needsReconciliation() || event.resynced)) {
        positionCheckComplete = false;
        if (event.resynced) pendingConnectionRecovery = true;
      }
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
    if (rollEligibilityToNewSession(now)) await persistEligibility();
    if (event.type === 'fill' && event.fill.accountId !== group.leaderAccountId) {
      rememberFollowerFillCause(event.fill, now);
    }
    // Asynchronní reject: REST ack s orderId NENÍ úspěch. Broker může
    // příkaz odmítnout až následným eventem (incident TDFYG: DLL reject
    // po acku) — outbox i eligibility to musí promítnout, jinak audit
    // vykazuje „dispatched“ nad mrtvým příkazem.
    if (event.type === 'order'
      && event.order.status === 'rejected'
      && [group.leaderAccountId, ...group.followers.map(item => item.accountId)]
        .includes(event.order.accountId)) {
      const order = event.order;
      await recordAccountRejection(order, now);
      // Leader reject se musí propsat do eligibility stejně jako follower
      // reject, ale nemá follower outbox položku, kterou by bylo co waivnout.
      if (order.accountId === group.leaderAccountId) {
        options.onAudit?.([{
          at: now, leaderEventId: `leader-reject-${order.brokerOrderId}`,
          kind: 'rejected', accountId: order.accountId,
          brokerOrderId: order.brokerOrderId,
          reason: order.rejectReason?.trim() || 'broker odmítl leader příkaz',
        }]);
      }
      const acknowledged = [...currentRuntime().outbox.values()].find(entry =>
        entry.brokerOrderId === order.brokerOrderId && entry.status === 'acknowledged');
      if (acknowledged) {
        const reason = order.rejectReason?.trim() || 'broker odmítl příkaz (async reject)';
        // Vysvětlený reject (DLL/breach) NESMÍ přes stuck-outbox zastavit
        // zdravé followery: účet už vyřadila eligibility, položka se
        // waivne s důvodem. Nevysvětlený reject zůstává 'rejected', tedy
        // fail-closed pro celou skupinu — leader a follower se rozešli
        // z neznámé příčiny.
        const classified = accountEligibility.get(order.accountId)?.state;
        const explained = classified === 'dll-locked' || classified === 'breached';
        await processor.mutate(async current => {
          const outbox = new Map(current.outbox);
          const entry = outbox.get(acknowledged.key);
          if (entry && entry.status === 'acknowledged') {
            outbox.set(entry.key, explained
              ? waiveOutboxEntry(markOutboxRejected(entry, reason, now), `${reason} — účet vyřazen z nových vstupů (${classified})`, now)
              : markOutboxRejected(entry, reason, now));
          }
          return { ...current, outbox };
        }).catch(() => undefined);
        options.onAudit?.([{
          at: now, leaderEventId: acknowledged.leaderEventId ?? `async-reject-${order.brokerOrderId}`,
          kind: 'rejected', accountId: order.accountId, key: acknowledged.key,
          brokerOrderId: order.brokerOrderId, reason,
        }]);
      }
    }
    // Cizí zásah se musí poznat z order streamu sám. Čekat, až ho odhalí
    // náš příští modify, znamená čekat na náhodu — 24. 8. žádný další modify
    // nepřišel a oversized noha vydržela pracovat až do fatálního fillu.
    if (event.type === 'order' && event.order.accountId !== group.leaderAccountId) {
      const runtime = currentRuntime();
      const asserted = assertedFollowerQuantity(runtime.state, runtime.cancelOutbox, event.order.brokerOrderId);
      const linked = [...runtime.state.links.values()]
        .flat()
        .find(link => link.brokerOrderId === event.order.brokerOrderId);
      const nativeProtective = linked?.nativeOsoRole === 'stop' || linked?.nativeOsoRole === 'target';
      const accountPositionSnapshot = positionsByAccount.get(event.order.accountId);
      // Po autoritativním snapshotu znamená chybějící symbol flat. Bez
      // snapshotu je stav neznámý a ochranný příkaz se nikdy naslepo neruší.
      const knownNet = accountPositionSnapshot == null
        ? undefined
        : accountPositionSnapshot.get(event.order.symbol) ?? 0;
      const venueManagedCoverage = nativeProtective
        && linked != null
        && knownNet != null
        && knownNet !== 0
        && event.order.status === 'working'
        && event.order.quantity === Math.abs(knownNet);

      // Tohle musí proběhnout i tehdy, když starý rozletěný modify dočasně
      // zvedl `asserted` na stejnou hodnotu jako venue. Autoritou pro nativní
      // OSO child není leaderův přechodný stav ani stará intence, ale přesná
      // follower pozice + working coverage. Link se podle nich srovná oběma
      // směry a nejasný modify se ukončí bez zrušení správného SL.
      if (venueManagedCoverage && linked.quantity !== event.order.quantity) {
        await processor.mutate(async current => {
          const cancelOutbox = new Map(current.cancelOutbox);
          for (const [key, entry] of cancelOutbox) {
            if (
              entry.operation === 'modify'
              && entry.brokerOrderId === event.order.brokerOrderId
              && (entry.status === 'sending' || entry.status === 'unknown')
            ) {
              cancelOutbox.set(key, waiveCancelEntry(
                entry,
                `venue-managed OSO coverage potvrzena podle pozice ${Math.abs(knownNet)}`,
                now,
              ));
            }
          }
          const state = updateFollowerLinkQuantity(
            current.state,
            event.order.brokerOrderId,
            event.order.quantity,
          );
          const committed = await options.store.commit(
            toSnapshot(
              state,
              current.outbox.values(),
              cancelOutbox.values(),
              current.revision,
              current.bracketOutbox.values(),
              current.osoOutbox.values(),
            ),
            current.revision,
          );
          return {
            ...current,
            state,
            cancelOutbox,
            revision: committed.revision,
          };
        });
        options.onAudit?.([{
          at: now,
          leaderEventId: `venue-oso-coverage-${event.order.accountId}-${event.order.brokerOrderId}`,
          kind: 'recovered',
          accountId: event.order.accountId,
          brokerOrderId: event.order.brokerOrderId,
          reason: `nativní OSO ochrana odpovídá skutečné pozici ${Math.abs(knownNet)}`,
        }]);
        return;
      }
      // `null` = objednávka není naše; do cizích účtů kopírce nic není.
      // Reconnect může znovu přehrát i terminální historii. Nafouknutý
      // working/pending příkaz je okamžité riziko, ale filled/canceled/rejected
      // už na venue nepracuje; případný dopad fillu zachytí position/fill
      // větev a autoritativní reconciliation. Historický terminální order
      // proto nesmí znovu otevírat stejný fail-closed incident po každé
      // pravidelné obnově socketu.
      if (
        asserted != null
        && isOpenOrderStatus(event.order.status)
        && event.order.quantity > asserted
      ) {
        failClosed(new Error(
          `Copier fail-closed: cizí navýšení množství u brokera — objednávka ${
            event.order.brokerOrderId} má ${event.order.quantity}, uplatnili jsme nejvýš ${asserted}`,
        ));
        // Odzbrojení nestačí: pokud je lokální expozice nula, auto-close
        // nemá co zavírat a oversized noha by u brokera dál pracovala —
        // její pozdější fill by otevřel protipozici už v DISARMED runtime.
        // Cancel cizím zásahem nafouknuté nohy je risk-redukující vždy.
        const { accountId, brokerOrderId } = event.order;
        // Entry nebo orphan ochranu nad autoritativně flat účtem lze zrušit.
        // Jediný working SL nad otevřenou či zatím neznámou pozicí se ale
        // nikdy nemaže naslepo — nouzový native liquidate zavře celý kontrakt.
        const safeDirectCancel = !nativeProtective || (knownNet != null && knownNet === 0);
        if (isOpenOrderStatus(event.order.status) && safeDirectCancel) {
          try {
            await broker.cancelOrder(accountId, brokerOrderId);
            options.onAudit?.([{
              at: now, leaderEventId: `foreign-inflation-${accountId}-${brokerOrderId}`,
              kind: 'canceled', accountId, brokerOrderId,
              reason: `cizí navýšení množství (${event.order.quantity} > ${asserted}) — noha zrušena`,
            }]);
          } catch (error) {
            options.onAudit?.([{
              at: now, leaderEventId: `foreign-inflation-${accountId}-${brokerOrderId}`,
              kind: 'cancel-failed', accountId, brokerOrderId,
              reason: `cizí navýšení množství — cancel selhal: ${
                error instanceof Error ? error.message : String(error)}`,
            }]);
          }
        }
        scheduleAutoClose('fail-closed');
      }
    }
    if (event.type === 'position') {
      const accountPositions = positionsByAccount.get(event.position.accountId) ?? new Map<string, number>();
      const previousAccountNet = accountPositions.get(event.position.symbol) ?? 0;
      accountPositions.set(event.position.symbol, event.position.netQuantity);
      positionsByAccount.set(event.position.accountId, accountPositions);
      // Incident 24. 8.: follower byl flat v 19.198, ale jeho stop u brokera
      // dál pracoval (venue ho přeasertoval na vyšší total) a o 980 ms
      // později ho otočil do protipozice. Jakmile follower dosáhne flat,
      // jeho ochranné nohy okamžitě rušíme sami — risk-redukující cancel,
      // který smí proběhnout i po DISARM. Zrušení už vyplněné/zrušené nohy
      // broker odmítne a to je v pořádku.
      if (
        event.position.accountId !== group.leaderAccountId
        && previousAccountNet !== 0
        && event.position.netQuantity === 0
      ) {
        const transitionKey = followerTransitionKey(event.position.accountId, event.position.symbol);
        clearPendingFollowerTransition(transitionKey);
        const protectiveFillCause = recentFollowerFillCauses.get(transitionKey);
        recentFollowerFillCauses.delete(transitionKey);
        await sweepFollowerProtectiveLegs(
          event.position.accountId,
          event.position.symbol,
          now,
          {
            ...(protectiveFillCause?.role === 'protective'
              ? { protectiveFillBrokerOrderId: protectiveFillCause.brokerOrderId }
              : {}),
          },
        );
      }
      // Follower může legitimně dostat fill kopie dřív, než websocket doručí
      // position event leadera. Historické „existuje někde ochranná noha se
      // stejným znaménkem“ tady způsobilo incident 25. 8.: validní vstup všech
      // pěti followerů byl po ~130 ms automaticky zploštěn. Rozhodujeme proto
      // jen z přesného brokerOrderId fillu; bez něj dáme streamu krátké
      // kauzální okno a potom provedeme read-only kontrolu u brokera.
      if (
        event.position.accountId !== group.leaderAccountId
        && event.position.netQuantity !== 0
        && (
          previousAccountNet === 0
          || Math.sign(previousAccountNet) !== Math.sign(event.position.netQuantity)
        )
        && (leaderPositions.get(event.position.symbol) ?? 0) === 0
      ) {
        const transitionKey = followerTransitionKey(event.position.accountId, event.position.symbol);
        const cause = recentFollowerFillCauses.get(transitionKey);
        const sign = Math.sign(event.position.netQuantity);
        if (
          cause
          && cause.sign === sign
          && now - cause.observedAt <= followerTransitionCorrelationWindowMs
        ) {
          recentFollowerFillCauses.delete(transitionKey);
          if (cause.role === 'protective') {
            failOnExactProtectiveReversal(
              event.position.accountId,
              event.position.symbol,
              event.position.netQuantity,
              cause.brokerOrderId,
            );
          }
        } else {
          scheduleFollowerTransitionVerification(
            event.position.accountId, event.position.symbol, event.position.netQuantity,
          );
        }
      }
      if (event.position.accountId === group.leaderAccountId) {
        const previousNet = leaderPositions.get(event.position.symbol) ?? 0;
        leaderPositions.set(event.position.symbol, event.position.netQuantity);
        if (event.position.netQuantity !== 0) {
          for (const [key, pending] of pendingFollowerTransitions) {
            if (
              pending.symbol === event.position.symbol
              && Math.sign(pending.netQuantity) === Math.sign(event.position.netQuantity)
            ) clearPendingFollowerTransition(key);
          }
        }
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
            if (gate.armed) {
              failClosed(new Error(`Bracket ${bracketEntryOrderId} nemá bezpečně spárovaný SL i TP`));
            }
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
          ineligibleAccounts: currentIneligibleAccounts(),
        },
        broker,
        clock,
        store: options.store,
        metrics,
        maxConcurrentDispatches: options.maxConcurrentDispatches,
      });
      runtime = result.runtime;
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      const criticalBracketAudit = result.audit.some(item => (
        item.kind === 'unknown'
        || item.kind === 'abandoned'
        || item.kind === 'blocked'
        || item.kind === 'rejected'
      ));
      if (criticalBracketAudit) {
        failClosedOnCriticalAudit(result.audit);
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
      if (gate.armed) failClosed(new Error(osoObservation.reason));
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
          ineligibleAccounts: currentIneligibleAccounts(),
        },
        broker,
        clock,
        store: options.store,
        metrics,
        maxConcurrentDispatches: options.maxConcurrentDispatches,
      });
      runtime = result.runtime;
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      const criticalOsoAudit = result.audit.some(item => (
        item.kind === 'unknown' || item.kind === 'abandoned'
        || item.kind === 'blocked' || item.kind === 'rejected'
      ));
      if (criticalOsoAudit) {
        failClosedOnCriticalAudit(result.audit);
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
        ineligibleAccounts: currentIneligibleAccounts(),
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
  async function performReconciliation(): Promise<{
    divergentAccounts: number[];
    workingOrderAccounts: number[];
  }> {
      if (!gate.connected) {
        // Holé „bez broker spojení" mate: uživatel vidí v kartě Připojení
        // platné OAuth a myslí si, že spojení stojí. Padá ale živý WebSocket
        // workeru, což je jiná vrstva — hláška proto říká i příčinu a co dál.
        const reason = lastError?.message?.trim();
        throw new Error([
          'Kontrolu pozic nelze provést: worker nemá živé spojení s Tradovate.',
          reason ? `Poslední chyba: ${reason}.` : '',
          'OAuth přihlášení tím není dotčené — spojení se obnoví samo, zkus to za chvíli znovu.',
        ].filter(Boolean).join(' '));
      }
      if (group.leaderAccountId == null) throw new Error('Copy group nemá leader účet');
      const accountIds = [group.leaderAccountId, ...group.followers.map(item => item.accountId)];
      const eligibilityNow = clock();
      const eligibilityByAccount = new Map<number, CopierAccountEligibility>();
      for (const [accountId, stored] of accountEligibility) {
        eligibilityByAccount.set(accountId, eligibilityAt(stored, eligibilityNow));
      }
      // Známý vyřazený follower nesmí zablokovat autoritativní kontrolu
      // zdravých účtů jen proto, že ho prop firma po BREACH/DLL přestala
      // vracet v account/list. Leader je vždy povinný. `unverifiable` účet
      // se naopak při dostupné capability dále načte a může se reaktivovat.
      const optionalFollowerIds = new Set(group.followers
        .filter(follower => (eligibilityByAccount.get(follower.accountId)?.state ?? 'active') !== 'active')
        .map(follower => follower.accountId));
      const capabilities = await broker.listAccountCapabilities(accountIds);
      const byCapability = new Map(capabilities.map(item => [item.accountId, item]));
      const missing = accountIds.filter(accountId => !byCapability.has(accountId) && !optionalFollowerIds.has(accountId));
      const inactive = accountIds.filter(accountId =>
        byCapability.get(accountId)?.active === false && !optionalFollowerIds.has(accountId));
      const readOnlyFollowers = group.followers.filter(
        follower => byCapability.get(follower.accountId)?.canTrade === false
          && !optionalFollowerIds.has(follower.accountId),
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
      const snapshotAccountIds = accountIds.filter(accountId => {
        const capability = byCapability.get(accountId);
        if (!capability?.active || !capability.canTrade) return false;
        const state = eligibilityByAccount.get(accountId)?.state ?? 'active';
        // BREACHED a stále platný DLL jsou známé exclusions. Expirující DLL
        // už eligibilityAt převedlo na `unverifiable`, takže se načte a po
        // úspěšném snapshotu může bezpečně vrátit do active.
        return state !== 'breached' && state !== 'dll-locked';
      });
      const snapshots = await Promise.all(snapshotAccountIds.map(async accountId => {
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
        snapshots.filter(item => item.orders.some(order => isOpenOrderStatus(order.status))).map(item => item.accountId),
      );
      // Reaktivace eligibility: JEDINÉ místo, kde se DLL/unverifiable vrací
      // do 'active' — autoritativní snapshot účtu se povedl. Čas sám nikdy
      // nestačí (rollEligibilityToNewSession umí jen zpřísnit na
      // 'unverifiable'). Breach zůstává trvale, dokud ho operátor neřeší.
      {
        const reactivationNow = clock();
        let eligibilityChanged = rollEligibilityToNewSession(reactivationNow);
        for (const [accountId, entry] of accountEligibility) {
          if (!byAccount.has(accountId)) continue;
          const newSessionBegan = entry.lockSessionEndAt != null
            && entry.lockSessionEndAt > 0
            && reactivationNow >= entry.lockSessionEndAt;
          if (entry.state === 'unverifiable' || (entry.state === 'dll-locked' && newSessionBegan)) {
            accountEligibility.set(accountId, {
              ...entry, state: 'active', at: reactivationNow,
              reason: 'autoritativně ověřeno při reconciliaci po nové session',
            });
            eligibilityChanged = true;
            options.onAudit?.([{
              at: reactivationNow, leaderEventId: `eligibility-reactivate-${accountId}`,
              kind: 'recovered', accountId,
              reason: 'účet znovu způsobilý — autoritativní ověření po nové session',
            }]);
          }
        }
        if (eligibilityChanged) await persistEligibility();
      }
      const ineligibleAfterReactivation = currentIneligibleAccounts();
      for (const follower of group.followers) {
        // Účet s autoritativní eligibility exclusion není participantem
        // copieru. Jeho chybějící snapshot proto není divergence zdravých
        // participantů; po reaktivaci se automaticky vrátí do této kontroly.
        if (ineligibleAfterReactivation.has(follower.accountId)) continue;
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
      // Durable dokončení sweep povinnosti: pád workeru mezi follower flat
      // a potvrzeným cancelem nesmí povinnost ztratit (review, bod 5).
      // Reconciliation je autoritativní moment, kdy se osiřelé working
      // ochranné nohy nad flat followerem dají najít a doprovodit.
      for (const follower of group.followers) {
        const snapshot = byAccount.get(follower.accountId);
        if (!snapshot) continue;
        const workingIds = new Set(
          snapshot.orders.filter(order => isOpenOrderStatus(order.status)).map(order => order.brokerOrderId),
        );
        if (workingIds.size === 0) continue;
        const flatSymbols = new Set<string>();
        const runtime = currentRuntime();
        for (const entry of [...runtime.bracketOutbox.values(), ...runtime.osoOutbox.values()]) {
          if (entry.request.accountId !== follower.accountId) continue;
          const net = snapshot.positions.find(item => item.symbol === entry.request.symbol)?.netQuantity ?? 0;
          if (net !== 0) continue;
          const hasWorkingLeg = [entry.firstBrokerOrderId, entry.secondBrokerOrderId]
            .some(id => id && workingIds.has(id));
          if (hasWorkingLeg) flatSymbols.add(entry.request.symbol);
        }
        for (const symbol of flatSymbols) {
          await sweepFollowerProtectiveLegs(follower.accountId, symbol, clock(), {
            authoritativeWorkingOrderIds: workingIds,
          });
        }
      }
      gate = { ...gate, divergentAccounts: divergent, sequenceBroken: false, armed: false };
      positionCheckComplete = divergent.size === 0 && workingOrderAccounts.size === 0;
      if (positionCheckComplete) {
        await acknowledgeTerminalRejectsAfterReconciliation();
        source.acknowledgeReconciliation();
        lastError = null;
        gate = { ...gate, shadowMode: true };
      }
      return {
        divergentAccounts: [...divergent],
        workingOrderAccounts: [...workingOrderAccounts],
      };
  }

  const LEADER_EPOCH_READ_DEADLINE_MS = 2_500;
  const withLeaderEpochDeadline = async <T>(label: string, work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label}: broker read deadline ${LEADER_EPOCH_READ_DEADLINE_MS} ms`)),
            LEADER_EPOCH_READ_DEADLINE_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Přepnutí leadera je změna celé order-lifecycle epochy, ne obyčejný
   * edit jednoho ID. Operace se řadí do stejné fronty jako broker eventy:
   * event, který dorazil před klikem, doběhne pod starým leaderem; event po
   * potvrzené změně už pod novým. Chyba se vrátí UI a frontu nezabije.
   */
  const reconfigureLeaderEpoch = async (
    nextGroup: CopyGroupConfig,
    switchOptions: { allowGroupChange?: boolean; forceEpoch?: boolean } = {},
  ): Promise<void> => {
    const operation = switchOptions.forceEpoch ? 'Aktivaci skupiny' : 'Změnu leadera';
    const run = eventTail.then(async () => {
      if (stopped) throw new Error('Copier runtime is stopped');
      if (nextGroup.id !== group.id && !switchOptions.allowGroupChange) {
        throw new Error('Nelze změnit runtime na jinou copy group bez explicitní aktivace');
      }
      assertRuntimeGroup(nextGroup);
      const currentTopology = new Set([
        group.leaderAccountId,
        ...group.followers.map(item => item.accountId),
      ]);
      const nextTopology = new Set([
        nextGroup.leaderAccountId,
        ...nextGroup.followers.map(item => item.accountId),
      ]);
      const topologyChanged = currentTopology.size !== nextTopology.size
        || [...currentTopology].some(accountId => !nextTopology.has(accountId));
      if (nextGroup.leaderAccountId === group.leaderAccountId && !topologyChanged && !switchOptions.forceEpoch) {
        group = nextGroup;
        positionCheckComplete = false;
        source.requireReconciliation();
        return;
      }
      if (!gate.connected) {
        throw new Error(`${operation} nelze potvrdit bez živého broker syncu workeru`);
      }
      if (currentStuckOperations().length > 0 || hasBrokerUncertainOutbox()) {
        throw new Error(`${operation} blokuje nevyřešený durable outbox`);
      }
      const pendingReasons = [
        pendingBracketTimers.size > 0 ? 'bracket correlation' : '',
        pendingOsoTimers.size > 0 || pendingOsoEvents.size > 0 || pendingOsoFlushes.size > 0
          ? 'OSO correlation'
          : '',
        pendingFollowerTransitions.size > 0 ? 'follower transition' : '',
        sweepingProtectiveLegs.size > 0 ? 'protective sweep' : '',
        autoCloseInFlight ? 'auto-close' : '',
        recoveryInFlight || pendingConnectionRecovery ? 'connection recovery' : '',
        cooldownPending ? 'cooldown transition' : '',
        dayLockPendingReason ? 'day-lock transition' : '',
      ].filter(Boolean);
      if (pendingReasons.length > 0) {
        throw new Error(`${operation} blokuje rozpracovaný lifecycle: ${pendingReasons.join(', ')}`);
      }
      const openLots = currentRuntime().state.safety.dailyStats?.openLots
        .filter(lot => lot.netQuantity !== 0) ?? [];
      if (openLots.length > 0) {
        throw new Error(`${operation} blokuje otevřená durable pozice leadera`);
      }

      const accountIds = [...new Set([
        group.leaderAccountId,
        ...group.followers.map(item => item.accountId),
        nextGroup.leaderAccountId,
        ...nextGroup.followers.map(item => item.accountId),
      ])];
      const leaderIds = new Set([group.leaderAccountId, nextGroup.leaderAccountId]);
      const eligibilityNow = clock();
      const optionalFollowerIds = new Set(accountIds.filter(accountId => {
        if (leaderIds.has(accountId)) return false;
        const stored = accountEligibility.get(accountId);
        return stored != null && eligibilityAt(stored, eligibilityNow).state !== 'active';
      }));
      const requiredAccountIds = accountIds.filter(accountId => !optionalFollowerIds.has(accountId));
      const capabilities = await withLeaderEpochDeadline(
        'leader capability preflight',
        broker.listAccountCapabilities(requiredAccountIds),
      );
      const capabilityByAccount = new Map(capabilities.map(item => [item.accountId, item]));
      const unavailable = requiredAccountIds.filter(accountId => {
        const capability = capabilityByAccount.get(accountId);
        return !capability || !capability.active || !capability.canTrade;
      });
      if (unavailable.length > 0) {
        throw new Error(`${operation} blokují neaktivní/read-only účty: ${unavailable.join(',')}`);
      }
      const snapshots = await Promise.all(requiredAccountIds.map(async accountId => {
        const [positions, orders] = await Promise.all([
          withLeaderEpochDeadline(`leader position preflight ${accountId}`, broker.listPositions(accountId)),
          withLeaderEpochDeadline(`leader order preflight ${accountId}`, broker.listOrders(accountId)),
        ]);
        return { accountId, positions, orders };
      }));
      const nonFlat = snapshots.filter(snapshot =>
        snapshot.positions.some(position => position.netQuantity !== 0));
      const withWorkingOrders = snapshots.filter(snapshot =>
        snapshot.orders.some(order => isOpenOrderStatus(order.status)));
      if (nonFlat.length > 0 || withWorkingOrders.length > 0) {
        const details = [
          nonFlat.length > 0 ? `nonFlat=${nonFlat.map(item => item.accountId).join(',')}` : '',
          withWorkingOrders.length > 0
            ? `working=${withWorkingOrders.map(item => item.accountId).join(',')}`
            : '',
        ].filter(Boolean).join(' ');
        throw new Error(`${operation} vyžaduje všechny staré i nové účty flat a bez příkazů: ${details}`);
      }

      runtime = await processor.mutate(async current => {
        const { liveCopyOpenSince: _dropOpenFlag, ...preservedSafety } = current.state.safety;
        const cleanState = createCopierState([], 0, [], [], [], preservedSafety);
        const committed = await options.store.commit(
          toSnapshot(cleanState, [], [], current.revision, [], []),
          current.revision,
        );
        return createRuntime(cleanState, [], [], committed.revision, [], []);
      });

      // Od tohoto bodu je durable stará epocha pryč a teprve teď se stává
      // nový leader autoritativní pro event source i risk vrstvu.
      group = nextGroup;
      options.broker.setCriticalAccounts?.([nextGroup.leaderAccountId]);
      bracketCorrelator = new CopierBracketCorrelator();
      osoCorrelator = new CopierOsoCorrelator(options.osoCorrelationWindowMs);
      recentCopyEvents.length = 0;
      copyEventCounter = 0;
      leaderStopOrderIds.clear();
      leaderTargetOrderIds.clear();
      lastLeaderFillOrderId.clear();
      plannedEntryBySymbol.clear();
      admittedLeaderOrders.clear();
      admittedFlatExitOrders.clear();
      leaderPositions.clear();
      positionsByAccount.clear();
      for (const snapshot of snapshots) {
        positionsByAccount.set(snapshot.accountId, new Map(
          snapshot.positions.map(position => [position.symbol, position.netQuantity]),
        ));
      }
      untrackedTradeSymbols.clear();
      recentFollowerFillCauses.clear();
      sweptProtectiveLegs.clear();
      sweepingProtectiveLegs.clear();
      workingOrderAccounts = new Set();
      lastAutoClose = null;
      lastResumeOffer = null;
      autoCloseEpisodeAttempts = 0;
      pendingConnectionRecovery = false;
      recoveryInFlight = false;
      bootRecoveryChecked = true;
      positionCheckComplete = false;
      lastError = null;
      source.requireReconciliation();
      gate = {
        ...gate,
        armed: false,
        armedAt: 0,
        now: clock(),
        shadowMode: true,
        divergentAccounts: new Set(),
        sequenceBroken: false,
        stuckOutbox: false,
      };
      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
    });
    eventTail = run.then(() => undefined, () => undefined);
    try {
      await run;
    } catch (reason) {
      const error = errorOf(reason);
      lastError = error;
      options.onError?.(error);
      throw error;
    }
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
      if (!group.enabled) throw new Error('Copier nelze armovat: skupina je vypnutá');
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
      if (hasStuckOutbox()) throw new Error('Copier má nevyřešený outbox');
      if (gate.divergentAccounts.size > 0) throw new Error('Pozice leader/follower se rozcházejí');
      if (workingOrderAccounts.size > 0) throw new Error('Před ARM musí být všechny účty bez pracovních příkazů');
      if (!shadowMode && !positionCheckComplete) throw new Error('Před live dispatch je nutné potvrdit kontrolu pozic');
      const ineligible = currentIneligibleAccounts();
      if (!shadowMode) {
        const armAccountIds = [
          group.leaderAccountId,
          ...group.followers
            .filter(follower => !ineligible.has(follower.accountId))
            .map(follower => follower.accountId),
        ];
        const allArmAccountsAuthoritativelyFlat = armAccountIds.every(accountId => {
          const positions = positionsByAccount.get(accountId);
          return positions != null && [...positions.values()].every(quantity => quantity === 0);
        });
        if (!allArmAccountsAuthoritativelyFlat) {
          throw new Error(
            'Před ARM musí být všechny zapojené účty flat; otevřený obchod se nikdy automaticky nepřebírá ani nedorovnává',
          );
        }
      }
      const leaderReason = ineligible.get(group.leaderAccountId);
      if (leaderReason) throw new Error(`Leader účet není způsobilý pro nové vstupy: ${leaderReason}`);
      if (!shadowMode) {
        const participatingFollowers = group.followers.filter(follower =>
          follower.mode !== 'off' && !ineligible.has(follower.accountId));
        if (participatingFollowers.length === 0) {
          throw new Error('ARM blokován: skupina nemá žádný způsobilý follower účet');
        }
      }
      // Kratší z limitů vyhrává: session TTL nesmí ARM prodloužit za výchozí strop.
      const armTtlMs = ttlMs != null ? Math.min(ttlMs, defaultArmTtlMs) : defaultArmTtlMs;
      gate = { ...gate, armed: true, armedAt: now, now, shadowMode, armTtlMs };
      lastResumeOffer = null;
      // Nová epizoda: ARM prošel všemi branami (flat, žádný stuck outbox),
      // takže počítadlo nouzových zavření začíná znovu.
      autoCloseEpisodeAttempts = 0;
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
    async applyAccountEligibilityExclusions(exclusions) {
      // Safety metadata může přijet z webu těsně před ARM/SHADOW. Nikdy
      // nesmí za běžícího dispatchu změnit účast bez fail-safe DISARMu.
      gate = { ...gate, armed: false };
      const members = new Set([
        group.leaderAccountId,
        ...group.followers.map(follower => follower.accountId),
      ]);
      const now = clock();
      let changed = false;
      for (const exclusion of exclusions) {
        if (!Number.isSafeInteger(exclusion.accountId) || exclusion.accountId <= 0) {
          throw new Error('Eligibility exclusion obsahuje neplatné accountId');
        }
        if (!members.has(exclusion.accountId)) {
          throw new Error(`Eligibility exclusion míří mimo aktivní skupinu: ${exclusion.accountId}`);
        }
        if (exclusion.state !== 'dll-locked' && exclusion.state !== 'breached') {
          throw new Error('Eligibility exclusion smí účet pouze zamknout jako DLL nebo BREACHED');
        }
        const reason = exclusion.reason.trim();
        if (reason.length < 3 || reason.length > 500) {
          throw new Error('Eligibility exclusion vyžaduje konkrétní důvod');
        }
        const current = accountEligibility.get(exclusion.accountId);
        // Stav z LIVE smí runtime jen zpřísnit. `unverifiable` je
        // fail-closed a nesmí se změnit na slabší DLL lock; BREACHED je
        // nejsilnější trvalá západka.
        const currentSeverity = current?.state === 'breached'
          ? 3
          : current?.state === 'unverifiable'
            ? 2
            : current?.state === 'dll-locked'
              ? 1
              : 0;
        const nextSeverity = exclusion.state === 'breached' ? 3 : 1;
        if (nextSeverity < currentSeverity) continue;
        const existingDllSessionEnd = current?.state === 'dll-locked'
          && current.lockSessionEndAt != null
          && current.lockSessionEndAt > now
          ? current.lockSessionEndAt
          : null;
        const next: CopierAccountEligibility = {
          ...(current ?? {}),
          accountId: exclusion.accountId,
          state: exclusion.state,
          reason,
          at: now,
          lockSessionEndAt: exclusion.state === 'dll-locked'
            ? existingDllSessionEnd ?? now + msUntilTradovateSessionEnd(now)
            : undefined,
        };
        if (
          current?.state === next.state
          && current.reason === next.reason
          && current.lockSessionEndAt === next.lockSessionEndAt
        ) continue;
        setEligibility(exclusion.accountId, next);
        changed = true;
      }
      if (changed) await persistEligibility();
    },
    async reconcile() {
      return performReconciliation();
    },
    async verifyAccountEligibility(accountId) {
      if (!Number.isSafeInteger(accountId) || accountId <= 0) {
        throw new Error('Neplatné ID účtu pro ověření');
      }
      if (!gate.connected) {
        const reason = lastError?.message?.trim();
        throw new Error([
          'Stav účtu nelze ověřit: worker nemá živé spojení s Tradovate.',
          reason ? `Poslední chyba: ${reason}.` : '',
          'OAuth přihlášení tím není dotčené — spojení se obnoví samo, zkus to za chvíli znovu.',
        ].filter(Boolean).join(' '));
      }

      const now = clock();
      const current = accountEligibility.get(accountId);
      const effective = current ? eligibilityAt(current, now) : undefined;
      if (effective?.state === 'breached') {
        throw new Error(`Účet je BREACHED a nelze ho automaticky reaktivovat: ${effective.reason ?? 'bez důvodu'}`);
      }
      if (effective?.state === 'dll-locked') {
        throw new Error(`DLL stále platí do konce broker session: ${effective.reason ?? 'bez důvodu'}`);
      }

      const capabilities = await broker.listAccountCapabilities([accountId]);
      const capability = capabilities.find(item => item.accountId === accountId);
      if (!capability) throw new Error(`Broker účet ${accountId} v OAuth spojení nevrátil`);
      if (!capability.active) throw new Error(`Broker účet ${accountId} stále hlásí jako neaktivní`);
      if (!capability.canTrade) throw new Error(`Broker účet ${accountId} zatím nepovoluje obchodování`);

      // Oba read-only dotazy jsou součástí důkazu: samotný account/list může
      // účet vrátit, i když jeho obchodní snapshot zatím není dostupný.
      await Promise.all([
        broker.listPositions(accountId),
        broker.listOrders(accountId),
      ]);

      const verified: CopierAccountEligibility = {
        ...(current ?? {}),
        accountId,
        state: 'active',
        reason: 'autoritativně ověřeno u brokera po nové session',
        at: now,
        lockSessionEndAt: undefined,
      };
      accountEligibility.set(accountId, verified);
      await persistEligibility();
      options.onAudit?.([{
        at: now,
        leaderEventId: `eligibility-verify-${accountId}`,
        kind: 'recovered',
        accountId,
        reason: 'účet znovu způsobilý — cílené read-only ověření u brokera',
      }]);
      return verified;
    },
    async reconfigureGroup(nextGroup) {
      // UI dostane okamžitě fail-safe DISARM ještě před čekáním na eventTail.
      gate = { ...gate, armed: false };
      positionCheckComplete = false;
      await reconfigureLeaderEpoch(nextGroup);
    },
    async activateGroup(nextGroup) {
      // Aktivace není ARM. Nejprve fail-safe DISARM, potom plný preflight
      // staré i nové topologie a nová durable epocha.
      gate = { ...gate, armed: false };
      positionCheckComplete = false;
      await reconfigureLeaderEpoch(nextGroup, { allowGroupChange: true, forceEpoch: true });
    },
    updateGroup(nextGroup) {
      // Jakýkoli pokus o změnu konfigurace nejdřív zavře live dispatch.
      gate = { ...gate, armed: false };
      if (nextGroup.id !== group.id) throw new Error('Nelze změnit runtime na jinou copy group');
      assertRuntimeGroup(nextGroup);
      if (nextGroup.leaderAccountId !== group.leaderAccountId) {
        throw new Error('Změna leadera vyžaduje bezpečný reconfigureGroup preflight');
      }
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
        accountEligibility: (() => {
          const now = clock();
          return [...accountEligibility.values()]
            .map(entry => eligibilityAt(entry, now))
            .filter(entry => entry.state !== 'active' || entry.lastExecution != null)
            .map(entry => ({ ...entry, lastExecution: entry.lastExecution ? { ...entry.lastExecution } : undefined }));
        })(),
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
      for (const pending of pendingFollowerTransitions.values()) clearTimeout(pending.timer);
      pendingFollowerTransitions.clear();
      recentFollowerFillCauses.clear();
      for (const entryOrderId of [...pendingOsoResolvers.keys()]) settleOsoFlush(entryOrderId);
      unsubscribe();
    },
  };
}

import {
  isOpenOrderStatus,
  type BrokerEvent,
  type BrokerFill,
  type BrokerOrder,
  type BrokerPort,
  type BrokerAccountRiskSnapshot,
} from './brokerPort';
import { msUntilTradovateSessionEnd } from './copierArmSession';
import { pointValueUsd } from './futuresContractSpecs';
import {
  createCopierState,
  followerQuantity,
  updateFollowerLinkQuantity,
  type CopierAccountEligibility,
  type CopierClosedTrade,
  type CopierDailyStats,
  type CopierDailyRule,
  type CopierRuleWarning,
  type CopierExecutionResolutionKind,
  type CopierRejectedExecution,
  type CopierSeenTerminalReject,
} from './copierEngine';
import { CopierLeaderEventSource } from './copierLeaderEventSource';
import {
  createLeaderFlatEpoch,
  evaluateLeaderFlatBatch,
  invalidateLeaderFlatEpoch,
  isLeaderFlatGuardTokenCurrent,
  mergeLeaderFlatEpochLineage,
  planLeaderPositionTransition,
  type LeaderFlatAccountBatchSnapshot,
  type LeaderFlatEpoch,
  type LeaderFlatExitEvidence,
  type LeaderFlatFollowerOwnership,
  type LeaderFlatGuardToken,
} from './copierLeaderFlatGuard';
import { CopierBracketCorrelator, type LeaderBracketPair } from './copierBracketCorrelator';
import { CopierOsoCorrelator } from './copierOsoCorrelator';
import { stuckCancelEntries, type CancelOutboxEntry } from './copierCancelOutbox';
import { waiveCancelEntry } from './copierCancelOutbox';
import {
  markRejected as markOutboxRejected,
  stuckEntries,
  waiveOutboxEntry,
  type OutboxEntry,
} from './copierOutbox';
import { stuckBracketEntries, waiveBracketOutboxEntry } from './copierBracketOutbox';
import { stuckOsoEntries, waiveOsoOutboxEntry } from './copierOsoOutbox';
import { applyResolved, type LeaderEvent } from './copierEngine';
import { COPIER_LEADER_DAILY_STATS_LABEL } from '../lib/copierDailyStatsLabels';
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
import { COPIER_SEEN_TERMINAL_REJECT_LIMIT, toSnapshot } from './copierStore';
import {
  DEFAULT_COPY_GROUP_SAFETY,
  sanitizeCopyGroupSafety,
  type CopyGroupConfig,
  type CopyGroupSafetySettings,
  type CopierRuleAction,
  type DayLockTrigger,
} from './liveCopyTrading';
import { isWeakerRiskConfig } from '../lib/copierRiskConfig';
import {
  clockMinutes,
  isTradingWindowWarningAt,
  tradingWindowStateAt,
  zonedMinuteOfDay,
} from './copierDailyRules';
import {
  processManualFlatten,
  processTargetedLiquidation,
  type ManualFlattenResult,
} from './copierManualActions';
import { createExposureCappedBroker } from './exposureCappedBroker';
import {
  COPIER_DISARM_HISTORY_LIMIT,
  createCopierDisarmRecord,
  type CopierCopiesOutcome,
  type CopierDisarmRecord,
  type CopierDisarmTrigger,
} from '../lib/copierDisarmReason';

export type CopierStuckOperationKind = 'place' | 'bracket' | 'oso' | 'cancel-or-modify';

const isCriticalAuditEntry = (item: CopierAuditEntry) => (
  item.kind === 'unknown'
  || item.kind === 'abandoned'
  || item.kind === 'rejected'
  || item.kind === 'cancel-failed'
  || item.kind === 'sequence-broken'
  || item.kind === 'blocked'
);

/**
 * Optimistická terminal-fill recovery je bezpečná pouze tehdy, když KAŽDÁ
 * kritická položka stejné dávky znamená tentýž autoritativně terminální modify.
 */
export function criticalAuditAllowsTerminalFillRecovery(
  entries: readonly CopierAuditEntry[],
  cancelOutbox: ReadonlyMap<string, CancelOutboxEntry>,
): boolean {
  const critical = entries.filter(isCriticalAuditEntry);
  return critical.length > 0 && critical.every(item => {
    const lifecycle = item.key ? cancelOutbox.get(item.key) : undefined;
    return item.kind === 'cancel-failed'
      && lifecycle?.operation === 'modify'
      && lifecycle.status === 'abandoned'
      && lifecycle.outcome === 'filled';
  });
}

/**
 * Způsobilost účtu k NOVÝM vstupům. Oddělená od broker connection statusu
 * (ten nese per-účet live tečka v UI) i od poslední execution události.
 * 'disconnected' tu záměrně není — odpojení je vlastnost spojení, ne účtu.
 */
export type { CopierAccountEligibility, CopierAccountEligibilityState } from './copierEngine';

const cloneRejectedExecution = (execution: CopierRejectedExecution): CopierRejectedExecution => ({
  ...execution,
  ...(execution.resolution ? { resolution: { ...execution.resolution } } : {}),
});

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
  /** Poslední read-only OAuth/capability preflight; pouze diagnostika pro UI. */
  oauthPreflight?: {
    missingAccounts: number[];
    inactiveAccounts: number[];
    readOnlyFollowerAccounts: number[];
  };
  /** Neukončená durable epocha, ve které může follower stále vlastnit kopii. */
  unverifiableFollowerOwnership?: Array<{
    accountId: number;
    epochIds: string[];
  }>;
  lastError: string | null;
  /** Poslední odzbrojení v tomto běhu; additivní kvůli starším klientům. */
  lastDisarm?: CopierDisarmRecord;
  /** Ohraničená historie odzbrojení aktuální runtime session. */
  disarmHistory?: CopierDisarmRecord[];
  revision: number;
  lastSequence: number;
  /** Celá skupina je podle lokálně známých pozic flat (vhodný moment pro údržbu). */
  groupFlat?: boolean;
  entryCooldownUntil?: number;
  dayLockUntil?: number;
  dayLockReason?: string | null;
  dayLockTrigger?: DayLockTrigger | null;
  dayLockAt?: number | null;
  dayLockSnoozedRules?: DayLockTrigger[];
  dayUnlock?: { at: number; reason: string } | null;
  /** Běžící pauza pravidla dne (blokuje jen vstupy leadera); null/undefined = žádná. */
  pause?: { until: number; rule: CopierDailyRule; at: number } | null;
  /** První ostrý ARM v aktuální session; > 0 = pravidla i limity jdou jen zpřísnit. */
  sessionArmedAt?: number;
  /** Followeři vyřazení z kopírování do konce session (limit účtu). */
  followerCuts?: CopierFollowerCut[];
  /** Poslední broker risk snapshot per účet (vč. limitu propky). */
  accountRisk?: CopierAccountRiskSnapshot[];
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
    label?: typeof COPIER_LEADER_DAILY_STATS_LABEL;
    sessionEndAt: number;
    realizedPnlUsd: number;
    losingTrades: number;
    tradesToday?: number;
    windowState?: 'inside' | 'outside' | 'off';
    warnedRules?: CopierRuleWarning[];
    unpricedSymbols: string[];
    recentClosedTrades?: CopierClosedTrade[];
  } | null;
}

export interface CopierFollowerCut {
  accountId: number;
  at: number;
  /** Konec broker session, do kdy je účet mimo kopírování. */
  until: number;
  realizedPnlUsd: number;
  cutUsd: number;
  source: 'broker' | 'ledger';
  /** null = kopie nebyla otevřená / `let-run`; číslo = čas zavření; false = zavření selhalo (fail-closed). */
  closed: number | null | false;
}

/**
 * Interní durable provenance side-effectu. Záměrně není součástí
 * veřejného follower-cut/status DTO: odpovídá pouze na otázku, zda
 * konkrétní pending cut vznikl za ostrého ARM, nebo v observe-only shadowu.
 * Starý snapshot bez tohoto důkazu je fail-safe observe-only.
 */
type CopierFollowerCutExecutionProvenance = {
  accountId: number;
  cutAt: number;
  cutUntil: number;
  mode: 'live' | 'observe-only';
  /** Pozice, jejíž copier ownership byl prokázaný ještě před cutem. */
  copiedExposureBySymbol?: Record<string, {
    netQuantity: number;
    ownedSince: number;
  }>;
};

type CopierFollowerRiskLotV1 = {
  netQuantity: number;
  avgPrice: number;
  realizedPnlUsd: number;
};

type CopierFollowerRiskLedgerV1 = {
  /** Broker-session boundary the aggregate belongs to. */
  sessionEndAt: number;
  lots: Record<string, CopierFollowerRiskLotV1>;
  realizedPnlUsd: Record<string, number>;
  /** Bounded replay guard for Tradovate sync fills after a worker restart. */
  seenFillIds: string[];
};

type CopierSafetyWithInternalRiskState = CopierRuntime['state']['safety'] & {
  followerCutExecutionProvenanceV1?: Record<string, CopierFollowerCutExecutionProvenance>;
  followerRiskLedgerV1?: CopierFollowerRiskLedgerV1;
};

const restoredFollowerRiskLedger = (
  safety: CopierRuntime['state']['safety'],
): { ledger: CopierFollowerRiskLedgerV1 | null; invalid: boolean } => {
  const raw = (safety as CopierSafetyWithInternalRiskState).followerRiskLedgerV1;
  if (raw == null) return { ledger: null, invalid: false };
  // A stale aggregate is expected exactly at a session rollover. The normal
  // session reset will replace it with an empty ledger for the new boundary.
  if (raw.sessionEndAt !== safety.dailyStats?.sessionEndAt) {
    return { ledger: null, invalid: false };
  }
  const lots = raw.lots && typeof raw.lots === 'object' ? Object.entries(raw.lots) : [];
  const realized = raw.realizedPnlUsd && typeof raw.realizedPnlUsd === 'object'
    ? Object.entries(raw.realizedPnlUsd)
    : [];
  const valid = Number.isFinite(raw.sessionEndAt)
    && raw.sessionEndAt > 0
    && lots.every(([key, lot]) => (
      /^\d+:.+/.test(key)
      && lot != null
      && Number.isSafeInteger(lot.netQuantity)
      && lot.netQuantity !== 0
      && Number.isFinite(lot.avgPrice)
      && Number.isFinite(lot.realizedPnlUsd)
    ))
    && realized.every(([accountId, pnl]) => (
      Number.isSafeInteger(Number(accountId))
      && Number(accountId) > 0
      && Number.isFinite(pnl)
    ))
    && Array.isArray(raw.seenFillIds)
    && raw.seenFillIds.length <= 1_000
    && raw.seenFillIds.every(fillId => typeof fillId === 'string' && fillId.length > 0);
  if (!valid) return { ledger: null, invalid: true };
  return {
    ledger: {
      sessionEndAt: raw.sessionEndAt,
      lots: Object.fromEntries(lots.map(([key, lot]) => [key, { ...lot }])),
      realizedPnlUsd: Object.fromEntries(realized),
      seenFillIds: [...raw.seenFillIds],
    },
    invalid: false,
  };
};

export interface CopierAccountRiskSnapshot {
  accountId: number;
  /** Čas broker dotazu; snapshot starší než 90 s je „neověřeno". */
  verifiedAt: number;
  realizedPnlUsd: number | null;
  netLiq: number | null;
  minNetLiq: number | null;
  dailyLossAutoLiq: number | null;
  trailingMaxDrawdown: number | null;
  /** dailyLossAutoLiq ?? (netLiq - minNetLiq); null = neznámý. */
  propLimitUsd: number | null;
  error?: string | null;
}

export interface CopierAccountEligibilityExclusion {
  accountId: number;
  state: 'dll-locked' | 'breached';
  reason: string;
}

export interface CopierReconciliationOptions {
  /**
   * Followeři, jejichž nepřítomnost právě potvrdil úplný refresh všech
   * připojených OAuth adresářů. Leader zde nikdy nesmí být.
   */
  missingOptionalAccountIds?: readonly number[];
}

export interface CopierGroupReconfigurationOptions {
  /**
   * Odebíraní followeři, které právě nevrátil žádný připojený OAuth.
   * Účet přítomný v OAuth se touto výjimkou označit nesmí a dál podléhá
   * capability + flat + no-working preflightu.
   */
  missingOptionalAccountIds?: readonly number[];
  /** Explicitní operátorské převzetí odpovědnosti za neověřitelnou kopii. */
  waiveUnverifiableFollowerOwnership?: true;
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
    | 'sl-moved' | 'tp-moved' | 'follower-cut';
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
  accountId?: number;
  cutUsd?: number;
  realizedPnlUsd?: number;
  source?: 'broker' | 'ledger';
  closed?: number | null | false;
}

export interface CopierRuntimeController {
  /**
   * `ttlMs` omezí platnost tohoto ARM (typicky do konce broker session).
   * Bez něj platí výchozí TTL z risk gate. Expirace odzbrojí a podle
   * `safety.armExpiryFlatten` risk-redukčně zavře otevřené kopie.
   */
  arm(options?: { shadowMode?: boolean; ttlMs?: number }): void;
  /** Irreversibly freezes new ARM and durably clears restart-recovery exposure state. */
  beginShutdown(): Promise<void>;
  disarm(): void;
  /** Jednosměrná nouzová západka pro aktuální runtime session. */
  engageKillSwitch(reason?: string): void;
  /** Trvalý lock do zadaného času; restart workeru ho nesmí obejít. */
  lockUntil(until: number, reason: string): Promise<void>;
  /** Legacy protokolová metoda; vždy odmítne (den odemyká jen nová session). */
  unlockDay(reason: string): Promise<void>;
  /**
   * Zpřísní eligibility podle čerstvého LIVE broker snapshotu. Tato cesta
   * umí pouze vyřazovat účty; `active` se obnovuje výhradně reconciliací.
   */
  applyAccountEligibilityExclusions(exclusions: readonly CopierAccountEligibilityExclusion[]): Promise<void>;
  /** Autoritativně porovná pozice a ověří, že nikde nezůstaly working orders. */
  reconcile(options?: CopierReconciliationOptions): Promise<{
    divergentAccounts: number[];
    workingOrderAccounts: number[];
    authoritativelyClean: boolean;
    missingAccounts: number[];
  }>;
  /**
   * Autoritativně ověří jediný účet u brokera bez změny execution skupiny.
   * Je to čistě read-only cesta pro ruční reaktivaci po skončené DLL session.
   */
  verifyAccountEligibility(accountId: number): Promise<CopierAccountEligibility>;
  /**
   * Bezpečně změní leader epochu. Vyžaduje flat + bez working příkazů na
   * všech routovatelných účtech sjednocené staré a nové topologie. Pouze
   * odebíraný follower, jehož absenci právě prokázal úplný OAuth refresh,
   * smí být odpojen bez route; leader i každý člen nové topologie zůstává
   * vždy povinný.
   * Zahodí pouze order-lifecycle stav předchozího leadera a nikdy neposílá
   * brokerový příkaz.
   */
  reconfigureGroup(group: CopyGroupConfig, options?: CopierGroupReconfigurationOptions): Promise<void>;
  /**
   * Bezpečně vybere jinou uloženou skupinu jako jedinou execution skupinu.
   * Vždy založí novou durable epochu a končí DISARMED.
   */
  activateGroup(group: CopyGroupConfig, options?: CopierGroupReconfigurationOptions): Promise<void>;
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
   * Read-only zdroj „followeři právě neviditelní v žádném připojeném OAuth
   * adresáři“ pro automatickou post-connect recovery. Stejný vstup dostává
   * CLI/UI Kontrola pozic; bez něj broker router pro zmizelý (typicky
   * breached) follower vyhodí chybu a recovery skončí fail-closed, i když je
   * jeho vynechání legitimní. Vrácené ID se filtrují na followery skupiny.
   */
  resolveMissingOptionalAccountIds?: (group: CopyGroupConfig) => Promise<readonly number[]>;
  /**
   * Bounded okno pro spárování follower position 0→nonzero s konkrétním
   * broker fill eventem. Po vypršení následuje autoritativní read-only
   * kontrola; nikdy nejde o autorizaci k automatickému zavření nejasné pozice.
   */
  followerTransitionCorrelationWindowMs?: number;
  /** Grace pro normální opožděný follower exit po známém leader open -> flat. */
  leaderFlatGraceMs?: number;
  /** Krátké čekání na projekci Position po potvrzeném exit fillu. */
  leaderFlatExitSettlementGraceMs?: number;
  /** Interval dalšího read-only batch ověření rozpracovaného copier exitu. */
  leaderFlatInflightRetryMs?: number;
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
    if (follower.dailyLossCutUsd != null && (
      !Number.isFinite(follower.dailyLossCutUsd)
      || follower.dailyLossCutUsd < 0
      || (follower.dailyLossCutUsd > 0 && follower.dailyLossCutUsd < 0.01)
      || follower.dailyLossCutUsd > 1_000_000
      || Number(follower.dailyLossCutUsd.toFixed(2)) !== follower.dailyLossCutUsd
    )) {
      throw new Error('Follower dailyLossCutUsd musí být 0 nebo 0,01 až 1 000 000 USD (nejvýš 2 desetinná místa)');
    }
    if (follower.onCut != null && follower.onCut !== 'close-copy' && follower.onCut !== 'let-run') {
      throw new Error('Follower onCut musí být close-copy nebo let-run');
    }
  }
  if (!sanitizeCopyGroupSafety(group.safety)) {
    throw new Error('Copy group obsahuje neplatná pravidla dne');
  }
}

const normalizedRuntimeGroup = (group: CopyGroupConfig): CopyGroupConfig => {
  assertRuntimeGroup(group);
  const safety = sanitizeCopyGroupSafety(group.safety);
  if (!safety) throw new Error('Copy group obsahuje neplatná pravidla dne');
  return { ...group, safety };
};

/**
 * Bezpečný bootstrap jednoho copy group runtime.
 *
 * Pořadí je záměrné: load durable snapshot -> recover unknown side effects ->
 * teprve potom subscribe. Controller vždy startuje DISARMED + shadow.
 */
export async function bootstrapCopierRuntime(options: BootstrapCopierOptions): Promise<CopierRuntimeController> {
  assertRuntimeGroup(options.group);
  const clock = options.clock ?? Date.now;
  let group = normalizedRuntimeGroup(options.group);
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
  let sessionArmedAt = runtime.state.safety.sessionArmedAt ?? 0;
  // Durable záznamy prošly vlastním zápisem, ale při načtení se validují
  // stejně přísně jako provenance níže: poškozený cut/snapshot se zahodí,
  // nikdy se nevydává za platný.
  const followerCuts = new Map<number, CopierFollowerCut>(
    Object.values(runtime.state.safety.followerCuts ?? {}).flatMap(cut => {
      if (!cut
        || !Number.isSafeInteger(cut.accountId) || cut.accountId <= 0
        || !Number.isFinite(cut.at) || !Number.isFinite(cut.until) || cut.until < cut.at
        || !Number.isFinite(cut.realizedPnlUsd)
        || !Number.isFinite(cut.cutUsd) || cut.cutUsd <= 0
        || (cut.source !== 'broker' && cut.source !== 'ledger')
        || !(cut.closed === null || cut.closed === false || (Number.isFinite(cut.closed) && cut.closed > 0))
      ) return [];
      return [[cut.accountId, { ...cut }] as const];
    }),
  );
  const followerCutExecutionProvenance = new Map<number, CopierFollowerCutExecutionProvenance>(
    Object.values(
      (runtime.state.safety as CopierSafetyWithInternalRiskState)
        .followerCutExecutionProvenanceV1 ?? {},
    ).flatMap(provenance => {
      const rawExposure = provenance?.copiedExposureBySymbol;
      const exposureEntries = rawExposure == null ? [] : Object.entries(rawExposure);
      const exposureValid = exposureEntries.every(([symbol, exposure]) => (
        symbol.trim().length > 0
        && Number.isSafeInteger(exposure?.netQuantity)
        && exposure.netQuantity !== 0
        && Number.isFinite(exposure.ownedSince)
        && exposure.ownedSince > 0
      ));
      if (
        !provenance
        || !Number.isSafeInteger(provenance.accountId)
        || provenance.accountId <= 0
        || !Number.isFinite(provenance.cutAt)
        || !Number.isFinite(provenance.cutUntil)
        || (provenance.mode !== 'live' && provenance.mode !== 'observe-only')
        || !exposureValid
      ) return [];
      return [[provenance.accountId, {
        ...provenance,
        ...(rawExposure ? {
          copiedExposureBySymbol: Object.fromEntries(
            exposureEntries.map(([symbol, exposure]) => [symbol, { ...exposure }]),
          ),
        } : {}),
      }] as const];
    }),
  );
  const finiteOrNullField = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
  );
  const accountRisk = new Map<number, CopierAccountRiskSnapshot>(
    Object.values(runtime.state.safety.accountRisk ?? {}).flatMap(snapshot => {
      if (!snapshot
        || !Number.isSafeInteger(snapshot.accountId) || snapshot.accountId <= 0
        || !Number.isFinite(snapshot.verifiedAt) || snapshot.verifiedAt <= 0
      ) return [];
      return [[snapshot.accountId, {
        accountId: snapshot.accountId,
        verifiedAt: snapshot.verifiedAt,
        realizedPnlUsd: finiteOrNullField(snapshot.realizedPnlUsd),
        netLiq: finiteOrNullField(snapshot.netLiq),
        minNetLiq: finiteOrNullField(snapshot.minNetLiq),
        dailyLossAutoLiq: finiteOrNullField(snapshot.dailyLossAutoLiq),
        trailingMaxDrawdown: finiteOrNullField(snapshot.trailingMaxDrawdown),
        propLimitUsd: finiteOrNullField(snapshot.propLimitUsd),
        ...(typeof snapshot.error === 'string' ? { error: snapshot.error } : {}),
      }] as const];
    }),
  );
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
      ...(entry.lastExecution ? { lastExecution: cloneRejectedExecution(entry.lastExecution) } : {}),
    }]),
  );
  let persistEligibility = async (): Promise<void> => undefined;
  const DLL_REASON_PATTERN = /daily\s*loss|loss\s*limit|\bdll\b/i;
  const BREACH_REASON_PATTERN = /breach|trailing\s*(max\s*)?drawdown|account\s*(disabled|locked|suspended)/i;
  const setEligibilityIn = (
    entries: Map<number, CopierAccountEligibility>,
    accountId: number,
    next: CopierAccountEligibility,
  ) => {
    // Breach je trvalý a nesmí ho přepsat slabší klasifikace téhož streamu;
    // odemyká ho jedině autoritativní reaktivace v reconciliaci.
    const current = entries.get(accountId);
    if (current?.state === 'breached' && next.state !== 'breached' && next.state !== 'active') return;
    entries.set(accountId, next);
  };
  const setEligibility = (accountId: number, next: CopierAccountEligibility) =>
    setEligibilityIn(accountEligibility, accountId, next);
  const terminalRejectKey = (accountId: number, brokerOrderId: string) =>
    `${accountId}:${brokerOrderId}`;
  const hasSeenTerminalReject = (
    safety: CopierRuntime['state']['safety'],
    accountId: number,
    brokerOrderId: string,
  ) => (
    safety.seenTerminalRejects?.some(entry => (
      entry.accountId === accountId && entry.brokerOrderId === brokerOrderId
    )) === true
    // Kompatibilita se snapshotem před durable ledgerem: alespoň poslední
    // už zapsaný reject nesmí po upgradu při prvním syncrequestu ožít znovu.
    || safety.accountEligibility?.some(entry => (
      entry.accountId === accountId && entry.lastExecution?.brokerOrderId === brokerOrderId
    )) === true
  );
  const recordAccountRejection = async (order: BrokerOrder, receivedAt: number) => {
    const reason = order.rejectReason?.trim() || 'broker odmítl příkaz';
    const at = Number.isFinite(order.updatedAt) && order.updatedAt > 0
      ? order.updatedAt
      : receivedAt;
    const lastExecution = {
      kind: 'rejected' as const,
      reason,
      symbol: order.symbol,
      brokerOrderId: order.brokerOrderId,
      orderType: order.orderType,
      side: order.side,
      ...(order.limitPrice != null ? { limitPrice: order.limitPrice } : {}),
      ...(order.stopPrice != null ? { stopPrice: order.stopPrice } : {}),
      at,
    };
    let result: {
      processed: boolean;
      acknowledged?: OutboxEntry;
      auditReason: string;
    } = { processed: false, auditReason: reason };

    await processor.mutate(async currentRuntimeValue => {
      if (hasSeenTerminalReject(
        currentRuntimeValue.state.safety,
        order.accountId,
        order.brokerOrderId,
      )) return currentRuntimeValue;

      const nextEligibility = new Map(accountEligibility);
      const current = nextEligibility.get(order.accountId);
      // `updatedAt` je brokerový čas terminální entity. Historický reject s
      // jiným ID se stále zpracuje pro safety/outbox, ale nesmí přepsat novější
      // kartu `lastExecution` jen proto, že dorazil při pozdějším syncrequestu.
      const effectiveLastExecution = current?.lastExecution && current.lastExecution.at >= at
        ? cloneRejectedExecution(current.lastExecution)
        : lastExecution;
      const eligibilityAt = Math.max(current?.at ?? 0, at);
      if (BREACH_REASON_PATTERN.test(reason)) {
        setEligibilityIn(nextEligibility, order.accountId, {
          accountId: order.accountId,
          state: 'breached',
          reason,
          at: eligibilityAt,
          lastExecution: effectiveLastExecution,
        });
      } else if (DLL_REASON_PATTERN.test(reason)) {
        setEligibilityIn(nextEligibility, order.accountId, {
          accountId: order.accountId,
          state: 'dll-locked',
          reason,
          at: eligibilityAt,
          lastExecution: effectiveLastExecution,
          // Hranice obchodní session v době locku: po jejím přejetí se stav
          // NEuvolní časem, jen přejde do 'unverifiable' a čeká na ověření.
          // Bez denních statistik se hranice odvodí ze session kalendáře.
          lockSessionEndAt: currentRuntimeValue.state.safety.dailyStats?.sessionEndAt
            ?? (at + msUntilTradovateSessionEnd(at)),
        });
      } else {
        // Neurčitý reject: jen execution událost, eligibility se nemění.
        setEligibilityIn(nextEligibility, order.accountId, {
          accountId: order.accountId,
          state: current?.state ?? 'active',
          reason: current?.reason,
          at: current?.at ?? at,
          lockSessionEndAt: current?.lockSessionEndAt,
          lastExecution: effectiveLastExecution,
        });
      }

      const classified = nextEligibility.get(order.accountId)?.state;
      const explained = classified === 'dll-locked' || classified === 'breached';
      const acknowledged = [...currentRuntimeValue.outbox.values()].find(entry =>
        entry.brokerOrderId === order.brokerOrderId && entry.status === 'acknowledged');
      const outbox = new Map(currentRuntimeValue.outbox);
      const auditReason = order.rejectReason?.trim() || 'broker odmítl příkaz (async reject)';
      if (acknowledged) {
        const entry = outbox.get(acknowledged.key);
        if (entry?.status === 'acknowledged') {
          outbox.set(entry.key, explained
            ? waiveOutboxEntry(
                markOutboxRejected(entry, auditReason, receivedAt),
                `${auditReason} — účet vyřazen z nových vstupů (${classified})`,
                receivedAt,
              )
            : markOutboxRejected(entry, auditReason, receivedAt));
        }
      }

      const receipt: CopierSeenTerminalReject = {
        accountId: order.accountId,
        brokerOrderId: order.brokerOrderId,
        at,
      };
      const receiptKey = terminalRejectKey(receipt.accountId, receipt.brokerOrderId);
      const seenTerminalRejects = [
        ...(currentRuntimeValue.state.safety.seenTerminalRejects ?? [])
          .filter(entry => terminalRejectKey(entry.accountId, entry.brokerOrderId) !== receiptKey),
        receipt,
      ].slice(-COPIER_SEEN_TERMINAL_REJECT_LIMIT);
      const safety = {
        ...currentRuntimeValue.state.safety,
        accountEligibility: [...nextEligibility.values()].map(entry => ({
          ...entry,
          ...(entry.lastExecution
            ? { lastExecution: cloneRejectedExecution(entry.lastExecution) }
            : {}),
        })),
        seenTerminalRejects,
      };
      const state = { ...currentRuntimeValue.state, safety };
      const committed = await options.store.commit(
        toSnapshot(
          state,
          outbox.values(),
          currentRuntimeValue.cancelOutbox.values(),
          currentRuntimeValue.revision,
          currentRuntimeValue.bracketOutbox.values(),
          currentRuntimeValue.osoOutbox.values(),
        ),
        currentRuntimeValue.revision,
      );
      accountEligibility.clear();
      for (const [accountId, entry] of nextEligibility) accountEligibility.set(accountId, entry);
      result = { processed: true, acknowledged, auditReason };
      return {
        ...currentRuntimeValue,
        state,
        outbox,
        revision: committed.revision,
      };
    });
    return result;
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
  const currentIneligibleAccounts = (now = clock()): ReadonlyMap<number, string> => {
    const ineligible = new Map<number, string>();
    for (const [accountId, stored] of accountEligibility) {
      const entry = eligibilityAt(stored, now);
      if (entry.state !== 'active') {
        ineligible.set(accountId, `${entry.state}: ${entry.reason ?? 'bez důvodu'}`);
      }
    }
    return ineligible;
  };
  const activeFollowerCut = (accountId: number, at = clock()): CopierFollowerCut | undefined => {
    const cut = followerCuts.get(accountId);
    return cut && cut.until > at ? cut : undefined;
  };
  const currentEntryIneligibleAccounts = (now = clock()): ReadonlyMap<number, string> => {
    const ineligible = new Map(currentIneligibleAccounts(now));
    for (const follower of group.followers) {
      const cut = activeFollowerCut(follower.accountId, now);
      if (cut) ineligible.set(follower.accountId, `follower-cut:${cut.source}:${cut.until}`);
    }
    return ineligible;
  };
  const currentExitIneligibleAccounts = (now = clock()): ReadonlyMap<number, string> => {
    const ineligible = new Map(currentIneligibleAccounts(now));
    for (const follower of group.followers) {
      const cut = activeFollowerCut(follower.accountId, now);
      if (cut && (follower.onCut ?? 'close-copy') === 'close-copy' && cut.closed !== false) {
        // `close-copy` už vlastní vlastní liquidation lifecycle. Jakýkoli
        // pozdější leader exit/protective příkaz by po úspěšném flat
        // mohl na tomto followerovi otevřít opačnou pozici. `let-run` se
        // naopak záměrně nevyřazuje, aby jeho existující kopie směla dojet.
        // Po SELHANÉM zavření (closed=false) kopie stále žije, proto se
        // chová jako let-run: exity leadera ji smějí zavřít.
        ineligible.set(follower.accountId, `follower-cut-close-copy:${cut.source}:${cut.until}`);
      }
    }
    return ineligible;
  };
  const currentBracketIneligibleAccounts = (entryOrderId: string): ReadonlyMap<number, string> => {
    const ineligible = new Map(currentExitIneligibleAccounts());
    const linkedAccounts = new Set(
      (currentRuntime().state.links.get(entryOrderId) ?? []).map(link => link.accountId),
    );
    for (const follower of group.followers) {
      if (follower.mode === 'on-submit' && !linkedAccounts.has(follower.accountId)) {
        ineligible.set(follower.accountId, `bracket-entry-not-copied:${entryOrderId}`);
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
  /**
   * Krátká reportingová stopa uzavíracího fillu. Tradovate může dodat
   * fill dřív než order event, ze kterého korelátor teprve pozná SL/TP.
   */
  const recentLeaderExitFills = new Map<string, {
    tradeId: string;
    symbol: string;
    observedAt: number;
  }>();
  const PROTECTIVE_EXIT_ATTRIBUTION_WINDOW_MS = 2_000;

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

  const reclassifyRecentProtectiveExit = async (
    brokerOrderId: string,
    exitReason: 'sl' | 'tp',
    now: number,
  ): Promise<void> => {
    const candidate = recentLeaderExitFills.get(brokerOrderId);
    if (!candidate || now - candidate.observedAt > PROTECTIVE_EXIT_ATTRIBUTION_WINDOW_MS) return;

    const stats = currentRuntime().state.safety.dailyStats;
    const closedTrade = stats?.recentClosedTrades?.find(trade => trade.id === candidate.tradeId);
    if (stats && closedTrade?.exitReason === 'manual') {
      await persistSafety({
        ...currentRuntime().state.safety,
        dailyStats: {
          ...stats,
          openLots: stats.openLots.map(lot => ({ ...lot })),
          recentClosedTrades: (stats.recentClosedTrades ?? []).map(trade =>
            trade.id === candidate.tradeId ? { ...trade, exitReason } : { ...trade }),
          unpricedSymbols: [...stats.unpricedSymbols],
        },
      });
    }

    // Position=0 can also precede the late protective order event. Correct
    // only the matching fresh reporting event; execution state is untouched.
    for (let index = recentCopyEvents.length - 1; index >= 0; index -= 1) {
      const event = recentCopyEvents[index];
      if (event.at < candidate.observedAt) break;
      if ((event.kind === 'exit' || event.kind === 'flip')
        && event.symbol === candidate.symbol
        && event.exitReason === 'manual') {
        recentCopyEvents[index] = { ...event, exitReason };
        break;
      }
    }
    recentLeaderExitFills.delete(brokerOrderId);
  };

  const rememberProtectiveLeg = async (
    stopOrderId: string,
    targetOrderId: string,
    now: number,
  ): Promise<void> => {
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
    await reclassifyRecentProtectiveExit(stopOrderId, 'sl', now);
    await reclassifyRecentProtectiveExit(targetOrderId, 'tp', now);
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
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | null = null;
  let positionCheckComplete = false;
  let workingOrderAccounts = new Set<number>();
  let lastError: Error | null = null;
  let lastDisarm: CopierDisarmRecord | undefined;
  const disarmHistory: CopierDisarmRecord[] = [];
  let lastOauthPreflight: NonNullable<CopierControllerStatus['oauthPreflight']> | undefined;
  /**
   * Monotónní verze bezpečnostního stavu. Reconciliation si ji zapamatuje
   * před broker I/O a čistý výsledek smí potvrdit pouze tehdy, když během
   * čtení nevznikl novější incident, reconnect ani jiná invalidace.
   */
  let safetyGeneration = 0;
  let eventTail: Promise<void> = Promise.resolve();
  let accountRiskPollTail: Promise<void> = Promise.resolve();
  const accountRiskLastRequestedAt = new Map<number, number>();
  const ACCOUNT_RISK_POLL_MS = 30_000;
  /** VYPNUTO/shadow: limity propek a PnL účtů chceme vidět vždy, jen pomaleji. */
  const ACCOUNT_RISK_IDLE_POLL_MS = 60_000;
  const ACCOUNT_RISK_STALE_MS = 90_000;
  const ACCOUNT_RISK_REQUEST_TIMEOUT_MS = 10_000;
  const restoredRiskLedger = restoredFollowerRiskLedger(runtime.state.safety);
  if (restoredRiskLedger.invalid) {
    throw new Error('Durable follower risk ledger je neplatný; worker zůstává fail-closed');
  }
  const followerRiskLots = new Map<string, CopierFollowerRiskLotV1>(
    Object.entries(restoredRiskLedger.ledger?.lots ?? {}).map(([key, lot]) => [key, { ...lot }]),
  );
  const followerRealizedPnlUsd = new Map<number, number>(
    Object.entries(restoredRiskLedger.ledger?.realizedPnlUsd ?? {})
      .map(([accountId, pnl]) => [Number(accountId), pnl]),
  );
  const seenFollowerRiskFillIds = new Set(restoredRiskLedger.ledger?.seenFillIds ?? []);
  let reconciliationTail: Promise<void> = Promise.resolve();
  let reconciliationRequestsPending = 0;
  const admittedLeaderOrders = new Set<string>();
  const admittedFlatExitOrders = new Set<string>();
  const knownLeaderReducingOrderIds = new Set<string>();
  const leaderReducingRemainingByOrder = new Map<string, number>();
  const leaderOrderIntents = new Map<string, Pick<LeaderEvent, 'symbol' | 'side' | 'quantity'>>();
  const leaderExposureIncreaseByEventId = new Map<string, boolean>();
  const leaderPreFillNetByEventId = new Map<string, number>();
  const leaderReducingQuantityByEventId = new Map<string, number>();
  /**
   * Pouze ACKnuté objednávky odeslané tímto konkrétním procesem.
   * Mapa se nikdy nehydratuje z durable outboxu a při disconnectu se maže:
   * starý/historický request proto nemůže vysvětlit novou divergenci.
   */
  interface CurrentRuntimePendingExposure {
    key: string;
    accountId: number;
    symbol: string;
    side: 'Buy' | 'Sell';
    quantity: number;
    orderReportedFilled: number;
    fillReportedQuantity: number;
  }
  const currentRuntimePendingExposure = new Map<string, CurrentRuntimePendingExposure>();
  const seenCurrentRuntimePendingFillIds = new Set<string>();
  /**
   * Lokální lineage záměrně vynechaných vstupů. Umožní pozdějšímu leader
   * exitu pouze zmenšit skutečně drženou follower pozici, nikdy ji otočit.
   * Po restartu se záměr neodhaduje: runtime startuje DISARMED a mismatch
   * musí projít novou autoritativní reconciliation.
   */
  const intentionalEntrySuppressions = new Map<string, {
    allowedNet: number;
    createdAt: number;
    leaderOrderId: string;
  }>();
  const exitOnlyReservations = new Map<string, {
    accountId: number;
    symbol: string;
    remaining: number;
    /** OCO/OSO sourozenci sdílejí kapacitu: vyplnit se smí jen jeden. */
    groupKey: string;
  }>();
  const exitOnlyPositionApplied = new Set<string>();
  /**
   * Fill exit-only nohy smí dorazit před Position=flat. Fill už aktualizuje
   * lokální cache, takže následný Position event by bez této stopy vypadal
   * jako 0 -> 0 a přeskočil povinný ochranný sweep.
   */
  const exitOnlyFlatFillAwaitingPosition = new Set<string>();
  const leaderPositions = new Map<string, number>();
  const positionsByAccount = new Map<number, Map<string, number>>();
  let cooldownPending = false;
  /** Čekající auto day-lock; zamyká se výhradně existující cestou po flat. */
  let dayLockPending: { trigger: DayLockTrigger; reason: string; until?: number } | null = null;
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
  let connectionRecoveryMissingOwnership: Array<{
    accountId: number;
    epochId: string;
  }> = [];
  let bootRecoveryChecked = false;
  let lastResumeOffer: { at: number } | null = null;
  const pendingBracketTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingOsoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingOsoEvents = new Map<string, LeaderEvent>();
  const blockedOsoEntries = new Set<string>();
  /**
   * Účty, které z mixed reversal OSO dostaly pouze zavírací standalone
   * slice. Pozdější SL/TP pár pro novou opačnou leader pozici na ně nesmí
   * být poslán, ani když mezitím globální pauza vyprší.
   */
  const osoOpeningExcludedAccounts = new Map<string, Set<number>>();
  const blockedLeaderEntryOrderIds = new Set<string>();
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
  const pendingFollowerMagnitudeChecks = new Map<string, ReturnType<typeof setTimeout>>();
  const leaderFlatGuardTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const followerTransitionCorrelationWindowMs = options.followerTransitionCorrelationWindowMs ?? 2_000;
  const leaderFlatGraceMs = options.leaderFlatGraceMs ?? 2_000;
  const leaderFlatExitSettlementGraceMs = options.leaderFlatExitSettlementGraceMs ?? 1_500;
  const leaderFlatInflightRetryMs = options.leaderFlatInflightRetryMs ?? 1_000;

  if (!Number.isFinite(followerTransitionCorrelationWindowMs) || followerTransitionCorrelationWindowMs < 1) {
    throw new Error('followerTransitionCorrelationWindowMs musí být kladné číslo');
  }
  for (const [label, value] of [
    ['leaderFlatGraceMs', leaderFlatGraceMs],
    ['leaderFlatExitSettlementGraceMs', leaderFlatExitSettlementGraceMs],
    ['leaderFlatInflightRetryMs', leaderFlatInflightRetryMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} musí být nezáporné číslo`);
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

  const persistSafetyUpdate = async (
    update: (current: CopierRuntime['state']['safety']) => CopierRuntime['state']['safety'],
  ) => {
    await processor.mutate(async current => {
      const safety = update(current.state.safety);
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
  const persistSafety = async (safety: CopierRuntime['state']['safety']) => (
    persistSafetyUpdate(() => safety)
  );

  const serializedFollowerCuts = (): NonNullable<CopierRuntime['state']['safety']['followerCuts']> =>
    Object.fromEntries([...followerCuts].map(([accountId, cut]) => [String(accountId), { ...cut }]));
  const serializedFollowerCutExecutionProvenance = () => Object.fromEntries(
    [...followerCutExecutionProvenance]
      .map(([accountId, provenance]) => [String(accountId), {
        ...provenance,
        ...(provenance.copiedExposureBySymbol ? {
          copiedExposureBySymbol: Object.fromEntries(
            Object.entries(provenance.copiedExposureBySymbol)
              .map(([symbol, exposure]) => [symbol, { ...exposure }]),
          ),
        } : {}),
      }]),
  );
  const serializedAccountRisk = (): NonNullable<CopierRuntime['state']['safety']['accountRisk']> =>
    Object.fromEntries([...accountRisk].map(([accountId, snapshot]) => [String(accountId), { ...snapshot }]));
  const serializedFollowerRiskLedger = (sessionEndAt: number): CopierFollowerRiskLedgerV1 => ({
    sessionEndAt,
    lots: Object.fromEntries([...followerRiskLots].map(([key, lot]) => [key, { ...lot }])),
    realizedPnlUsd: Object.fromEntries(
      [...followerRealizedPnlUsd].map(([accountId, pnl]) => [String(accountId), pnl]),
    ),
    seenFillIds: [...seenFollowerRiskFillIds],
  });
  const persistRiskSafety = async (): Promise<void> => {
    const sessionEndAt = currentRuntime().state.safety.dailyStats?.sessionEndAt;
    if (sessionEndAt == null || !Number.isFinite(sessionEndAt) || sessionEndAt <= 0) {
      throw new Error('Follower risk ledger nelze uložit bez platné broker session');
    }
    await persistSafetyUpdate(current => ({
      ...current,
      sessionArmedAt,
      followerCuts: serializedFollowerCuts(),
      followerCutExecutionProvenanceV1: serializedFollowerCutExecutionProvenance(),
      followerRiskLedgerV1: serializedFollowerRiskLedger(sessionEndAt),
      accountRisk: serializedAccountRisk(),
    }));
  };
  let locallyRolledRiskSessionEndAt = 0;
  const rollRiskSessionMemoryIfExpired = (at: number): boolean => {
    const storedSessionEnd = currentRuntime().state.safety.dailyStats?.sessionEndAt ?? 0;
    if (storedSessionEnd <= 0 || at < storedSessionEnd
      || locallyRolledRiskSessionEndAt === storedSessionEnd) return false;
    locallyRolledRiskSessionEndAt = storedSessionEnd;
    sessionArmedAt = 0;
    followerCuts.clear();
    followerCutExecutionProvenance.clear();
    followerRiskLots.clear();
    followerRealizedPnlUsd.clear();
    seenFollowerRiskFillIds.clear();
    accountRiskLastRequestedAt.clear();
    intentionalEntrySuppressions.clear();
    exitOnlyReservations.clear();
    exitOnlyPositionApplied.clear();
    exitOnlyFlatFillAwaitingPosition.clear();
    leaderReducingRemainingByOrder.clear();
    leaderReducingQuantityByEventId.clear();
    appliedRuleActionSignatures.clear();
    appliedRuleActionSignaturesInitialized = false;
    return true;
  };
  const assertCutsWithinKnownPropLimits = (candidate: CopyGroupConfig): void => {
    for (const follower of candidate.followers) {
      const cutUsd = follower.dailyLossCutUsd ?? 0;
      if (cutUsd <= 0) continue;
      const propLimitUsd = accountRisk.get(follower.accountId)?.propLimitUsd;
      if (propLimitUsd == null || !Number.isFinite(propLimitUsd)) continue;
      const maximum = propLimitUsd * 0.95;
      if (cutUsd > maximum) {
        throw new Error(
          `Follower ${follower.accountId}: denní cut ${cutUsd} USD musí být nejvýše 95 % prop limitu (${maximum.toFixed(2)} USD)`,
        );
      }
    }
  };
  const assertTightenOnly = (candidate: CopyGroupConfig): void => {
    rollRiskSessionMemoryIfExpired(clock());
    if (!(sessionArmedAt > 0)) return;
    const weaker = isWeakerRiskConfig(group, candidate);
    if (weaker.length > 0) {
      throw new Error(`Pravidla jdou dnes jen zpřísnit: ${weaker.join(', ')} (reset po konci session)`);
    }
  };

  persistEligibility = async () => {
    await persistSafetyUpdate(current => ({
      ...current,
      accountEligibility: [...accountEligibility.values()].map(entry => ({
        ...entry,
        ...(entry.lastExecution ? { lastExecution: cloneRejectedExecution(entry.lastExecution) } : {}),
      })),
    }));
  };

  /**
   * Additivní reporting nad už autoritativně potvrzeným flat stavem. Selhání
   * jeho persistence nesmí změnit výsledek guardu, reconciliation ani close.
   */
  const resolveRejectedExecutions = async ({
    accountIds,
    kind,
    at,
    symbol,
    detail,
  }: {
    accountIds: readonly number[];
    kind: Exclude<CopierExecutionResolutionKind, 'unresolved'>;
    at: number;
    symbol?: string;
    detail?: string;
  }): Promise<void> => {
    const previous = new Map<number, CopierAccountEligibility>();
    for (const accountId of accountIds) {
      const current = accountEligibility.get(accountId);
      const execution = current?.lastExecution;
      if (!current || !execution) continue;
      if (symbol != null && execution.symbol !== symbol) continue;
      if (execution.resolution && execution.resolution.kind !== 'unresolved') continue;
      previous.set(accountId, current);
      accountEligibility.set(accountId, {
        ...current,
        lastExecution: {
          ...execution,
          resolution: { kind, at, ...(detail ? { detail } : {}) },
        },
      });
    }
    if (previous.size === 0) return;
    try {
      await persistEligibility();
    } catch {
      for (const [accountId, entry] of previous) accountEligibility.set(accountId, entry);
    }
  };

  const leaderExposureEpoch = (symbol: string): LeaderFlatEpoch | null =>
    currentRuntime().state.safety.leaderExposureEpochs?.find(epoch => (
      epoch.groupId === group.id
      && epoch.leaderAccountId === group.leaderAccountId
      && epoch.symbol === symbol
    )) ?? null;

  const unfinishedLeaderFlatPhase = (phase: LeaderFlatEpoch['phase']) => (
    phase === 'open'
    || phase === 'grace'
    || phase === 'waiting-inflight'
    || phase === 'closing'
    || phase === 'blocked'
  );

  // Guard ukládá jen `confirmed | unproven`, nikoli `none`. Pozitivní
  // lineage je tedy `confirmed`; `eligibleAtOpen:false + unproven` je známý
  // neparticipant, který při otevření kopii dostat nemohl.
  const isLeaderFlatLineageParticipant = (follower: LeaderFlatFollowerOwnership) => (
    follower.eligibleAtOpen === true || follower.copyLineage === 'confirmed'
  );

  const unverifiableFollowerOwnership = (
    accountIds?: ReadonlySet<number>,
  ): Array<{ accountId: number; epochId: string }> => {
    const result: Array<{ accountId: number; epochId: string }> = [];
    for (const epoch of currentRuntime().state.safety.leaderExposureEpochs ?? []) {
      if (
        epoch.groupId !== group.id
        || epoch.leaderAccountId !== group.leaderAccountId
        || !unfinishedLeaderFlatPhase(epoch.phase)
      ) continue;
      for (const follower of epoch.followers) {
        if (
          isLeaderFlatLineageParticipant(follower)
          && (accountIds == null || accountIds.has(follower.accountId))
        ) result.push({ accountId: follower.accountId, epochId: epoch.id });
      }
    }
    return result.sort((left, right) => (
      left.accountId - right.accountId || left.epochId.localeCompare(right.epochId)
    ));
  };

  const persistLeaderExposureEpoch = async (epoch: LeaderFlatEpoch) => {
    const safety = currentRuntime().state.safety;
    const others = (safety.leaderExposureEpochs ?? []).filter(item => !(
      item.groupId === epoch.groupId
      && item.leaderAccountId === epoch.leaderAccountId
      && item.symbol === epoch.symbol
    ));
    await persistSafety({
      ...safety,
      leaderExposureEpochs: [...others, epoch].slice(-20),
    });
  };

  const copiedEntryLineage = (
    accountId: number,
    symbol: string,
    netQuantity: number,
  ): boolean => {
    if (netQuantity === 0) return false;
    const cause = recentFollowerFillCauses.get(`${accountId}:${symbol}`);
    if (
      !cause
      || cause.role !== 'copied-entry'
      || cause.sign !== Math.sign(netQuantity)
      || clock() - cause.observedAt > followerTransitionCorrelationWindowMs
    ) return false;
    const live = currentRuntime();
    const links = [...live.state.links.values()].flat().filter(link => link.accountId === accountId);
    if (!links.some(link => link.brokerOrderId === cause.brokerOrderId)) return false;
    const standard = [...live.outbox.values()].some(entry => (
      entry.status === 'acknowledged'
      && entry.operationKind !== 'liquidate-position'
      && entry.request.accountId === accountId
      && entry.request.symbol === symbol
      && entry.brokerOrderId === cause.brokerOrderId
    ));
    if (standard) return true;
    return [...live.osoOutbox.values()].some(entry => (
      entry.status === 'acknowledged'
      && entry.request.accountId === accountId
      && entry.request.symbol === symbol
      && entry.entryBrokerOrderId === cause.brokerOrderId
    ));
  };

  const leaderFlatFollowersAt = (symbol: string, leaderNet: number): LeaderFlatFollowerOwnership[] =>
    group.followers.map(follower => {
      const eligibleAtOpen = follower.mode !== 'off'
        && !currentIneligibleAccounts().has(follower.accountId)
        && !activeFollowerCut(follower.accountId);
      const followerNet = positionsByAccount.get(follower.accountId)?.get(symbol);
      const expectedNet = Math.trunc(leaderNet * follower.multiplier);
      const exactManagedNet = followerNet != null
        && followerNet !== 0
        && followerNet === expectedNet
        && copiedEntryLineage(follower.accountId, symbol, followerNet);
      return {
        accountId: follower.accountId,
        replicationModeAtOpen: follower.mode,
        eligibleAtOpen,
        copyLineage: exactManagedNet ? 'confirmed' : 'unproven',
        ...(exactManagedNet ? { confirmedNetQuantity: followerNet } : {}),
      };
    });

  const strengthenLeaderFlatLineage = async (
    accountId: number,
    symbol: string,
    netQuantity: number,
  ) => {
    const epoch = leaderExposureEpoch(symbol);
    if (!epoch || epoch.phase !== 'open' || netQuantity === 0) return;
    const follower = group.followers.find(item => item.accountId === accountId);
    if (!follower || follower.mode === 'off') return;
    const leaderNet = leaderPositions.get(symbol);
    if (leaderNet == null || leaderNet === 0) return;
    const expectedNet = Math.trunc(leaderNet * follower.multiplier);
    if (
      netQuantity !== expectedNet
      || !copiedEntryLineage(accountId, symbol, netQuantity)
    ) return;
    const participant = epoch.followers.find(item => item.accountId === accountId);
    if (!participant || !participant.eligibleAtOpen) return;
    if (
      participant.copyLineage === 'confirmed'
      && participant.confirmedNetQuantity === netQuantity
    ) return;
    await persistLeaderExposureEpoch(mergeLeaderFlatEpochLineage(epoch, {
      followers: [{
        ...participant,
        copyLineage: 'confirmed',
        confirmedNetQuantity: netQuantity,
      }],
    }));
  };

  const scheduleLeaderFlatEpochVerification = (
    epoch: LeaderFlatEpoch,
    token: LeaderFlatGuardToken,
    expectedSafetyGeneration = safetyGeneration,
  ) => {
    const existing = leaderFlatGuardTimers.get(epoch.id);
    if (existing) clearTimeout(existing);
    const scheduledAt = clock();
    const delay = Math.max(0, (epoch.graceUntil ?? scheduledAt) - scheduledAt);
    const timer = setTimeout(() => {
      leaderFlatGuardTimers.delete(epoch.id);
      eventTail = eventTail
        .then(() => verifyLeaderFlatEpoch(token, expectedSafetyGeneration))
        .catch(reason => failClosed(reason, { autoClose: false }));
    }, delay);
    leaderFlatGuardTimers.set(epoch.id, timer);
  };

  const groupIsFlat = () => [group.leaderAccountId, ...group.followers.map(item => item.accountId)]
    .filter((accountId): accountId is number => accountId != null)
    .every(accountId => [...(positionsByAccount.get(accountId)?.values() ?? [])]
      .every(quantity => quantity === 0));

  const hasFollowerExposure = () => group.followers.some(follower =>
    [...(positionsByAccount.get(follower.accountId)?.values() ?? [])].some(quantity => quantity !== 0));

  const recordDisarm = (
    trigger: CopierDisarmTrigger,
    detail: string,
    copiesOutcome: CopierCopiesOutcome,
  ): CopierDisarmRecord => {
    const record = createCopierDisarmRecord({
      at: clock(), trigger, detail, copiesOutcome,
    });
    lastDisarm = record;
    disarmHistory.push(record);
    if (disarmHistory.length > COPIER_DISARM_HISTORY_LIMIT) {
      disarmHistory.splice(0, disarmHistory.length - COPIER_DISARM_HISTORY_LIMIT);
    }
    return record;
  };

  const disarmIndexAt = (recordAt: number): number => {
    let index = -1;
    for (let candidate = disarmHistory.length - 1; candidate >= 0; candidate -= 1) {
      if (disarmHistory[candidate].at === recordAt) {
        index = candidate;
        break;
      }
    }
    return index;
  };

  const updateDisarmOutcome = (
    recordAt: number | undefined,
    copiesOutcome: CopierCopiesOutcome,
  ) => {
    if (recordAt == null) return;
    const index = disarmIndexAt(recordAt);
    if (index < 0) return;
    const updated = { ...disarmHistory[index], copiesOutcome };
    disarmHistory[index] = updated;
    if (lastDisarm?.at === recordAt) lastDisarm = updated;
  };

  const successfulAutoCloseOutcome = (recordAt: number): CopierCopiesOutcome => (
    disarmHistory[disarmIndexAt(recordAt)]?.copiesOutcome === 'flat'
      ? 'flat'
      : 'auto-closed'
  );

  /** Durable stopa „za živého ARM existují kopie" — podklad boot recovery. */
  const syncLiveCopyExposureFlag = async (reason: 'update' | 'clear') => {
    // Čtení i rozhodnutí musí proběhnout až uvnitř serial processoru. Kdyby
    // clear četl stav před zařazením, mohl by minout právě commitovaný update
    // a po clean shutdownu nechat stale boot-recovery marker.
    await processor.mutate(async current => {
      const stored = current.state.safety.liveCopyOpenSince;
      let safety: CopierRuntime['state']['safety'];
      if (reason === 'clear' || groupIsFlat()) {
        if (stored == null) return current;
        const { liveCopyOpenSince: _cleared, ...rest } = current.state.safety;
        safety = rest;
      } else {
        if (stored != null) return current;
        if (!(gate.armed && !gate.shadowMode && hasFollowerExposure())) return current;
        safety = { ...current.state.safety, liveCopyOpenSince: clock() };
      }
      const state = { ...current.state, safety };
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
    tradesToday: 0,
    windowState: tradingWindowStateAt(
      group.safety?.tradingWindow ?? DEFAULT_COPY_GROUP_SAFETY.tradingWindow,
      at,
    ),
    warnedRules: [],
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
      tradesToday: stored.tradesToday ?? stored.recentClosedTrades?.length ?? 0,
      windowState: tradingWindowStateAt(
        group.safety?.tradingWindow ?? DEFAULT_COPY_GROUP_SAFETY.tradingWindow,
        at,
      ),
      warnedRules: stored.warnedRules?.map(warning => ({ ...warning })) ?? [],
      openLots: stored.openLots.map(lot => ({ ...lot })),
      recentClosedTrades: stored.recentClosedTrades?.map(trade => ({ ...trade })) ?? [],
      unpricedSymbols: [...stored.unpricedSymbols],
    };
  };

  const resetDayLockForNewSession = (
    safety: CopierRuntime['state']['safety'],
  ): CopierRuntime['state']['safety'] => ({
    ...safety,
    dayLockUntil: 0,
    dayLockReason: undefined,
    dayLockTrigger: null,
    dayLockAt: null,
    dayLockSnoozedRules: [],
    dayUnlock: null,
    pauseUntil: 0,
    pauseRule: null,
    pauseAt: 0,
    sessionArmedAt: 0,
    followerCuts: {},
  });

  /** Persistuje legacy defaulty i úplný reset na hranici broker session. */
  const ensureDailySession = async (at: number): Promise<CopierDailyStats> => {
    const safety = currentRuntime().state.safety;
    const stored = safety.dailyStats;
    const newSession = stored != null && at >= stored.sessionEndAt;
    const stats = currentDailyStats(at);
    const needsNormalization = stored == null
      || newSession
      || stored.tradesToday == null
      || stored.windowState !== stats.windowState
      || stored.warnedRules == null
      || safety.dayLockTrigger === undefined
      || safety.dayLockAt === undefined
      || safety.dayLockSnoozedRules === undefined
      || safety.dayUnlock === undefined
      || safety.pauseUntil === undefined
      || safety.pauseRule === undefined
      || safety.pauseAt === undefined
      || safety.sessionArmedAt === undefined
      || safety.followerCuts === undefined
      || (safety as CopierSafetyWithInternalRiskState).followerRiskLedgerV1 === undefined
      || safety.accountRisk === undefined;
    if (!needsNormalization) return stats;
    if (newSession) {
      rollRiskSessionMemoryIfExpired(at);
      dayLockPending = null;
      untrackedTradeSymbols.clear();
    }
    const normalizedSafety = newSession ? resetDayLockForNewSession(safety) : safety;
    await persistSafety({
      ...normalizedSafety,
      dayLockTrigger: normalizedSafety.dayLockTrigger ?? null,
      dayLockAt: normalizedSafety.dayLockAt ?? null,
      dayLockSnoozedRules: [...(normalizedSafety.dayLockSnoozedRules ?? [])],
      dayUnlock: normalizedSafety.dayUnlock ? { ...normalizedSafety.dayUnlock } : null,
      pauseUntil: normalizedSafety.pauseUntil ?? 0,
      pauseRule: normalizedSafety.pauseRule ?? null,
      pauseAt: normalizedSafety.pauseAt ?? 0,
      sessionArmedAt,
      followerCuts: serializedFollowerCuts(),
      followerCutExecutionProvenanceV1: serializedFollowerCutExecutionProvenance(),
      followerRiskLedgerV1: serializedFollowerRiskLedger(stats.sessionEndAt),
      accountRisk: serializedAccountRisk(),
      dailyStats: stats,
    } as CopierSafetyWithInternalRiskState);
    return stats;
  };

  const warningAlreadyRecorded = (stats: CopierDailyStats, rule: CopierDailyRule) =>
    stats.warnedRules?.some(warning => warning.rule === rule) === true;

  const warningAudit = (warning: CopierRuleWarning): CopierAuditEntry => ({
    at: warning.at,
    leaderEventId: `rule-warning:${warning.rule}:${warning.at}`,
    kind: 'rule-warning',
    reason: `rule=${warning.rule} current=${warning.current} limit=${warning.limit}`,
    rule: warning.rule,
    current: warning.current,
    limit: warning.limit,
  });

  const appliedRuleActionSignatures = new Map<string, string>();
  let appliedRuleActionSignaturesInitialized = false;
  const ruleActionSignature = (action: CopierRuleAction) => (
    action.kind === 'lock' ? 'lock' : `pause:${action.minutes}`
  );
  const ruleActionKey = (rule: CopierDailyRule, atLimit: boolean) => (
    `${rule}:${atLimit ? 'limit' : 'pre'}`
  );
  const configuredRuleAction = (
    safety: CopyGroupSafetySettings,
    rule: CopierDailyRule,
    atLimit: boolean,
  ): CopierRuleAction | null => {
    if (rule === 'daily-loss') {
      return atLimit ? safety.dayRuleActions.dailyLoss.atLimit : safety.dayRuleActions.dailyLoss.at80Percent;
    }
    if (rule === 'losing-trades') {
      return atLimit ? safety.dayRuleActions.losingTrades.atLimit : safety.dayRuleActions.losingTrades.beforeLimit;
    }
    if (rule === 'max-trades') return safety.dayRuleActions.maxTrades.atLimit;
    return safety.dayRuleActions.windowEnd.atEnd;
  };

  /** Vyhodnotí pravidla dne. Lock vždy přebíjí pauzu; obě větve jsou durable. */
  const evaluateDailyRules = async (at: number): Promise<void> => {
    const stats = await ensureDailySession(at);
    const safety = group.safety ?? DEFAULT_COPY_GROUP_SAFETY;
    if (!appliedRuleActionSignaturesInitialized) {
      // Starý durable warning znamená, že konfigurace, se kterou worker
      // právě startuje, už svou one-shot reakci provedla. Během tohoto
      // procesu se podpis záměrně nemění při updateGroup; povolené zpřísnění
      // tak práh znovu vyhodnotí, místo aby ho starý warning navždy skryl.
      for (const warning of stats.warnedRules ?? []) {
        const atLimit = warning.current >= warning.limit;
        const action = configuredRuleAction(safety, warning.rule, atLimit);
        // Warning je durable, pending lock nikoli. Pokud po restartu ještě
        // neexistuje aktivní durable lock, nesmíme starý warning vydávat za
        // dokončenou lock akci: práh se znovu vyhodnotí a pending lock se
        // bezpečně obnoví. Pause akce naopak durable je a zůstává one-shot.
        if (action && (
          action.kind !== 'lock'
          || currentRuntime().state.safety.dayLockUntil > at
        )) {
          appliedRuleActionSignatures.set(
            ruleActionKey(warning.rule, atLimit),
            ruleActionSignature(action),
          );
        }
      }
      appliedRuleActionSignaturesInitialized = true;
    }
    const beforeEvaluation = currentRuntime().state.safety;
    if ((beforeEvaluation.pauseUntil ?? 0) > 0 && (beforeEvaluation.pauseUntil ?? 0) <= at) {
      const endedRule = beforeEvaluation.pauseRule;
      const endedAt = beforeEvaluation.pauseUntil ?? at;
      await persistSafety({
        ...beforeEvaluation,
        pauseUntil: 0,
        pauseRule: null,
        pauseAt: 0,
      });
      options.onAudit?.([{
        at,
        leaderEventId: `rule-pause-end:${endedRule ?? 'unknown'}:${endedAt}`,
        kind: 'rule-pause-end',
        rule: endedRule ?? undefined,
        until: endedAt,
        reason: `pause ended rule=${endedRule ?? 'unknown'} until=${endedAt}`,
      }]);
    }

    const originalWarnings = stats.warnedRules?.map(warning => ({ ...warning })) ?? [];
    const warnings = originalWarnings.map(warning => ({ ...warning }));
    const addedRules = new Set<CopierDailyRule>();
    const addWarning = (rule: CopierDailyRule, current: number, limit: number) => {
      if (warningAlreadyRecorded({ ...stats, warnedRules: warnings }, rule)) return false;
      warnings.push({ rule, current, limit, at });
      addedRules.add(rule);
      return true;
    };

    if (safety.dailyMaxLosingTrades > 0
      && stats.losingTrades >= (safety.dailyMaxLosingTrades >= 2
        ? safety.dailyMaxLosingTrades - 1
        : safety.dailyMaxLosingTrades)) {
      addWarning('losing-trades', stats.losingTrades, safety.dailyMaxLosingTrades);
    }
    if (safety.dailyMaxTrades > 0
      && (stats.tradesToday ?? 0) >= Math.max(0, safety.dailyMaxTrades - 1)) {
      addWarning('max-trades', stats.tradesToday ?? 0, safety.dailyMaxTrades);
    }
    if (safety.dailyLossLimitUsd > 0
      && stats.realizedPnlUsd <= -0.8 * safety.dailyLossLimitUsd) {
      addWarning('daily-loss', Math.abs(stats.realizedPnlUsd), safety.dailyLossLimitUsd);
    }
    if (isTradingWindowWarningAt(safety.tradingWindow, at)
      || (gate.armed && !gate.shadowMode && stats.windowState === 'outside')) {
      addWarning(
        'window-end',
        zonedMinuteOfDay(at, safety.tradingWindow.timeZone) ?? 0,
        clockMinutes(safety.tradingWindow.to),
      );
    }

    const currentSafety = currentRuntime().state.safety;
    const addedWarnings = warnings.slice(originalWarnings.length);
    if (currentSafety.dayLockUntil > at || dayLockPending) {
      if (addedWarnings.length > 0) {
        stats.warnedRules = warnings;
        await persistSafety({ ...currentSafety, dailyStats: stats });
        options.onAudit?.(addedWarnings.map(warningAudit));
      }
      return;
    }
    type Candidate = {
      rule: CopierDailyRule;
      action: CopierRuleAction;
      actionKey: string;
      actionSignature: string;
      reason: string;
      atLimit: boolean;
      current: number;
      limit: number;
    };
    const candidates: Candidate[] = [];
    const addCandidate = (
      rule: CopierDailyRule,
      action: CopierRuleAction | null,
      reason: string,
      atLimit: boolean,
      current: number,
      limit: number,
    ) => {
      if (!action) return;
      const actionKey = ruleActionKey(rule, atLimit);
      const actionSignature = ruleActionSignature(action);
      if (appliedRuleActionSignatures.get(actionKey) === actionSignature) return;
      candidates.push({ rule, action, actionKey, actionSignature, reason, atLimit, current, limit });
    };

    if (safety.dailyLossLimitUsd > 0 && stats.realizedPnlUsd <= -safety.dailyLossLimitUsd) {
      addCandidate('daily-loss', safety.dayRuleActions.dailyLoss.atLimit,
        `denní ztráta dosáhla limitu ${safety.dailyLossLimitUsd} USD`, true,
        Math.abs(stats.realizedPnlUsd), safety.dailyLossLimitUsd);
    }
    if (safety.dailyMaxLosingTrades > 0 && stats.losingTrades >= safety.dailyMaxLosingTrades) {
      addCandidate('losing-trades', safety.dayRuleActions.losingTrades.atLimit,
        `${stats.losingTrades}. ztrátový obchod dne (limit ${safety.dailyMaxLosingTrades})`, true,
        stats.losingTrades, safety.dailyMaxLosingTrades);
    }
    if (safety.dailyMaxTrades > 0 && (stats.tradesToday ?? 0) >= safety.dailyMaxTrades) {
      addCandidate('max-trades', safety.dayRuleActions.maxTrades.atLimit,
        `${stats.tradesToday ?? 0}. uzavřený obchod dne (limit ${safety.dailyMaxTrades})`, true,
        stats.tradesToday ?? 0, safety.dailyMaxTrades);
    }
    if (gate.armed && !gate.shadowMode && stats.windowState === 'outside') {
      const minute = zonedMinuteOfDay(at, safety.tradingWindow.timeZone) ?? clockMinutes(safety.tradingWindow.to);
      addCandidate('window-end', safety.dayRuleActions.windowEnd.atEnd,
        `obchodní okno skončilo v ${safety.tradingWindow.to} (${safety.tradingWindow.timeZone})`, true,
        minute, clockMinutes(safety.tradingWindow.to));
    }
    if (safety.dailyLossLimitUsd > 0
      && stats.realizedPnlUsd <= -0.8 * safety.dailyLossLimitUsd
      && stats.realizedPnlUsd > -safety.dailyLossLimitUsd) {
      addCandidate('daily-loss', safety.dayRuleActions.dailyLoss.at80Percent,
        `denní ztráta dosáhla 80 % limitu ${safety.dailyLossLimitUsd} USD`, false,
        Math.abs(stats.realizedPnlUsd), safety.dailyLossLimitUsd);
    }
    if (safety.dailyMaxLosingTrades >= 2
      && stats.losingTrades >= safety.dailyMaxLosingTrades - 1
      && stats.losingTrades < safety.dailyMaxLosingTrades) {
      addCandidate('losing-trades', safety.dayRuleActions.losingTrades.beforeLimit,
        `zbývá poslední ztrátový obchod do limitu ${safety.dailyMaxLosingTrades}`, false,
        stats.losingTrades, safety.dailyMaxLosingTrades);
    }

    // Jakýkoli současný lock přebíjí všechny pause kandidáty.
    const lockCandidate = candidates.find(item => item.action.kind === 'lock');
    if (lockCandidate) {
      if (addedWarnings.length > 0) {
        stats.warnedRules = warnings;
        await persistSafety({ ...currentRuntime().state.safety, dailyStats: stats });
        options.onAudit?.(addedWarnings.map(warningAudit));
      }
      dayLockPending = { trigger: lockCandidate.rule, reason: lockCandidate.reason };
      appliedRuleActionSignatures.set(lockCandidate.actionKey, lockCandidate.actionSignature);
      options.onAudit?.([{
        at,
        leaderEventId: `auto-day-lock:${lockCandidate.rule}`,
        kind: 'blocked',
        rule: lockCandidate.rule,
        reason: `auto day-lock trigger=${lockCandidate.rule} čeká na flat: ${lockCandidate.reason}`,
      }]);
      await maybeEngageDayLock(at);
      return;
    }

    const pauseCandidates = candidates.filter(
      (candidate): candidate is Candidate & { action: Extract<CopierRuleAction, { kind: 'pause' }> } => (
        candidate.action.kind === 'pause'
      ),
    );
    if (pauseCandidates.length === 0) {
      if (addedWarnings.length > 0) {
        stats.warnedRules = warnings;
        await persistSafety({ ...currentRuntime().state.safety, dailyStats: stats });
        options.onAudit?.(addedWarnings.map(warningAudit));
      }
      return;
    }

    // Všechny současné pauzy se uplatní v jediném durable commitu.
    // Nejdelší konec vyhrává; kratší kandidát ho nesmí zkrátit.
    for (const candidate of pauseCandidates) {
      if (!candidate.atLimit) continue;
      const marker = warnings.find(item => item.rule === candidate.rule);
      if (marker) marker.current = Math.max(marker.current, marker.limit);
    }
    stats.warnedRules = warnings;
    const longestCandidate = pauseCandidates.reduce((longest, candidate) => (
      candidate.action.minutes > longest.action.minutes ? candidate : longest
    ));
    const longestNewUntil = at + longestCandidate.action.minutes * 60_000;
    const existingUntil = currentRuntime().state.safety.pauseUntil ?? 0;
    const until = Math.max(existingUntil, longestNewUntil);
    const extendedByNewRule = longestNewUntil >= existingUntil;
    await persistSafety({
      ...currentRuntime().state.safety,
      pauseUntil: until,
      pauseRule: extendedByNewRule
        ? longestCandidate.rule
        : currentRuntime().state.safety.pauseRule ?? longestCandidate.rule,
      pauseAt: extendedByNewRule ? at : currentRuntime().state.safety.pauseAt ?? at,
      dailyStats: stats,
    });
    for (const candidate of pauseCandidates) {
      appliedRuleActionSignatures.set(candidate.actionKey, candidate.actionSignature);
    }
    if (addedWarnings.length > 0) options.onAudit?.(addedWarnings.map(warningAudit));
    options.onAudit?.(pauseCandidates.map(candidate => ({
      at,
      leaderEventId: `rule-pause:${candidate.rule}:${at}`,
      kind: 'rule-pause' as const,
      rule: candidate.rule,
      until,
      reason: `rule=${candidate.rule} pause until=${until}: ${candidate.reason}`,
    })));
  };

  /**
   * Denní read-only ledger z leader fillů (avg-cost matching per symbol).
   * Běží vždy, aby uzavřené copier obchody a P&L přežily restart a mohly
   * napájet widgety. Risk limity jsou pouze volitelní konzumenti; při jejich
   * překročení se day-lock stále aktivuje až po zploštění celé skupiny.
   */
  const trackLeaderFill = async (fill: BrokerFill, now: number) => {
    const limitUsd = group.safety?.dailyLossLimitUsd ?? 0;
    const at = fill.filledAt > 0 ? fill.filledAt : now;
    const stored = currentRuntime().state.safety.dailyStats;
    if (stored && at + msUntilTradovateSessionEnd(at) !== stored.sessionEndAt) {
      options.onAudit?.([{
        at: now,
        leaderEventId: `daily-risk-stale-session:${fill.fillId}`,
        kind: 'skipped',
        reason: `denní počítadlo ignorovalo fill ${fill.fillId} z jiné broker session`,
      }]);
      return;
    }
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
        stats.tradesToday = (stats.tradesToday ?? 0) + 1;
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
        recentLeaderExitFills.set(fill.brokerOrderId, {
          tradeId: fill.fillId,
          symbol: fill.symbol,
          observedAt: now,
        });
        for (const [orderId, candidate] of recentLeaderExitFills) {
          if (now - candidate.observedAt > PROTECTIVE_EXIT_ATTRIBUTION_WINDOW_MS) {
            recentLeaderExitFills.delete(orderId);
          }
        }
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
    await evaluateDailyRules(at);
  };

  /** Zamkne den do konce broker session — až když je celá skupina flat. */
  const maybeEngageDayLock = async (now: number) => {
    if (!dayLockPending || !groupIsFlat()) return;
    const pending = dayLockPending;
    const automatic = pending.trigger !== 'manual';
    const reason = automatic ? `auto day-lock: ${pending.reason}` : pending.reason;
    dayLockPending = null;
    const until = pending.until ?? (now + msUntilTradovateSessionEnd(now));
    gate = { ...gate, armed: false };
    await persistSafety({
      ...currentRuntime().state.safety,
      dayLockUntil: Math.max(currentRuntime().state.safety.dayLockUntil, until),
      dayLockReason: reason,
      dayLockTrigger: pending.trigger,
      dayLockAt: now,
    });
    options.onAudit?.([{
      at: now,
      leaderEventId: automatic ? `auto-day-lock:${pending.trigger}` : 'manual-day-lock',
      kind: 'blocked',
      reason: `day-lock trigger=${pending.trigger}: ${reason}`,
    }]);
  };

  /**
   * Zneplatní poslední autoritativní preflight bez vytváření falešného
   * incidentu. Používá se hlavně v DISARMED, kde nová leader anomálie nic
   * neposílá followerům, ale další ARM musí nejdřív znovu načíst broker stav.
   */
  const invalidateReconciliation = () => {
    safetyGeneration += 1;
    positionCheckComplete = false;
    source.requireReconciliation();
  };

  const failClosed = (
    reason: unknown,
    failure: {
      transportLost?: boolean;
      autoClose?: boolean;
      reconcileAfterTerminalFill?: boolean;
    } = {},
  ) => {
    const wasArmed = gate.armed;
    const wasLiveArmed = gate.armed && !gate.shadowMode;
    invalidateReconciliation();
    lastError = errorOf(reason);
    const disarm = wasArmed
      ? recordDisarm(
          failure.transportLost ? 'transport' : 'fail-closed',
          lastError.message,
          groupIsFlat()
            ? 'flat'
            : 'unknown',
        )
      : undefined;
    gate = {
      ...gate,
      armed: false,
      shadowMode: true,
      ...(failure.transportLost ? { connected: false } : {}),
    };
    // Interní nejistota odzbrojí copier a vynutí novou autoritativní kontrolu,
    // ale nesmí předstírat fyzický disconnect. Živé spojení je potřeba právě
    // proto, aby mohly doběhnout risk-redukující cancely už známých objednávek.
    if (failure.transportLost) source.connection(false);
    options.onError?.(lastError);
    // Fail-closed uprostřed živého obchodu nesmí nechat kopie viset bez
    // dozoru (živý incident: rejected modify zabil follower SL a exit
    // leadera o 9 s později už byl blokovaný). Bez transportu zavřít nejde
    // a kill switch je explicitní freeze — obojí kryje jen notifikace.
    if (wasLiveArmed && !failure.transportLost && !gate.killSwitch && failure.autoClose !== false) {
      scheduleAutoClose('fail-closed', {
        reconcileAfterTerminalFill: failure.reconcileAfterTerminalFill === true,
      }, disarm?.at);
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
    disarmAt = lastDisarm?.trigger === 'fail-closed' ? lastDisarm.at : undefined,
  ) => {
    if (autoCloseInFlight || stopped) return;
    autoCloseInFlight = true;
    const seed = clock();
    eventTail = eventTail
      .then(async () => {
        try {
          const autoCloseSafeForRecovery = await autoFlattenCopies(trigger, seed);
          if (disarmAt != null) {
            updateDisarmOutcome(
              disarmAt,
              autoCloseSafeForRecovery ? successfulAutoCloseOutcome(disarmAt) : 'unknown',
            );
          }
          if (
            recovery.reconcileAfterTerminalFill
            && autoCloseSafeForRecovery
            && gate.connected
            && !gate.killSwitch
          ) {
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
    if (activeFollowerCut(pending.accountId)) return;

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
      gate = {
        ...gate,
        divergentAccounts: new Set([...gate.divergentAccounts, pending.accountId]),
      };
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

  const clearPendingFollowerMagnitudeCheck = (accountId: number, symbol: string) => {
    const key = followerTransitionKey(accountId, symbol);
    const timer = pendingFollowerMagnitudeChecks.get(key);
    if (timer) clearTimeout(timer);
    pendingFollowerMagnitudeChecks.delete(key);
  };

  const verifyFollowerMagnitude = async (accountId: number, symbol: string) => {
    const key = followerTransitionKey(accountId, symbol);
    if (!pendingFollowerMagnitudeChecks.has(key) || stopped) return;
    pendingFollowerMagnitudeChecks.delete(key);
    const follower = group.followers.find(item => item.accountId === accountId);
    if (!follower
      || follower.mode === 'off'
      || currentIneligibleAccounts().has(accountId)
      || activeFollowerCut(accountId)) return;

    try {
      const [leaderSnapshot, followerSnapshot] = await Promise.all([
        broker.listPositions(group.leaderAccountId),
        broker.listPositions(accountId),
      ]);
      const leaderNet = leaderSnapshot.find(item => item.symbol === symbol)?.netQuantity ?? 0;
      const followerNet = followerSnapshot.find(item => item.symbol === symbol)?.netQuantity ?? 0;
      const expectedFollowerNet = Math.trunc(leaderNet * follower.multiplier);

      leaderPositions.set(symbol, leaderNet);
      const followerPositions = positionsByAccount.get(accountId) ?? new Map<string, number>();
      followerPositions.set(symbol, followerNet);
      positionsByAccount.set(accountId, followerPositions);

      if (followerNet === expectedFollowerNet) return;
      const suppression = intentionalEntrySuppressions.get(
        intentionalSuppressionKey(accountId, symbol),
      );
      if (suppression && followerNet === suppression.allowedNet) return;
      gate = {
        ...gate,
        divergentAccounts: new Set([...gate.divergentAccounts, accountId]),
      };
      failClosed(new Error(
        `Copier fail-closed: follower ${accountId} má autoritativně pozici ${followerNet} na ${symbol}, `
        + `očekáváno ${expectedFollowerNet} podle leadera ${leaderNet} × ${follower.multiplier}`,
      ), { autoClose: false });
    } catch (error) {
      failClosed(new Error(
        `Copier fail-closed: autoritativní kontrola expozice followera ${accountId} `
        + `na ${symbol} selhala: ${errorOf(error).message}`,
      ), { autoClose: false });
    }
  };

  const scheduleFollowerMagnitudeCheck = (accountId: number, symbol: string) => {
    const key = followerTransitionKey(accountId, symbol);
    clearPendingFollowerMagnitudeCheck(accountId, symbol);
    const timer = setTimeout(() => {
      eventTail = eventTail
        .then(() => verifyFollowerMagnitude(accountId, symbol))
        .catch(reason => failClosed(reason, { autoClose: false }));
    }, followerTransitionCorrelationWindowMs);
    pendingFollowerMagnitudeChecks.set(key, timer);
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
    if (role === 'protective') {
      recentFollowerFillCauses.delete(key);
      failOnExactProtectiveReversal(
        pending.accountId, pending.symbol, pending.netQuantity, fill.brokerOrderId,
      );
    }
  };

  const failClosedOnCriticalAudit = (entries: readonly CopierAuditEntry[]) => {
    const critical = entries.filter(isCriticalAuditEntry);
    if (critical.length === 0) return;
    if (!gate.armed) {
      invalidateReconciliation();
      return;
    }
    const reconcileAfterTerminalFill = criticalAuditAllowsTerminalFillRecovery(
      entries,
      currentRuntime().cancelOutbox,
    );
    const primary = critical[0];
    failClosed(new Error(
      primary.reason
        ? `Copier fail-closed: ${primary.reason}`
        : `Copier fail-closed: ${primary.kind}`,
    ), { reconcileAfterTerminalFill });
  };

  const handleLeaderPositionTransition = async (
    symbol: string,
    previousKnown: boolean,
    previousNet: number,
    nextNet: number,
    observedAt: number,
  ) => {
    if (!previousKnown || previousNet === nextNet) return;
    let epoch = leaderExposureEpoch(symbol);
    const exitOrderId = previousNet !== 0 && nextNet === 0
      ? lastLeaderFillOrderId.get(symbol)
      : undefined;
    const entryOrderId = nextNet !== 0 ? lastLeaderFillOrderId.get(symbol) : undefined;

    // Restart/legacy obchod nebo první známý scale-in může mít autoritativně
    // známou otevřenou pozici, ale ještě ne durable epochu. Založíme pouze
    // detect-only ownership; bez důkazu z opening epochy nesmí pozdější guard
    // automaticky obchodovat.
    let legacyFollowers: LeaderFlatFollowerOwnership[] | null = null;
    if (previousNet !== 0 && !epoch) {
      legacyFollowers = group.followers.map(follower => ({
        accountId: follower.accountId,
        replicationModeAtOpen: follower.mode,
        eligibleAtOpen: false,
        copyLineage: 'unproven',
      }));
      epoch = createLeaderFlatEpoch({
        id: globalThis.crypto.randomUUID(),
        groupId: group.id,
        leaderAccountId: group.leaderAccountId!,
        symbol,
        openedAt: currentRuntime().state.safety.liveCopyOpenSince ?? observedAt,
        leaderNet: previousNet,
        followers: legacyFollowers,
      });
    }

    const plan = planLeaderPositionTransition({
      epoch,
      previousKnown,
      previousNet,
      nextNet,
      observedAt,
      graceMs: leaderFlatGraceMs,
      nextEpochId: globalThis.crypto.randomUUID(),
      groupId: group.id,
      leaderAccountId: group.leaderAccountId!,
      symbol,
      followersAtOpen: legacyFollowers
        ?? leaderFlatFollowersAt(symbol, nextNet !== 0 ? nextNet : previousNet),
      ...(entryOrderId ? { leaderEntryOrderIds: [entryOrderId] } : {}),
      ...(exitOrderId ? { leaderExitOrderIds: [exitOrderId] } : {}),
    });

    if (plan.kind === 'opened' || plan.kind === 'updated') {
      if (plan.kind === 'opened' && epoch) {
        const staleTimer = leaderFlatGuardTimers.get(epoch.id);
        if (staleTimer) clearTimeout(staleTimer);
        leaderFlatGuardTimers.delete(epoch.id);
      }
      await persistLeaderExposureEpoch(plan.epoch);
      return;
    }
    if (plan.kind === 'scheduled') {
      await persistLeaderExposureEpoch(plan.epoch);
      scheduleLeaderFlatEpochVerification(plan.epoch, plan.token);
      return;
    }
    if (plan.kind === 'blocked') {
      if (plan.epoch) {
        await persistLeaderExposureEpoch(invalidateLeaderFlatEpoch(
          plan.epoch,
          `leader-flat transition blocked: ${plan.reason}`,
          observedAt,
        ));
      }
      failClosed(new Error(
        `Copier fail-closed: leader-flat guard nelze bezpečně založit (${plan.reason})`,
      ), { autoClose: false });
    }
  };

  const flatten = async (
    accountIds: readonly number[],
    operationId: string,
    { preserveArm = false, scopedFailure = false }: { preserveArm?: boolean; scopedFailure?: boolean } = {},
  ) => {
    // `scopedFailure`: selhání se vrací volajícímu jako výjimka a NEodzbrojí
    // celou skupinu — používá follower cut, který smí ovlivnit jen svůj účet
    // (spec RISK_TAB §0/§3.3: vyřazení účtu nikdy nezamyká skupinu).
    if (!preserveArm) {
      gate = { ...gate, armed: false };
      invalidateReconciliation();
    }
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
      if (!scopedFailure) failClosed(error, preserveArm ? { autoClose: false } : undefined);
      throw error;
    }
    if (!result) throw new Error('Flatten nedokončil žádný výsledek');
    if (preserveArm) {
      for (const accountId of accountIds) workingOrderAccounts.delete(accountId);
      for (const accountId of result.workingOrderAccounts) workingOrderAccounts.add(accountId);
    } else {
      workingOrderAccounts = new Set(result.workingOrderAccounts);
    }
    if (!result.flat) {
      const failed = result.accounts.filter(account => !account.ok);
      const detail = failed
        .map(account => `${account.accountId} (${account.error ?? 'účet není autoritativně flat'})`)
        .join(', ');
      const error = new Error(
        `Flatten selhal: zavřeno ${result.accounts.length - failed.length}/${result.accounts.length} účtů; selhaly ${detail || 'neznámé účty'}`,
      );
      if (!scopedFailure) failClosed(error, preserveArm ? { autoClose: false } : undefined);
      throw error;
    }
    if (preserveArm) {
      for (const accountId of accountIds) positionsByAccount.set(accountId, new Map());
    }
    return result;
  };

  const finiteOrNull = (value: number | null): number | null => (
    value != null && Number.isFinite(value) ? value : null
  );
  const normalizeAccountRiskSnapshot = (
    snapshot: BrokerAccountRiskSnapshot,
  ): CopierAccountRiskSnapshot => {
    const netLiq = finiteOrNull(snapshot.netLiq);
    const minNetLiq = finiteOrNull(snapshot.minNetLiq);
    const dailyLossAutoLiq = finiteOrNull(snapshot.dailyLossAutoLiq);
    const validTimestamp = Number.isFinite(snapshot.at) && snapshot.at > 0;
    return {
      accountId: snapshot.accountId,
      // Neplatný čas se nesmí přepsat lokálním `clock()`: tím by se starý
      // či vadný broker payload změnil na čerstvě ověřený cut signál.
      verifiedAt: validTimestamp ? snapshot.at : 0,
      realizedPnlUsd: finiteOrNull(snapshot.realizedPnlUsd),
      netLiq,
      minNetLiq,
      dailyLossAutoLiq,
      trailingMaxDrawdown: finiteOrNull(snapshot.trailingMaxDrawdown),
      propLimitUsd: dailyLossAutoLiq ?? (
        netLiq != null && minNetLiq != null ? netLiq - minNetLiq : null
      ),
      error: validTimestamp ? null : 'broker risk snapshot má neplatný čas',
    };
  };

  const pushFollowerCutEvent = (cut: CopierFollowerCut): void => {
    copyEventCounter += 1;
    const event: CopierCopyEvent = {
      id: `${cut.at}-${copyEventCounter}`,
      at: cut.at,
      kind: 'follower-cut',
      symbol: '',
      side: 'Long',
      quantity: 0,
      followers: group.followers.filter(follower => follower.mode !== 'off').length,
      accountId: cut.accountId,
      cutUsd: cut.cutUsd,
      realizedPnlUsd: cut.realizedPnlUsd,
      source: cut.source,
      closed: cut.closed,
    };
    recentCopyEvents.push(event);
    if (recentCopyEvents.length > 20) recentCopyEvents.shift();
    options.onCopyEvent?.(event);
  };

  const followerHasCopyToClose = async (accountId: number): Promise<boolean> => {
    const live = currentRuntime();
    const confirmedEpochParticipants = new Map(
      (live.state.safety.leaderExposureEpochs ?? [])
        .filter(epoch => (
          epoch.groupId === group.id
          && epoch.leaderAccountId === group.leaderAccountId
          && unfinishedLeaderFlatPhase(epoch.phase)
        ))
        .flatMap(epoch => epoch.followers
          .filter(follower => (
            follower.accountId === accountId
            && follower.copyLineage === 'confirmed'
            && follower.confirmedNetQuantity != null
          ))
          .map(follower => [epoch.symbol, follower] as const)),
    );

    // Cut, který smí obchodovat, se vždy rozhoduje z čerstvého read-only
    // snapshotu. Cached pozice ani samotná existence staré epochy nejsou
    // oprávnění zavřít účet — mezitím mohl přijít manuální zásah.
    const copiedOrderIds = new Set(
      [...live.state.links.values()]
        .flat()
        .filter(link => link.accountId === accountId && !link.brokerOrderId.startsWith('shadow:'))
        .map(link => link.brokerOrderId),
    );
    const ownedBrokerOrderIds = new Set(copiedOrderIds);
    for (const entry of live.osoOutbox.values()) {
      if (entry.request.accountId !== accountId) continue;
      for (const brokerOrderId of [
        entry.entryBrokerOrderId,
        entry.firstBrokerOrderId,
        entry.secondBrokerOrderId,
      ]) {
        if (brokerOrderId && !brokerOrderId.startsWith('shadow:')) {
          ownedBrokerOrderIds.add(brokerOrderId);
        }
      }
      if (entry.entryBrokerOrderId && !entry.entryBrokerOrderId.startsWith('shadow:')) {
        copiedOrderIds.add(entry.entryBrokerOrderId);
      }
    }
    for (const entry of live.bracketOutbox.values()) {
      if (entry.request.accountId !== accountId) continue;
      for (const brokerOrderId of [entry.firstBrokerOrderId, entry.secondBrokerOrderId]) {
        if (brokerOrderId && !brokerOrderId.startsWith('shadow:')) {
          ownedBrokerOrderIds.add(brokerOrderId);
        }
      }
    }
    const [positions, orders] = await Promise.all([
      broker.listPositions(accountId),
      broker.listOrders(accountId),
    ]);
    const positionSnapshot = new Map(
      positions.map(position => [position.symbol, position.netQuantity]),
    );
    positionsByAccount.set(accountId, positionSnapshot);

    const copiedEntryRequests = [
      ...[...live.outbox.values()]
        .filter(entry => (
          entry.status === 'acknowledged'
          && entry.operationKind !== 'liquidate-position'
          && entry.request.accountId === accountId
        ))
        .map(entry => entry.request),
      ...[...live.osoOutbox.values()]
        .filter(entry => entry.status === 'acknowledged' && entry.request.accountId === accountId)
        .map(entry => entry.request),
    ];
    const follower = group.followers.find(item => item.accountId === accountId);
    if (!follower) return false;
    const lineageCut = activeFollowerCut(accountId);
    const lineageProvenance = followerCutExecutionProvenance.get(accountId);
    const durableCutExposure = lineageCut
      && lineageProvenance?.mode === 'live'
      && lineageProvenance.cutAt === lineageCut.at
      && lineageProvenance.cutUntil === lineageCut.until
      ? lineageProvenance.copiedExposureBySymbol
      : undefined;
    const hasUnownedFillSince = (symbol: string, ownedSince: number) => orders.some(order => (
      order.symbol === symbol
      && order.filledQuantity > 0
      && !ownedBrokerOrderIds.has(order.brokerOrderId)
      && (
        !Number.isFinite(order.updatedAt)
        || order.updatedAt <= 0
        || order.updatedAt >= ownedSince
      )
    ));
    const copiedPositionSymbols = new Set<string>();
    for (const position of positions) {
      if (position.netQuantity === 0) continue;
      const leaderNet = leaderExposureReferenceNet(position.symbol);
      const expected = Math.trunc(leaderNet * follower.multiplier);
      if (leaderNet === 0 || position.netQuantity !== expected) continue;
      const requestEvidence = copiedEntryRequests.some(request => (
        request.symbol === position.symbol
        && (request.side === 'Buy' ? 1 : -1) === Math.sign(position.netQuantity)
      ));
      const epochParticipant = confirmedEpochParticipants.get(position.symbol);
      const epochEvidence = epochParticipant?.confirmedNetQuantity != null
        && Math.sign(epochParticipant.confirmedNetQuantity) === Math.sign(position.netQuantity)
        && Math.abs(position.netQuantity) <= Math.abs(epochParticipant.confirmedNetQuantity);
      const recentCause = recentFollowerFillCauses.get(`${accountId}:${position.symbol}`);
      const recentEvidence = copiedEntryLineage(accountId, position.symbol, position.netQuantity)
        && recentCause != null;
      const cutExposure = durableCutExposure?.[position.symbol];
      const durableCutEvidence = cutExposure != null
        && cutExposure.netQuantity === position.netQuantity;
      const ownershipStarts = [
        ...(epochEvidence ? [
          (live.state.safety.leaderExposureEpochs ?? [])
            .filter(epoch => (
              epoch.groupId === group.id
              && epoch.leaderAccountId === group.leaderAccountId
              && epoch.symbol === position.symbol
              && unfinishedLeaderFlatPhase(epoch.phase)
              && epoch.followers.some(participant => (
                participant.accountId === accountId
                && participant.copyLineage === 'confirmed'
              ))
            ))
            .reduce((oldest, epoch) => Math.min(oldest, epoch.openedAt), Number.POSITIVE_INFINITY),
        ] : []),
        ...(recentEvidence ? [recentCause.observedAt] : []),
        ...(durableCutEvidence ? [cutExposure.ownedSince] : []),
      ].filter(value => Number.isFinite(value) && value > 0);
      // Historický acknowledged request + stejné znaménko + aktuální
      // shoda s leaderem nejsou samy o sobě ownership důkaz. Follower mohl
      // původní kopii mezitím manuálně zavřít a otevřít stejnou pozici.
      // Account-wide close proto vyžaduje i potvrzenou exposure epochu nebo
      // čerstvou korelaci ke konkrétnímu copier-issued fillu. Durable cut
      // evidence dovolí dokončení po pádu, ale jen pokud broker historie
      // od potvrzení ownership neobsahuje žádný cizí fill.
      if (requestEvidence && ownershipStarts.some(ownedSince => (
        !hasUnownedFillSince(position.symbol, ownedSince)
      ))) copiedPositionSymbols.add(position.symbol);
    }

    const openOrders = orders.filter(order => isOpenOrderStatus(order.status));
    const ownedOpeningOrder = openOrders.some(order => {
      if (!copiedOrderIds.has(order.brokerOrderId)) return false;
      const remaining = Math.max(0, order.quantity - order.filledQuantity);
      const net = positionSnapshot.get(order.symbol) ?? 0;
      const signed = order.side === 'Buy' ? remaining : -remaining;
      return remaining > 0 && (
        net === 0
        || Math.sign(net) === Math.sign(signed)
        || remaining > Math.abs(net)
      );
    });
    const hasConfirmedCopy = copiedPositionSymbols.size > 0 || ownedOpeningOrder;
    if (!hasConfirmedCopy) {
      const staleLineageDivergence = positions.some(position => (
        position.netQuantity !== 0
        && (
          confirmedEpochParticipants.has(position.symbol)
          || copiedEntryRequests.some(request => request.symbol === position.symbol)
        )
      ));
      if (staleLineageDivergence) {
        throw new Error('potvrzená copier lineage neodpovídá aktuální pozici účtu');
      }
      return false;
    }

    const unrelatedPositions = positions.filter(position => (
      position.netQuantity !== 0 && !copiedPositionSymbols.has(position.symbol)
    ));
    const unrelatedWorkingOrders = openOrders.filter(order => !ownedBrokerOrderIds.has(order.brokerOrderId));
    if (unrelatedPositions.length > 0 || unrelatedWorkingOrders.length > 0) {
      const details = [
        ...unrelatedPositions.map(position => `${position.symbol}:${position.netQuantity}`),
        ...unrelatedWorkingOrders.map(order => `order:${order.brokerOrderId}`),
      ].join(', ');
      throw new Error(
        `účet obsahuje expozici bez potvrzené copier lineage (${details}); account-wide close není bezpečný`,
      );
    }
    return true;
  };

  const cancelOwnedOpeningOrdersForLetRunCut = async (
    accountId: number,
    follower: CopyGroupConfig['followers'][number],
    cut: CopierFollowerCut,
  ): Promise<void> => {
    const live = currentRuntime();
    const leaderOrderByFollowerOrder = new Map<string, string>();
    for (const [leaderOrderId, links] of live.state.links) {
      for (const link of links) {
        if (link.accountId === accountId && !link.brokerOrderId.startsWith('shadow:')) {
          leaderOrderByFollowerOrder.set(link.brokerOrderId, leaderOrderId);
        }
      }
    }
    if (leaderOrderByFollowerOrder.size === 0) return;

    const [positions, orders] = await Promise.all([
      broker.listPositions(accountId),
      broker.listOrders(accountId),
    ]);
    const positionSnapshot = new Map(
      positions.map(position => [position.symbol, position.netQuantity]),
    );
    positionsByAccount.set(accountId, positionSnapshot);
    const strategyGroupByOrder = new Map<string, string>();
    for (const entry of [...live.bracketOutbox.values(), ...live.osoOutbox.values()]) {
      if (entry.request.accountId !== accountId) continue;
      const groupKey = `protective:${entry.key}`;
      for (const brokerOrderId of [entry.firstBrokerOrderId, entry.secondBrokerOrderId]) {
        if (brokerOrderId) strategyGroupByOrder.set(brokerOrderId, groupKey);
      }
    }
    const candidateByLeaderOrder = new Map<string, BrokerOrder>();
    type ReducingBucket = {
      groupKey: string;
      symbol: string;
      side: BrokerOrder['side'];
      effectiveRemaining: number;
      orders: BrokerOrder[];
      protective: boolean;
    };
    const reducingBuckets = new Map<string, ReducingBucket>();
    for (const order of orders) {
      const leaderOrderId = leaderOrderByFollowerOrder.get(order.brokerOrderId);
      if (!leaderOrderId || !isOpenOrderStatus(order.status)) continue;
      const remaining = Math.max(0, order.quantity - order.filledQuantity);
      const net = positionSnapshot.get(order.symbol) ?? 0;
      const signed = order.side === 'Buy' ? remaining : -remaining;
      if (remaining <= 0) continue;
      const isReducing = net !== 0 && Math.sign(net) !== Math.sign(signed);
      if (!isReducing) {
        candidateByLeaderOrder.set(leaderOrderId, order);
        continue;
      }
      const strategyGroup = strategyGroupByOrder.get(order.brokerOrderId);
      const groupKey = strategyGroup ?? `order:${order.brokerOrderId}`;
      const bucketKey = `${order.symbol}:${order.side}:${groupKey}`;
      const bucket = reducingBuckets.get(bucketKey) ?? {
        groupKey,
        symbol: order.symbol,
        side: order.side,
        effectiveRemaining: 0,
        orders: [],
        protective: strategyGroup != null,
      };
      bucket.effectiveRemaining = Math.max(bucket.effectiveRemaining, remaining);
      bucket.orders.push(order);
      reducingBuckets.set(bucketKey, bucket);
    }

    let unsafeProtectiveOverflow = false;
    const reducingByExposure = new Map<string, ReducingBucket[]>();
    for (const bucket of reducingBuckets.values()) {
      const key = `${bucket.symbol}:${bucket.side}`;
      const list = reducingByExposure.get(key) ?? [];
      list.push(bucket);
      reducingByExposure.set(key, list);
    }
    for (const buckets of reducingByExposure.values()) {
      buckets.sort((left, right) => Number(right.protective) - Number(left.protective));
      const first = buckets[0];
      const net = positionSnapshot.get(first.symbol) ?? 0;
      let available = Math.abs(net);
      for (const bucket of buckets) {
        if (bucket.effectiveRemaining > available) {
          for (const order of bucket.orders) {
            const leaderOrderId = leaderOrderByFollowerOrder.get(order.brokerOrderId);
            if (leaderOrderId) candidateByLeaderOrder.set(leaderOrderId, order);
          }
          if (bucket.protective) unsafeProtectiveOverflow = true;
          continue;
        }
        available -= bucket.effectiveRemaining;
        for (const order of bucket.orders) {
          exitOnlyReservations.set(order.brokerOrderId, {
            accountId,
            symbol: order.symbol,
            remaining: Math.max(0, order.quantity - order.filledQuantity),
            groupKey: bucket.groupKey,
          });
        }
      }
    }

    for (const [leaderOrderId, order] of candidateByLeaderOrder) {
      const cancelEvent: LeaderEvent = {
        id: `follower-cut-cancel:${accountId}:${leaderOrderId}:${cut.until}`,
        orderId: leaderOrderId,
        kind: 'canceled',
        accountId: group.leaderAccountId!,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        orderType: order.orderType,
        sequence: currentRuntime().state.lastSequence,
        receivedAt: clock(),
      };
      const result = await processor.process({
        event: cancelEvent,
        group: { ...group, followers: [{ ...follower, mode: 'on-submit' }] },
        context: {
          ...gate,
          now: clock(),
          shadowMode: false,
          sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
          stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
          ineligibleAccounts: new Map(),
        },
        broker,
        clock,
        store: options.store,
        metrics,
        maxConcurrentDispatches: options.maxConcurrentDispatches,
      });
      runtime = result.runtime;
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      const unsafe = result.audit.find(item => (
        item.kind === 'unknown'
        || item.kind === 'abandoned'
        || item.kind === 'cancel-failed'
        || item.kind === 'sequence-broken'
        || item.kind === 'blocked'
      ));
      if (unsafe) {
        throw new Error(
          unsafe.reason
            ? `čekající copier entry ${order.brokerOrderId} nelze bezpečně zrušit: ${unsafe.reason}`
            : `čekající copier entry ${order.brokerOrderId} nelze bezpečně zrušit`,
        );
      }
    }
    if (unsafeProtectiveOverflow) {
      throw new Error('copier protective exit přesahoval skutečnou pozici; nebezpečná strategie byla zrušena');
    }
  };

  const recordFollowerCutAudit = (cut: CopierFollowerCut): void => {
    options.onAudit?.([{
      at: cut.at,
      leaderEventId: `follower-cut:${cut.accountId}:${cut.until}`,
      kind: 'follower-cut',
      accountId: cut.accountId,
      until: cut.until,
      source: cut.source,
      cutUsd: cut.cutUsd,
      current: Math.abs(cut.realizedPnlUsd),
      limit: cut.cutUsd,
      reason: `follower ${cut.accountId} cut: realized=${cut.realizedPnlUsd} USD limit=${cut.cutUsd} USD source=${cut.source}`,
    }]);
  };

  const copiedExposureEvidenceAtCut = (
    accountId: number,
  ): CopierFollowerCutExecutionProvenance['copiedExposureBySymbol'] => {
    const evidence: NonNullable<
      CopierFollowerCutExecutionProvenance['copiedExposureBySymbol']
    > = {};
    const positions = positionsByAccount.get(accountId);
    if (!positions) return evidence;
    const live = currentRuntime();
    const linkedBrokerOrderIds = new Set(
      [...live.state.links.values()].flat()
        .filter(link => link.accountId === accountId && !link.brokerOrderId.startsWith('shadow:'))
        .map(link => link.brokerOrderId),
    );
    for (const [symbol, netQuantity] of positions) {
      if (netQuantity === 0) continue;
      const ownedSinceCandidates: number[] = [];
      for (const epoch of live.state.safety.leaderExposureEpochs ?? []) {
        if (
          epoch.groupId !== group.id
          || epoch.leaderAccountId !== group.leaderAccountId
          || epoch.symbol !== symbol
          || !unfinishedLeaderFlatPhase(epoch.phase)
        ) continue;
        const participant = epoch.followers.find(item => item.accountId === accountId);
        if (
          participant?.copyLineage !== 'confirmed'
          || participant.confirmedNetQuantity == null
          || Math.sign(participant.confirmedNetQuantity) !== Math.sign(netQuantity)
          || Math.abs(netQuantity) > Math.abs(participant.confirmedNetQuantity)
        ) continue;
        ownedSinceCandidates.push(epoch.openedAt);
      }
      const recentCause = recentFollowerFillCauses.get(`${accountId}:${symbol}`);
      if (
        recentCause
        && copiedEntryLineage(accountId, symbol, netQuantity)
      ) ownedSinceCandidates.push(recentCause.observedAt);
      for (const entry of live.outbox.values()) {
        if (
          entry.status !== 'acknowledged'
          || entry.operationKind === 'liquidate-position'
          || entry.request.accountId !== accountId
          || entry.request.symbol !== symbol
          || (entry.request.side === 'Buy' ? 1 : -1) !== Math.sign(netQuantity)
          || !entry.brokerOrderId
          || !linkedBrokerOrderIds.has(entry.brokerOrderId)
        ) continue;
        ownedSinceCandidates.push(entry.updatedAt);
      }
      for (const entry of live.osoOutbox.values()) {
        if (
          entry.status !== 'acknowledged'
          || entry.request.accountId !== accountId
          || entry.request.symbol !== symbol
          || (entry.request.side === 'Buy' ? 1 : -1) !== Math.sign(netQuantity)
          || !entry.entryBrokerOrderId
          || !linkedBrokerOrderIds.has(entry.entryBrokerOrderId)
        ) continue;
        ownedSinceCandidates.push(entry.updatedAt);
      }
      if (ownedSinceCandidates.length === 0) continue;
      evidence[symbol] = {
        netQuantity,
        // Nejstarší platný ownership začátek je konzervativní: každý
        // pozdější cizí fill při recovery důkaz zneplatní.
        ownedSince: Math.min(...ownedSinceCandidates),
      };
    }
    return evidence;
  };

  const prepareFollowerCut = (
    accountId: number,
    realizedPnlUsd: number,
    sourceKind: CopierFollowerCut['source'],
    at: number,
  ): { cut: CopierFollowerCut; follower: CopyGroupConfig['followers'][number] } | null => {
    if (!gate.armed || activeFollowerCut(accountId, at)) return null;
    const follower = group.followers.find(item => item.accountId === accountId);
    const cutUsd = follower?.dailyLossCutUsd ?? 0;
    if (!follower || cutUsd <= 0 || realizedPnlUsd > -cutUsd) return null;
    const cut: CopierFollowerCut = {
      accountId,
      at,
      until: currentDailyStats(at).sessionEndAt,
      realizedPnlUsd,
      cutUsd,
      source: sourceKind,
      closed: null,
    };
    followerCuts.set(accountId, cut);
    followerCutExecutionProvenance.set(accountId, {
      accountId,
      cutAt: cut.at,
      cutUntil: cut.until,
      mode: gate.armed && !gate.shadowMode ? 'live' : 'observe-only',
      copiedExposureBySymbol: copiedExposureEvidenceAtCut(accountId),
    });
    for (const [key, timer] of pendingFollowerMagnitudeChecks) {
      if (!key.startsWith(`${accountId}:`)) continue;
      clearTimeout(timer);
      pendingFollowerMagnitudeChecks.delete(key);
    }
    return { cut, follower };
  };

  /**
   * Selhání zásahu na jednom followerovi: durable closed=false + audit.
   * Nikdy neodzbrojuje skupinu; selhání durable zápisu je jediná výjimka
   * (stav workeru by lhal), ta zůstává fail-closed.
   */
  const recordFollowerCutFailure = async (cut: CopierFollowerCut, detail: string): Promise<void> => {
    const failed = { ...cut, closed: false as const };
    followerCuts.set(cut.accountId, failed);
    options.onAudit?.([{
      at: clock(),
      leaderEventId: `follower-cut:${cut.accountId}:${cut.until}:close-failed`,
      kind: 'follower-cut',
      accountId: cut.accountId,
      until: cut.until,
      source: cut.source,
      cutUsd: cut.cutUsd,
      current: Math.abs(cut.realizedPnlUsd),
      limit: cut.cutUsd,
      reason: `follower ${cut.accountId} cut: kopii se nepodařilo zavřít — ${detail}`,
    }]);
    try {
      await persistRiskSafety();
    } catch (persistReason) {
      failClosed(new Error(
        `Selhání follower cut ${cut.accountId} nelze durable uložit: ${errorOf(persistReason).message}`,
      ), { autoClose: false });
    }
  };

  const executeFollowerCutAction = async (
    cut: CopierFollowerCut,
    follower: CopyGroupConfig['followers'][number],
    liveSideEffects: boolean,
    emitCopyEvent = true,
  ): Promise<void> => {
    const { accountId, at } = cut;
    // Živý cut (spuštěný daty za ARM, emitCopyEvent=true) drží selhání per
    // účet a skupinu neodzbrojuje (spec §0/§3.3). Recovery/restart a
    // update-group cesty (emitCopyEvent=false) běží už DISARMED a nechávají
    // si původní fail-closed chování, aby se nic neobnovovalo naslepo.
    const scopedFailure = emitCopyEvent;
    if (!liveSideEffects) {
      // Shadow ARM smí risk data i cut stav pozorovat, nikdy však nesmí
      // vytvořit cancel/liquidation side effect.
      if (emitCopyEvent) pushFollowerCutEvent(cut);
      return;
    }
    const provenance = followerCutExecutionProvenance.get(accountId);
    const liveRecoveryAuthorized = provenance?.mode === 'live'
      && provenance.cutAt === cut.at
      && provenance.cutUntil === cut.until;
    if (!liveRecoveryAuthorized) {
      // sessionArmedAt dokazuje jen, že v této session někdy proběhl live
      // ARM. Nikdy nesmí povýšit pozdější shadow cut na oprávnění
      // poslat cancel/liquidate po restartu. Cut zůstává observe-only
      // (closed=null: žádný pokus o zavření).
      if (!scopedFailure) {
        failClosed(new Error(
          `Follower cut ${accountId}: chybí durable live provenance konkrétního cutu; `
          + 'cancel/close zůstává observe-only',
        ), { autoClose: false });
      }
      if (emitCopyEvent) pushFollowerCutEvent(cut);
      return;
    }
    if ((follower.onCut ?? 'close-copy') === 'let-run') {
      try {
        // Let-run ponechá existující pozici a její čistě redukující ochranu,
        // ale copier-owned waiting entry/scale-in už po cutu nesmí fillnout.
        await cancelOwnedOpeningOrdersForLetRunCut(accountId, follower, cut);
      } catch (reason) {
        if (scopedFailure) await recordFollowerCutFailure(cut, errorOf(reason).message);
        else failClosed(new Error(`Follower cut ${accountId}: ${errorOf(reason).message}`), { autoClose: false });
      }
      if (emitCopyEvent) pushFollowerCutEvent(followerCuts.get(accountId) ?? cut);
      return;
    }
    let hasKnownCopy: boolean;
    try {
      hasKnownCopy = await followerHasCopyToClose(accountId);
    } catch (reason) {
      // Neověřitelný stav kopie = closed:false (žádný slepý liquidation pokus).
      const detail = `stav kopie nelze autoritativně ověřit: ${errorOf(reason).message}`;
      if (scopedFailure) {
        await recordFollowerCutFailure(cut, detail);
      } else {
        const failed = { ...cut, closed: false as const };
        followerCuts.set(accountId, failed);
        try {
          await persistRiskSafety();
        } catch {
          // Níže stejně přejdeme fail-closed; chybu nelze vydávat za dokončený cut.
        }
        failClosed(new Error(`Follower cut ${accountId}: ${detail}`), { autoClose: false });
      }
      if (emitCopyEvent) pushFollowerCutEvent(followerCuts.get(accountId) ?? cut);
      return;
    }
    if (!hasKnownCopy) {
      if (emitCopyEvent) pushFollowerCutEvent(cut);
      return;
    }
    try {
      await flatten(
        [accountId],
        `cut-${accountId}-${Math.floor(cut.until / 86_400_000)}`,
        { preserveArm: true, scopedFailure },
      );
    } catch (reason) {
      // Jediný pokus, žádný druhý liquidation. Živě: když broker liquidate
      // ODMÍTL (nic neletí, stav účtu je známý), selhání se drží per účet
      // (closed=false, vstupy blokované, exity leadera se kopírují dál, aby
      // se kopie mohla zavřít s leaderem) a skupina zůstává ARM — ostatní
      // followeři nesmí přijít o kopírování kvůli jednomu účtu. Když je ale
      // výsledek liquidate NEZNÁMÝ (odeslán, flat nepotvrzen), platí obecný
      // invariant: neznámý broker stav = fail-closed celé skupiny.
      // Recovery: `flatten` už nastavil fail-closed stav i lastError.
      const unknownBrokerState = currentStuckOperations().some(operation => operation.accountId === accountId);
      if (scopedFailure && !unknownBrokerState) {
        await recordFollowerCutFailure(cut, errorOf(reason).message);
      } else if (scopedFailure) {
        const failed = { ...cut, closed: false as const };
        followerCuts.set(accountId, failed);
        try {
          await persistRiskSafety();
        } catch {
          // Níže stejně přejdeme fail-closed.
        }
        failClosed(reason, { autoClose: false });
      } else {
        const failed = { ...cut, closed: false as const };
        followerCuts.set(accountId, failed);
        try {
          await persistRiskSafety();
        } catch (persistReason) {
          failClosed(new Error(
            `Selhání follower cut ${accountId} nelze durable uložit: ${errorOf(persistReason).message}`,
          ), { autoClose: false });
        }
      }
      if (emitCopyEvent) pushFollowerCutEvent(followerCuts.get(accountId) ?? cut);
      return;
    }
    const closed = { ...cut, closed: at };
    followerCuts.set(accountId, closed);
    try {
      await persistRiskSafety();
    } catch (reason) {
      failClosed(new Error(
        `Výsledek follower cut ${accountId} nelze durable uložit: ${errorOf(reason).message}`,
      ), { autoClose: false });
    }
    if (emitCopyEvent) pushFollowerCutEvent(closed);
  };

  const triggerFollowerCut = async (
    accountId: number,
    realizedPnlUsd: number,
    sourceKind: CopierFollowerCut['source'],
    at: number,
  ): Promise<void> => {
    const prepared = prepareFollowerCut(accountId, realizedPnlUsd, sourceKind, at);
    if (!prepared) return;
    const liveSideEffects = !gate.shadowMode;
    try {
      await persistRiskSafety();
    } catch (reason) {
      const error = new Error(
        `Follower cut ${accountId} nelze durable uložit: ${errorOf(reason).message}`,
      );
      failClosed(error, { autoClose: false });
      throw error;
    }
    recordFollowerCutAudit(prepared.cut);
    await executeFollowerCutAction(prepared.cut, prepared.follower, liveSideEffects);
  };

  const tightenedCutClosures = (
    previousGroup: CopyGroupConfig,
    nextGroup: CopyGroupConfig,
  ): Array<{ cut: CopierFollowerCut; follower: CopyGroupConfig['followers'][number] }> => {
    if (!(sessionArmedAt > 0)) return [];
    const previousByAccount = new Map(
      previousGroup.followers.map(follower => [follower.accountId, follower]),
    );
    return nextGroup.followers.flatMap(follower => {
      const previous = previousByAccount.get(follower.accountId);
      const cut = activeFollowerCut(follower.accountId);
      return cut
        && (previous?.onCut ?? 'close-copy') === 'let-run'
        && (follower.onCut ?? 'close-copy') === 'close-copy'
        ? [{ cut, follower }]
        : [];
    });
  };

  const applyAccountRiskPoll = async (
    requestedAccountIds: readonly number[],
    requestedSessionEndAt: number,
    snapshots: readonly BrokerAccountRiskSnapshot[] | null,
    errors: ReadonlyMap<number, Error> = new Map(),
  ): Promise<void> => {
    // Pozdní odpověď z minulé broker session nesmí po resetu založit
    // cut platný až do konce nového dne.
    if (currentDailyStats(clock()).sessionEndAt !== requestedSessionEndAt) return;
    const byAccount = new Map(snapshots?.map(snapshot => [snapshot.accountId, snapshot]) ?? []);
    for (const accountId of requestedAccountIds) {
      const raw = byAccount.get(accountId);
      if (!raw) {
        const previous = accountRisk.get(accountId);
        const accountError = errors.get(accountId);
        accountRisk.set(accountId, {
          accountId,
          verifiedAt: previous?.verifiedAt ?? 0,
          realizedPnlUsd: previous?.realizedPnlUsd ?? null,
          netLiq: previous?.netLiq ?? null,
          minNetLiq: previous?.minNetLiq ?? null,
          dailyLossAutoLiq: previous?.dailyLossAutoLiq ?? null,
          trailingMaxDrawdown: previous?.trailingMaxDrawdown ?? null,
          propLimitUsd: previous?.propLimitUsd ?? null,
          error: accountError?.message ?? 'broker risk snapshot chybí',
        });
        continue;
      }
      accountRisk.set(accountId, normalizeAccountRiskSnapshot(raw));
    }
    try {
      await persistRiskSafety();
    } catch {
      // Risk poll je read-only observability. Selhání jeho pomocné persistence
      // nesmí přepsat execution lastError. Ověřený limit se ale i tak
      // musí vyhodnotit; teprve durable cut má vlastní fail-closed commit.
    }
    if (!gate.armed) return;
    try {
      assertCutsWithinKnownPropLimits(group);
    } catch (reason) {
      failClosed(reason, { autoClose: false });
      return;
    }
    const now = clock();
    const preparedCuts: Array<{
      cut: CopierFollowerCut;
      follower: CopyGroupConfig['followers'][number];
    }> = [];
    for (const follower of group.followers) {
      const snapshot = accountRisk.get(follower.accountId);
      if (!snapshot
        || snapshot.error
        || snapshot.realizedPnlUsd == null
        || now - snapshot.verifiedAt > ACCOUNT_RISK_STALE_MS) continue;
      const prepared = prepareFollowerCut(
        follower.accountId,
        snapshot.realizedPnlUsd,
        'broker',
        now,
      );
      if (prepared) preparedCuts.push(prepared);
    }
    if (preparedCuts.length === 0) return;
    const liveSideEffects = !gate.shadowMode;
    try {
      // Všechny zasažené účty se durable vypnou v jednom kroku ještě před
      // prvním close/cancel side effectem. Selhání účtu A tak nesmí potlačit
      // již ověřený cut účtu B jen tím, že DISARMne gate.
      await persistRiskSafety();
    } catch (reason) {
      failClosed(new Error(
        `Follower cuts nelze durable uložit: ${errorOf(reason).message}`,
      ), { autoClose: false });
      return;
    }
    for (const prepared of preparedCuts) recordFollowerCutAudit(prepared.cut);
    for (const prepared of preparedCuts) {
      await executeFollowerCutAction(prepared.cut, prepared.follower, liveSideEffects);
    }
  };

  const scheduleAccountRiskPoll = (
    accountIds: readonly number[],
    force = false,
  ): void => {
    // Čtení je read-only a limity propek musí být vidět i s vypnutou
    // kopírkou (spec RISK_TAB §3.4); za ARM častěji, jinak pomaleji.
    if (stopped || !gate.connected) return;
    const now = clock();
    const interval = gate.armed ? ACCOUNT_RISK_POLL_MS : ACCOUNT_RISK_IDLE_POLL_MS;
    const requested = [...new Set(accountIds)].filter(accountId => {
      if (!Number.isSafeInteger(accountId) || accountId <= 0) return false;
      return force || now - (accountRiskLastRequestedAt.get(accountId) ?? -Infinity) >= interval;
    });
    if (requested.length === 0) return;
    const requestedSessionEndAt = currentDailyStats(now).sessionEndAt;
    for (const accountId of requested) accountRiskLastRequestedAt.set(accountId, now);
    accountRiskPollTail = accountRiskPollTail.then(async () => {
      const withDeadline = <T>(promise: Promise<T>, accountId: number): Promise<T> => (
        new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(
              `broker risk snapshot účtu ${accountId} překročil ${ACCOUNT_RISK_REQUEST_TIMEOUT_MS} ms`,
            ));
          }, ACCOUNT_RISK_REQUEST_TIMEOUT_MS);
          promise.then(
            value => {
              clearTimeout(timer);
              resolve(value);
            },
            reason => {
              clearTimeout(timer);
              reject(reason);
            },
          );
        })
      );
      const settled = await Promise.all(requested.map(async accountId => {
        try {
          return {
            accountId,
            snapshots: await withDeadline(broker.listAccountRiskSnapshots([accountId]), accountId),
          } as const;
        } catch (reason) {
          return { accountId, error: errorOf(reason) } as const;
        }
      }));
      const snapshots = settled.flatMap(result => 'snapshots' in result ? result.snapshots : []);
      const pollErrors = new Map<number, Error>(
        settled.flatMap(result => 'error' in result ? [[result.accountId, result.error] as const] : []),
      );
      const applied = eventTail.then(() => applyAccountRiskPoll(
        requested,
        requestedSessionEndAt,
        snapshots,
        pollErrors,
      ));
      eventTail = applied.catch(() => undefined);
      await applied;
    }).catch(() => undefined);
  };

  const trackFollowerRiskFill = async (fill: BrokerFill, at: number): Promise<void> => {
    const currentSessionEndAt = currentRuntime().state.safety.dailyStats?.sessionEndAt;
    if (
      currentSessionEndAt != null
      && at + msUntilTradovateSessionEnd(at) !== currentSessionEndAt
    ) {
      options.onAudit?.([{
        at: clock(),
        leaderEventId: `follower-risk-stale-session:${fill.fillId}`,
        kind: 'skipped',
        accountId: fill.accountId,
        reason: `follower risk ledger ignoroval fill ${fill.fillId} z jiné broker session`,
      }]);
      return;
    }
    if (seenFollowerRiskFillIds.has(fill.fillId)) return;
    seenFollowerRiskFillIds.add(fill.fillId);
    while (seenFollowerRiskFillIds.size > 1_000) {
      const oldest = seenFollowerRiskFillIds.values().next().value as string | undefined;
      if (!oldest) break;
      seenFollowerRiskFillIds.delete(oldest);
    }
    const follower = group.followers.find(item => item.accountId === fill.accountId);
    if (!follower) return;
    const key = `${fill.accountId}:${fill.symbol}`;
    let lot = followerRiskLots.get(key);
    let remaining = fill.side === 'Buy' ? fill.quantity : -fill.quantity;
    let realized = followerRealizedPnlUsd.get(fill.accountId) ?? 0;
    if (lot && lot.netQuantity !== 0 && Math.sign(lot.netQuantity) !== Math.sign(remaining)) {
      const closing = Math.min(Math.abs(lot.netQuantity), Math.abs(remaining));
      const pv = pointValueUsd(fill.symbol);
      if (pv != null) {
        realized += (fill.price - lot.avgPrice) * Math.sign(lot.netQuantity) * closing * pv;
      }
      lot.netQuantity += Math.sign(remaining) * closing;
      remaining -= Math.sign(remaining) * closing;
      if (lot.netQuantity === 0) {
        followerRiskLots.delete(key);
        lot = undefined;
      }
    }
    if (remaining !== 0) {
      if (!lot) {
        lot = { netQuantity: remaining, avgPrice: fill.price, realizedPnlUsd: realized };
        followerRiskLots.set(key, lot);
      } else {
        const total = Math.abs(lot.netQuantity) + Math.abs(remaining);
        lot.avgPrice = ((Math.abs(lot.netQuantity) * lot.avgPrice) + (Math.abs(remaining) * fill.price)) / total;
        lot.netQuantity += remaining;
        lot.realizedPnlUsd = realized;
      }
    }
    followerRealizedPnlUsd.set(fill.accountId, realized);
    await triggerFollowerCut(fill.accountId, realized, 'ledger', at);
  };

  const leaderFlatExitEvidence = (
    epoch: LeaderFlatEpoch,
    accountId: number,
    orders: readonly BrokerOrder[],
  ): LeaderFlatExitEvidence[] => {
    const evidence: LeaderFlatExitEvidence[] = [];
    const orderById = new Map(orders.map(order => [order.brokerOrderId, order]));
    for (const entry of currentRuntime().outbox.values()) {
      if (entry.request.accountId !== accountId || entry.request.symbol !== epoch.symbol) continue;
      const guardLiquidation = entry.operationKind === 'liquidate-position'
        && entry.leaderEventId?.includes(`leader-flat:${epoch.id}`) === true;
      const copiedExit = epoch.leaderExitOrderIds.includes(entry.leaderOrderId);
      if (!guardLiquidation && !copiedExit) continue;
      const brokerOrder = entry.brokerOrderId ? orderById.get(entry.brokerOrderId) : undefined;
      const status = entry.status === 'sending' || entry.status === 'unknown'
        ? entry.status
        : brokerOrder?.status;
      if (!status || status === 'canceled' || status === 'rejected') continue;
      evidence.push({
        accountId,
        symbol: epoch.symbol,
        role: guardLiquidation ? 'guard-liquidation' : 'copied-exit',
        status,
        ...(guardLiquidation ? { epochId: epoch.id } : {}),
        ...(copiedExit ? { leaderOrderId: entry.leaderOrderId } : {}),
        ...(entry.brokerOrderId ? { brokerOrderId: entry.brokerOrderId } : {}),
        updatedAt: brokerOrder?.updatedAt ?? entry.updatedAt,
      });
    }
    const protectiveIds = new Set<string>();
    for (const entry of [...currentRuntime().osoOutbox.values(), ...currentRuntime().bracketOutbox.values()]) {
      if (entry.request.accountId !== accountId || entry.request.symbol !== epoch.symbol) continue;
      for (const id of [entry.firstBrokerOrderId, entry.secondBrokerOrderId]) {
        if (id) protectiveIds.add(id);
      }
    }
    for (const order of orders) {
      if (!protectiveIds.has(order.brokerOrderId) || order.symbol !== epoch.symbol) continue;
      evidence.push({
        accountId,
        symbol: epoch.symbol,
        role: 'protective',
        status: order.status,
        brokerOrderId: order.brokerOrderId,
        updatedAt: order.updatedAt,
      });
    }
    return evidence;
  };

  async function verifyLeaderFlatEpoch(
    token: LeaderFlatGuardToken,
    expectedSafetyGeneration: number,
  ): Promise<void> {
    if (stopped) return;
    const storedEpoch = currentRuntime().state.safety.leaderExposureEpochs
      ?.find(item => item.id === token.epochId) ?? null;
    const epoch = storedEpoch
      && storedEpoch.groupId === group.id
      && storedEpoch.leaderAccountId === group.leaderAccountId
      ? storedEpoch
      : null;
    if (
      !isLeaderFlatGuardTokenCurrent(epoch, token)
      || safetyGeneration !== expectedSafetyGeneration
      || !gate.connected
    ) return;

    const accountIds = [...new Set([
      epoch.leaderAccountId,
      ...epoch.followers.map(follower => follower.accountId),
    ])];
    const rows = await Promise.all(accountIds.map(async accountId => {
      try {
        const [positions, orders] = await Promise.all([
          broker.listPositions(accountId),
          broker.listOrders(accountId),
        ]);
        return { accountId, ok: true as const, positions, orders };
      } catch (reason) {
        return { accountId, ok: false as const, error: errorOf(reason).message };
      }
    }));

    const current = leaderExposureEpoch(epoch.symbol);
    if (
      !isLeaderFlatGuardTokenCurrent(current, token)
      || safetyGeneration !== expectedSafetyGeneration
      || !gate.connected
    ) return;

    // Cache aktualizujeme až po ověření tokenu; pozdní snapshot staré epochy
    // nesmí přepsat novější obchod ani autorizovat jeho zavření.
    for (const row of rows) {
      if (!row.ok) continue;
      const map = positionsByAccount.get(row.accountId) ?? new Map<string, number>();
      for (const position of row.positions) map.set(position.symbol, position.netQuantity);
      positionsByAccount.set(row.accountId, map);
      if (row.accountId === epoch.leaderAccountId) {
        const leaderNet = row.positions
          .filter(position => position.symbol === epoch.symbol)
          .reduce((sum, position) => sum + position.netQuantity, 0);
        leaderPositions.set(epoch.symbol, leaderNet);
      }
    }

    const batchAccounts: LeaderFlatAccountBatchSnapshot[] = rows.map(row => row.ok
      ? {
        accountId: row.accountId,
        ok: true,
        positions: row.positions.map(position => ({
          symbol: position.symbol,
          netQuantity: position.netQuantity,
        })),
        exitEvidence: leaderFlatExitEvidence(epoch, row.accountId, row.orders),
      }
      : { accountId: row.accountId, ok: false, error: row.error });
    const evaluation = evaluateLeaderFlatBatch({
      epoch,
      snapshot: { observedAt: clock(), accounts: batchAccounts },
      autoCloseFollowerPositions: (
        group.safety?.autoCloseFollowerPositions
        ?? DEFAULT_COPY_GROUP_SAFETY.autoCloseFollowerPositions
      ) && !gate.killSwitch,
      exitSettlementGraceMs: leaderFlatExitSettlementGraceMs,
      inflightRetryMs: leaderFlatInflightRetryMs,
    });
    await persistLeaderExposureEpoch(evaluation.epoch);

    if (evaluation.kind === 'resolved') {
      options.onAudit?.([{
        at: clock(), leaderEventId: `leader-flat:${epoch.id}`, kind: 'recovered',
        reason: 'leader-flat guard: leader i všichni účastníci jsou autoritativně flat',
      }]);
      await syncLiveCopyExposureFlag('clear');
      await resolveRejectedExecutions({
        accountIds: epoch.followers.map(follower => follower.accountId),
        kind: 'follower-flat',
        at: clock(),
        symbol: epoch.symbol,
        detail: 'leader-flat guard autoritativně potvrdil followera flat',
      });
      return;
    }

    if (evaluation.kind === 'wait-inflight') {
      const afterGrace = evaluation.waitingInflightAccountIds.length > 0
        || evaluation.divergentAccountIds.length > 0;
      if (afterGrace) {
        gate = {
          ...gate,
          divergentAccounts: new Set([
            ...gate.divergentAccounts,
            ...evaluation.divergentAccountIds,
            ...evaluation.blockedAccountIds,
          ]),
        };
        failClosed(new Error(
          `Copier fail-closed: leader je flat, follower exit stále čeká (${evaluation.reason})`,
        ), { autoClose: false });
      }
      scheduleLeaderFlatEpochVerification(
        evaluation.epoch,
        { epochId: evaluation.epoch.id, generation: evaluation.epoch.generation },
        safetyGeneration,
      );
      return;
    }

    const affected = [
      ...evaluation.divergentAccountIds,
      ...evaluation.blockedAccountIds,
    ];
    gate = {
      ...gate,
      divergentAccounts: new Set([...gate.divergentAccounts, ...affected]),
    };
    failClosed(new Error(
      `Copier fail-closed: leader je autoritativně flat, follower stav se neshoduje (${evaluation.reason})`,
    ), { autoClose: false });
    const leaderFlatDisarmAt = lastDisarm?.code === 'leader-flat-follower-open'
      || lastDisarm?.trigger === 'transport'
      ? lastDisarm.at
      : undefined;

    if (evaluation.kind !== 'close-targets') return;
    const closeSafetyGeneration = safetyGeneration;
    const closeToken = {
      epochId: evaluation.epoch.id,
      generation: evaluation.epoch.generation,
    };
    if (
      !isLeaderFlatGuardTokenCurrent(leaderExposureEpoch(epoch.symbol), closeToken)
      || closeSafetyGeneration !== safetyGeneration
      || gate.killSwitch
      || !gate.connected
    ) return;

    let closeResult: ManualFlattenResult | null = null;
    try {
      await processor.mutate(async runtimeBeforeClose => {
        // Poslední fencing kontrola bezprostředně před durable write-ahead a
        // případným POSTem. Novější epocha ani safety incident nesmí proklouznout.
        if (
          !isLeaderFlatGuardTokenCurrent(leaderExposureEpoch(epoch.symbol), closeToken)
          || safetyGeneration !== closeSafetyGeneration
        ) return runtimeBeforeClose;
        const processed = await processTargetedLiquidation({
          runtime: runtimeBeforeClose,
          broker,
          store: options.store,
          groupId: group.id,
          targets: evaluation.targets,
          operationId: `leader-flat:${epoch.id}`,
          clock,
          confirmationAttempts: options.flattenConfirmationAttempts,
          confirmationPollMs: options.flattenConfirmationPollMs,
          accountConcurrency: options.flattenAccountConcurrency,
          wait: options.wait,
        });
        closeResult = processed.result;
        return processed.runtime;
      });
    } catch (reason) {
      failClosed(new Error(
        `Leader-flat cílené zavření selhalo: ${errorOf(reason).message}`,
      ), { autoClose: false });
      return;
    }

    const result = closeResult as ManualFlattenResult | null;
    const finalEpoch = leaderExposureEpoch(epoch.symbol);
    if (
      !result
      || !result.flat
      || !finalEpoch
      || !isLeaderFlatGuardTokenCurrent(finalEpoch, closeToken)
    ) {
      failClosed(new Error('Leader-flat cílené zavření není autoritativně potvrzené'), {
        autoClose: false,
      });
      return;
    }
    const fullyResolved = evaluation.blockedAccountIds.length === 0
      && evaluation.detectOnlyAccountIds.length === 0
      && evaluation.waitingInflightAccountIds.length === 0;
    await persistLeaderExposureEpoch({
      ...finalEpoch,
      generation: finalEpoch.generation + 1,
      phase: fullyResolved ? 'resolved' : 'blocked',
      terminalAt: clock(),
      terminalReason: fullyResolved
        ? 'orphan kopie byly stavově zploštěny; explicitní reconciliation je stále povinná'
        : 'bezpečně vlastněné orphan kopie byly zploštěny, ale část batch snapshotu zůstala neověřená nebo detect-only',
    });
    if (fullyResolved) await syncLiveCopyExposureFlag('clear');
    options.onAudit?.([{
      at: clock(), leaderEventId: `leader-flat:${epoch.id}`,
      kind: fullyResolved ? 'recovered' : 'blocked',
      reason: fullyResolved
        ? `leader-flat guard cíleně zploštil ${evaluation.targets.length} account/symbol expozic; runtime zůstává DISARMED`
        : `leader-flat guard zploštil ${evaluation.targets.length} bezpečně vlastněných expozic, ale neověřený zbytek vyžaduje ruční reconciliation`,
    }]);
    await resolveRejectedExecutions({
      accountIds: evaluation.targets.map(target => target.accountId),
      kind: 'guard-flattened',
      at: clock(),
      symbol: epoch.symbol,
      detail: 'leader-flat guard cíleně zploštil kopii a potvrdil flat stav',
    });
    updateDisarmOutcome(leaderFlatDisarmAt, 'guard-flattened');
  }

  /**
   * Risk-redukující zavření kopií — jediná automatická broker akce copieru.
   * Ruší working příkazy a zavírá pozice k nule; nikdy nezvětší |pozici|
   * ani neotočí směr (planFlatten). Spouští ji expirace ARM a fail-closed
   * za živého ARM. Bez lokálně známé expozice se nic neposílá — výpadek na
   * hranici session nesmí vyrábět falešné FAIL-CLOSED poplachy z flattenu
   * naprázdno (working day-orders ruší burza sama).
   */
  const autoFlattenCopies = async (
    trigger: CopierAutoClose['trigger'],
    seed: number,
  ): Promise<boolean> => {
    const scope = group.safety?.armExpiryFlatten ?? DEFAULT_COPY_GROUP_SAFETY.armExpiryFlatten;
    if (scope === 'off' || group.leaderAccountId == null || gate.killSwitch) return false;
    const accountIds = scope === 'group'
      ? [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)]
      : group.followers.map(follower => follower.accountId);
    const hasExposure = accountIds.some(accountId =>
      [...(positionsByAccount.get(accountId)?.values() ?? [])].some(quantity => quantity !== 0));
    // Nulová lokální expozice nevyžaduje broker side effect; následující
    // reconciliation je právě autoritativní důkaz, že stav zůstal flat.
    if (!hasExposure) return true;
    if (autoCloseEpisodeAttempts >= AUTO_CLOSE_MAX_ATTEMPTS_PER_EPISODE) {
      options.onAudit?.([{
        at: clock(), leaderEventId: `auto-close-limit:${trigger}:${seed}`, kind: 'blocked',
        reason: `auto-close vyčerpal ${AUTO_CLOSE_MAX_ATTEMPTS_PER_EPISODE} pokusů v epizodě — nutný ruční zásah`,
      }]);
      return false;
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
        await resolveRejectedExecutions({
          accountIds: group.followers
            .map(follower => follower.accountId)
            .filter(accountId => accountIds.includes(accountId)),
          kind: 'auto-closed',
          at: clock(),
          detail: `auto-close (${trigger}) autoritativně potvrdil followera flat`,
        });
      }
      return result.flat;
    } catch (error) {
      lastAutoClose = {
        at, operationId, trigger, scope, accountIds, flat: false,
        canceledOrders: 0, submittedClosures: 0, error: errorOf(error).message,
      };
      failClosed(new Error(`Auto-close kopií (${trigger}) selhal: ${errorOf(error).message}`));
      return false;
    }
  };

  /**
   * Obnoví durable leader-flat epochy po autoritativním snapshotu. Tato
   * funkce pouze plánuje stejný symbolově cílený guard; sama neposílá broker
   * write. Legacy/restart expozice bez opening ownership zůstává detect-only.
   */
  const resumeLeaderFlatEpochsAfterSnapshot = async (): Promise<Set<string>> => {
    const leaderAccountId = group.leaderAccountId;
    if (leaderAccountId == null) return new Set();
    const matching = currentRuntime().state.safety.leaderExposureEpochs?.filter(epoch => (
      epoch.groupId === group.id && epoch.leaderAccountId === leaderAccountId
    )) ?? [];
    const latestBySymbol = new Map<string, LeaderFlatEpoch>();
    for (const epoch of matching) latestBySymbol.set(epoch.symbol, epoch);

    const guardedSymbols = new Set<string>();
    for (const epoch of latestBySymbol.values()) {
      const leaderNet = positionsByAccount.get(leaderAccountId)?.get(epoch.symbol) ?? 0;
      if (epoch.phase === 'open') {
        if (leaderNet === 0) {
          const observedAt = clock();
          const plan = planLeaderPositionTransition({
            epoch,
            previousKnown: true,
            previousNet: epoch.lastLeaderNet,
            nextNet: 0,
            observedAt,
            graceMs: leaderFlatGraceMs,
            nextEpochId: globalThis.crypto.randomUUID(),
            groupId: group.id,
            leaderAccountId,
            symbol: epoch.symbol,
            // Ownership pochází výhradně z opening epochy; reconnect ji
            // nesmí rozšířit odhadem z právě nalezené pozice.
            followersAtOpen: epoch.followers,
          });
          if (plan.kind === 'scheduled') {
            await persistLeaderExposureEpoch(plan.epoch);
            scheduleLeaderFlatEpochVerification(plan.epoch, plan.token);
            guardedSymbols.add(epoch.symbol);
          } else {
            await persistLeaderExposureEpoch(invalidateLeaderFlatEpoch(
              epoch,
              `connection-recovery nedokázala obnovit leader-flat guard (${plan.kind})`,
              observedAt,
            ));
          }
          continue;
        }

        if (Math.sign(leaderNet) !== Math.sign(epoch.lastLeaderNet)) {
          // Směrový flip proběhl během mezery streamu. Novou expozici jsme
          // neviděli vzniknout, proto založíme pouze detect-only ownership.
          await persistLeaderExposureEpoch(createLeaderFlatEpoch({
            id: globalThis.crypto.randomUUID(),
            groupId: group.id,
            leaderAccountId,
            symbol: epoch.symbol,
            openedAt: clock(),
            leaderNet,
            generation: epoch.generation + 1,
            followers: epoch.followers.map(follower => ({
              ...follower,
              eligibleAtOpen: false,
              copyLineage: 'unproven',
              confirmedNetQuantity: undefined,
            })),
          }));
        } else if (leaderNet !== epoch.lastLeaderNet) {
          // Same-sign změna zachová jen dříve prokázaný quantity ceiling.
          await persistLeaderExposureEpoch({ ...epoch, lastLeaderNet: leaderNet });
        }
        continue;
      }

      if (
        epoch.phase === 'grace'
        || epoch.phase === 'waiting-inflight'
        || epoch.phase === 'closing'
      ) {
        if (leaderNet === 0) {
          scheduleLeaderFlatEpochVerification(epoch, {
            epochId: epoch.id,
            generation: epoch.generation,
          });
          guardedSymbols.add(epoch.symbol);
        } else {
          await persistLeaderExposureEpoch(invalidateLeaderFlatEpoch(
            epoch,
            `leader během connection-recovery už není flat (${leaderNet})`,
            clock(),
          ));
        }
      }
    }
    return guardedSymbols;
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
    // `armExpiryFlatten: off` vypíná jen automatickou broker akci, nikoli
    // povinnou read-only kontrolu po reconnectu/resyncu.
    if (gate.killSwitch || group.leaderAccountId == null) {
      pendingConnectionRecovery = false;
      connectionRecoveryMissingOwnership = [];
      return;
    }
    if (!gate.connected) {
      pendingConnectionRecovery = true;
      return;
    }
    connectionRecoveryMissingOwnership = [];
    const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let lastRecoveryError: string | null = null;
    const resolveMissing = async (): Promise<number[]> => {
      if (!options.resolveMissingOptionalAccountIds) return [];
      const followerIds = new Set(group.followers.map(follower => follower.accountId));
      return [...new Set(await options.resolveMissingOptionalAccountIds(group))]
        .filter(accountId => followerIds.has(accountId) && accountId !== group.leaderAccountId)
        .sort((left, right) => left - right);
    };
    const sameAccounts = (left: readonly number[], right: readonly number[]) => (
      left.length === right.length && left.every((accountId, index) => accountId === right[index])
    );
    let reconciliation: ReconciliationResult | null = null;
    for (let attempt = 0; attempt < 5 && !stopped; attempt += 1) {
      if (attempt > 0) await wait(2_000);
      if (!gate.connected) {
        pendingConnectionRecovery = true;
        return;
      }
      let missingBefore: number[];
      try {
        // Routing/OAuth stav se obnovuje před KAŽDÝM pokusem. Jediný
        // snapshot callbacku nesmí zestárnout pro celou recovery vlnu.
        missingBefore = await resolveMissing();
      } catch (reason) {
        lastRecoveryError = `optional-skip resolver: ${errorOf(reason).message}`;
        options.onAudit?.([{
          at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
          reason: `connection-recovery: ${lastRecoveryError}`,
        }]);
        continue;
      }
      try {
        const candidate = await performReconciliation({
          missingOptionalAccountIds: [...missingBefore],
        });
        const missingAfter = await resolveMissing();
        if (!sameAccounts(missingBefore, missingAfter)) {
          invalidateReconciliation();
          lastRecoveryError = `optional-skip seznam se změnil (${missingBefore.join(',') || 'none'} -> ${missingAfter.join(',') || 'none'}); snapshot byl zahozen`;
          options.onAudit?.([{
            at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
            reason: `connection-recovery: ${lastRecoveryError}`,
          }]);
          continue;
        }
        if (!candidate.authoritativelyClean) {
          const missingOwnership = unverifiableFollowerOwnership(
            new Set(candidate.missingAccounts),
          );
          // Kompletní a generation-stable divergence je stále platný
          // snapshot pro stávající detect-only / leader-flat guard větve.
          // Nesmí ale shodit pending ani provést clean-recovery úklid.
          if (
            missingOwnership.length === 0
            && candidate.generationUnchanged
            && candidate.workingOrderAccounts.length === 0
            && candidate.divergentAccounts.length > 0
          ) {
            reconciliation = candidate;
            break;
          }
          connectionRecoveryMissingOwnership = missingOwnership;
          const details = [
            missingOwnership.length > 0
              ? `chybí lineage participants ${missingOwnership.map(item => `${item.accountId} (epocha ${item.epochId})`).join(', ')}`
              : '',
            candidate.divergentAccounts.length > 0
              ? `divergence=${candidate.divergentAccounts.join(',')}`
              : '',
            candidate.workingOrderAccounts.length > 0
              ? `working=${candidate.workingOrderAccounts.join(',')}`
              : '',
          ].filter(Boolean);
          lastRecoveryError = details.join('; ')
            || 'safety generation se během broker I/O změnila nebo snapshot nebyl kompletní';
          pendingConnectionRecovery = true;
          options.onAudit?.([{
            at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
            reason: `connection-recovery: ${lastRecoveryError}; runtime zůstává DISARMED`,
          }]);
          failClosed(new Error(`Connection recovery není autoritativně čistá: ${lastRecoveryError}`), {
            autoClose: false,
          });
          return;
        }
        reconciliation = candidate;
        break;
      } catch (reason) {
        // Spojení je čerstvé — pár pokusů, pak poctivé přiznání níže.
        lastRecoveryError = errorOf(reason).message;
      }
    }
    if (!reconciliation) {
      // Pět rychlých pokusů je jen jedna recovery vlna. Příští potvrzený
      // connected event (nebo čistá ruční Kontrola pozic) ji musí smět spustit
      // znovu; stav zůstává DISARMED.
      pendingConnectionRecovery = true;
      options.onAudit?.([{
        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
        reason: `connection-recovery: reconciliation selhala 5× — ${lastRecoveryError ?? 'bez důvodu'}`,
      }]);
      failClosed(new Error(
        'connection=aggregate phase=reconciliation Po obnovení spojení se nepodařilo ověřit stav účtů — kopie zůstávají chráněné brackety, zkontroluj Tradovate'
        + (lastRecoveryError ? ` (${lastRecoveryError})` : ''),
      ));
      return;
    }
    if (reconciliation.authoritativelyClean) {
      pendingConnectionRecovery = false;
      connectionRecoveryMissingOwnership = [];
    } else {
      pendingConnectionRecovery = true;
    }
    const guardedSymbols = await resumeLeaderFlatEpochsAfterSnapshot();
    if (!hasFollowerExposure()) {
      if (lastDisarm?.trigger === 'transport') updateDisarmOutcome(lastDisarm.at, 'flat');
      await syncLiveCopyExposureFlag('clear');
      options.onAudit?.([{
        at: clock(), leaderEventId: 'connection-recovery', kind: 'recovered',
        reason: 'connection-recovery: autoritativní reconciliation potvrdila flat/no-active stav; runtime zůstává DISARMED',
      }]);
      return;
    }
    const orphanSymbols = new Set<string>();
    for (const follower of group.followers) {
      for (const [symbol, quantity] of positionsByAccount.get(follower.accountId) ?? []) {
        if (quantity !== 0 && (leaderPositions.get(symbol) ?? 0) === 0) orphanSymbols.add(symbol);
      }
    }
    const unguardedOrphanSymbols = [...orphanSymbols].filter(symbol => !guardedSymbols.has(symbol));
    if (unguardedOrphanSymbols.length > 0) {
      failClosed(new Error(
        `Copier fail-closed: po reconnectu je leader flat a follower má neověřenou expozici (${unguardedOrphanSymbols.join(', ')}); bez opening ownership se automaticky nezavírá`,
      ), { autoClose: false });
      options.onAudit?.([{
        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
        reason: `connection-recovery: detect-only orphan expozice bez durable opening epochy (${unguardedOrphanSymbols.join(', ')}); žádný broker write`,
      }]);
      return;
    }
    if (orphanSymbols.size > 0) {
      options.onAudit?.([{
        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
        reason: `connection-recovery: leader-flat guard obnoven pro ${[...orphanSymbols].join(', ')}; runtime zůstává DISARMED`,
      }]);
      return;
    }
    const leaderOpen = [...(positionsByAccount.get(group.leaderAccountId)?.values() ?? [])]
      .some(quantity => quantity !== 0);
    if (leaderOpen && reconciliation.divergentAccounts.length === 0) {
      if (lastDisarm?.trigger === 'transport') {
        updateDisarmOutcome(lastDisarm.at, 'left-open-protected');
      }
      lastResumeOffer = null;
      options.onAudit?.([{
        at: clock(), leaderEventId: 'connection-recovery', kind: 'blocked',
        reason: 'connection-recovery: kopie jsou synchronní s leaderem — drženy DISARMED, ARM je blokovaný do flat',
      }]);
      return;
    }
    const flat = await autoFlattenCopies('reconnect', clock());
    if (lastDisarm?.trigger === 'transport') {
      updateDisarmOutcome(lastDisarm.at, flat ? 'auto-closed' : 'unknown');
    }
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
    const disarm = recordDisarm(
      'arm-expiry',
      'ARM TTL vypršel, copier se odzbrojil',
      groupIsFlat() ? 'flat' : 'unknown',
    );
    gate = { ...gate, armed: false };
    options.onAudit?.([{
      at: now, leaderEventId: `arm-expiry-${armedAt}`, kind: 'blocked',
      reason: 'arm-expired: ARM TTL vypršel, copier se odzbrojil',
    }]);
    if (wasShadow || autoCloseInFlight) return;
    autoCloseInFlight = true;
    try {
      const flat = await autoFlattenCopies('arm-expiry', armedAt);
      updateDisarmOutcome(disarm.at, flat ? successfulAutoCloseOutcome(disarm.at) : 'unknown');
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
    const openingExcludedAccounts = osoOpeningExcludedAccounts.get(entryOrderId) ?? new Set<number>();
    osoOpeningExcludedAccounts.delete(entryOrderId);
    const entryWasBlocked = blockedOsoEntries.delete(entryOrderId);
    const loneLegCount = osoCorrelator.pendingLegCount(entryOrderId);
    osoCorrelator.release(entryOrderId);
    if (!pending || stopped) {
      settleOsoFlush(entryOrderId);
      return;
    }
    if (entryWasBlocked) {
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
      } else invalidateReconciliation();
      settleOsoFlush(entryOrderId);
      return;
    }
    try {
      const increasesExposure = leaderEventIncreasesExposure(pending);
      if (await blockDuringPause(pending, false, pending, true)) {
        settleOsoFlush(entryOrderId);
        return;
      }
      if (await blockOutsideTradingWindow(pending, true)) {
        settleOsoFlush(entryOrderId);
        return;
      }
      const adjustedDispatch = cutAwareDispatchFor(pending, increasesExposure);
      if (adjustedDispatch.unsafeDivergenceAccounts.length > 0) {
        failClosed(new Error(
          `Copier fail-closed: nevysvětlená divergence účtů ${adjustedDispatch.unsafeDivergenceAccounts.join(', ')} před leader exitem ${pending.symbol}`,
        ), { autoClose: false });
        settleOsoFlush(entryOrderId);
        return;
      }
      const standaloneDispatchGroup = openingExcludedAccounts.size === 0
        ? adjustedDispatch.dispatchGroup
        : {
          ...adjustedDispatch.dispatchGroup,
          followers: adjustedDispatch.dispatchGroup.followers.map(follower => (
            openingExcludedAccounts.has(follower.accountId)
              ? { ...follower, mode: 'off' as const }
              : follower
          )),
        };
      const result = await processor.process({
        event: pending,
        group: standaloneDispatchGroup,
        context: {
          ...gate,
          now: clock(),
          sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
          stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
          ineligibleAccounts: adjustedDispatch.ineligibleAccounts,
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
      rememberCurrentRuntimePendingExposure(result.plan, result.audit);
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      rememberExitOnlyReservations(
        adjustedDispatch.exitOnlyAccounts,
        result.plan,
        result.audit,
      );
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

  const rememberReducingLeaderOrder = (orderId: string, reducing: boolean) => {
    if (reducing) knownLeaderReducingOrderIds.add(orderId);
    else knownLeaderReducingOrderIds.delete(orderId);
    while (knownLeaderReducingOrderIds.size > 1_000) {
      const oldest = knownLeaderReducingOrderIds.values().next().value as string | undefined;
      if (!oldest) break;
      knownLeaderReducingOrderIds.delete(oldest);
    }
  };
  const leaderExposureReferenceNet = (
    symbol: string,
    preferLedger = false,
    at = clock(),
  ): number => {
    const stats = currentRuntime().state.safety.dailyStats;
    const ledgerNet = stats && at < stats.sessionEndAt
      ? stats.openLots.find(lot => lot.symbol === symbol)?.netQuantity ?? 0
      : 0;
    if (preferLedger && ledgerNet !== 0) return ledgerNet;
    const cached = leaderPositions.get(symbol) ?? 0;
    if (cached !== 0) return cached;
    const epoch = leaderExposureEpoch(symbol);
    if (epoch && unfinishedLeaderFlatPhase(epoch.phase) && epoch.lastLeaderNet !== 0) {
      return epoch.lastLeaderNet;
    }
    return ledgerNet;
  };
  const exposurePotential = (
    net: number,
    side: LeaderEvent['side'],
    quantity: number,
  ): number => {
    const signedQuantity = side === 'Buy' ? quantity : -quantity;
    if (net === 0 || Math.sign(net) === Math.sign(signedQuantity)) return Math.abs(quantity);
    return Math.max(0, Math.abs(quantity) - Math.abs(net));
  };
  const signedQuantityIncreasesExposure = (
    net: number,
    side: LeaderEvent['side'],
    quantity: number,
  ): boolean => exposurePotential(net, side, quantity) > 0;
  const reducingQuantityAgainst = (
    net: number,
    side: LeaderEvent['side'],
    quantity: number,
  ): number => {
    const signedQuantity = side === 'Buy' ? quantity : -quantity;
    return net !== 0 && Math.sign(net) !== Math.sign(signedQuantity)
      ? Math.min(Math.abs(net), quantity)
      : 0;
  };
  const cacheExposureClassification = (
    eventId: string,
    increases: boolean,
    preNet?: number,
    reducingQuantity = 0,
  ) => {
    leaderExposureIncreaseByEventId.set(eventId, increases);
    if (preNet != null) leaderPreFillNetByEventId.set(eventId, preNet);
    leaderReducingQuantityByEventId.set(eventId, reducingQuantity);
    while (leaderExposureIncreaseByEventId.size > 2_000) {
      const oldest = leaderExposureIncreaseByEventId.keys().next().value as string | undefined;
      if (!oldest) break;
      leaderExposureIncreaseByEventId.delete(oldest);
      leaderPreFillNetByEventId.delete(oldest);
      leaderReducingQuantityByEventId.delete(oldest);
    }
  };
  const preclassifyLeaderFillExposure = (fill: BrokerFill): void => {
    const eventId = `fill:${fill.fillId}`;
    if (leaderExposureIncreaseByEventId.has(eventId)) return;
    const preNet = leaderExposureReferenceNet(
      fill.symbol,
      true,
      fill.filledAt > 0 ? fill.filledAt : clock(),
    );
    const signedFill = fill.side === 'Buy' ? fill.quantity : -fill.quantity;
    const inferredCapacity = preNet !== 0 && Math.sign(preNet) !== Math.sign(signedFill)
      ? Math.abs(preNet)
      : 0;
    const availableReducing = leaderReducingRemainingByOrder.has(fill.brokerOrderId)
      ? leaderReducingRemainingByOrder.get(fill.brokerOrderId) ?? 0
      : inferredCapacity;
    const reducingQuantity = Math.min(availableReducing, fill.quantity);
    const increases = fill.quantity > reducingQuantity;
    const remainingReducing = Math.max(0, availableReducing - reducingQuantity);
    // I nula je autoritativní: další partial fill stejného reversal orderu
    // už po průchodu přes flat nesmí znovu čerpat kapacitu ze stale epochy.
    leaderReducingRemainingByOrder.set(fill.brokerOrderId, remainingReducing);
    cacheExposureClassification(eventId, increases, preNet, reducingQuantity);
    rememberReducingLeaderOrder(fill.brokerOrderId, !increases);
  };
  const leaderEventIncreasesExposure = (event: LeaderEvent): boolean => {
    const cached = leaderExposureIncreaseByEventId.get(event.id);
    if (cached != null) return cached;
    let increases = false;
    let preNet: number | undefined;
    let reducingQuantity = 0;
    if (event.kind === 'submitted' || event.kind === 'filled') {
      preNet = leaderExposureReferenceNet(event.symbol, event.kind === 'filled', event.receivedAt);
      reducingQuantity = reducingQuantityAgainst(preNet, event.side, event.quantity);
      if (event.kind === 'filled' && reducingQuantity === 0) {
        reducingQuantity = Math.min(
          leaderReducingRemainingByOrder.get(event.orderId) ?? 0,
          event.quantity,
        );
      }
      increases = event.quantity > reducingQuantity;
      if (event.kind === 'submitted') {
        leaderReducingRemainingByOrder.set(event.orderId, reducingQuantity);
      } else {
        const remaining = Math.max(
          0,
          (leaderReducingRemainingByOrder.get(event.orderId) ?? reducingQuantity) - reducingQuantity,
        );
        leaderReducingRemainingByOrder.set(event.orderId, remaining);
      }
      rememberReducingLeaderOrder(event.orderId, !increases);
    } else if (event.kind === 'replaced') {
      preNet = leaderExposureReferenceNet(event.symbol, false, event.receivedAt);
      const previous = leaderOrderIntents.get(event.orderId);
      const nextPotential = exposurePotential(preNet, event.side, event.quantity);
      const previousPotential = previous
        ? exposurePotential(preNet, previous.side, previous.quantity)
        : 0;
      increases = nextPotential > previousPotential;
      reducingQuantity = reducingQuantityAgainst(preNet, event.side, event.quantity);
      if (reducingQuantity > 0) {
        leaderReducingRemainingByOrder.set(event.orderId, reducingQuantity);
      } else {
        leaderReducingRemainingByOrder.delete(event.orderId);
      }
      // Quantity-increasing replace, který z exitu udělá flip, musí
      // invalidovat dřív zapamatovaný reducing intent.
      rememberReducingLeaderOrder(event.orderId, !increases && nextPotential === 0);
    }
    if (event.kind === 'submitted' || event.kind === 'replaced') {
      leaderOrderIntents.set(event.orderId, {
        symbol: event.symbol,
        side: event.side,
        quantity: event.quantity,
      });
      while (leaderOrderIntents.size > 1_000) {
        const oldest = leaderOrderIntents.keys().next().value as string | undefined;
        if (!oldest) break;
        leaderOrderIntents.delete(oldest);
      }
    } else if (event.kind === 'canceled' || event.kind === 'rejected') {
      leaderOrderIntents.delete(event.orderId);
      knownLeaderReducingOrderIds.delete(event.orderId);
      leaderReducingRemainingByOrder.delete(event.orderId);
    }
    cacheExposureClassification(event.id, increases, preNet, reducingQuantity);
    return increases;
  };
  const rememberBlockedLeaderEntryOrder = (orderId: string) => {
    blockedLeaderEntryOrderIds.add(orderId);
    while (blockedLeaderEntryOrderIds.size > 1_000) {
      const oldest = blockedLeaderEntryOrderIds.values().next().value as string | undefined;
      if (!oldest) break;
      blockedLeaderEntryOrderIds.delete(oldest);
    }
  };
  const intentionalSuppressionKey = (accountId: number, symbol: string) => `${accountId}:${symbol}`;
  const rememberIntentionalEntrySuppression = (event: LeaderEvent): void => {
    for (const follower of group.followers) {
      const acceptsEvent = (event.kind === 'submitted' && follower.mode === 'on-submit')
        || (event.kind === 'filled' && follower.mode === 'on-fill');
      if (!acceptsEvent || currentIneligibleAccounts().has(follower.accountId)) continue;
      const key = intentionalSuppressionKey(follower.accountId, event.symbol);
      if (intentionalEntrySuppressions.has(key)) continue;
      const authoritativePositions = positionsByAccount.get(follower.accountId);
      if (!authoritativePositions) continue;
      intentionalEntrySuppressions.set(key, {
        allowedNet: authoritativePositions.get(event.symbol) ?? 0,
        createdAt: event.receivedAt,
        leaderOrderId: event.orderId,
      });
    }
    while (intentionalEntrySuppressions.size > 2_000) {
      const oldest = intentionalEntrySuppressions.keys().next().value as string | undefined;
      if (!oldest) break;
      intentionalEntrySuppressions.delete(oldest);
    }
  };

  const leaderReducingQuantityFor = (event: LeaderEvent): number => {
    if (event.kind !== 'submitted' && event.kind !== 'filled') return 0;
    const cached = leaderReducingQuantityByEventId.get(event.id);
    if (cached != null) return cached;
    const preNet = leaderPreFillNetByEventId.get(event.id) ?? 0;
    return reducingQuantityAgainst(preNet, event.side, event.quantity);
  };

  const blockDuringPause = async (
    event: LeaderEvent,
    record = true,
    eventToRecord: LeaderEvent = event,
    allowReducingSlice = false,
  ): Promise<boolean> => {
    const safety = currentRuntime().state.safety;
    const now = event.receivedAt;
    if (gate.shadowMode || safety.dayLockUntil > now || !leaderEventIncreasesExposure(event)) return false;
    if (dayLockPending) {
      const splitExit = allowReducingSlice && leaderReducingQuantityFor(event) > 0;
      rememberIntentionalEntrySuppression(event);
      if (record && !splitExit) {
        const recorded = await processor.record({ event: eventToRecord, group, clock, store: options.store });
        runtime = recorded.runtime;
        if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      }
      options.onAudit?.([{
        at: event.receivedAt,
        leaderEventId: event.id,
        kind: 'blocked',
        rule: dayLockPending.trigger === 'manual' ? undefined : dayLockPending.trigger,
        reason: `day-lock-pending:${dayLockPending.trigger}`,
      }]);
      if (event.kind === 'submitted') rememberBlockedLeaderEntryOrder(event.orderId);
      return !splitExit;
    }
    if ((safety.pauseUntil ?? 0) <= now || safety.pauseRule == null) return false;
    const splitExit = allowReducingSlice && leaderReducingQuantityFor(event) > 0;
    rememberIntentionalEntrySuppression(event);
    if (record && !splitExit) {
      const recorded = await processor.record({ event: eventToRecord, group, clock, store: options.store });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
    }
    options.onAudit?.([{
      at: event.receivedAt,
      leaderEventId: event.id,
      kind: 'blocked',
      rule: safety.pauseRule,
      until: safety.pauseUntil,
      reason: `pause:${safety.pauseRule}:${safety.pauseUntil}`,
    }]);
    if (event.kind === 'submitted') rememberBlockedLeaderEntryOrder(event.orderId);
    return !splitExit;
  };

  const blockOutsideTradingWindow = async (
    event: LeaderEvent,
    allowReducingSlice = false,
  ): Promise<boolean> => {
    const window = group.safety?.tradingWindow ?? DEFAULT_COPY_GROUP_SAFETY.tradingWindow;
    if (!window.enabled
      || gate.shadowMode
      || tradingWindowStateAt(window, event.receivedAt) === 'inside'
      || !leaderEventIncreasesExposure(event)) return false;
    const splitExit = allowReducingSlice && leaderReducingQuantityFor(event) > 0;
    rememberIntentionalEntrySuppression(event);
    if (!splitExit) {
      const recorded = await processor.record({ event, group, clock, store: options.store });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
    }
    options.onAudit?.([{
      at: event.receivedAt,
      leaderEventId: event.id,
      kind: 'blocked',
      reason: `trading-window-outside ${window.from}-${window.to} ${window.timeZone}`,
    }]);
    if (event.kind === 'submitted') rememberBlockedLeaderEntryOrder(event.orderId);
    return !splitExit;
  };

  const pendingExposureRemaining = (
    pending: CurrentRuntimePendingExposure,
  ) => Math.max(
    0,
    pending.quantity - Math.max(pending.orderReportedFilled, pending.fillReportedQuantity),
  );

  const rememberCurrentRuntimePendingExposure = (
    plan: {
      orders: readonly {
        key: string;
        request: {
          accountId: number;
          symbol: string;
          side: 'Buy' | 'Sell';
          quantity: number;
        };
      }[];
    },
    audit: readonly CopierAuditEntry[],
  ): void => {
    if (!gate.armed || gate.shadowMode) return;
    const live = currentRuntime();
    for (const planned of plan.orders) {
      const dispatched = audit.find(entry => (
        entry.kind === 'dispatched'
        && entry.key === planned.key
        && entry.accountId === planned.request.accountId
        && entry.brokerOrderId != null
        && !entry.brokerOrderId.includes(',')
        && !entry.brokerOrderId.startsWith('shadow:')
      ));
      if (!dispatched?.brokerOrderId) continue;
      const durable = live.outbox.get(planned.key);
      if (
        durable?.status !== 'acknowledged'
        || durable.brokerOrderId !== dispatched.brokerOrderId
        || leaderExposureIncreaseByEventId.get(durable.leaderEventId ?? '') !== true
        || durable.request.accountId !== planned.request.accountId
        || durable.request.symbol !== planned.request.symbol
        || durable.request.side !== planned.request.side
        || durable.request.quantity !== planned.request.quantity
      ) continue;
      currentRuntimePendingExposure.set(dispatched.brokerOrderId, {
        key: planned.key,
        accountId: planned.request.accountId,
        symbol: planned.request.symbol,
        side: planned.request.side,
        quantity: planned.request.quantity,
        orderReportedFilled: 0,
        fillReportedQuantity: 0,
      });
    }
  };

  const rememberCurrentRuntimePendingOsoExposure = (
    audit: readonly CopierAuditEntry[],
  ): void => {
    if (!gate.armed || gate.shadowMode) return;
    const live = currentRuntime();
    for (const dispatched of audit) {
      if (
        dispatched.kind !== 'dispatched'
        || dispatched.reason !== 'native-oso'
        || !dispatched.key
        || !dispatched.brokerOrderId
      ) continue;
      const entry = live.osoOutbox.get(dispatched.key);
      if (
        entry?.status !== 'acknowledged'
        || !entry.entryBrokerOrderId
        || entry.entryBrokerOrderId.startsWith('shadow:')
        || dispatched.brokerOrderId.split(',')[0] !== entry.entryBrokerOrderId
        || leaderExposureIncreaseByEventId.get(entry.leaderEventId) !== true
      ) continue;
      currentRuntimePendingExposure.set(entry.entryBrokerOrderId, {
        key: entry.key,
        accountId: entry.request.accountId,
        symbol: entry.request.symbol,
        side: entry.request.side,
        quantity: entry.request.quantity,
        orderReportedFilled: 0,
        fillReportedQuantity: 0,
      });
    }
  };

  const observeCurrentRuntimePendingExposure = (event: BrokerEvent): void => {
    if (event.type === 'order') {
      const pending = currentRuntimePendingExposure.get(event.order.brokerOrderId);
      if (!pending) return;
      if (
        event.order.accountId !== pending.accountId
        || event.order.symbol !== pending.symbol
        || event.order.side !== pending.side
        || event.order.quantity !== pending.quantity
        || !Number.isFinite(event.order.filledQuantity)
        || event.order.filledQuantity < 0
        || event.order.filledQuantity > pending.quantity
      ) {
        currentRuntimePendingExposure.delete(event.order.brokerOrderId);
        return;
      }
      const updated = {
        ...pending,
        orderReportedFilled: Math.max(pending.orderReportedFilled, event.order.filledQuantity),
      };
      if (
        event.order.status === 'filled'
        || event.order.status === 'canceled'
        || event.order.status === 'rejected'
        || pendingExposureRemaining(updated) === 0
      ) currentRuntimePendingExposure.delete(event.order.brokerOrderId);
      else currentRuntimePendingExposure.set(event.order.brokerOrderId, updated);
      return;
    }
    if (event.type !== 'fill' || seenCurrentRuntimePendingFillIds.has(event.fill.fillId)) return;
    const pending = currentRuntimePendingExposure.get(event.fill.brokerOrderId);
    if (!pending) return;
    seenCurrentRuntimePendingFillIds.add(event.fill.fillId);
    while (seenCurrentRuntimePendingFillIds.size > 2_048) {
      const oldest = seenCurrentRuntimePendingFillIds.values().next().value as string | undefined;
      if (!oldest) break;
      seenCurrentRuntimePendingFillIds.delete(oldest);
    }
    if (
      event.fill.accountId !== pending.accountId
      || event.fill.symbol !== pending.symbol
      || event.fill.side !== pending.side
      || !Number.isFinite(event.fill.quantity)
      || event.fill.quantity <= 0
    ) {
      currentRuntimePendingExposure.delete(event.fill.brokerOrderId);
      return;
    }
    const updated = {
      ...pending,
      fillReportedQuantity: pending.fillReportedQuantity + event.fill.quantity,
    };
    if (updated.fillReportedQuantity > pending.quantity || pendingExposureRemaining(updated) === 0) {
      currentRuntimePendingExposure.delete(event.fill.brokerOrderId);
    } else {
      currentRuntimePendingExposure.set(event.fill.brokerOrderId, updated);
    }
  };

  const currentRuntimePendingNet = (accountId: number, symbol: string): number => {
    let net = 0;
    for (const pending of currentRuntimePendingExposure.values()) {
      if (pending.accountId !== accountId || pending.symbol !== symbol) continue;
      const remaining = pendingExposureRemaining(pending);
      net += (pending.side === 'Buy' ? 1 : -1) * remaining;
    }
    return net;
  };

  const cutAwareDispatchFor = (
    event: LeaderEvent,
    increasesExposure: boolean,
  ): {
    dispatchGroup: CopyGroupConfig;
    ineligibleAccounts: ReadonlyMap<number, string>;
    unsafeDivergenceAccounts: number[];
    exitOnlyAccounts: number[];
  } => {
    const at = event.receivedAt;
    if (event.kind !== 'submitted' && event.kind !== 'filled') {
      return {
        dispatchGroup: group,
        ineligibleAccounts: increasesExposure
          ? currentEntryIneligibleAccounts(at)
          : currentExitIneligibleAccounts(at),
        unsafeDivergenceAccounts: [],
        exitOnlyAccounts: [],
      };
    }
    const ineligibleAccounts = new Map(
      increasesExposure ? currentEntryIneligibleAccounts(at) : currentExitIneligibleAccounts(at),
    );
    const preNet = leaderPreFillNetByEventId.get(event.id) ?? 0;
    const leaderReducingQuantity = leaderReducingQuantityFor(event);
    if (leaderReducingQuantity <= 0) {
      return {
        dispatchGroup: group,
        ineligibleAccounts,
        unsafeDivergenceAccounts: [],
        exitOnlyAccounts: [],
      };
    }

    let changed = false;
    const basisQuantity = event.kind === 'filled'
      ? event.cumulativeQuantity ?? event.quantity
      : event.quantity;
    const safety = currentRuntime().state.safety;
    const tradingWindow = group.safety?.tradingWindow ?? DEFAULT_COPY_GROUP_SAFETY.tradingWindow;
    const entryRestrictionActive = increasesExposure && !gate.shadowMode && (
      dayLockPending != null
      || ((safety.pauseUntil ?? 0) > at && safety.pauseRule != null)
      || (tradingWindow.enabled
        && tradingWindowStateAt(tradingWindow, event.receivedAt) !== 'inside')
      || blockedLeaderEntryOrderIds.has(event.orderId)
    );
    const eligibilityIneligible = currentIneligibleAccounts(at);
    const unsafeDivergenceAccounts: number[] = [];
    const exitOnlyAccounts: number[] = [];
    const followers = group.followers.map(follower => {
      const cut = activeFollowerCut(follower.accountId, at);
      const letRunCut = cut != null && (follower.onCut ?? 'close-copy') === 'let-run';
      const modeAcceptsEvent = (event.kind === 'filled' && follower.mode === 'on-fill')
        || (event.kind === 'submitted' && follower.mode === 'on-submit');
      if (!modeAcceptsEvent || (cut && !letRunCut)) {
        return follower;
      }
      const positionSnapshot = positionsByAccount.get(follower.accountId);
      // Reconciliation ukládá autoritativní mapu účtu; chybějící symbol v
      // existující mapě znamená flat, nikoli „neznámý“. Jinak by follower,
      // kterému pauza zablokovala entry z flat, dostal pozdější Sell exit a
      // otevřel se do shortu.
      const hasPositionSnapshot = positionSnapshot != null;
      const followerNet = positionSnapshot?.get(event.symbol) ?? 0;
      const expectedPreNet = Math.trunc(preNet * follower.multiplier);
      const pendingNet = currentRuntimePendingNet(follower.accountId, event.symbol);
      const actualPositionHasCurrentLineage = followerNet === 0
        || copiedEntryLineage(follower.accountId, event.symbol, followerNet);
      const exactCurrentPendingExposure = hasPositionSnapshot
        && followerNet !== expectedPreNet
        && pendingNet !== 0
        && followerNet + pendingNet === expectedPreNet
        && expectedPreNet !== 0
        && Math.sign(pendingNet) === Math.sign(expectedPreNet)
        && (followerNet === 0 || Math.sign(followerNet) === Math.sign(expectedPreNet))
        && Math.abs(followerNet) <= Math.abs(expectedPreNet)
        && actualPositionHasCurrentLineage
        // Pending entry smí vysvětlit jen čistý exit/redukci. U mixed
        // reversal by stejná výjimka mohla poslat otevírací slice do reverse.
        && leaderReducingQuantity === event.quantity;
      const divergedFromLeaderTarget = hasPositionSnapshot && (
        pendingNet !== 0
          ? !exactCurrentPendingExposure
          : followerNet !== expectedPreNet
      );
      const suppressionKey = intentionalSuppressionKey(follower.accountId, event.symbol);
      let suppression = intentionalEntrySuppressions.get(suppressionKey);
      const reservedByGroup = new Map<string, number>();
      for (const reservation of exitOnlyReservations.values()) {
        if (reservation.accountId !== follower.accountId || reservation.symbol !== event.symbol) continue;
        reservedByGroup.set(
          reservation.groupKey,
          Math.max(reservedByGroup.get(reservation.groupKey) ?? 0, reservation.remaining),
        );
      }
      const reservedExitQuantity = [...reservedByGroup.values()]
        .reduce((sum, remaining) => sum + remaining, 0);
      // Leader se může vlastním risk-redukujícím pohybem vrátit přesně na
      // followerův držený stav. Tím divergence zanikla bez follower obchodu
      // a stará suppression lineage už nesmí autorizovat budoucí zásahy.
      if (
        suppression
        && hasPositionSnapshot
        && followerNet === suppression.allowedNet
        && followerNet === expectedPreNet
        && reservedExitQuantity === 0
        && !entryRestrictionActive
      ) {
        intentionalEntrySuppressions.delete(suppressionKey);
        suppression = undefined;
      }
      const documentedSuppression = suppression != null
        && hasPositionSnapshot
        && followerNet === suppression.allowedNet;
      if (
        divergedFromLeaderTarget
        && !letRunCut
        && !entryRestrictionActive
        && !documentedSuppression
      ) {
        unsafeDivergenceAccounts.push(follower.accountId);
        ineligibleAccounts.set(
          follower.accountId,
          `unexplained-position-divergence:${event.symbol}:${followerNet}:${expectedPreNet}`,
        );
        return { ...follower, mode: 'off' as const };
      }
      if (suppression && !documentedSuppression && !letRunCut) {
        unsafeDivergenceAccounts.push(follower.accountId);
        ineligibleAccounts.set(
          follower.accountId,
          `suppression-lineage-mismatch:${event.symbol}:${followerNet}:${suppression.allowedNet}`,
        );
        return { ...follower, mode: 'off' as const };
      }
      if (!letRunCut && !entryRestrictionActive && !documentedSuppression) return follower;

      const orderSign = event.side === 'Buy' ? 1 : -1;
      const reducingCapacity = hasPositionSnapshot
        && followerNet !== 0
        && Math.sign(followerNet) !== orderSign
        ? Math.max(0, Math.abs(followerNet) - reservedExitQuantity)
        : 0;
      const previousTarget = event.kind === 'filled'
        ? currentRuntime().state.followerFillTargets.get(`${event.orderId}:${follower.accountId}`) ?? 0
        : 0;
      // Exit-only množství se odvozuje z cílové POZICE po leader redukci,
      // nikoli z floor(quantity * multiplier) jedné objednávky. Jinak např.
      // leader +2 / follower +1 při multiplieru 0.5 a Sell1 nikdy followera
      // nezavře, přestože nový správný follower target je 0.
      const postLeaderNet = preNet + orderSign * event.quantity;
      const sameDirectionPostLeaderNet = preNet !== 0
        && postLeaderNet !== 0
        && Math.sign(postLeaderNet) === Math.sign(preNet)
        ? postLeaderNet
        : 0;
      const desiredFollowerNet = Math.trunc(sameDirectionPostLeaderNet * follower.multiplier);
      const projectedFollowerAbs = Math.max(0, Math.abs(followerNet) - reservedExitQuantity);
      const desiredFollowerAbs = Math.sign(desiredFollowerNet) === Math.sign(followerNet)
        ? Math.abs(desiredFollowerNet)
        : 0;
      const requiredReduction = Math.max(0, projectedFollowerAbs - desiredFollowerAbs);
      const exitOnlyIncrement = Math.min(requiredReduction, reducingCapacity);
      if (exitOnlyIncrement <= 0 || basisQuantity <= 0) {
        changed = true;
        return { ...follower, mode: 'off' as const };
      }
      const targetAfterExitSlice = previousTarget + exitOnlyIncrement;
      // planReplication počítá floor(basis * multiplier)-previousTarget.
      // Malý vnitřní zlomek drží floor přesně na požadovaném integeru.
      const sliceMultiplier = (targetAfterExitSlice + 0.25) / basisQuantity;
      changed = true;
      exitOnlyAccounts.push(follower.accountId);
      if (!eligibilityIneligible.has(follower.accountId)) ineligibleAccounts.delete(follower.accountId);
      return { ...follower, multiplier: sliceMultiplier };
    });
    return {
      dispatchGroup: changed ? { ...group, followers } : group,
      ineligibleAccounts,
      unsafeDivergenceAccounts,
      exitOnlyAccounts,
    };
  };

  const rememberExitOnlyReservations = (
    exitOnlyAccounts: readonly number[],
    plan: { orders: readonly { key: string; request: { accountId: number; symbol: string; quantity: number } }[] },
    audit: readonly CopierAuditEntry[],
  ): void => {
    const accounts = new Set(exitOnlyAccounts);
    if (accounts.size === 0) return;
    for (const order of plan.orders) {
      if (!accounts.has(order.request.accountId)) continue;
      const dispatched = audit.find(entry => (
        entry.kind === 'dispatched'
        && entry.key === order.key
        && entry.accountId === order.request.accountId
        && entry.brokerOrderId
      ));
      if (!dispatched?.brokerOrderId) continue;
      exitOnlyReservations.set(dispatched.brokerOrderId, {
        accountId: order.request.accountId,
        symbol: order.request.symbol,
        remaining: order.request.quantity,
        groupKey: dispatched.brokerOrderId,
      });
    }
  };

  const sweepExitOnlyReservationsAtFlat = async (
    accountId: number,
    symbol: string,
    at: number,
  ): Promise<void> => {
    const reservedIds = [...exitOnlyReservations]
      .filter(([, reservation]) => (
        reservation.accountId === accountId && reservation.symbol === symbol
      ))
      .map(([brokerOrderId]) => brokerOrderId);
    if (reservedIds.length === 0) return;
    let orders: BrokerOrder[];
    try {
      orders = await withSweepDeadline(broker.listOrders(accountId));
    } catch (reason) {
      failClosed(new Error(
        `Copier fail-closed: po follower flat nelze ověřit exit-only příkazy ${accountId}/${symbol}: ${errorOf(reason).message}`,
      ), { autoClose: false });
      return;
    }
    const byId = new Map(orders.map(order => [order.brokerOrderId, order]));
    const failures: string[] = [];
    for (const brokerOrderId of reservedIds) {
      const order = byId.get(brokerOrderId);
      if (order?.status === 'filled') {
        // Position projekce předběhla Fill entity tohoto příkazu. Rezervace
        // zůstane do fillu, ale fill už nesmí aritmeticky aplikovat pozici podruhé.
        exitOnlyPositionApplied.add(brokerOrderId);
        continue;
      }
      if (order && !isOpenOrderStatus(order.status)) {
        exitOnlyReservations.delete(brokerOrderId);
        exitOnlyPositionApplied.delete(brokerOrderId);
        if (followerFillRole(accountId, brokerOrderId) === 'protective') {
          sweptProtectiveLegs.add(brokerOrderId);
        }
        continue;
      }
      if (!order) {
        failures.push(`${brokerOrderId}: broker order chybí`);
        continue;
      }
      try {
        // Cancel timeout není důkaz neúspěchu. Stejně jako durable cancel
        // cesta vždy rozhoduje až následný lookup; další pokus smí vzniknout
        // jen z nového snapshotu, který objednávku znovu ukáže jako working.
        await withSweepDeadline(broker.cancelOrder(accountId, brokerOrderId)).catch(() => undefined);
        const verified = await withSweepDeadline(broker.findOrderById(accountId, brokerOrderId));
        if (verified.order && isOpenOrderStatus(verified.order.status)) {
          failures.push(`${brokerOrderId}: po cancelu stále ${verified.order.status}`);
          continue;
        }
        if (!verified.order && verified.completeness !== 'authoritative') {
          failures.push(`${brokerOrderId}: eventual lookup nepotvrdil zrušení`);
          continue;
        }
        exitOnlyReservations.delete(brokerOrderId);
        exitOnlyPositionApplied.delete(brokerOrderId);
        if (followerFillRole(accountId, brokerOrderId) === 'protective') {
          sweptProtectiveLegs.add(brokerOrderId);
        }
        options.onAudit?.([{
          at,
          leaderEventId: `exit-only-flat-sweep:${accountId}:${brokerOrderId}`,
          kind: 'canceled',
          accountId,
          brokerOrderId,
          reason: 'follower je flat — zbývající exit-only příkaz zrušen proti reverse fillu',
        }]);
      } catch (reason) {
        failures.push(`${brokerOrderId}: ${errorOf(reason).message}`);
      }
    }
    if (failures.length > 0) {
      failClosed(new Error(
        `Copier fail-closed: exit-only sweep ${accountId}/${symbol} selhal (${failures.join(', ')})`,
      ), { autoClose: false });
    }
  };

  const handleBrokerEvent = async (event: BrokerEvent) => {
    if (stopped) return;
    const now = clock();
    if (event.type === 'heartbeat') {
      gate = { ...gate, lastHeartbeatAt: event.at };
      await maybeHandleArmExpiry(now);
      await evaluateDailyRules(now);
      scheduleAccountRiskPoll(
        [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)],
      );
      return;
    }
    if (event.type === 'error') {
      currentRuntimePendingExposure.clear();
      seenCurrentRuntimePendingFillIds.clear();
      failClosed(event.error, { transportLost: true });
      return;
    }
    if (event.type === 'connection') {
      const wasArmed = gate.armed;
      if (!event.connected) {
        currentRuntimePendingExposure.clear();
        seenCurrentRuntimePendingFillIds.clear();
      }
      // Výpadek za živého ARM s otevřenými kopiemi → po reconnectu se
      // rozhodne „podle stavu" (držet synchronní / zavřít osiřelé).
      if (!event.connected && gate.armed && !gate.shadowMode && hasFollowerExposure()) {
        pendingConnectionRecovery = true;
      }
      if (!event.connected && wasArmed) {
        recordDisarm(
          'transport',
          'Spojení k brokerovi bylo přerušeno',
          groupIsFlat() ? 'flat' : 'unknown',
        );
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
      // synchronní, runtime je bezpečně drží DISARMED. Nový LIVE ARM je navíc
      // povolen jen z autoritativně flat stavu.
      if (!event.connected || source.needsReconciliation() || event.resynced) {
        invalidateReconciliation();
        if (event.resynced) pendingConnectionRecovery = true;
      }
      if (event.connected) {
        // Boot po pádu: durable stopa říká, že kopie vznikly za živého ARM.
        if (!bootRecoveryChecked) {
          bootRecoveryChecked = true;
          const hasRecoverableLeaderFlatEpoch = currentRuntime().state.safety.leaderExposureEpochs
            ?.some(epoch => (
              epoch.groupId === group.id
              && epoch.leaderAccountId === group.leaderAccountId
              && (
                epoch.phase === 'open'
                || epoch.phase === 'grace'
                || epoch.phase === 'waiting-inflight'
                || epoch.phase === 'closing'
                || epoch.phase === 'blocked'
              )
            )) === true;
          if (
            currentRuntime().state.safety.liveCopyOpenSince != null
            || hasRecoverableLeaderFlatEpoch
          ) pendingConnectionRecovery = true;
        }
        if (pendingConnectionRecovery) scheduleConnectionRecovery();
      }
      return;
    }
    await maybeHandleArmExpiry(now);
    if (rollEligibilityToNewSession(now)) await persistEligibility();
    await evaluateDailyRules(now);
    observeCurrentRuntimePendingExposure(event);
    if (event.type === 'fill' && event.fill.accountId !== group.leaderAccountId) {
      const reservation = exitOnlyReservations.get(event.fill.brokerOrderId);
      if (reservation) {
        if (event.fill.quantity > reservation.remaining) {
          failClosed(new Error(
            `Copier fail-closed: exit-only fill ${event.fill.brokerOrderId} překročil rezervaci ${reservation.remaining}`,
          ), { autoClose: false });
        }
        const applied = Math.min(reservation.remaining, event.fill.quantity);
        const accountPositions = positionsByAccount.get(reservation.accountId);
        const cachedNet = accountPositions?.get(reservation.symbol) ?? 0;
        const signedFill = event.fill.side === 'Buy' ? applied : -applied;
        const positionAlreadyApplied = exitOnlyPositionApplied.delete(event.fill.brokerOrderId);
        const reducesCachedPosition = cachedNet !== 0
          && Math.sign(cachedNet) !== Math.sign(signedFill)
          && applied <= Math.abs(cachedNet);
        if (!positionAlreadyApplied && (!accountPositions || !reducesCachedPosition)) {
          failClosed(new Error(
            `Copier fail-closed: exit-only fill ${event.fill.brokerOrderId} nemá bezpečnou pre-fill pozici `
            + `${reservation.symbol}:${cachedNet}`,
          ), { autoClose: false });
        }
        const projectedNet = positionAlreadyApplied ? cachedNet : cachedNet + signedFill;
        if (!positionAlreadyApplied && accountPositions && reducesCachedPosition) {
          accountPositions.set(reservation.symbol, projectedNet);
        }
        const suppressionKey = intentionalSuppressionKey(
          reservation.accountId,
          reservation.symbol,
        );
        const suppression = intentionalEntrySuppressions.get(suppressionKey);
        if (suppression && applied > 0 && (positionAlreadyApplied || reducesCachedPosition)) {
          const nextAllowedNet = suppression.allowedNet + signedFill;
          const safelyReduced = Math.abs(nextAllowedNet) <= Math.abs(suppression.allowedNet)
            && (
              nextAllowedNet === 0
              || Math.sign(nextAllowedNet) === Math.sign(suppression.allowedNet)
            );
          if (safelyReduced) {
            intentionalEntrySuppressions.set(suppressionKey, {
              ...suppression,
              allowedNet: nextAllowedNet,
            });
          } else {
            failClosed(new Error(
              `Copier fail-closed: exit-only fill ${event.fill.brokerOrderId} nezmenšil povolenou expozici`,
            ), { autoClose: false });
          }
        }
        const remaining = Math.max(0, reservation.remaining - event.fill.quantity);
        if (remaining === 0) exitOnlyReservations.delete(event.fill.brokerOrderId);
        else exitOnlyReservations.set(event.fill.brokerOrderId, { ...reservation, remaining });
        // OCO/OSO sourozenci jsou alternativy téže kapacity. Po částečném
        // fillu se jejich lokální rezervace smí nejvýš rovnat zbývající
        // skutečné expozici. Ve flat stavu se ale rezervace nesmí jen smazat:
        // každá stále working noha se musí nejdřív autoritativně zrušit, jinak
        // by její pozdější fill otevřel reverse pozici.
        const remainingCapacity = Math.abs(projectedNet);
        if (remainingCapacity === 0 && (positionAlreadyApplied || reducesCachedPosition)) {
          if (!positionAlreadyApplied) {
            exitOnlyFlatFillAwaitingPosition.add(followerTransitionKey(
              reservation.accountId,
              reservation.symbol,
            ));
          }
          await sweepExitOnlyReservationsAtFlat(
            reservation.accountId,
            reservation.symbol,
            now,
          );
        } else {
          for (const [brokerOrderId, sibling] of exitOnlyReservations) {
            if (sibling.groupKey !== reservation.groupKey) continue;
            if (sibling.remaining > remainingCapacity) {
              exitOnlyReservations.set(brokerOrderId, {
                ...sibling,
                remaining: remainingCapacity,
              });
            }
          }
        }
      }
    }
    // Tradovate může poslat Order=Filled před odpovídajícím Fill/Position.
    // Rezervaci proto uvolní až fill; okamžitě ji ruší jen definitivně
    // neprovedené příkazy.
    if (event.type === 'order'
      && (event.order.status === 'canceled' || event.order.status === 'rejected')) {
      exitOnlyReservations.delete(event.order.brokerOrderId);
      exitOnlyPositionApplied.delete(event.order.brokerOrderId);
    }
    if (event.type === 'fill'
      && [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)]
        .includes(event.fill.accountId)) {
      scheduleAccountRiskPoll([event.fill.accountId], true);
      if (event.fill.accountId !== group.leaderAccountId) {
        await trackFollowerRiskFill(event.fill, event.fill.filledAt > 0 ? event.fill.filledAt : now);
      }
    }
    if (event.type === 'fill' && event.fill.accountId !== group.leaderAccountId) {
      rememberFollowerFillCause(event.fill, now);
      const cachedNet = positionsByAccount.get(event.fill.accountId)?.get(event.fill.symbol) ?? 0;
      if (
        cachedNet !== 0
        && Math.sign(cachedNet) === (event.fill.side === 'Buy' ? 1 : -1)
        && followerFillRole(event.fill.accountId, event.fill.brokerOrderId) === 'copied-entry'
      ) {
        // Kryje opačné pořadí streamu: Position dorazila před Fillem. Teprve
        // přesný brokerOrderId copier-issued entry smí posílit ownership.
        await strengthenLeaderFlatLineage(
          event.fill.accountId,
          event.fill.symbol,
          cachedNet,
        );
      }
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
      const rejection = await recordAccountRejection(order, now);
      if (rejection.processed) {
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
        const acknowledged = rejection.acknowledged;
        if (acknowledged) {
          options.onAudit?.([{
            at: now, leaderEventId: acknowledged.leaderEventId ?? `async-reject-${order.brokerOrderId}`,
            kind: 'rejected', accountId: order.accountId, key: acknowledged.key,
            brokerOrderId: order.brokerOrderId, reason: rejection.auditReason,
          }]);
        }
      }
      // Source musí i duplicitní událost dostat: u leadera může jeho vlastní
      // durable lifecycle cesta dokončit cancel po pádu mezi dvěma commity.
      // Přeskakuje se jen už hotová přímá reject/eligibility/outbox větev.
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
      const transitionKey = followerTransitionKey(event.position.accountId, event.position.symbol);
      const exitOnlyFillReachedFlat = exitOnlyFlatFillAwaitingPosition.delete(transitionKey);
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
        && event.position.netQuantity === 0
        && (previousAccountNet !== 0 || exitOnlyFillReachedFlat)
      ) {
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
        await sweepExitOnlyReservationsAtFlat(
          event.position.accountId,
          event.position.symbol,
          now,
        );
      }
      if (
        event.position.accountId !== group.leaderAccountId
        && event.position.netQuantity !== 0
      ) {
        await strengthenLeaderFlatLineage(
          event.position.accountId,
          event.position.symbol,
          event.position.netQuantity,
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
        && !activeFollowerCut(event.position.accountId)
      ) {
        const transitionKey = followerTransitionKey(event.position.accountId, event.position.symbol);
        const cause = recentFollowerFillCauses.get(transitionKey);
        const sign = Math.sign(event.position.netQuantity);
        if (
          cause
          && cause.sign === sign
          && now - cause.observedAt <= followerTransitionCorrelationWindowMs
        ) {
          if (cause.role === 'protective') {
            recentFollowerFillCauses.delete(transitionKey);
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
      if (event.position.accountId !== group.leaderAccountId) {
        const follower = group.followers.find(item => item.accountId === event.position.accountId);
        if (follower
          && follower.mode !== 'off'
          && !currentIneligibleAccounts().has(follower.accountId)
          && !activeFollowerCut(follower.accountId)) {
          const expected = Math.trunc(
            (leaderPositions.get(event.position.symbol) ?? 0) * follower.multiplier,
          );
          const leaderNet = leaderPositions.get(event.position.symbol) ?? 0;
          if (leaderNet !== 0 && event.position.netQuantity !== expected) {
            scheduleFollowerMagnitudeCheck(follower.accountId, event.position.symbol);
          } else {
            clearPendingFollowerMagnitudeCheck(follower.accountId, event.position.symbol);
          }
        }
      }
      if (event.position.accountId === group.leaderAccountId) {
        const previousKnown = leaderPositions.has(event.position.symbol);
        const previousNet = leaderPositions.get(event.position.symbol) ?? 0;
        await handleLeaderPositionTransition(
          event.position.symbol,
          previousKnown,
          previousNet,
          event.position.netQuantity,
          now,
        );
        leaderPositions.set(event.position.symbol, event.position.netQuantity);
        for (const follower of group.followers) {
          const followerNet = positionsByAccount.get(follower.accountId)?.get(event.position.symbol) ?? 0;
          const suppression = intentionalEntrySuppressions.get(
            intentionalSuppressionKey(follower.accountId, event.position.symbol),
          );
          if (follower.mode === 'off'
            || currentIneligibleAccounts().has(follower.accountId)
            || activeFollowerCut(follower.accountId)
            || (suppression != null && followerNet === suppression.allowedNet)) continue;
          const expected = Math.trunc(event.position.netQuantity * follower.multiplier);
          if (event.position.netQuantity !== 0 && followerNet !== expected) {
            scheduleFollowerMagnitudeCheck(follower.accountId, event.position.symbol);
          } else {
            clearPendingFollowerMagnitudeCheck(follower.accountId, event.position.symbol);
          }
        }
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
      // Musí proběhnout před `trackLeaderFill`: ten uzavře durable lot.
      // Když Position=0 dorazila před Fillem, právě tento pre-fill lot
      // zůstává autoritativním důkazem, že jde o exit, ne nový entry.
      preclassifyLeaderFillExposure(event.fill);
      // Atribuce exitu (SL/TP/ručně): flat přechod se páruje s objednávkou
      // posledního fillu daného symbolu.
      lastLeaderFillOrderId.set(event.fill.symbol, event.fill.brokerOrderId);
      const flatEpoch = leaderExposureEpoch(event.fill.symbol);
      if (
        flatEpoch
        && (leaderPositions.get(event.fill.symbol) ?? 0) === 0
        && (
          flatEpoch.phase === 'grace'
          || flatEpoch.phase === 'waiting-inflight'
          || flatEpoch.phase === 'closing'
        )
        && !flatEpoch.leaderExitOrderIds.includes(event.fill.brokerOrderId)
      ) {
        // WebSocket smí doručit Position=0 před závěrečným Fillem. Pozdní
        // fill doplní exit lineage do už naplánované epochy bez změny jejího
        // generation tokenu, aby guard poznal rozjetý follower exit a
        // nevytvořil druhý.
        await persistLeaderExposureEpoch(mergeLeaderFlatEpochLineage(flatEpoch, {
          leaderExitOrderIds: [event.fill.brokerOrderId],
        }));
      }
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
    // Stabilní klasifikace pro všechny následující větve této události;
    // nesmí se změnit jen proto, že mezitím dorazí Position projekce.
    const eventIncreasesExposure = leaderEventIncreasesExposure(leaderEvent);
    if (leaderEvent.kind === 'filled' && eventIncreasesExposure) {
      const previouslyBlockedEntry = blockedLeaderEntryOrderIds.has(leaderEvent.orderId);
      const blockedWithoutExitSlice = previouslyBlockedEntry
        && leaderReducingQuantityFor(leaderEvent) <= 0;
      let blockedByPause = false;
      let blockedByWindow = false;
      if (blockedWithoutExitSlice) {
        // Submitted entry byl tombstonován během pauzy/okna. Když jeho fill
        // dorazí až po expiraci, on-fill follower ho stále úmyslně vynechá;
        // přesná suppression lineage zabrání, aby následná Position projekce
        // tento očekávaný rozdíl mylně vyhodnotila jako incident a DISARM.
        rememberIntentionalEntrySuppression(leaderEvent);
        const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
        runtime = recorded.runtime;
        if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
        options.onAudit?.([{
          at: now,
          leaderEventId: leaderEvent.id,
          kind: 'blocked',
          reason: `fill-of-blocked-entry:${leaderEvent.orderId}`,
        }]);
      } else {
        blockedByPause = await blockDuringPause(leaderEvent, true, leaderEvent, true);
        blockedByWindow = blockedByPause ? false : await blockOutsideTradingWindow(leaderEvent, true);
      }
      if (blockedWithoutExitSlice || blockedByPause || blockedByWindow) {
        const linkedAccounts = new Set(
          (currentRuntime().state.links.get(leaderEvent.orderId) ?? []).map(link => link.accountId),
        );
        const hasExistingOnSubmitCopy = group.followers.some(follower => (
          follower.mode === 'on-submit' && linkedAccounts.has(follower.accountId)
        ));
        // Bracket korelátor smí fill podržet jen tehdy, když alespoň
        // jeden on-submit follower prokazatelně dostal jeho entry. Jinak je
        // orderId tombstone: pozdější SL/TP nesmí vytvořit naked OCO.
        bracketCorrelator.observe(leaderEvent);
        if (!hasExistingOnSubmitCopy) rememberBlockedLeaderEntryOrder(leaderEvent.orderId);
        return;
      }
    }
    const parentHasCopiedEntry = leaderEvent.parentOrderId != null
      && (currentRuntime().state.links.get(leaderEvent.parentOrderId)?.length ?? 0) > 0;
    const parentIsPendingOso = leaderEvent.parentOrderId != null
      && pendingOsoEvents.has(leaderEvent.parentOrderId);
    if (leaderEvent.kind === 'submitted'
      && leaderEvent.parentOrderId
      && (
        blockedLeaderEntryOrderIds.has(leaderEvent.parentOrderId)
        || (!parentHasCopiedEntry && !parentIsPendingOso)
      )) {
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      options.onAudit?.([{
        at: now,
        leaderEventId: leaderEvent.id,
        kind: 'blocked',
        reason: blockedLeaderEntryOrderIds.has(leaderEvent.parentOrderId)
          ? `protective-child-of-blocked-entry:${leaderEvent.parentOrderId}`
          : `protective-child-without-copied-entry:${leaderEvent.parentOrderId}`,
      }]);
      return;
    }
    const bracketPendingUpdated = bracketCorrelator.updatePending(leaderEvent);
    if (bracketPendingUpdated) {
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      if (recorded.audit.some(item => item.kind === 'sequence-broken')) {
        failClosed(new Error('Pending bracket replace přišel mimo pořadí'));
      }
      return;
    }
    const bracketPair = bracketCorrelator.observe(leaderEvent);
    const bracketEntryOrderId = bracketCorrelator.entryOrderIdForLeg(leaderEvent.orderId);
    if (bracketPair && blockedLeaderEntryOrderIds.has(bracketPair.entryOrderId)) {
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      const timer = pendingBracketTimers.get(bracketPair.entryOrderId);
      if (timer) clearTimeout(timer);
      pendingBracketTimers.delete(bracketPair.entryOrderId);
      bracketCorrelator.abandonPendingPair(bracketPair.entryOrderId);
      options.onAudit?.([{
        at: now,
        leaderEventId: leaderEvent.id,
        kind: 'blocked',
        reason: `protective-pair-of-blocked-entry:${bracketPair.entryOrderId}`,
      }]);
      return;
    }
    if (leaderEvent.kind === 'submitted' && bracketEntryOrderId) {
      if (blockedLeaderEntryOrderIds.has(bracketEntryOrderId)) {
        const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
        runtime = recorded.runtime;
        if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
        options.onAudit?.([{
          at: now,
          leaderEventId: leaderEvent.id,
          kind: 'blocked',
          reason: `protective-leg-of-blocked-entry:${bracketEntryOrderId}`,
        }]);
        return;
      }
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
            bracketCorrelator.abandonPendingPair(bracketEntryOrderId);
            options.onAudit?.([{
              at: clock(), leaderEventId: leaderEvent.id, kind: 'blocked',
              reason: 'incomplete-bracket-pair',
            }]);
            if (gate.armed) {
              failClosed(new Error(`Bracket ${bracketEntryOrderId} nemá bezpečně spárovaný SL i TP`));
            } else invalidateReconciliation();
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
          ineligibleAccounts: currentBracketIneligibleAccounts(bracketPair.entryOrderId),
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
      // Reporting attribution depends only on deterministic recognition of
      // the leader's protective pair, never on follower dispatch success.
      await rememberProtectiveLeg(bracketPair.stopOrderId, bracketPair.targetOrderId, now);
      if (!result.audit.some(isCriticalAuditEntry)) {
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
    if (
      leaderEvent.kind !== 'submitted'
      && !(
        leaderEvent.kind === 'replaced'
        && leaderEvent.executionShapeChanged === true
      )
      && pendingOsoEvents.has(leaderEvent.orderId)
    ) {
      await flushStandaloneOsoEntry(leaderEvent.orderId);
    }

    const osoObservation = osoCorrelator.observe(leaderEvent);
    if (osoObservation.kind === 'ambiguous') {
      options.onAudit?.([{
        at: now, leaderEventId: leaderEvent.id, kind: 'blocked', reason: osoObservation.reason,
      }]);
      if (gate.armed) failClosed(new Error(osoObservation.reason));
      else invalidateReconciliation();
      return;
    }
    if (osoObservation.kind === 'updated') {
      const pendingEntry = pendingOsoEvents.get(osoObservation.entryOrderId);
      if (pendingEntry && pendingEntry.orderId === leaderEvent.orderId) {
        // Entry se může posunout během korelačního okna. Až se okno dokončí,
        // musí se případný standalone follower entry vytvořit z nejnovější
        // ceny i uživatelsky změněné quantity, ale stále pod původním
        // submitted eventem. Protective leg quantity se zde nemění, protože
        // jeho orderId se entry orderId neshoduje.
        pendingOsoEvents.set(osoObservation.entryOrderId, {
          ...pendingEntry,
          orderType: leaderEvent.orderType,
          quantity: leaderEvent.quantity,
          limitPrice: leaderEvent.limitPrice,
          stopPrice: leaderEvent.stopPrice,
        });
      }
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      if (recorded.audit.some(item => item.kind === 'sequence-broken')) {
        failClosed(new Error('Pending OSO replace přišel mimo pořadí'));
      }
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
      const blockedByPause = await blockDuringPause(leaderEvent, true, leaderEvent, true);
      const blockedByWindow = blockedByPause ? false : await blockOutsideTradingWindow(leaderEvent, true);
      if (blockedByPause || blockedByWindow) {
        // Protective children mohou dorazit až po blocked entry. Korelaci
        // necháme doběhnout pouze kvůli sekvenci, ale označení zabrání tomu,
        // aby po mezitím vypršené pauze původní entry později ožil.
        blockedOsoEntries.add(leaderEvent.orderId);
        rememberBlockedLeaderEntryOrder(leaderEvent.orderId);
        pendingOsoEvents.set(leaderEvent.orderId, leaderEvent);
        const timer = setTimeout(() => {
          pendingOsoTimers.delete(leaderEvent.orderId);
          pendingOsoEvents.delete(leaderEvent.orderId);
          blockedOsoEntries.delete(leaderEvent.orderId);
          osoCorrelator.release(leaderEvent.orderId);
        }, osoCorrelator.pendingWindowMs() + 50);
        pendingOsoTimers.set(leaderEvent.orderId, timer);
        return;
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
      const adjustedDispatch = cutAwareDispatchFor(leaderEvent, eventIncreasesExposure);
      if (adjustedDispatch.unsafeDivergenceAccounts.length > 0) {
        pendingOsoEvents.delete(leaderEvent.orderId);
        const accounts = adjustedDispatch.unsafeDivergenceAccounts.join(', ');
        failClosed(new Error(
          `Copier fail-closed: nevysvětlená divergence účtů ${accounts} před OSO leader exitem ${leaderEvent.symbol}`,
        ), { autoClose: false });
        return;
      }
      const exitOnlyAccounts = new Set(adjustedDispatch.exitOnlyAccounts);
      const globalOpeningBlock = blockedLeaderEntryOrderIds.has(leaderEvent.orderId);
      const openingExcluded = globalOpeningBlock
        ? new Set(group.followers.map(follower => follower.accountId))
        : exitOnlyAccounts;
      if (openingExcluded.size > 0) {
        osoOpeningExcludedAccounts.set(leaderEvent.orderId, openingExcluded);
      }
      if (exitOnlyAccounts.size > 0) {
        const exitOnlyGroup: CopyGroupConfig = {
          ...adjustedDispatch.dispatchGroup,
          followers: adjustedDispatch.dispatchGroup.followers.map(follower => (
            exitOnlyAccounts.has(follower.accountId)
              ? follower
              : { ...follower, mode: 'off' as const }
          )),
        };
        const exitResult = await processor.process({
          event: leaderEvent,
          group: exitOnlyGroup,
          context: {
            ...gate,
            now,
            sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
            stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
            ineligibleAccounts: adjustedDispatch.ineligibleAccounts,
          },
          broker,
          clock,
          store: options.store,
          metrics,
          maxConcurrentDispatches: options.maxConcurrentDispatches,
        });
        runtime = exitResult.runtime;
        if (exitResult.audit.length > 0) options.onAudit?.(exitResult.audit);
        rememberExitOnlyReservations(
          adjustedDispatch.exitOnlyAccounts,
          exitResult.plan,
          exitResult.audit,
        );
        failClosedOnCriticalAudit(exitResult.audit);
      } else {
        const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
        runtime = recorded.runtime;
        if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      }
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
      const pendingEntry = pendingOsoEvents.get(pair.entryOrderId);
      const previouslyExcluded = osoOpeningExcludedAccounts.get(pair.entryOrderId) ?? new Set<number>();
      osoOpeningExcludedAccounts.delete(pair.entryOrderId);
      const entryWasBlocked = blockedOsoEntries.delete(pair.entryOrderId);
      const timer = pendingOsoTimers.get(pair.entryOrderId);
      if (timer) clearTimeout(timer);
      pendingOsoTimers.delete(pair.entryOrderId);
      pendingOsoEvents.delete(pair.entryOrderId);
      settleOsoFlush(pair.entryOrderId);
      if (entryWasBlocked) {
        const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
        runtime = recorded.runtime;
        if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
        options.onAudit?.([{
          at: now,
          leaderEventId: pendingEntry?.id ?? leaderEvent.id,
          kind: 'blocked',
          reason: 'blocked-oso-entry-remains-blocked',
        }]);
        return;
      }
      if (pendingEntry) {
        const blockedByPause = await blockDuringPause(pendingEntry, true, leaderEvent, true);
        const blockedByWindow = blockedByPause
          ? false
          : await blockOutsideTradingWindow(pendingEntry, true);
        if (blockedByPause || blockedByWindow) return;
      }
      const adjustedEntryDispatch = pendingEntry
        ? cutAwareDispatchFor(pendingEntry, leaderEventIncreasesExposure(pendingEntry))
        : null;
      if (adjustedEntryDispatch?.unsafeDivergenceAccounts.length) {
        const accounts = adjustedEntryDispatch.unsafeDivergenceAccounts.join(', ');
        failClosed(new Error(
          `Copier fail-closed: nevysvětlená divergence účtů ${accounts} před OSO leader exitem ${pair.symbol}`,
        ), { autoClose: false });
        return;
      }
      const exitOnlyAccounts = new Set(adjustedEntryDispatch?.exitOnlyAccounts ?? []);
      if (pendingEntry && adjustedEntryDispatch && exitOnlyAccounts.size > 0) {
        const exitOnlyGroup: CopyGroupConfig = {
          ...adjustedEntryDispatch.dispatchGroup,
          followers: adjustedEntryDispatch.dispatchGroup.followers.map(follower => (
            exitOnlyAccounts.has(follower.accountId)
              ? follower
              : { ...follower, mode: 'off' as const }
          )),
        };
        const exitResult = await processor.process({
          event: pendingEntry,
          group: exitOnlyGroup,
          context: {
            ...gate,
            now,
            sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
            stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
            ineligibleAccounts: adjustedEntryDispatch.ineligibleAccounts,
          },
          broker,
          clock,
          store: options.store,
          metrics,
          maxConcurrentDispatches: options.maxConcurrentDispatches,
          deferredReplay: true,
        });
        runtime = exitResult.runtime;
        if (exitResult.audit.length > 0) options.onAudit?.(exitResult.audit);
        rememberExitOnlyReservations(
          adjustedEntryDispatch.exitOnlyAccounts,
          exitResult.plan,
          exitResult.audit,
        );
        failClosedOnCriticalAudit(exitResult.audit);
        if (!gate.armed) return;
      }
      const openingExcluded = new Set([...previouslyExcluded, ...exitOnlyAccounts]);
      if (blockedLeaderEntryOrderIds.has(pair.entryOrderId)) {
        for (const follower of group.followers) openingExcluded.add(follower.accountId);
      }
      const osoDispatchGroup: CopyGroupConfig = openingExcluded.size === 0
        ? group
        : {
          ...group,
          followers: group.followers.map(follower => (
            openingExcluded.has(follower.accountId)
              ? { ...follower, mode: 'off' as const }
              : follower
          )),
        };
      const result = await processor.processOso({
        pair,
        event: leaderEvent,
        group: osoDispatchGroup,
        context: {
          ...gate,
          now,
          sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
          stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
          ineligibleAccounts: currentEntryIneligibleAccounts(),
        },
        broker,
        clock,
        store: options.store,
        metrics,
        maxConcurrentDispatches: options.maxConcurrentDispatches,
      });
      runtime = result.runtime;
      rememberCurrentRuntimePendingOsoExposure(result.audit);
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      failClosedOnCriticalAudit(result.audit);
      await rememberProtectiveLeg(pair.stopOrderId, pair.targetOrderId, now);
      if (!result.audit.some(isCriticalAuditEntry)) {
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
    // Zvyšující fill už guard prošel výše. U mixed reversal tam mohl být
    // propuštěn pouze exit slice; druhý průchod by audit zdvojil.
    if (!(leaderEvent.kind === 'filled' && eventIncreasesExposure)) {
      if (await blockDuringPause(leaderEvent, true, leaderEvent, true)) return;
      if (await blockOutsideTradingWindow(leaderEvent, true)) return;
    }
    if (leaderEvent.kind === 'replaced' && leaderEvent.executionShapeChanged === true) {
      const hasFollowerLink = (currentRuntime().state.links.get(leaderEvent.orderId)?.length ?? 0) > 0;
      const needsSubmitLifecycle = group.followers.some(follower => (
        follower.mode === 'on-submit' && !currentIneligibleAccounts().has(follower.accountId)
      ));
      if (!hasFollowerLink && needsSubmitLifecycle) {
        const error = new Error(
          `Copier fail-closed: leader replace ${leaderEvent.orderId} nemá pending korelaci ani follower link`,
        );
        options.onAudit?.([{
          at: now,
          leaderEventId: leaderEvent.id,
          kind: 'blocked',
          reason: 'unmapped-leader-replace',
        }]);
        if (gate.armed) failClosed(error);
        else invalidateReconciliation();
        return;
      }
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
    const cutAwareDispatch = cutAwareDispatchFor(leaderEvent, eventIncreasesExposure);
    if (cutAwareDispatch.unsafeDivergenceAccounts.length > 0) {
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: options.store });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      const accounts = cutAwareDispatch.unsafeDivergenceAccounts.join(', ');
      options.onAudit?.([{
        at: now,
        leaderEventId: leaderEvent.id,
        kind: 'blocked',
        reason: `unexplained-position-divergence:${accounts}:${leaderEvent.symbol}`,
      }]);
      failClosed(new Error(
        `Copier fail-closed: nevysvětlená divergence účtů ${accounts} před leader exitem ${leaderEvent.symbol}`,
      ), { autoClose: false });
      return;
    }
    const result = await processor.process({
      event: leaderEvent,
      group: cutAwareDispatch.dispatchGroup,
      context: {
        ...gate,
        now,
        sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
        stuckOutbox: gate.stuckOutbox || hasStuckOutbox(),
        ineligibleAccounts: cutAwareDispatch.ineligibleAccounts,
      },
      broker,
      clock,
      store: options.store,
      metrics,
      maxConcurrentDispatches: options.maxConcurrentDispatches,
    });
    runtime = result.runtime;
    rememberCurrentRuntimePendingExposure(result.plan, result.audit);
    if (result.audit.length > 0) options.onAudit?.(result.audit);
    rememberExitOnlyReservations(
      cutAwareDispatch.exitOnlyAccounts,
      result.plan,
      result.audit,
    );
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

  type ReconciliationResult = {
    divergentAccounts: number[];
    workingOrderAccounts: number[];
    authoritativelyClean: boolean;
    missingAccounts: number[];
    generationUnchanged: boolean;
  };

  /**
   * Všechny reconciliation běhy sdílejí jednu frontu. Novější požadavek tak
   * vždy čte broker až po starším a starý snapshot nemůže doběhnout jako
   * poslední a přepsat novější bezpečnostní stav.
   */
  async function performReconciliation(
    reconciliationOptions: CopierReconciliationOptions & { clearLastError?: boolean } = {},
  ): Promise<ReconciliationResult> {
    const requestedGeneration = safetyGeneration;
    reconciliationRequestsPending += 1;
    const reconciliation = reconciliationTail.then(() => runReconciliation(
      reconciliationOptions,
      requestedGeneration,
    ));
    const run = reconciliation.finally(() => {
      reconciliationRequestsPending -= 1;
    });
    reconciliationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Autoritativní reconciliation — sdílí ji veřejné API i connection recovery. */
  async function runReconciliation(
    reconciliationOptions: CopierReconciliationOptions & { clearLastError?: boolean },
    requestedGeneration: number,
  ): Promise<ReconciliationResult> {
      const generationAtStart = safetyGeneration;
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
      const followerIds = new Set(group.followers.map(item => item.accountId));
      const lineageParticipantIds = new Set(
        unverifiableFollowerOwnership().map(item => item.accountId),
      );
      const missingOptionalAccountIds = new Set(reconciliationOptions.missingOptionalAccountIds ?? []);
      for (const accountId of missingOptionalAccountIds) {
        if (!Number.isSafeInteger(accountId) || !followerIds.has(accountId)) {
          throw new Error(`Reconciliation dostala neplatný optional follower účet ${accountId}`);
        }
      }
      let missingEligibilityChanged = false;
      for (const accountId of missingOptionalAccountIds) {
        const current = accountEligibility.get(accountId);
        if (current && current.state !== 'active') continue;
        setEligibility(accountId, {
          ...(current ?? {}),
          accountId,
          state: 'unverifiable',
          reason: 'účet není viditelný v žádném připojeném OAuth při read-only reconciliaci',
          at: eligibilityNow,
        });
        missingEligibilityChanged = true;
      }
      if (missingEligibilityChanged) await persistEligibility();
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
      const routedAccountIds = accountIds.filter(accountId => !missingOptionalAccountIds.has(accountId));
      const capabilities = await broker.listAccountCapabilities(routedAccountIds);
      const byCapability = new Map(capabilities.map(item => [item.accountId, item]));
      const missingRequired = routedAccountIds.filter(
        accountId => !byCapability.has(accountId) && !optionalFollowerIds.has(accountId),
      );
      const missing = [...new Set([...missingOptionalAccountIds, ...missingRequired])];
      const inactive = routedAccountIds.filter(accountId =>
        byCapability.get(accountId)?.active === false && !optionalFollowerIds.has(accountId));
      const readOnlyFollowers = group.followers.filter(
        follower => byCapability.get(follower.accountId)?.canTrade === false
          && !optionalFollowerIds.has(follower.accountId),
      ).map(follower => follower.accountId);
      lastOauthPreflight = {
        missingAccounts: [...missing],
        inactiveAccounts: [...inactive],
        readOnlyFollowerAccounts: [...readOnlyFollowers],
      };
      if (missingRequired.length > 0 || inactive.length > 0 || readOnlyFollowers.length > 0) {
        gate = { ...gate, armed: false };
        invalidateReconciliation();
        const details = [
          missingRequired.length > 0 ? `missing=${missingRequired.join(',')}` : '',
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
        return lineageParticipantIds.has(accountId)
          || (state !== 'breached' && state !== 'dll-locked');
      });
      const snapshots = await Promise.all(snapshotAccountIds.map(async accountId => {
        const [positions, orders] = await Promise.all([
          broker.listPositions(accountId),
          broker.listOrders(accountId),
        ]);
        return { accountId, positions, orders };
      }));
      const byAccount = new Map(snapshots.map(item => [item.accountId, item]));
      const missingAccounts = accountIds.filter(accountId => !byAccount.has(accountId));
      const missingLineageParticipants = unverifiableFollowerOwnership(
        new Set(missingAccounts),
      );
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
      let completedCutChanged = false;
      for (const follower of group.followers) {
        const cut = activeFollowerCut(follower.accountId);
        if (!cut || cut.closed !== null) continue;
        const cutAction = follower.onCut ?? 'close-copy';
        if (cutAction === 'let-run') {
          if (sessionArmedAt > 0) {
            // Cut je uložený před cancel side-effectem. Po pádu mezi těmito
            // kroky obnovíme tentýž deterministický cancel přes durable
            // cancel outbox; nikdy neposíláme nový vstup ani blind retry.
            await executeFollowerCutAction(cut, follower, true, false);
            const refreshed = byAccount.get(follower.accountId);
            if (refreshed) {
              const [positions, orders] = await Promise.all([
                broker.listPositions(follower.accountId),
                broker.listOrders(follower.accountId),
              ]);
              refreshed.positions = positions;
              refreshed.orders = orders;
              positionsByAccount.set(follower.accountId, new Map(
                positions.map(position => [position.symbol, position.netQuantity]),
              ));
            }
          } else {
            lastError = new Error(
              `Follower cut ${follower.accountId} zůstal po restartu nedokončený; `
              + 'bez durable live ARM markeru nelze let-run cancel side effect bezpečně obnovit',
            );
          }
          continue;
        }
        if (cutAction !== 'close-copy') continue;
        const snapshot = byAccount.get(follower.accountId);
        const confirmedFlat = snapshot != null
          && snapshot.positions.every(position => position.netQuantity === 0)
          && snapshot.orders.every(order => !isOpenOrderStatus(order.status));
        if (confirmedFlat) {
          followerCuts.set(follower.accountId, { ...cut, closed: clock() });
          completedCutChanged = true;
        } else if (sessionArmedAt > 0) {
          // Pád mohl nastat po durable followerCuts.closed=null, ale ještě
          // před samotným close-copy. Stejný operationId vede přes durable
          // liquidation outbox: známý výsledek se jen dohledá/dokončí a
          // nikdy se naslepo neposílá druhý obchod.
          await executeFollowerCutAction(cut, follower, true, false);
          const refreshed = byAccount.get(follower.accountId);
          if (refreshed) {
            const [positions, orders] = await Promise.all([
              broker.listPositions(follower.accountId),
              broker.listOrders(follower.accountId),
            ]);
            refreshed.positions = positions;
            refreshed.orders = orders;
            positionsByAccount.set(follower.accountId, new Map(
              positions.map(position => [position.symbol, position.netQuantity]),
            ));
          }
        } else {
          lastError = new Error(
            `Follower cut ${follower.accountId} zůstal po restartu nedokončený; `
            + 'bez durable live ARM markeru nelze close-copy side effect bezpečně obnovit',
          );
        }
      }
      if (completedCutChanged) await persistRiskSafety();
      const divergent = new Set<number>();
      workingOrderAccounts = new Set(
        snapshots.filter(item => (
          item.orders.some(order => isOpenOrderStatus(order.status))
        )).map(item => item.accountId),
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
        if (ineligibleAfterReactivation.has(follower.accountId)
          && !lineageParticipantIds.has(follower.accountId)) continue;
        const followerPositions = new Map(
          (byAccount.get(follower.accountId)?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
        );
        const symbols = new Set([...reconciledLeaderPositions.keys(), ...followerPositions.keys()]);
        const cut = activeFollowerCut(follower.accountId);
        const expectsFlatAfterCut = cut != null && (follower.onCut ?? 'close-copy') === 'close-copy';
        for (const symbol of symbols) {
          const leaderNet = reconciledLeaderPositions.get(symbol) ?? 0;
          const expected = expectsFlatAfterCut
            ? 0
            : Math.trunc(leaderNet * follower.multiplier);
          const actual = followerPositions.get(symbol) ?? 0;
          const intentionalLetRun = cut != null && (follower.onCut ?? 'close-copy') === 'let-run';
          const pauseSuppression = intentionalEntrySuppressions.get(
            intentionalSuppressionKey(follower.accountId, symbol),
          );
          const allowedLetRunSubset = intentionalLetRun
            && (
              actual === 0
              || (leaderNet !== 0
                && Math.sign(actual) === Math.sign(leaderNet)
                && Math.abs(actual) <= Math.abs(expected))
            );
          const allowedPausePosition = pauseSuppression != null
            && actual === pauseSuppression.allowedNet;
          if (actual !== expected && !allowedLetRunSubset && !allowedPausePosition) {
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
      const sameSafetyGeneration = requestedGeneration === generationAtStart
        && safetyGeneration === generationAtStart;
      positionCheckComplete = sameSafetyGeneration
        && divergent.size === 0
        && workingOrderAccounts.size === 0
        && missingLineageParticipants.length === 0;
      if (positionCheckComplete) {
        await acknowledgeTerminalRejectsAfterReconciliation();
      }
      await resolveRejectedExecutions({
        accountIds: group.followers
          .filter(follower => {
            const snapshot = byAccount.get(follower.accountId);
            return snapshot != null
              && snapshot.positions.every(position => position.netQuantity === 0);
          })
          .map(follower => follower.accountId),
        kind: 'follower-flat',
        at: clock(),
        detail: 'autoritativní reconciliation potvrdila followera flat',
      });
      const generationUnchanged = requestedGeneration === generationAtStart
        && safetyGeneration === generationAtStart;
      const authoritativelyClean = positionCheckComplete && generationUnchanged;
      positionCheckComplete = authoritativelyClean;
      if (authoritativelyClean) {
        source.acknowledgeReconciliation();
        if (reconciliationOptions.clearLastError && !gate.killSwitch) lastError = null;
      }
      return {
        divergentAccounts: [...divergent],
        workingOrderAccounts: [...workingOrderAccounts],
        authoritativelyClean,
        missingAccounts,
        generationUnchanged,
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
    switchOptions: CopierGroupReconfigurationOptions & {
      allowGroupChange?: boolean;
      forceEpoch?: boolean;
    } = {},
  ): Promise<void> => {
    nextGroup = normalizedRuntimeGroup(nextGroup);
    assertTightenOnly(nextGroup);
    assertCutsWithinKnownPropLimits(nextGroup);
    const operation = switchOptions.forceEpoch ? 'Aktivaci skupiny' : 'Změnu leadera';
    const run = eventTail.then(async () => {
      if (stopped) throw new Error('Copier runtime is stopped');
      assertTightenOnly(nextGroup);
      assertCutsWithinKnownPropLimits(nextGroup);
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
      const accountIds = [...new Set([
        group.leaderAccountId,
        ...group.followers.map(item => item.accountId),
        nextGroup.leaderAccountId,
        ...nextGroup.followers.map(item => item.accountId),
      ])];
      const leaderIds = new Set([group.leaderAccountId, nextGroup.leaderAccountId]);
      const nextAccountIds = new Set([
        nextGroup.leaderAccountId,
        ...nextGroup.followers.map(item => item.accountId),
      ]);
      const removableFollowerIds = new Set(group.followers
        .map(item => item.accountId)
        .filter(accountId => !nextAccountIds.has(accountId) && !leaderIds.has(accountId)));
      const optionalFollowerIds = new Set(switchOptions.missingOptionalAccountIds ?? []);
      for (const accountId of optionalFollowerIds) {
        if (!Number.isSafeInteger(accountId) || !removableFollowerIds.has(accountId)) {
          throw new Error(`${operation} dostala neplatný chybějící optional follower účet ${accountId}`);
        }
      }
      if (
        switchOptions.waiveUnverifiableFollowerOwnership !== undefined
        && switchOptions.waiveUnverifiableFollowerOwnership !== true
      ) throw new Error(`${operation} dostala neplatný ownership waiver`);
      const ownershipRisks = unverifiableFollowerOwnership(optionalFollowerIds);
      if (ownershipRisks.length > 0 && !switchOptions.waiveUnverifiableFollowerOwnership) {
        throw new Error(ownershipRisks.map(item => (
          `Účet ${item.accountId} může držet neověřenou kopii z epochy ${item.epochId}; potvrď převzetí odpovědnosti`
        )).join('. '));
      }
      const waivesBlockedRecovery = switchOptions.waiveUnverifiableFollowerOwnership === true
        && connectionRecoveryMissingOwnership.length > 0
        && connectionRecoveryMissingOwnership.every(item => ownershipRisks.some(risk => (
          risk.accountId === item.accountId && risk.epochId === item.epochId
        )));
      if (nextGroup.leaderAccountId === group.leaderAccountId && !topologyChanged && !switchOptions.forceEpoch) {
        const pendingCutClosures = tightenedCutClosures(group, nextGroup);
        group = nextGroup;
        invalidateReconciliation();
        for (const pending of pendingCutClosures) {
          await executeFollowerCutAction(pending.cut, pending.follower, true, false);
        }
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
        pendingFollowerMagnitudeChecks.size > 0 ? 'follower magnitude check' : '',
        sweepingProtectiveLegs.size > 0 ? 'protective sweep' : '',
        [...leaderFlatGuardTimers.keys()].some(epochId => (
          !ownershipRisks.some(item => item.epochId === epochId)
        )) ? 'leader-flat guard' : '',
        autoCloseInFlight ? 'auto-close' : '',
        recoveryInFlight || (pendingConnectionRecovery && !waivesBlockedRecovery)
          ? 'connection recovery'
          : '',
        cooldownPending ? 'cooldown transition' : '',
        dayLockPending ? 'day-lock transition' : '',
      ].filter(Boolean);
      if (pendingReasons.length > 0) {
        throw new Error(`${operation} blokuje rozpracovaný lifecycle: ${pendingReasons.join(', ')}`);
      }
      // Stejná session-aware statistika jako všude jinde: lot z už skončené
      // session (po 17:00 CT) je jen historie, ne důkaz otevřené expozice.
      // Autoritativní flat/no-working preflight následuje níže tak jako tak.
      const openLots = currentDailyStats(clock()).openLots
        .filter(lot => lot.netQuantity !== 0);
      if (openLots.length > 0) {
        throw new Error(`${operation} blokuje otevřená durable pozice leadera`);
      }

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

      if (ownershipRisks.length > 0) {
        options.onAudit?.(ownershipRisks.map(item => ({
          at: clock(),
          leaderEventId: `ownership-waiver:${item.epochId}:${item.accountId}`,
          kind: 'blocked' as const,
          accountId: item.accountId,
          reason: `ownership waived by operator: účet ${item.accountId}, epocha ${item.epochId}`,
        })));
      }

      runtime = await processor.mutate(async current => {
        const {
          liveCopyOpenSince: _dropOpenFlag,
          leaderExposureEpochs: _dropLeaderExposureEpochs,
          ...preservedSafety
        } = current.state.safety;
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
      knownLeaderReducingOrderIds.clear();
      leaderReducingRemainingByOrder.clear();
      leaderOrderIntents.clear();
      leaderExposureIncreaseByEventId.clear();
      leaderPreFillNetByEventId.clear();
      leaderReducingQuantityByEventId.clear();
      blockedLeaderEntryOrderIds.clear();
      intentionalEntrySuppressions.clear();
      exitOnlyReservations.clear();
      exitOnlyPositionApplied.clear();
      exitOnlyFlatFillAwaitingPosition.clear();
      osoOpeningExcludedAccounts.clear();
      leaderPositions.clear();
      positionsByAccount.clear();
      for (const snapshot of snapshots) {
        positionsByAccount.set(snapshot.accountId, new Map(
          snapshot.positions.map(position => [position.symbol, position.netQuantity]),
        ));
      }
      untrackedTradeSymbols.clear();
      recentFollowerFillCauses.clear();
      for (const timer of pendingFollowerMagnitudeChecks.values()) clearTimeout(timer);
      pendingFollowerMagnitudeChecks.clear();
      for (const timer of leaderFlatGuardTimers.values()) clearTimeout(timer);
      leaderFlatGuardTimers.clear();
      sweptProtectiveLegs.clear();
      sweepingProtectiveLegs.clear();
      workingOrderAccounts = new Set();
      lastAutoClose = null;
      lastResumeOffer = null;
      autoCloseEpisodeAttempts = 0;
      pendingConnectionRecovery = false;
      connectionRecoveryMissingOwnership = [];
      recoveryInFlight = false;
      bootRecoveryChecked = true;
      invalidateReconciliation();
      lastError = null;
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

  // Staré snapshoty dostanou additivní defaulty ještě před prvním heartbeatem;
  // žádná chybějící metadata se pak v DTO nesmějí odhadovat na serveru.
  await ensureDailySession(clock());
  assertCutsWithinKnownPropLimits(group);

  const unsubscribe = broker.subscribe(event => {
    eventTail = eventTail.then(() => handleBrokerEvent(event)).catch(failClosed);
  });

  return {
    arm({ shadowMode = false, ttlMs }: { shadowMode?: boolean; ttlMs?: number } = {}) {
      if (stopped) throw new Error('Copier runtime is stopped');
      if (shutdownRequested) throw new Error('Copier runtime se právě bezpečně ukončuje');
      if (gate.killSwitch) throw new Error('Copier nelze armovat: kill switch je aktivní');
      if (ttlMs != null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
        throw new Error('ARM TTL musí být kladný počet milisekund');
      }
      const now = clock();
      const startedNewRiskSession = rollRiskSessionMemoryIfExpired(now);
      assertCutsWithinKnownPropLimits(group);
      if (!group.enabled) throw new Error('Copier nelze armovat: skupina je vypnutá');
      if (!gate.connected) throw new Error('Copier nelze armovat bez dokončeného broker syncu');
      if (source.needsReconciliation()) {
        throw new Error('Po reconnectu je nutná kontrola pozic; před ARM proveď kontrolu pozic');
      }
      const safety = currentRuntime().state.safety;
      if (!shadowMode && now < safety.dayLockUntil) {
        throw new Error(`ARM blokován denním lockem: ${safety.dayLockReason ?? 'risk lock'}`);
      }
      const tradingWindow = group.safety?.tradingWindow ?? DEFAULT_COPY_GROUP_SAFETY.tradingWindow;
      if (!shadowMode && tradingWindow.enabled
        && tradingWindowStateAt(tradingWindow, now) !== 'inside') {
        throw new Error(
          `ARM blokován mimo obchodní okno ${tradingWindow.from}–${tradingWindow.to} (${tradingWindow.timeZone})`,
        );
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
            .filter(follower => !ineligible.has(follower.accountId) && !activeFollowerCut(follower.accountId, now))
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
          follower.mode !== 'off'
          && !ineligible.has(follower.accountId)
          && !activeFollowerCut(follower.accountId, now));
        if (participatingFollowers.length === 0) {
          throw new Error('ARM blokován: skupina nemá žádný způsobilý follower účet');
        }
      }
      // Kratší z limitů vyhrává: session TTL nesmí ARM prodloužit za výchozí strop.
      const armTtlMs = ttlMs != null ? Math.min(ttlMs, defaultArmTtlMs) : defaultArmTtlMs;
      gate = { ...gate, armed: true, armedAt: now, now, shadowMode, armTtlMs };
      if (!shadowMode && sessionArmedAt <= 0) {
        sessionArmedAt = now;
        const firstLiveArmAt = now;
        eventTail = eventTail
          .then(async () => {
            if (startedNewRiskSession) await ensureDailySession(firstLiveArmAt);
            // `ensureDailySession` nuluje starou session; marker tohoto
            // úspěšného ARM proto patří do téhož navazujícího commitu.
            sessionArmedAt = firstLiveArmAt;
            await persistRiskSafety();
          })
          .catch(reason => failClosed(reason, { autoClose: false }));
      } else if (startedNewRiskSession) {
        // Shadow ARM marker nezakládá, ale reset nové session musí být
        // stejně durable dřív, než se zpracuje další broker event.
        eventTail = eventTail
          .then(() => ensureDailySession(now).then(() => undefined))
          .catch(reason => failClosed(reason, { autoClose: false }));
      }
      scheduleAccountRiskPoll(
        [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)],
        true,
      );
      lastResumeOffer = null;
      // Nová epizoda: ARM prošel všemi branami (flat, žádný stuck outbox),
      // takže počítadlo nouzových zavření začíná znovu.
      autoCloseEpisodeAttempts = 0;
    },
    beginShutdown() {
      if (shutdownPromise) return shutdownPromise;
      if (stopped) return Promise.resolve();
      shutdownRequested = true;
      gate = { ...gate, armed: false };
      lastResumeOffer = null;
      // Stejně jako DISARM: worker při shutdownu nesmí po restartu nabízet
      // automatické převzetí expozice. Rozpracovaný outbox/bracket/OSO drain
      // ale zůstává živý až do waitForIdle().
      // Clear musí být až ZA celým právě běžícím broker eventem, ne pouze za
      // jeho momentálně otevřeným processor commitem. Událost může po dispatchi
      // ještě zařadit exposure update; opačné pořadí by po shutdownu obnovilo
      // stale liveCopyOpenSince marker.
      shutdownPromise = eventTail.then(() => syncLiveCopyExposureFlag('clear'));
      eventTail = shutdownPromise.then(() => undefined, () => undefined);
      // Pilot promise později autoritativně awaitne a případnou chybu vrátí;
      // handler zde pouze zabrání mezitímnímu unhandled-rejection oknu.
      void shutdownPromise.catch(() => undefined);
      return shutdownPromise;
    },
    disarm() {
      const wasArmed = gate.armed;
      gate = { ...gate, armed: false };
      if (wasArmed) {
        recordDisarm(
          'manual',
          'Uživatel vypnul kopírku ručně',
          groupIsFlat() ? 'flat' : 'unknown',
        );
      }
      lastResumeOffer = null;
      // Ruční DISARM zastaví nové kopie. Starý obecný account-wide boot
      // auto-close vypneme, ale durable leader-flat epocha zůstává: pokud
      // leader později zavře, smí dokončit jen prokázanou existující kopii
      // přes přesný account/symbol guard.
      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
    },
    engageKillSwitch(reason = 'Ruční nouzové zastavení') {
      if (stopped) return;
      const wasArmed = gate.armed;
      invalidateReconciliation();
      lastError = new Error(reason.trim() || 'Ruční nouzové zastavení');
      if (wasArmed || !lastDisarm || lastDisarm.trigger !== 'kill-switch') {
        recordDisarm(
          'kill-switch',
          lastError.message,
          groupIsFlat() ? 'flat' : 'unknown',
        );
      }
      // Kill switch se v této runtime session nedá odjistit. Nový bootstrap znovu
      // startuje DISARMED a stále vyžaduje reconciliation před ostrým ARM.
      gate = { ...gate, armed: false, killSwitch: true };
      lastResumeOffer = null;
      pendingConnectionRecovery = false;
      // Kill switch = explicitní freeze; žádná pozdější automatika.
      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
      options.onError?.(lastError);
    },
    async lockUntil(until, reason) {
      const now = clock();
      if (!Number.isFinite(until) || until <= now) {
        throw new Error('Denní lock musí končit v budoucnosti');
      }
      const explanation = reason.trim();
      if (explanation.length < 3 || explanation.length > 200
        || /[\u0000-\u001f\u007f]/.test(explanation)) {
        throw new Error('Denní lock vyžaduje platný důvod (3–200 znaků)');
      }
      dayLockPending = { trigger: 'manual', reason: explanation, until };
      options.onAudit?.([{
        at: now,
        leaderEventId: 'manual-day-lock',
        kind: 'blocked',
        reason: `day-lock trigger=manual čeká na flat: ${explanation}`,
      }]);
      await maybeEngageDayLock(now);
    },
    async unlockDay(_reason) {
      throw new Error('unlock-day není podporován: den se odemyká jen koncem session');
    },
    async applyAccountEligibilityExclusions(exclusions) {
      // Safety metadata může přijet z webu těsně před ARM/SHADOW. Nikdy
      // nesmí za běžícího dispatchu změnit účast bez fail-safe DISARMu.
      gate = { ...gate, armed: false };
      if (reconciliationRequestsPending > 0) invalidateReconciliation();
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
    async reconcile(reconciliationOptions = {}) {
      // Veřejná Kontrola pozic je explicitní uživatelská recovery akce.
      // Pouze její čistý výsledek smí odstranit starou chybu; automatické
      // reconnect/terminal-fill kontroly incident uživateli neschovávají.
      const result = await performReconciliation({ ...reconciliationOptions, clearLastError: true });
      if (
        result.authoritativelyClean
        && pendingConnectionRecovery
        && !recoveryInFlight
        && gate.connected
      ) {
        // Čistý ruční výsledek recovery NEnahrazuje (přeskočil by obnovu
        // leader-flat guardu, úklid exposure markeru i recovery audit) — jen
        // ji znovu spustí. Vlna si sama vezme optional-skip vstup a příznak
        // shodí až po kompletním doběhu; při selhání zůstává pending.
        scheduleConnectionRecovery();
      }
      return {
        divergentAccounts: result.divergentAccounts,
        workingOrderAccounts: result.workingOrderAccounts,
        authoritativelyClean: result.authoritativelyClean,
        missingAccounts: result.missingAccounts,
      };
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
    async reconfigureGroup(nextGroup, reconfigurationOptions = {}) {
      // UI dostane okamžitě fail-safe DISARM ještě před čekáním na eventTail.
      gate = { ...gate, armed: false };
      invalidateReconciliation();
      await reconfigureLeaderEpoch(nextGroup, reconfigurationOptions);
    },
    async activateGroup(nextGroup, reconfigurationOptions = {}) {
      // Aktivace není ARM. Nejprve fail-safe DISARM, potom plný preflight
      // staré i nové topologie a nová durable epocha.
      gate = { ...gate, armed: false };
      invalidateReconciliation();
      await reconfigureLeaderEpoch(nextGroup, {
        ...reconfigurationOptions,
        allowGroupChange: true,
        forceEpoch: true,
      });
    },
    updateGroup(nextGroup) {
      // Jakýkoli pokus o změnu konfigurace nejdřív zavře live dispatch.
      gate = { ...gate, armed: false };
      if (recoveryInFlight || pendingConnectionRecovery || reconciliationRequestsPending > 0) {
        throw new Error('Změnu konfigurace blokuje probíhající connection recovery/reconciliation');
      }
      if (nextGroup.id !== group.id) throw new Error('Nelze změnit runtime na jinou copy group');
      nextGroup = normalizedRuntimeGroup(nextGroup);
      assertTightenOnly(nextGroup);
      assertCutsWithinKnownPropLimits(nextGroup);
      if (nextGroup.leaderAccountId !== group.leaderAccountId) {
        throw new Error('Změna leadera vyžaduje bezpečný reconfigureGroup preflight');
      }
      const pendingCutClosures = tightenedCutClosures(group, nextGroup);
      group = nextGroup;
      invalidateReconciliation();
      if (pendingCutClosures.length > 0) {
        const run = eventTail.then(async () => {
          for (const pending of pendingCutClosures) {
            await executeFollowerCutAction(pending.cut, pending.follower, true, false);
          }
        });
        eventTail = run.then(() => undefined, reason => {
          failClosed(reason, { autoClose: false });
        });
      }
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
      invalidateReconciliation();
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
      const statusNow = clock();
      const stuckOperations = currentStuckOperations();
      const storedSessionEndAt = current.state.safety.dailyStats?.sessionEndAt ?? 0;
      const effectiveSessionArmedAt = storedSessionEndAt > 0
        && statusNow >= storedSessionEndAt
        && locallyRolledRiskSessionEndAt !== storedSessionEndAt
        ? 0
        : sessionArmedAt;
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
            .map(entry => ({
              ...entry,
              lastExecution: entry.lastExecution
                ? cloneRejectedExecution(entry.lastExecution)
                : undefined,
            }));
        })(),
        ...(lastOauthPreflight ? {
          oauthPreflight: {
            missingAccounts: [...lastOauthPreflight.missingAccounts],
            inactiveAccounts: [...lastOauthPreflight.inactiveAccounts],
            readOnlyFollowerAccounts: [...lastOauthPreflight.readOnlyFollowerAccounts],
          },
        } : {}),
        unverifiableFollowerOwnership: (() => {
          const byAccount = new Map<number, string[]>();
          for (const item of unverifiableFollowerOwnership()) {
            byAccount.set(item.accountId, [...(byAccount.get(item.accountId) ?? []), item.epochId]);
          }
          return [...byAccount].map(([accountId, epochIds]) => ({ accountId, epochIds }));
        })(),
        lastError: lastError?.message ?? null,
        ...(lastDisarm ? { lastDisarm: { ...lastDisarm } } : {}),
        disarmHistory: disarmHistory.map(record => ({ ...record })),
        revision: current.revision,
        lastSequence: current.state.lastSequence,
        groupFlat: groupIsFlat(),
        entryCooldownUntil: current.state.safety.entryCooldownUntil,
        dayLockUntil: current.state.safety.dayLockUntil,
        dayLockReason: current.state.safety.dayLockReason ?? null,
        dayLockTrigger: current.state.safety.dayLockTrigger ?? null,
        dayLockAt: current.state.safety.dayLockAt ?? null,
        dayLockSnoozedRules: [...(current.state.safety.dayLockSnoozedRules ?? [])],
        dayUnlock: current.state.safety.dayUnlock ? { ...current.state.safety.dayUnlock } : null,
        pause: (current.state.safety.pauseUntil ?? 0) > statusNow
          && current.state.safety.pauseRule != null
          ? {
            until: current.state.safety.pauseUntil ?? 0,
            rule: current.state.safety.pauseRule,
            at: current.state.safety.pauseAt ?? 0,
          }
          : null,
        sessionArmedAt: effectiveSessionArmedAt,
        followerCuts: [...followerCuts.values()]
          .filter(cut => cut.until > statusNow
            && group.followers.some(follower => follower.accountId === cut.accountId))
          .map(cut => ({ ...cut })),
        accountRisk: [...accountRisk.values()]
          .filter(snapshot => snapshot.accountId === group.leaderAccountId
            || group.followers.some(follower => follower.accountId === snapshot.accountId))
          .map(snapshot => ({
            ...snapshot,
            error: snapshot.error
              ?? (statusNow - snapshot.verifiedAt > ACCOUNT_RISK_STALE_MS ? 'stale-snapshot' : null),
          })),
        armExpiresAt: gate.armed && gate.armTtlMs > 0 ? gate.armedAt + gate.armTtlMs : 0,
        armedAt: gate.armed ? gate.armedAt : 0,
        recentCopyEvents: [...recentCopyEvents],
        autoClose: lastAutoClose ? { ...lastAutoClose, accountIds: [...lastAutoClose.accountIds] } : null,
        resumeOffer: lastResumeOffer ? { ...lastResumeOffer } : null,
        dailyStats: current.state.safety.dailyStats
          ? {
            label: COPIER_LEADER_DAILY_STATS_LABEL,
            sessionEndAt: current.state.safety.dailyStats.sessionEndAt,
            realizedPnlUsd: current.state.safety.dailyStats.realizedPnlUsd,
            losingTrades: current.state.safety.dailyStats.losingTrades,
            tradesToday: current.state.safety.dailyStats.tradesToday ?? 0,
            windowState: current.state.safety.dailyStats.windowState ?? 'off',
            warnedRules: current.state.safety.dailyStats.warnedRules?.map(warning => ({ ...warning })) ?? [],
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
        const observedRiskPoll = accountRiskPollTail;
        await observedRiskPoll;
        const observedShutdown = shutdownPromise;
        if (observedShutdown) await observedShutdown;
        const pendingFlushes = [...pendingOsoFlushes.values()];
        if (pendingFlushes.length > 0) await Promise.all(pendingFlushes);
        if (
          observed === eventTail
          && observedRiskPoll === accountRiskPollTail
          && observedShutdown === shutdownPromise
          && pendingOsoFlushes.size === 0
        ) return;
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
      blockedOsoEntries.clear();
      osoOpeningExcludedAccounts.clear();
      blockedLeaderEntryOrderIds.clear();
      knownLeaderReducingOrderIds.clear();
      leaderReducingRemainingByOrder.clear();
      leaderOrderIntents.clear();
      leaderExposureIncreaseByEventId.clear();
      leaderPreFillNetByEventId.clear();
      leaderReducingQuantityByEventId.clear();
      currentRuntimePendingExposure.clear();
      seenCurrentRuntimePendingFillIds.clear();
      intentionalEntrySuppressions.clear();
      exitOnlyReservations.clear();
      exitOnlyPositionApplied.clear();
      exitOnlyFlatFillAwaitingPosition.clear();
      for (const pending of pendingFollowerTransitions.values()) clearTimeout(pending.timer);
      pendingFollowerTransitions.clear();
      for (const timer of pendingFollowerMagnitudeChecks.values()) clearTimeout(timer);
      pendingFollowerMagnitudeChecks.clear();
      for (const timer of leaderFlatGuardTimers.values()) clearTimeout(timer);
      leaderFlatGuardTimers.clear();
      recentFollowerFillCauses.clear();
      for (const entryOrderId of [...pendingOsoResolvers.keys()]) settleOsoFlush(entryOrderId);
      unsubscribe();
    },
  };
}

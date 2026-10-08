import {
  brokerRiskEquity,
  isOpenOrderStatus,
  type BrokerEvent,
  type BrokerFill,
  type BrokerOrder,
  type BrokerPosition,
  type BrokerOrderStatusLookup,
  type BrokerPort,
  type BrokerAccountRiskSnapshot,
} from './brokerPort';
import { msUntilTradovateSessionEnd, sameTradovateSession } from './copierArmSession';
import { pointValueUsd } from './futuresContractSpecs';
import {
  createCopierState,
  followerQuantity,
  updateFollowerLinkQuantity,
  venueManagedProtectiveCoverage,
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
import {
  stuckCancelEntries,
  waiveCancelEntry,
  type CancelOutboxEntry,
} from './copierCancelOutbox';
import {
  markRejected as markOutboxRejected,
  stuckEntries,
  waiveOutboxEntry,
  type OutboxEntry,
} from './copierOutbox';
import { stuckBracketEntries, waiveBracketOutboxEntry } from './copierBracketOutbox';
import { stuckOsoEntries, waiveOsoOutboxEntry, type OsoOutboxEntry } from './copierOsoOutbox';
import { applyResolved, type LeaderEvent } from './copierEngine';
import { COPIER_LEADER_DAILY_STATS_LABEL } from '../lib/copierDailyStatsLabels';
import { cancelLifecycleHaltReason, createRiskGateContext, haltReason, type RiskGateContext } from './copierRiskGate';
import {
  createCopierMetrics,
  createRuntime,
  createSerialCopierProcessor,
  CopierProcessorCommitError,
  recoverOutbox,
  runtimeFromSnapshot,
  type CopierAuditEntry,
  type CopierMetrics,
  type CopierRuntime,
  assertedFollowerQuantity,
} from './copierRunner';
import type { CopierStore } from './copierStore';
import {
  COPIER_SEEN_TERMINAL_REJECT_LIMIT,
  createMemoryCopierStore,
  toSnapshot,
} from './copierStore';
import { retryTransient } from '../lib/retryTransient';
import {
  DEFAULT_COPY_GROUP_SAFETY,
  sanitizeCopyGroupSafety,
  type CopyGroupConfig,
  type CopyGroupSafetySettings,
  type CopierRuleAction,
  type DayLockTrigger,
} from './liveCopyTrading';
import {
  isInPlaceCutTightening,
  isMetadataOnlyGroupChange,
  isWeakerRiskConfig,
} from '../lib/copierRiskConfig';
import {
  clockMinutes,
  isTradingWindowWarningAt,
  isAfterTradingWindowsAt,
  lastTradingWindowEnd,
  formatTradingWindows,
  tradingWindowStateAt,
  zonedMinuteOfDay,
} from './copierDailyRules';
import {
  processManualFlatten,
  processTargetedLiquidation,
  type ManualFlattenResult,
  type ManualFlattenTarget,
} from './copierManualActions';
import { CopierDispatchRevokedError, createExposureCappedBroker } from './exposureCappedBroker';
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

export type CopierArmPreparationBlocker =
  | 'incident'
  | 'kill-switch'
  | 'starting'
  | 'recovery'
  | 'configuration'
  | 'shutdown';

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
  /** Režim opravy po startu s nepoužitelnou uloženou skupinou (null = normální běh). */
  startupGroupRepair?: { groupId: string; unavailableAccountIds: number[] } | null;
  started: boolean;
  armed: boolean;
  killSwitch: boolean;
  shadowMode: boolean;
  connected: boolean;
  reconciliationRequired: boolean;
  /** Worker-local read-only readiness. Never an authorization token for the UI. */
  armPreparation?: {
    state: 'needed' | 'checking' | 'ready' | 'blocked';
    verifiedAt: number | null;
    reason: string | null;
    blockedBy: CopierArmPreparationBlocker | null;
    manualRecoveryRequired: boolean;
  };
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
  /**
   * Autoritativní expozice pro read-only klienty (Mac companion): čas
   * poslední broker informace o pozicích (úplné čtení při reconciliation
   * nebo Position entita ze streamu), aktuální nenulové pozice všech účtů
   * a per-follower shoda s očekávanou expozicí. null = v tomto běhu ještě
   * neproběhla úplná kontrola, nebo stream není připojený.
   */
  exposure?: {
    verifiedAt: number;
    positions: Array<{ accountId: number; symbol: string; netQuantity: number }>;
    followers: Array<{ accountId: number; ok: boolean; detail: string | null }>;
    /**
     * Aktivní příkazy účtů skupiny z brokerového streamu a poslední úplné
     * kontroly; web z nich kreslí ochranu (SL/TP) bez vlastního REST pollingu.
     */
    orders?: Array<{
      accountId: number;
      brokerOrderId: string;
      symbol: string;
      side: 'Buy' | 'Sell';
      orderType: string;
      quantity: number;
      filledQuantity: number;
      limitPrice: number | null;
      stopPrice: number | null;
      status: string;
      updatedAt: number;
    }>;
  } | null;
  lastError: string | null;
  /** Poslední odzbrojení v tomto běhu; additivní kvůli starším klientům. */
  lastDisarm?: CopierDisarmRecord;
  /** Ohraničená historie odzbrojení aktuální runtime session. */
  disarmHistory?: CopierDisarmRecord[];
  /** Poslední detekované uspání/zamrznutí hostitele; null = v tomto běhu nic. */
  hostSleep?: {
    unresponsiveSince: number;
    detectedAt: number;
    sleepDurationMs: number;
  } | null;
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
  /** Nové vstupy jsou blokované, existující kopie se dál risk-redukčně řídí. */
  managementOnly?: {
    at: number;
    reason: string;
    source: 'protected-target-modify';
    accountIds: number[];
  } | null;
  /** První ostrý ARM v aktuální session; > 0 = pravidla i limity jdou jen zpřísnit. */
  sessionArmedAt?: number;
  /** Followeři vyřazení do konce session nebo do clean boundary aktuálního obchodu. */
  followerCuts?: CopierFollowerCut[];
  /** Ruční participation je oddělená od automatické eligibility a cutů. */
  followerParticipation?: Array<{
    accountId: number;
    configuredEnabled: boolean;
    effectiveEnabled: boolean;
    canToggle: boolean;
    blockers: string[];
    automaticExclusion?: string;
  }>;
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
  /** Horní časová mez; trade cut se může uvolnit dřív po čistém flat celé skupiny. */
  until: number;
  realizedPnlUsd: number;
  cutUsd: number;
  source: 'broker' | 'ledger' | 'manual' | 'prop-reserve';
  /** Legacy záznam bez scope je session cut. */
  scope?: 'session' | 'trade';
  /** Idempotency klíč ručního Flatten followera. */
  operationId?: string;
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
  /** Přímé otevřené P&L; null = broker ho neposkytl. */
  openPnlUsd?: number | null;
  /** Net liq jen když ho broker transport vydal; jinak null. */
  netLiq: number | null;
  /** Realizovaný cash zůstatek; u flat účtu rovný net liq. Starší snapshoty ho nemají. */
  cashBalanceUsd?: number | null;
  /** Durable tighten-only runtime cap odvozený z prop rezervy pro tuto session. */
  effectiveDailyLossCutUsd?: number | null;
  /** Konfigurovaný cut, ke kterému durable cap náleží. */
  configuredDailyLossCutUsd?: number | null;
  /** Brokerem vedený high-watermark net liq. */
  highWaterNetLiq?: number | null;
  /** Odvozený floor propky (high-watermark − trailing, nejvýš trailing limit). */
  minNetLiq: number | null;
  dailyLossAutoLiq: number | null;
  trailingMaxDrawdown: number | null;
  trailingMaxDrawdownLimit?: number | null;
  /** dailyLossAutoLiq ?? ((netLiq ?? cashBalanceUsd) − minNetLiq); null = neznámý. */
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
  /** Explicitní, auditované vyřazení celé staré skupiny, jejíž účty zmizely z OAuth. Nikdy nepovoluje ARM. */
  retireMissingOldGroup?: {
    groupId: string;
    accountIds: readonly number[];
    reason: string;
  };
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
  source?: 'broker' | 'ledger' | 'manual' | 'prop-reserve';
  closed?: number | null | false;
}

export interface CopierRuntimeController {
  /**
   * `ttlMs` omezí platnost tohoto ARM (typicky do konce broker session).
   * Bez něj platí výchozí TTL z risk gate. Expirace odzbrojí a podle
   * `safety.armExpiryFlatten` risk-redukčně zavře otevřené kopie.
   */
  arm(options?: { shadowMode?: boolean; ttlMs?: number; requirePreparation?: boolean }): void;
  /** Deduplicated read-only preparation; never acknowledges an incident or arms. */
  prepareArm?(): Promise<void>;
  /** Enable background warming when an execution agent starts serving ON/OFF. */
  startArmPreparation?(): void;
  /** Keep preparation warm briefly after an operator reads local LIVE status. */
  noteArmPreparationInterest?(): void;
  /** Irreversibly freezes new ARM and durably clears restart-recovery exposure state. */
  beginShutdown(): Promise<void>;
  disarm(trigger?: 'manual' | 'config-change' | 'connection-removed'): void;
  /** Jednosměrná nouzová západka pro aktuální runtime session. */
  engageKillSwitch(reason?: string): void;
  /** Pilot hlásí rozdíl wall/monotonic hodin; nic nečte ani nezapisuje u brokera. */
  reportHostSleep(incident: {
    unresponsiveSince: number;
    detectedAt: number;
    sleepDurationMs: number;
  }): void;
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
  /** Čistý synchronní preflight změny konfigurace; nikdy nemění gate ani routing. */
  preflightGroupChange(group: CopyGroupConfig, options?: { allowGroupChange?: boolean }): void;
  /** Synchronní změna follower/risk konfigurace při nezměněném leaderovi. */
  updateGroup(group: CopyGroupConfig): void;
  /** Metadata a pravidla bez změny execution topologie/expozice; zachová ARM. */
  updateGroupMetadata(group: CopyGroupConfig): void;
  /** Pouze cut↓/nový cut/let-run→close-copy; serializované s eventy a bez DISARM. */
  updateGroupRiskInPlace(group: CopyGroupConfig): Promise<void>;
  /** Bez DISARM, serializovaně s broker eventy a s durable zápisem před změnou účasti. */
  setFollowerEnabled(
    accountId: number,
    enabled: boolean,
    persistGroup: (group: CopyGroupConfig) => Promise<void>,
  ): Promise<CopyGroupConfig>;
  /** Explicitní ruční Flatten jednoho účtu. Nikdy se nespouští automaticky. */
  flattenAccount(accountId: number, operationId: string): Promise<ManualFlattenResult>;
  /**
   * Zavře potvrzenou kopii followera a vyřadí jej jen do čistého konce obchodu.
   * `onAdmitted` se zavolá po durable přijetí cutu, ještě před zavíráním
   * (B1: příkazová fronta agenta nesmí čekat na celé zavření).
   */
  flattenFollowerTrade(
    accountId: number,
    operationId: string,
    options?: { onAdmitted?: () => void },
  ): Promise<ManualFlattenResult>;
  /** Explicitní ruční Flatten leadera i všech followerů ve skupině. */
  flattenGroup(operationId: string): Promise<ManualFlattenResult>;
  /** Ruční uzavření nejasné operace; nikdy nic neposílá a vynutí novou reconciliation. */
  waiveStuckOperation(options: {
    kind: CopierStuckOperationKind;
    key: string;
    reason: string;
  }): Promise<void>;
  /** Důvod, proč teď nesmí začít plánovaná obměna broker socketu. */
  connectionRenewalBlocker(): string | null;
  /**
   * Proč teď nejde worker bezpečně restartovat kvůli údržbě (nové účty):
   * rozpracovaný lifecycle, nedokončená epocha/cut, durable stopa kopií
   * nebo cokoli z `connectionRenewalBlocker`. `null` = klid.
   */
  maintenanceRestartBlocker(): string | null;
  status(): CopierControllerStatus;
  waitForIdle(): Promise<void>;
  stop(): void;
}

export interface BootstrapCopierOptions {
  broker: BrokerPort;
  store: CopierStore;
  group: CopyGroupConfig;
  /**
   * Jednorázová startup výjimka vystavená pouze po ověření CLI flagu a
   * úplné OAuth absence přesné durable skupiny. Povoluje jen DISARMED
   * bootstrap pro její pozdější auditované vyřazení.
   */
  missingGroupRetirementBootstrap?: {
    groupId: string;
    accountIds: readonly number[];
  };
  /**
   * Uložená skupina má účty, které při startu nejsou v OAuth (typicky
   * breached leader/followeři). Worker místo crash loopu naběhne jen
   * DISARMED v režimu opravy: ARM je blokovaný, dokud se skupina neopraví
   * a nedostupné účty se auditovaně nevyřadí.
   */
  unusableGroupRepairBootstrap?: {
    groupId: string;
    unavailableAccountIds: readonly number[];
  };
  clock?: () => number;
  /** Klidové okno po leader trade eventu před plánovanou obměnou (default 5 s). */
  connectionRenewalQuietMs?: number;
  /** Monotónní hodiny renewal scheduleru oddělené od trading/event hodin. */
  connectionRenewalClock?: () => number;
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
  /** Deadline jednoho broker callu v prioritní ruční Flatten lane (default 20 s, nad 15s REST timeoutem brokeru). */
  flattenBrokerRequestTimeoutMs?: number;
  /**
   * Kolik času smí prioritní Flatten věnovat opakování čtení (positions,
   * orders, lookup) po timeoutu/5xx brokera. Zápisy se neopakují.
   */
  flattenRetryBudgetMs?: number;
  /** Celkový deadline jednoho Flatten příkazu; po něm se vrátí poctivý částečný výsledek. */
  flattenDeadlineMs?: number;
  /** Nejvyšší počet stavově ověřených nativních liquidate pokusů na pozici. */
  flattenLiquidateAttempts?: number;
  /** Prodleva mezi dalšími průchody účtů, které selhaly na přechodnou chybu. */
  flattenRetryPollMs?: number;
  /** Testovatelný celkový deadline background follower cutu (produkčně 90 s). */
  followerCutDeadlineMs?: number;
  /** Deadline jednoho broker callu v background follower cut lane. */
  followerCutBrokerRequestTimeoutMs?: number;
  /** Omezené read-only konfirmace follower cutu s exponenciálním backoffem. */
  followerCutConfirmationAttempts?: number;
  followerCutConfirmationPollMs?: number;
  followerCutConfirmationMaxPollMs?: number;
  /** Celkový budget jedné flat události napříč účty a oběma sweepy. */
  flatSweepBudgetMs?: number;
  /** Deadline každého jednotlivého cancel write ve flat sweepu; timeout se nikdy naslepo neopakuje. */
  flatSweepCancelTimeoutMs?: number;
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
  /** Deadline jednoho read-only broker čtení leader-flat guardu. */
  leaderFlatReadTimeoutMs?: number;
  /** Odstup mezi dvěma REST koly při usazení kopie na flat účtu (test override). */
  copierSettlementQuietMs?: number;
  /** Minimální stáří položky outboxu před usazením (test override). */
  copierSettlementMinAgeMs?: number;
  /** Minimální doba od ukončení nohy kopie před usazením (test override). */
  copierSettlementTerminalAgeMs?: number;
}

/** Prefix důvodu, kterým reconciliation přepisuje potvrzený konečný reject na waived. */
const TERMINAL_REJECT_WAIVE_REASON = 'Konečný reject potvrzen následnou autoritativní reconciliation';

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
    if (follower.enabled != null && typeof follower.enabled !== 'boolean') {
      throw new Error('Follower má neplatný ruční participation stav');
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
  const durableStore: CopierStore = {
    load: () => options.store.load(),
    async commit(snapshot, expectedRevision) {
      try {
        return await options.store.commit(snapshot, expectedRevision);
      } catch (reason) {
        throw reason instanceof CopierProcessorCommitError
          ? reason
          : new CopierProcessorCommitError(reason);
      }
    },
  };
  let group = normalizedRuntimeGroup(options.group);
  let startupMissingLeaderRoute: Error | null = null;
  try {
    options.broker.setCriticalAccounts?.([group.leaderAccountId]);
  } catch (reason) {
    const error = errorOf(reason);
    // Po odpojení zlikvidované prop firmy smí worker pouze naběhnout v
    // DISARMED stavu, aby šlo starou skupinu administrativně vyřadit.
    // Jakákoli jiná chyba bootstrapu zůstává fatální; samotný text
    // missing leader chyby nikdy nestačí. Autorizace musí pojmenovat
    // přesnou skupinu i celou topologii a každý její účet musí stejný
    // router potvrdit jako chybějící.
    const retirementBootstrap = options.missingGroupRetirementBootstrap;
    const topology = [group.leaderAccountId, ...group.followers.map(item => item.accountId)]
      .sort((a, b) => a - b);
    const asserted = [...new Set(retirementBootstrap?.accountIds ?? [])]
      .sort((a, b) => a - b);
    const exactAuthorization = error.message.includes(
      `Pro účet ${group.leaderAccountId} není nakonfigurované OAuth spojení`,
    )
      && retirementBootstrap?.groupId === group.id
      && asserted.length === retirementBootstrap.accountIds.length
      && asserted.length === topology.length
      && asserted.every((accountId, index) => accountId === topology[index]);
    const everyAccountMissing = exactAuthorization && topology.every(accountId => {
      try {
        options.broker.setCriticalAccounts?.([accountId]);
        return false;
      } catch (accountReason) {
        return errorOf(accountReason).message.includes(
          `Pro účet ${accountId} není nakonfigurované OAuth spojení`,
        );
      }
    });
    const repairBootstrap = options.unusableGroupRepairBootstrap;
    const repairAuthorizesMissingLeader = repairBootstrap?.groupId === group.id
      && repairBootstrap.unavailableAccountIds.includes(group.leaderAccountId!)
      && error.message.includes(`Pro účet ${group.leaderAccountId} není nakonfigurované OAuth spojení`);
    if (!everyAccountMissing && !repairAuthorizesMissingLeader) throw error;
    startupMissingLeaderRoute = error;
  }
  let startupGroupRepair: { groupId: string; unavailableAccountIds: number[] } | null = (
    options.unusableGroupRepairBootstrap?.groupId === group.id
    && options.unusableGroupRepairBootstrap.unavailableAccountIds.length > 0
  )
    ? {
      groupId: group.id,
      unavailableAccountIds: [...new Set(options.unusableGroupRepairBootstrap.unavailableAccountIds)]
        .sort((a, b) => a - b),
    }
    : null;
  const broker = createExposureCappedBroker(
    options.broker,
    accountId => group.followers.find(item => item.accountId === accountId)?.maxContracts,
  );
  let runtime: CopierRuntime = runtimeFromSnapshot(await durableStore.load());
  const metrics = options.metrics ?? createCopierMetrics();
  const recovered = await recoverOutbox({
    runtime,
    broker,
    clock,
    store: durableStore,
    metrics,
  });
  runtime = recovered.runtime;
  if (recovered.audit.length > 0) options.onAudit?.(recovered.audit);

  const processor = createSerialCopierProcessor(runtime, {
    reload: async () => runtimeFromSnapshot(await durableStore.load()),
  });
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
        || !Number.isFinite(cut.cutUsd)
        || (cut.source === 'manual' ? cut.cutUsd !== 0 : cut.cutUsd <= 0)
        || (cut.source !== 'broker' && cut.source !== 'ledger' && cut.source !== 'manual' && cut.source !== 'prop-reserve')
        || (cut.scope !== undefined && cut.scope !== 'session' && cut.scope !== 'trade')
        || (cut.source === 'manual' && cut.scope !== 'trade')
        || (cut.operationId !== undefined && (typeof cut.operationId !== 'string' || cut.operationId.trim().length < 8))
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
        || !sameTradovateSession(snapshot.verifiedAt, clock())
      ) return [];
      return [[snapshot.accountId, {
        accountId: snapshot.accountId,
        verifiedAt: snapshot.verifiedAt,
        realizedPnlUsd: finiteOrNullField(snapshot.realizedPnlUsd),
        openPnlUsd: finiteOrNullField(snapshot.openPnlUsd),
        netLiq: finiteOrNullField(snapshot.netLiq),
        cashBalanceUsd: finiteOrNullField(snapshot.cashBalanceUsd),
        highWaterNetLiq: finiteOrNullField(snapshot.highWaterNetLiq),
        minNetLiq: finiteOrNullField(snapshot.minNetLiq),
        dailyLossAutoLiq: finiteOrNullField(snapshot.dailyLossAutoLiq),
        trailingMaxDrawdown: finiteOrNullField(snapshot.trailingMaxDrawdown),
        trailingMaxDrawdownLimit: finiteOrNullField(snapshot.trailingMaxDrawdownLimit),
        propLimitUsd: finiteOrNullField(snapshot.propLimitUsd),
        effectiveDailyLossCutUsd: finiteOrNullField(snapshot.effectiveDailyLossCutUsd),
        configuredDailyLossCutUsd: finiteOrNullField(snapshot.configuredDailyLossCutUsd),
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
                markOutboxRejected(entry, auditReason, receivedAt, 'broker'),
                `${auditReason} — účet vyřazen z nových vstupů (${classified})`,
                receivedAt,
              )
            : markOutboxRejected(entry, auditReason, receivedAt, 'broker'));
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
      const committed = await durableStore.commit(
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
  const effectiveFollowerCutAction = (
    cut: CopierFollowerCut,
    follower: CopyGroupConfig['followers'][number],
  ): 'close-copy' | 'let-run' => (
    cut.source === 'manual' || cut.source === 'prop-reserve'
      ? 'close-copy'
      : follower.onCut ?? 'close-copy'
  );
  const currentEntryIneligibleAccounts = (now = clock()): ReadonlyMap<number, string> => {
    const ineligible = new Map(currentIneligibleAccounts(now));
    for (const follower of group.followers) {
      if (follower.enabled === false) ineligible.set(follower.accountId, 'manual-participation-disabled');
      const cut = activeFollowerCut(follower.accountId, now);
      if (cut) ineligible.set(follower.accountId, `follower-cut:${cut.source}:${cut.until}`);
    }
    return ineligible;
  };
  const currentExitIneligibleAccounts = (now = clock()): ReadonlyMap<number, string> => {
    const ineligible = new Map(currentIneligibleAccounts(now));
    for (const follower of group.followers) {
      if (follower.enabled === false) ineligible.set(follower.accountId, 'manual-participation-disabled');
      const cut = activeFollowerCut(follower.accountId, now);
      const closesCopy = cut != null && effectiveFollowerCutAction(cut, follower) === 'close-copy';
      if (cut && closesCopy && (cut.source === 'manual' || cut.closed !== false)) {
        // `close-copy` už vlastní vlastní liquidation lifecycle. Jakýkoli
        // pozdější leader exit/protective příkaz by po úspěšném flat
        // mohl na tomto followerovi otevřít opačnou pozici. `let-run` se
        // naopak záměrně nevyřazuje, aby jeho existující kopie směla dojet.
        // Po SELHANÉM automatickém risk cutu (closed=false) kopie stále žije,
        // proto se chová jako let-run a leader exit ji smí zavřít. Ruční
        // trade cut zůstává vyřazený i po selhání: další příkaz by mohl
        // zasáhnout manuální/nejistou expozici, kvůli níž close neprošel.
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
      followers: group.followers.filter(follower => follower.enabled !== false && follower.mode !== 'off').length,
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
  /** Čas poslední úplné broker kontroly pozic (reconciliation / recovery) v tomto běhu. */
  let lastAuthoritativeReadAt: number | null = null;
  /** Čas poslední broker Position entity ze streamu nebo čtení. */
  let lastBrokerPositionAt: number | null = null;
  // A complete position/list also proves zero for symbols omitted by the broker.
  // A per-symbol stream event alone does not establish that account-wide fact.
  let leaderPositionSnapshotComplete = false;
  // Keep ownership/audit records intact, but never reuse a pre-reconciliation
  // epoch as exposure after an authoritative flat snapshot. Rebuilt at boot
  // by the mandatory pre-ARM reconciliation (not a persisted "all safe" flag).
  const flatReconciledLeaderEpochIds = new Set<string>();
  let workingOrderAccounts = new Set<number>();
  const storedManualRecovery = runtime.state.safety.manualRecoveryRequired;
  const restoredManualRecovery = storedManualRecovery == null
    ? null
    : typeof storedManualRecovery === 'object'
      && Number.isFinite(storedManualRecovery.at)
      && storedManualRecovery.at > 0
      && typeof storedManualRecovery.reason === 'string'
      && storedManualRecovery.reason.trim().length > 0
      ? { at: storedManualRecovery.at, reason: storedManualRecovery.reason.trim() }
      : { at: clock(), reason: 'Durable příznak ruční obnovy je neplatný; proveď Kontrolu pozic' };
  let lastError: Error | null = startupGroupRepair
    ? new Error(
      `Uložená skupina má nedostupné účty (${startupGroupRepair.unavailableAccountIds.join(', ')}); `
      + 'worker běží jen VYPNUTÝ v režimu opravy. Uprav skupinu v UI a nedostupné účty z ní odeber.',
    )
    : startupMissingLeaderRoute ?? (restoredManualRecovery
      ? new Error(restoredManualRecovery.reason)
      : null);
  const disarmHistory: CopierDisarmRecord[] = (runtime.state.safety.disarmHistory ?? [])
    .filter(record => (
      Number.isFinite(record?.at)
      && record.at > 0
      && typeof record.detail === 'string'
      && typeof record.trigger === 'string'
      && typeof record.copiesOutcome === 'string'
    ))
    .slice(-COPIER_DISARM_HISTORY_LIMIT)
    .map(record => createCopierDisarmRecord({
      at: record.at,
      trigger: record.trigger,
      detail: record.detail,
      copiesOutcome: record.copiesOutcome,
      code: record.code,
      ...(record.episodeId ? { episodeId: record.episodeId } : {}),
    }));
  let lastDisarm: CopierDisarmRecord | undefined = disarmHistory.at(-1);
  let lastHostSleep: NonNullable<CopierControllerStatus['hostSleep']> | null = null;
  let lastOauthPreflight: NonNullable<CopierControllerStatus['oauthPreflight']> | undefined;
  /**
   * Monotónní verze bezpečnostního stavu. Reconciliation si ji zapamatuje
   * před broker I/O a čistý výsledek smí potvrdit pouze tehdy, když během
   * čtení nevznikl novější incident, reconnect ani jiná invalidace.
   */
  let safetyGeneration = 0;
  let participationGeneration = 0;
  /** Každá přijatá runtime konfigurace zneplatní background práci staré skupiny. */
  let groupRevision = 0;
  /** Agregovaný connection event zneplatní in-memory order důkaz; router ale
   * nekritický follower reconnect může skrýt, proto V12 výjimka vždy dělá
   * autoritativní lookup obou orderů a follower pozice. */
  let connectionSyncGeneration = 0;
  /** Jedna live ARM session = jedna obchodní epocha pro krátkodobou pending lineage. */
  let tradeEpochGeneration = 0;

  // Ingress runs synchronously, while handleBrokerEvent is serialized behind
  // potentially slow OSO correlation/store writes. A terminal leader event
  // must fence an older submitted event before its follower broker write,
  // even when that terminal event has not reached the event processor yet.
  const terminalLeaderOrdersOnIngress = new Map<string, 'rejected' | 'canceled'>();
  /** Každý povolený broker dispatch zneplatní snapshot vlny pořízený před ním. */
  let dispatchObservationVersion = 0;

  // Capture admission once, but read live safety again after every async preflight,
  // immediately before the raw broker write. Re-ARM cannot revive an older job.
  const dispatchBroker = (
    generation: number,
    event?: LeaderEvent,
    leaderOrderIds: readonly string[] = event ? [event.orderId] : [],
  ): BrokerPort => createExposureCappedBroker(
    options.broker,
    accountId => group.followers.find(follower => follower.accountId === accountId)?.maxContracts,
    operation => {
      if (event && (event.kind === 'submitted' || leaderOrderIds.length > 1)
        && (operation === 'place' || operation === 'oso')) {
        const terminal = leaderOrderIds.find(orderId =>
          terminalLeaderOrdersOnIngress.has(`${event.accountId}:${orderId}`));
        if (terminal) {
          const status = terminalLeaderOrdersOnIngress.get(`${event.accountId}:${terminal}`);
          throw new CopierDispatchRevokedError(`leader-${status}-before-dispatch:${terminal}`);
        }
      }
      const terminalCancel = operation === 'cancel'
        && (event?.kind === 'canceled' || event?.kind === 'rejected')
        && ![...runtime.bracketOutbox.values(), ...runtime.osoOutbox.values()]
          .some(entry => entry.leaderStopOrderId === event.orderId || entry.leaderTargetOrderId === event.orderId);
      const current = { ...gate, now: clock() };
      const reason = stopped ? 'stopped'
        : terminalCancel ? cancelLifecycleHaltReason(current)
        : shutdownRequested ? 'shutdown'
        : generation !== safetyGeneration ? 'safety-generation-changed'
        : current.shadowMode ? 'shadow-mode'
        : haltReason(current);
      if (reason) throw new CopierDispatchRevokedError(reason);
      dispatchObservationVersion += 1;
    },
  );
  let eventTail: Promise<void> = Promise.resolve();
  /** Durable audit writes are serialized separately from broker event ingress. */
  let disarmPersistenceTail: Promise<void> = Promise.resolve();
  /** Konfigurační read-only preflighty jsou sériové, broker eventy ale neblokují. */
  let reconfigurationTail: Promise<void> = Promise.resolve();

  /** Broker lifecycle follower cutu běží mimo eventTail; sada slouží jen waitForIdle/stop observabilitě. */
  const followerCutBackgroundJobs = new Set<Promise<unknown>>();
  const followerCutBackgroundAccounts = new Set<number>();
  const followerCutBackgroundJobsByAccount = new Map<number, Promise<unknown>>();
  const followerCutBackgroundAbortByAccount = new Map<number, (reason: string) => void>();
  /**
   * Všechny raw broker write promises mimo hlavní processor lane. Deadline
   * ukončí čekání volajícího, ne samotný request; dokud raw promise běží,
   * další risk-redukční cesta musí stejný účet pouze označit jako nejasný.
   */
  const inFlightBrokerWritesByAccount = new Map<number, Set<Promise<unknown>>>();
  const registerInFlightBrokerWrite = <T>(accountId: number, raw: Promise<T>): Promise<T> => {
    const pending = inFlightBrokerWritesByAccount.get(accountId) ?? new Set<Promise<unknown>>();
    pending.add(raw);
    inFlightBrokerWritesByAccount.set(accountId, pending);
    const cleanup = () => {
      const current = inFlightBrokerWritesByAccount.get(accountId);
      current?.delete(raw);
      if (current?.size === 0) inFlightBrokerWritesByAccount.delete(accountId);
    };
    void raw.then(cleanup, cleanup);
    return raw;
  };
  const cancelFollowerCutBackgroundLanes = (reason: string) => {
    for (const abort of followerCutBackgroundAbortByAccount.values()) abort(reason);
  };
  const settleFollowerCutBackgroundAccounts = async (
    accountIds: readonly number[],
  ): Promise<Set<number>> => {
    const jobsByAccount = new Map(accountIds.flatMap(accountId => {
      const job = followerCutBackgroundJobsByAccount.get(accountId);
      return job ? [[accountId, job] as const] : [];
    }));
    const jobs = [...new Set(jobsByAccount.values())];
    if (jobs.length === 0) {
      return new Set(accountIds.filter(accountId => (
        (inFlightBrokerWritesByAccount.get(accountId)?.size ?? 0) > 0
      )));
    }
    const timeoutMs = Math.max(1, options.followerCutDeadlineMs ?? 90_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    let settled = false;
    try {
      settled = await Promise.race([
        Promise.allSettled(jobs).then(() => true as const),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return new Set(accountIds.filter(accountId => (
      (inFlightBrokerWritesByAccount.get(accountId)?.size ?? 0) > 0
      || (!settled && jobsByAccount.has(accountId))
    )));
  };
  const awaitFollowerCutBackgroundAccounts = async (
    accountIds: readonly number[],
    label: string,
  ): Promise<void> => {
    const protectedAccounts = await settleFollowerCutBackgroundAccounts(accountIds);
    const accountId = [...protectedAccounts][0];
    if (accountId != null) {
      throw new Error(
        `${label}: účet ${accountId} má stále nejasný broker write z background lane; vyžaduje read-only reconciliation po jeho doběhnutí`,
      );
    }
  };
  let brokerObservationVersion = 0;
  /** Connection/error/resync/route-gap ingress fence pro durable config zápisy. */
  let configurationControlVersion = 0;
  /** Jen události, které mohou změnit trade boundary; heartbeat čtení nesmí hladovět. */
  let tradeBoundaryObservationVersion = 0;
  /** Aktuální + už přijaté, ale serializací ještě nezpracované broker eventy. */
  let pendingBrokerEvents = 0;
  const connectionRenewalQuietMs = Math.max(0, options.connectionRenewalQuietMs ?? 5_000);
  const connectionRenewalClock = options.connectionRenewalClock ?? Date.now;
  let leaderEventQuietUntil = 0;
  /**
   * Trade ingress čekající před eventTail, po účtech. Zpracovávaná událost
   * už v čítači není; V12 streamový důkaz tak vidí pouze backlog za sebou.
   */
  const pendingTradeIngressByAccount = new Map<number, number>();
  /** Nové účty právě ověřované změnou skupiny musí být součástí scoped fence. */
  const configurationFenceAccountRefs = new Map<number, number>();
  /**
   * Objektový ingress plot pro V12. Účetní čítač zůstává pro reconciliation,
   * ale pending mirror smí invalidovat jen event stejného symbolu/orderu.
   */
  const pendingTradeIngressByKey = new Map<string, number>();
  /** Account-scoped fence pro reconciliation; ruch jiné OAuth route ho neruší. */
  const tradeObservationVersionByAccount = new Map<number, number>();
  const pendingTradeEventsFor = (accountIds: readonly number[]): boolean => (
    accountIds.some(accountId => (pendingTradeIngressByAccount.get(accountId) ?? 0) > 0)
  );

  /** REST snapshot generation; prevents an older epoch refresh overwriting a newer targeted read. */
  const authoritativeReadVersionByAccount = new Map<number, number>();
  let accountRiskPollTail: Promise<void> = Promise.resolve();
  const accountRiskLastRequestedAt = new Map<number, number>();
  /** Jak starý smí být terminální reject vstupu, aby vysvětlil flat followera při otevřeném leaderu. */
  const REJECTED_ENTRY_ISOLATION_WINDOW_MS = 15 * 60_000;
  const MAX_EXPOSURE_EVENT_AGE_MS = 5_000;
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
  const ARM_PREPARATION_MAX_AGE_MS = 30_000;
  const ARM_PREPARATION_ACTIVE_REFRESH_MS = 20_000;
  const ARM_PREPARATION_IDLE_REFRESH_MS = 5 * 60_000;
  const ARM_PREPARATION_INTEREST_MS = 60_000;
  let armPreparationReceipt: {
    generation: number;
    observation: number;
    connection: number;
    configuration: string;
    verifiedAt: number;
    accountIds: number[];
    routes: string | null;
  } | null = null;
  let armPreparationInFlight: Promise<void> | null = null;
  let armPreparationError: string | null = null;
  let armPreparationIncidentRequiresRecovery = restoredManualRecovery != null;
  let armPreparationLastAttemptAt = -Infinity;
  let armPreparationInterestUntil = -Infinity;
  let automaticArmPreparation = false;
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
    leaderOrderId: string;
    followerBrokerOrderId: string;
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: BrokerOrder['orderType'];
    multiplier: number;
    leaderQuantity: number;
    followerQuantity: number;
    leaderLimitPrice?: number;
    leaderStopPrice?: number;
    followerLimitPrice?: number;
    followerStopPrice?: number;
    leaderOrderReportedFilled: number;
    leaderCumQuantity: number;
    followerOrderReportedFilled: number;
    followerFillReportedQuantity: number;
    tradeEpochGeneration: number;
    connectionSyncGeneration: number;
    leaderRouteEpoch: number | null;
    followerRouteEpoch: number | null;
    evidenceInvalid: boolean;
    /** Tvary, které kopírka sama dříve potvrdila během modify lifecycle. */
    priorFollowerShapes?: readonly string[];
    /** Po přijetí aktuálního potvrzeného tvaru už starší tvar nesmí znovu projít. */
    currentFollowerShapeObserved?: boolean;
  }
  const currentRuntimePendingExposure = new Map<string, CurrentRuntimePendingExposure>();
  const seenCurrentRuntimePendingFillIds = new Set<string>();
  let s1bIngressVersion = 0;
  const s1bIngressOrders = new Map<string, { version: number; order: BrokerOrder }>();
  const s1bIngressFillQuantities = new Map<string, {
    version: number;
    accountId: number;
    symbol: string;
    side: 'Buy' | 'Sell';
    quantity: number;
  }>();
  const s1bIngressFillIds = new Set<string>();
  const s1bIngressPositions = new Map<string, { version: number; netQuantity: number }>();
  const s1bIngressWaiters = new Set<() => void>();
  const observeS1bIngress = (event: BrokerEvent): void => {
    if (event.type !== 'order' && event.type !== 'fill' && event.type !== 'position') return;
    s1bIngressVersion += 1;
    if (event.type === 'order') {
      s1bIngressOrders.set(event.order.brokerOrderId, {
        version: s1bIngressVersion,
        order: { ...event.order },
      });
    } else if (event.type === 'fill' && !s1bIngressFillIds.has(event.fill.fillId)) {
      s1bIngressFillIds.add(event.fill.fillId);
      const current = s1bIngressFillQuantities.get(event.fill.brokerOrderId);
      s1bIngressFillQuantities.set(event.fill.brokerOrderId, {
        version: s1bIngressVersion,
        accountId: event.fill.accountId,
        symbol: event.fill.symbol,
        side: event.fill.side,
        quantity: (current?.quantity ?? 0) + event.fill.quantity,
      });
    } else if (event.type === 'position') {
      s1bIngressPositions.set(`${event.position.accountId}:${event.position.symbol}`, {
        version: s1bIngressVersion,
        netQuantity: event.position.netQuantity,
      });
    }
    for (const wake of [...s1bIngressWaiters]) wake();
    while (s1bIngressFillIds.size > 2_048) {
      const oldest = s1bIngressFillIds.values().next().value as string | undefined;
      if (!oldest) break;
      s1bIngressFillIds.delete(oldest);
    }
  };
  const conditionalMirrorSourcesByLeaderEvent = new Map<string, Map<number, string[]>>();
  const conditionalMirrorWritesBySourceOrder = new Map<string, {
    accountId: number;
    symbol: string;
    leaderOrderId: string;
    multiplier: number;
    sourceQuantity: number;
    sourceFilledQuantity: number;
    dispatchedAt: number;
    dependentOrderIds: Set<string>;
  }>();
  /** S1b cancel byl jednou autoritativně potvrzen jako zero-fill terminal. */
  const s1bCanceledZeroFillOrderIds = new Map<string, {
    accountId: number;
    symbol: string;
    epochId: string | null;
  }>();
  /** Bounded settlement doběhl bez terminálu; pozdější fill je orphan incident. */
  const s1bUnresolvedCopyOrderIds = new Map<string, {
    accountId: number;
    symbol: string;
    leaderEventId: string;
  }>();
  /**
   * Lokální lineage záměrně vynechaných vstupů. Umožní pozdějšímu leader
   * exitu pouze zmenšit skutečně drženou follower pozici, nikdy ji otočit.
   * Po restartu se záměr neodhaduje: runtime startuje DISARMED a mismatch
   * musí projít novou autoritativní reconciliation.
   */
  interface IntentionalEntrySuppression {
    allowedNet: number;
    createdAt: number;
    leaderOrderId: string;
    /** Otevřená leader epizoda, ke které výjimka patří; před Position open může být null. */
    epochId: string | null;
    /** Nulová výjimka je platná jen nad stejným autoritativním broker snapshotem. */
    observationVersion: number;
    zeroEvidence: boolean;
  }
  const intentionalEntrySuppressions = new Map<string, IntentionalEntrySuppression>();
  /**
   * A3 (review 30. 9.): zpožděný leader reversal (mixed exit+entry) nesmí
   * zablokovat i svou exitovou část. Followeři dostanou jen exit slice,
   * vstup se nekopíruje a fail-closed proběhne až po jeho dispatchi.
   */
  const staleExitOnlyEventIds = new Set<string>();
  let deferredStaleFailClosed: Error | null = null;
  /**
   * On-fill followeři dostanou exit slice až z `filled`. Zpožděný `submitted`
   * reversalu proto fail-closed odloží na fill téhož orderu (který se
   * nezávisle na stáří kopíruje jen exit-only).
   */
  const staleReversalOrderIds = new Map<string, Error>();
  interface EpisodeFollowerIsolationEvidence {
    accountId: number;
    symbol: string;
    epochId: string;
    eligibilityState: 'breached' | 'dll-locked';
    observedAt: number;
    observationVersion: number;
  }
  const exitOnlyReservations = new Map<string, {
    accountId: number;
    symbol: string;
    remaining: number;
    initialNet: number;
    filled: number;
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
  // A fill-derived lot can be newer than the last Position projection. Keep
  // that causal ordering explicit rather than always preferring either cache.
  const leaderFillAheadOfPosition = new Set<string>();
  const rememberLeaderPosition = (symbol: string, netQuantity: number) => {
    leaderPositions.set(symbol, netQuantity);
    leaderFillAheadOfPosition.delete(symbol);
  };
  const positionsByAccount = new Map<number, Map<string, number>>();
  /**
   * Aktivní příkazy účtů skupiny z `order` událostí streamu a z úplných
   * broker čtení při reconciliation. Pro execution se používají pouze jako
   * přesný zero-fill důkaz ve stejné connection generation; jinak fail-closed.
   */
  const liveOrdersByAccount = new Map<number, Map<string, BrokerOrder>>();
  const liveOrderGenerationsByAccount = new Map<number, Map<string, number>>();
  const observedOrderStatusesByAccount = new Map<number, Map<string, BrokerOrder['status']>>();
  const rememberLiveOrder = (order: BrokerOrder) => {
    const observed = observedOrderStatusesByAccount.get(order.accountId)
      ?? new Map<string, BrokerOrder['status']>();
    observed.set(order.brokerOrderId, order.status);
    observedOrderStatusesByAccount.set(order.accountId, observed);
    const orders = liveOrdersByAccount.get(order.accountId) ?? new Map<string, BrokerOrder>();
    const generations = liveOrderGenerationsByAccount.get(order.accountId) ?? new Map<string, number>();
    if (isOpenOrderStatus(order.status)) {
      orders.set(order.brokerOrderId, order);
      generations.set(order.brokerOrderId, connectionSyncGeneration);
    } else {
      orders.delete(order.brokerOrderId);
      generations.delete(order.brokerOrderId);
    }
    liveOrdersByAccount.set(order.accountId, orders);
    liveOrderGenerationsByAccount.set(order.accountId, generations);
  };
  const rememberLiveOrderSnapshot = (accountId: number, orders: readonly BrokerOrder[]) => {
    const open = orders.filter(order => isOpenOrderStatus(order.status));
    liveOrdersByAccount.set(accountId, new Map(open.map(order => [order.brokerOrderId, order])));
    liveOrderGenerationsByAccount.set(accountId, new Map(
      open.map(order => [order.brokerOrderId, connectionSyncGeneration]),
    ));
  };
  /** Leader příkaz je podle order streamu zrušený (i s částečným plněním). */
  const leaderOrderCanceled = (leaderOrderId: string): boolean => (
    group.leaderAccountId != null
    && observedOrderStatusesByAccount.get(group.leaderAccountId)?.get(leaderOrderId) === 'canceled'
  );
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
  /**
   * Běžný reconnect v už DISARMED runtime potřebuje jen nový autoritativní
   * pre-ARM snapshot. Tato větev nikdy nesmí poslat cancel, liquidate ani
   * jiný broker write; ne-flat/working/nejistý stav zůstane fail-closed.
   */
  let pendingReadOnlyConnectionRecovery = false;
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
  const pendingOsoGenerations = new Map<string, number>();
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
  type FollowerFillRole = 'copied-entry' | 'copied-exit' | 'protective';
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
  const leaderFlatGuardGenerationRetries = new Map<string, number>();
  const LEADER_FLAT_GENERATION_RETRY_LIMIT = 3;
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
  /** OSO entry parent, na který flat sweep už odeslal risk-redukující cancel. */
  const flatSweepEntryCancelAttempts = new Set<string>();
  /**
   * Nejistý flat-sweep cancel. Blokuje další write jen do prvního nového
   * autoritativního snapshotu; working order nad potvrzeně flat followerem
   * je potom nové rozhodnutí, ne slepý retry.
   */
  const flatSweepCancelAttempts = new Set<string>();
  const flatSweepCancelAttemptAccounts = new Map<string, number>();
  /** Rušení právě běží; brání smyčce cancel → position event → cancel. */
  const sweepingProtectiveLegs = new Set<string>();
  const FLAT_SWEEP_TOTAL_BUDGET_MS = options.flatSweepBudgetMs ?? 6_000;
  if (!Number.isFinite(FLAT_SWEEP_TOTAL_BUDGET_MS) || FLAT_SWEEP_TOTAL_BUDGET_MS <= 0) {
    throw new Error('flatSweepBudgetMs musí být kladné číslo');
  }
  if (FLAT_SWEEP_TOTAL_BUDGET_MS >= 10_000) {
    throw new Error('flatSweepBudgetMs musí být bezpečně pod heartbeat bránou 10000 ms');
  }
  const FLAT_SWEEP_CANCEL_TIMEOUT_MS = options.flatSweepCancelTimeoutMs ?? 2_000;
  if (!Number.isFinite(FLAT_SWEEP_CANCEL_TIMEOUT_MS) || FLAT_SWEEP_CANCEL_TIMEOUT_MS <= 0) {
    throw new Error('flatSweepCancelTimeoutMs musí být kladné číslo');
  }
  if (FLAT_SWEEP_CANCEL_TIMEOUT_MS >= 10_000) {
    throw new Error('flatSweepCancelTimeoutMs musí být bezpečně pod heartbeat bránou 10000 ms');
  }
  /** Horní mez skutečně pracovních noh v jedné okamžité sweep dávce. */
  const SWEEP_MAX_LEGS_PER_CALL = 6;
  const STREAM_SWEEP_READ_TIMEOUT_MS = 250;
  /** TooLate cancel: krátké čtení streamu, než order u brokera doběhne. */
  const TOO_LATE_STREAM_SETTLE_DELAYS_MS = [250, 500, 750] as const;
  /** Rezerva rozpočtu sweepu na závěrečnou postkontrolu (orders + pozice). */
  const FLAT_SWEEP_SETTLE_RESERVE_MS = 2_000;

  interface FlatSweepBudget {
    startedAt: number;
  }

  const createFlatSweepBudget = (startedAt = performance.now()): FlatSweepBudget => ({ startedAt });

  const flatSweepRemainingMs = (budget: FlatSweepBudget) => (
    FLAT_SWEEP_TOTAL_BUDGET_MS - (performance.now() - budget.startedAt)
  );

  const withFlatSweepBudget = async <T>(
    budget: FlatSweepBudget,
    label: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const remaining = flatSweepRemainingMs(budget);
    if (remaining <= 0) throw new Error('celkový deadline ' + FLAT_SWEEP_TOTAL_BUDGET_MS + ' ms');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(label + ': celkový deadline ' + FLAT_SWEEP_TOTAL_BUDGET_MS + ' ms')),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const withFlatSweepCancelDeadline = async <T>(
    accountId: number,
    brokerOrderId: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(
              `cancel deadline ${FLAT_SWEEP_CANCEL_TIMEOUT_MS} ms (${accountId}/${brokerOrderId})`,
            )),
            FLAT_SWEEP_CANCEL_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const streamSweepStatuses = async (
    accountId: number,
    brokerOrderIds: readonly string[],
  ): Promise<Map<string, BrokerOrderStatusLookup>> => {
    if (!broker.findOrderStatusById) return new Map();
    const rows = await Promise.all([...new Set(brokerOrderIds)].map(async brokerOrderId => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const lookup = await Promise.race([
        broker.findOrderStatusById!(accountId, brokerOrderId, { streamOnly: true }),
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), STREAM_SWEEP_READ_TIMEOUT_MS);
        }),
      ]).catch(() => null).finally(() => clearTimeout(timer));
      return [brokerOrderId, lookup] as const;
    }));
    return new Map(rows.filter(([, lookup]) => (
      lookup != null && lookup.completeness === 'authoritative' && lookup.status != null
    )) as Array<readonly [string, BrokerOrderStatusLookup]>);
  };

  /**
   * Kauzalita podle přesného broker orderId. Historické znaménko ochranných
   * nohou nestačí: po restartu v durable outboxu zůstávají staré strategie a
   * nová legitimní long kopie pak může vypadat jako fill staré Buy ochrany.
   */
  const isStandaloneProtective = (value: unknown): boolean => (
    (value as { protectiveRole?: string } | null)?.protectiveRole === 'standalone-stop'
  );
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
        if (isStandaloneProtective(entry)) return 'protective';
        const increasesExposure = entry.leaderEventId == null
          ? undefined
          : leaderExposureIncreaseByEventId.get(entry.leaderEventId);
        return increasesExposure === true
          ? 'copied-entry'
          : increasesExposure === false
            ? 'copied-exit'
            // Klasifikační mapa je bounded. Po jejím vypadnutí je bezpečnější
            // předpokládat vstupní fill a posílit pouze přesnou order lineage,
            // než fill nechat bez role a tím obejít následnou kontrolu.
            : 'copied-entry';
      }
    }
    return null;
  };
  interface FlatSweepHint {
    /** Přesná ochranná noha, jejíž fill způsobil přechod do flat. */
    protectiveFillBrokerOrderId?: string;
    /** Čerstvý autoritativní order snapshot z reconciliation. */
    authoritativeOrders?: readonly BrokerOrder[];
    /** Líně sdílený globální order graf pro jednu ingress vlnu flat eventů. */
    loadAuthoritativeOrders?: () => Promise<readonly BrokerOrder[]>;
  }

  const recordTerminalSweepState = (
    accountId: number,
    brokerOrderId: string,
    status: BrokerOrderStatusLookup['status'],
  ): void => {
    if (status == null || isOpenOrderStatus(status)) return;
    flatSweepCancelAttempts.delete(brokerOrderId);
    flatSweepCancelAttemptAccounts.delete(brokerOrderId);
    if (followerFillRole(accountId, brokerOrderId) === 'protective') {
      sweptProtectiveLegs.add(brokerOrderId);
    }
    const reservation = exitOnlyReservations.get(brokerOrderId);
    if (!reservation) return;
    if (status === 'filled') {
      exitOnlyPositionApplied.add(brokerOrderId);
      return;
    }
    exitOnlyReservations.delete(brokerOrderId);
    exitOnlyPositionApplied.delete(brokerOrderId);
  };

  const recordAuthoritativeSweepAbsence = (
    accountId: number,
    brokerOrderId: string,
  ): void => {
    flatSweepCancelAttempts.delete(brokerOrderId);
    flatSweepCancelAttemptAccounts.delete(brokerOrderId);
    if (followerFillRole(accountId, brokerOrderId) === 'protective') {
      sweptProtectiveLegs.add(brokerOrderId);
    }
    exitOnlyReservations.delete(brokerOrderId);
    exitOnlyPositionApplied.delete(brokerOrderId);
  };

  const preferredSweepStatus = (
    ...statuses: Array<BrokerOrderStatusLookup['status'] | undefined>
  ): BrokerOrderStatusLookup['status'] => (
    statuses.find(status => status != null && !isOpenOrderStatus(status))
    ?? statuses.find((status): status is NonNullable<typeof status> => status != null)
    ?? null
  );

  const waiveResolvedSweepLifecycles = async (
    brokerOrderIds: ReadonlySet<string>,
  ): Promise<void> => {
    if (brokerOrderIds.size === 0) return;
    await processor.mutate(async current => {
      const cancelOutbox = new Map(current.cancelOutbox);
      for (const [key, entry] of cancelOutbox) {
        if (!brokerOrderIds.has(entry.brokerOrderId)
          || (entry.status !== 'unknown' && entry.status !== 'sending')) continue;
        cancelOutbox.set(key, waiveCancelEntry(
          entry,
          'autoritativně potvrzený flat + žádná pracovní ochranná noha',
          clock(),
        ));
      }
      return { ...current, cancelOutbox };
    });
  };

  const sweepFollowerProtectiveLegs = async (
    accountId: number,
    symbol: string,
    at: number,
    hint: FlatSweepHint = {},
    sharedBudget?: FlatSweepBudget,
  ): Promise<void> => {
    const budget = sharedBudget ?? createFlatSweepBudget();
    const runtime = currentRuntime();
    const bracketEntries = [...runtime.bracketOutbox.values()].filter(entry => (
      entry.request.accountId === accountId && entry.request.symbol === symbol
    ));
    const osoEntries = [...runtime.osoOutbox.values()].filter(entry => (
      entry.request.accountId === accountId && entry.request.symbol === symbol
    ));
    const protectiveEntries = [...bracketEntries, ...osoEntries];
    const standaloneIds = [
      ...[...runtime.outbox.values()]
        .filter(entry => (
          entry.request.accountId === accountId
          && entry.request.symbol === symbol
          && isStandaloneProtective(entry)
        ))
        .map(entry => entry.brokerOrderId),
      ...[...runtime.state.links.values()].flat()
        .filter(link => link.accountId === accountId && isStandaloneProtective(link))
        .map(link => link.brokerOrderId),
    ].filter((brokerOrderId): brokerOrderId is string => Boolean(brokerOrderId));

    const allLegIds = [...new Set(
      [
        ...protectiveEntries.flatMap(entry => [entry.firstBrokerOrderId, entry.secondBrokerOrderId])
          .filter((brokerOrderId): brokerOrderId is string => Boolean(brokerOrderId)),
        ...standaloneIds,
      ],
    )];
    const candidateIds = allLegIds.filter(brokerOrderId => (
      !sweptProtectiveLegs.has(brokerOrderId)
      && !sweepingProtectiveLegs.has(brokerOrderId)
    ));
    if (candidateIds.length === 0) return;

    let followerFlatConfirmed = false;
    const failSweep = (reason: string, brokerOrderId?: string) => {
      options.onAudit?.([{
        at,
        leaderEventId: 'flat-sweep-' + accountId + '-' + (brokerOrderId ?? symbol),
        accountId,
        ...(brokerOrderId ? { brokerOrderId } : {}),
        kind: 'cancel-failed',
        reason,
      }]);
      const error = new Error(
        'Flat sweep nedokončen — účet ' + accountId + ' ' + symbol + ': ' + reason,
      );
      if (followerFlatConfirmed) failClosed(error, { autoClose: false });
      else failClosed(error);
    };

    try {
      const osoParentIds = osoEntries
        .map(entry => entry.entryBrokerOrderId)
        .filter((brokerOrderId): brokerOrderId is string => Boolean(brokerOrderId));
      const streamStatuses = hint.authoritativeOrders
        ? new Map<string, BrokerOrderStatusLookup>()
        : await streamSweepStatuses(accountId, [...candidateIds, ...osoParentIds]);
      for (const [brokerOrderId, lookup] of streamStatuses) {
        if (!isOpenOrderStatus(lookup.status)) {
          recordTerminalSweepState(accountId, brokerOrderId, lookup.status);
        }
      }
      // P6/V5a: čistě in-memory terminální důkaz nesmí kontrolovat už
      // vyčerpaný REST budget ani spouštět další čtení.
      const hasStreamOpenParent = osoParentIds.some(id => (
        isOpenOrderStatus(streamStatuses.get(id)?.status ?? null)
      ));
      // Terminální status neříká, zda order nebyl částečně vyplněn (Tradovate
      // hlásí partial cancel jako canceled s fillem). Návrat bez cancelu proto
      // při fillu nebo neznámém množství potvrdí čerstvou nulovou pozici —
      // až po důkazu z orderů. Bez fillu zůstává čistě in-memory (P6/V5a).
      // Známý fill (filled / filledQuantity > 0) vyžaduje čerstvou pozici.
      // Čisté zrušení zůstává in-memory beze změny proti produkci (P6/V5a,
      // žádné REST ani zdržení eventTail); důkaz nulového fillu u
      // canceled/rejected s nulou je evidovaný samostatný dluh.
      const knownFill = (lookup: BrokerOrderStatusLookup | undefined) => (
        lookup != null && (lookup.status === 'filled' || (lookup.filledQuantity ?? 0) > 0)
      );
      const confirmFlatAfterTerminal = async (label: string, lookups: Array<BrokerOrderStatusLookup | undefined>) => {
        if (lookups.some(knownFill)) await confirmFreshFlat(label);
      };
      const confirmFreshFlat = async (label: string) => {
        const fresh = await withFlatSweepBudget(
          budget,
          label + ' ' + accountId + '/' + symbol,
          () => broker.listPositions(accountId),
        );
        const freshNet = fresh.find(position => position.symbol === symbol)?.netQuantity ?? 0;
        if (freshNet !== 0) {
          followerFlatConfirmed = false;
          throw new Error('ochranná noha skončila a broker hlásí pozici ' + freshNet);
        }
      };
      if (!hasStreamOpenParent && candidateIds.every(id => {
        const status = streamStatuses.get(id)?.status;
        return status != null && !isOpenOrderStatus(status);
      })) {
        await confirmFlatAfterTerminal(
          'kontrola pozice po terminálních nohách',
          candidateIds.map(id => streamStatuses.get(id)),
        );
        return;
      }

      const osoParentByLeg = new Map<string, string>();
      for (const entry of osoEntries) {
        if (!entry.entryBrokerOrderId) continue;
        for (const brokerOrderId of [entry.firstBrokerOrderId, entry.secondBrokerOrderId]) {
          if (brokerOrderId) osoParentByLeg.set(brokerOrderId, entry.entryBrokerOrderId);
        }
      }

      const cancelErrors = new Map<string, Error>();
      const attemptedIds: string[] = [];
      const reauthorizedAttemptIds = new Set<string>();
      const attemptCancels = async (brokerOrderIds: readonly string[]) => {
        const fresh = [...new Set(brokerOrderIds)].filter(id => (
          !attemptedIds.includes(id)
          && (!flatSweepCancelAttempts.has(id) || reauthorizedAttemptIds.has(id))
        ));
        for (const brokerOrderId of fresh) {
          attemptedIds.push(brokerOrderId);
          reauthorizedAttemptIds.delete(brokerOrderId);
          flatSweepCancelAttempts.add(brokerOrderId);
          flatSweepCancelAttemptAccounts.set(brokerOrderId, accountId);
          sweepingProtectiveLegs.add(brokerOrderId);
          if (osoEntries.some(entry => entry.entryBrokerOrderId === brokerOrderId)) {
            flatSweepEntryCancelAttempts.add(brokerOrderId);
          }
        }
        await Promise.all(fresh.map(async brokerOrderId => {
          try {
            // Write má vlastní deadline oddělený od read-only REST budgetu.
            // Timeout je nejasný výsledek: tentýž cancel se nikdy neopakuje a
            // o výsledku rozhodne pouze následující stream/REST postkontrola.
            await withFlatSweepCancelDeadline(
              accountId,
              brokerOrderId,
              () => broker.cancelOrder(accountId, brokerOrderId),
            );
          } catch (reason) {
            // Broker write se nikdy neopakuje. Nejasný výsledek rozhodne jen
            // následující read-only snapshot.
            cancelErrors.set(brokerOrderId, errorOf(reason));
          }
        }));
      };

      const unresolvedIds = candidateIds.filter(id => {
        const status = streamStatuses.get(id)?.status;
        return status == null || isOpenOrderStatus(status);
      });
      const knownPartialOrTerminalParents = osoEntries.filter(entry => {
        if (!entry.entryBrokerOrderId) return false;
        const parent = liveOrdersByAccount.get(accountId)?.get(entry.entryBrokerOrderId);
        const leaderStatus = observedOrderStatusesByAccount
          .get(group.leaderAccountId!)?.get(entry.leaderEntryOrderId);
        return parent != null && isOpenOrderStatus(parent.status) && (
          parent.filledQuantity > 0
          || (leaderStatus != null && !isOpenOrderStatus(leaderStatus))
        );
      });
      const needsAuthoritativePreSnapshot = unresolvedIds.some(id => (
        streamStatuses.get(id)?.status !== 'working'
        || flatSweepCancelAttempts.has(id)
      )) || knownPartialOrTerminalParents.length > 0 || hasStreamOpenParent;

      type SweepReadResult<T> = { ok: true; value: T } | { ok: false; error: Error };
      const prePositionsPromise: Promise<SweepReadResult<readonly BrokerPosition[]>> = withFlatSweepBudget(
        budget,
        'kontrola pozice před cancelem ' + accountId + '/' + symbol,
        () => broker.listPositions(accountId),
      ).then(
        value => ({ ok: true as const, value }),
        reason => ({ ok: false as const, error: errorOf(reason) }),
      );
      const preOrdersPromise: Promise<SweepReadResult<readonly BrokerOrder[]>> = hint.authoritativeOrders
        ? Promise.resolve({ ok: true as const, value: hint.authoritativeOrders })
        : needsAuthoritativePreSnapshot
          ? withFlatSweepBudget(
          budget,
          'globální seznam orderů ' + accountId,
          () => hint.loadAuthoritativeOrders?.() ?? broker.listOrders(accountId),
          ).then(
            value => ({ ok: true as const, value }),
            reason => ({ ok: false as const, error: errorOf(reason) }),
          )
          : Promise.resolve({ ok: true as const, value: [] });

      // Přesný sourozenec právě vyplněné ochranné nohy už nemůže
      // chránit novou pozici. Jeho první cancel proto nesmí čekat na
      // /position/list; tombstone se tudy znovu nikdy neposílá.
      const hintedEntry = hint.protectiveFillBrokerOrderId == null
        ? undefined
        : protectiveEntries.find(entry => (
          entry.firstBrokerOrderId === hint.protectiveFillBrokerOrderId
          || entry.secondBrokerOrderId === hint.protectiveFillBrokerOrderId
        ));
      const hintedWorkingIds = hintedEntry == null
        ? []
        : [hintedEntry.firstBrokerOrderId, hintedEntry.secondBrokerOrderId]
          .filter((id): id is string => Boolean(id) && id !== hint.protectiveFillBrokerOrderId)
          .filter(id => streamStatuses.get(id)?.status === 'working');
      await attemptCancels(hintedWorkingIds.slice(0, SWEEP_MAX_LEGS_PER_CALL));

      const prePositions = await prePositionsPromise;
      if ('error' in prePositions) throw prePositions.error;
      const authoritativePositions = new Map<string, number>();
      for (const position of prePositions.value) {
        authoritativePositions.set(
          position.symbol,
          (authoritativePositions.get(position.symbol) ?? 0) + position.netQuantity,
        );
      }
      positionsByAccount.set(accountId, authoritativePositions);
      const preNetQuantity = authoritativePositions.get(symbol) ?? 0;
      if (preNetQuantity !== 0) {
        throw new Error('broker stále hlásí pozici ' + preNetQuantity + ' před prvním cancelem');
      }
      followerFlatConfirmed = true;

      const preOrders = await preOrdersPromise;
      if ('error' in preOrders) throw preOrders.error;
      const orders = hint.authoritativeOrders ?? preOrders.value;
      const byId = new Map(orders.map(order => [order.brokerOrderId, order]));
      for (const brokerOrderId of [...candidateIds, ...osoParentIds]) {
        if (!flatSweepCancelAttempts.has(brokerOrderId)) continue;
        const authoritative = byId.get(brokerOrderId);
        if (!authoritative || !isOpenOrderStatus(authoritative.status)) continue;
        flatSweepCancelAttempts.delete(brokerOrderId);
        flatSweepCancelAttemptAccounts.delete(brokerOrderId);
        reauthorizedAttemptIds.add(brokerOrderId);
      }
      const streamWorkingIds = candidateIds.filter(id => (
        streamStatuses.get(id)?.status === 'working'
      ));
      await attemptCancels(streamWorkingIds.slice(0, SWEEP_MAX_LEGS_PER_CALL));
      const classificationFailures: string[] = [];
      const workingLegIds: string[] = [];
      for (const brokerOrderId of unresolvedIds) {
        const order = byId.get(brokerOrderId);
        const status = preferredSweepStatus(
          streamStatuses.get(brokerOrderId)?.status,
          order?.status,
        );
        if (status != null && !isOpenOrderStatus(status)) {
          recordTerminalSweepState(accountId, brokerOrderId, status);
          continue;
        }
        if (status == null) {
          if (hint.authoritativeOrders) {
            continue;
          }
          classificationFailures.push(
            'stav ochranné nohy ' + brokerOrderId + ' chybí v autoritativních zdrojích',
          );
          continue;
        }
        if (status === 'pending') {
          const parentId = osoParentByLeg.get(brokerOrderId);
          // Bracket/OCO nohy parent z principu nemají. Jejich PendingNew /
          // PendingReplace / PendingCancel je aktivovaná ochrana a nad flat
          // followerem se ruší stejně jako Working.
          if (!parentId) {
            workingLegIds.push(brokerOrderId);
            continue;
          }
          const parent = byId.get(parentId);
          if (!parent) {
            classificationFailures.push(
              'pending ochranná noha ' + brokerOrderId + ' nemá autoritativně určitelný OSO parent',
            );
            continue;
          }
          // Suspended/pending dítě skutečně čekajícího, dosud nevyplněného
          // OSO vstupu je jediná bezpečná výjimka. Po partial fillu už jde o
          // aktivovanou ochranu v přechodném stavu a musí pryč.
          if (isOpenOrderStatus(parent.status) && parent.filledQuantity === 0) continue;
        }
        // Vlastní Working stav je dostatečný důkaz aktivované nohy. Parent se
        // u ní nečte ani nepoužívá jako výjimka: nad flat followerem se ruší.
        workingLegIds.push(brokerOrderId);
      }

      const childCancelIds = new Set([...hintedWorkingIds, ...workingLegIds]);
      const parentIds = osoEntries.flatMap(entry => {
        if (!entry.entryBrokerOrderId) return [];
        const parent = byId.get(entry.entryBrokerOrderId);
        if (!parent || !isOpenOrderStatus(parent.status)) return [];
        const leaderStatus = observedOrderStatusesByAccount
          .get(group.leaderAccountId!)?.get(entry.leaderEntryOrderId);
        const leaderCanceledOrRejected = leaderStatus === 'canceled' || leaderStatus === 'rejected';
        const leaderPositionKnown = leaderPositions.has(entry.request.symbol)
          || leaderPositionSnapshotComplete;
        const leaderFlat = leaderPositionKnown
          && (leaderPositions.get(entry.request.symbol) ?? 0) === 0;
        const leaderEntryNoLongerWorking = leaderStatus != null
          && !isOpenOrderStatus(leaderStatus);
        const filledOrPartialMayCancel = leaderFlat
          && leaderEntryNoLongerWorking
          && (leaderStatus === 'filled' || parent.filledQuantity > 0);
        const childWillBeCanceled = [entry.firstBrokerOrderId, entry.secondBrokerOrderId]
          .some(id => id != null && childCancelIds.has(id));
        if (childWillBeCanceled && !leaderEntryNoLongerWorking) {
          classificationFailures.push(
            'leaderův OSO vstup ' + entry.leaderEntryOrderId
            + ' zůstává otevřený po zrušení ochranných dětí followera',
          );
        }
        return leaderCanceledOrRejected || filledOrPartialMayCancel || childWillBeCanceled
          ? [entry.entryBrokerOrderId]
          : [];
      });
      if (workingLegIds.length > SWEEP_MAX_LEGS_PER_CALL) {
        classificationFailures.push(
          'broker stále hlásí ' + workingLegIds.length + ' pracovních ochranných noh',
        );
      }
      const cancelIds = [
        ...workingLegIds.slice(0, SWEEP_MAX_LEGS_PER_CALL),
        ...parentIds,
      ];
      try {
        await attemptCancels(cancelIds);

        if (attemptedIds.length === 0) {
          if (classificationFailures.length > 0) throw new Error(classificationFailures.join(', '));
          // Pozice čtená před cancelem je starší než důkaz z orderů.
          await confirmFlatAfterTerminal(
            'kontrola pozice po terminálních nohách',
            candidateIds.map(id => {
              const order = byId.get(id);
              return order != null
                ? { status: order.status, completeness: 'authoritative' as const, observedAt: clock(), filledQuantity: order.filledQuantity }
                : streamStatuses.get(id);
            }),
          );
          return;
        }

        const postStreamStatuses = await streamSweepStatuses(accountId, attemptedIds);
        const streamOutcome = (brokerOrderId: string) => preferredSweepStatus(
          postStreamStatuses.get(brokerOrderId)?.status,
          streamStatuses.get(brokerOrderId)?.status,
        );
        // 8. 10. 2026 (produkce, účet 68931462): cancel dostal TooLate, protože
        // order už rušil dřívější cancel; stream doručil Canceled ~0,8 s po
        // odmítnutí a sweep mezitím kopírku zbytečně vypnul. Jen pro TooLate
        // proto krátce (≤ 1,5 s) čteme levný stream status — žádné REST grafy,
        // žádný další cancel ani jiný write.
        const tooLateOpen = () => attemptedIds.filter(id => (
          /TooLate/i.test(cancelErrors.get(id)?.message ?? '')
          && (streamOutcome(id) == null || isOpenOrderStatus(streamOutcome(id)!))
        ));
        for (const delayMs of TOO_LATE_STREAM_SETTLE_DELAYS_MS) {
          const pending = tooLateOpen();
          if (pending.length === 0) break;
          // Rezerva počítá i s visícím stream lookupem po spánku.
          if (flatSweepRemainingMs(budget) < delayMs + STREAM_SWEEP_READ_TIMEOUT_MS + FLAT_SWEEP_SETTLE_RESERVE_MS) break;
          await (options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(delayMs);
          for (const [id, lookup] of await streamSweepStatuses(accountId, pending)) postStreamStatuses.set(id, lookup);
        }
        const allAttemptsTerminalInStream = attemptedIds.every(id => {
          const status = streamOutcome(id);
          return status != null && !isOpenOrderStatus(status);
        });
        if (allAttemptsTerminalInStream && classificationFailures.length === 0) {
          // Zrušení se známým fillem: nejdřív čerstvá pozice.
          await confirmFlatAfterTerminal(
            'postkontrola pozice',
            attemptedIds.map(id => postStreamStatuses.get(id) ?? streamStatuses.get(id)),
          );
          for (const brokerOrderId of attemptedIds) {
            const outcome = streamOutcome(brokerOrderId);
            recordTerminalSweepState(accountId, brokerOrderId, outcome);
            options.onAudit?.([{
              at,
              leaderEventId: 'flat-sweep-' + accountId + '-' + brokerOrderId,
              accountId,
              brokerOrderId,
              kind: outcome === 'filled' ? 'filled' : outcome === 'rejected' ? 'rejected' : 'canceled',
              reason: parentIds.includes(brokerOrderId)
                ? 'follower flat — osiřelý OSO vstup autoritativně nepracuje'
                : outcome === 'filled'
                  ? 'follower flat — ochranná noha se mezitím vyplnila'
                  : outcome === 'rejected'
                    ? 'follower flat — ochranná noha skončila rejectem'
                    : 'follower flat — ochranná noha autoritativně nepracuje',
            }]);
          }
          await waiveResolvedSweepLifecycles(new Set(
            attemptedIds.filter(id => allLegIds.includes(id)),
          ));
          return;
        }

        const needsPostOrderGraph = attemptedIds.some(id => {
          const lookup = postStreamStatuses.get(id);
          return lookup == null || isOpenOrderStatus(lookup.status);
        });
        const postOrders = needsPostOrderGraph
          ? await withFlatSweepBudget(
            budget,
            'postkontrola orderů ' + accountId,
            () => broker.listOrders(accountId),
          )
          : [];
        // Pozice až po orderech: kdyby graf ukázal Filled, pozice je novější
        // než tento důkaz a otevřená pozice se neschová (review 8. 10.).
        const positions = await withFlatSweepBudget(
          budget,
          'postkontrola pozice ' + accountId + '/' + symbol,
          () => broker.listPositions(accountId),
        );
        const netQuantity = positions.find(position => position.symbol === symbol)?.netQuantity ?? 0;
        const postById = new Map([
          ...orders.map(order => [order.brokerOrderId, order] as const),
          ...postOrders.map(order => [order.brokerOrderId, order] as const),
        ]);
        const postStatus = (brokerOrderId: string) => (
          preferredSweepStatus(
            postStreamStatuses.get(brokerOrderId)?.status,
            postById.get(brokerOrderId)?.status,
            streamStatuses.get(brokerOrderId)?.status,
          )
        );
        const failures: string[] = [...classificationFailures];
        const checkedIds = [...new Set([...allLegIds, ...parentIds])];
        for (const brokerOrderId of checkedIds) {
          const order = postById.get(brokerOrderId);
          const status = postStatus(brokerOrderId);
          if (status == null || !isOpenOrderStatus(status)) {
            recordTerminalSweepState(accountId, brokerOrderId, status);
            continue;
          }
          if (status === 'pending') {
            const parentId = osoParentByLeg.get(brokerOrderId);
            if (!parentId) {
              failures.push(brokerOrderId + ': bracket/OCO pending noha po cancelu stále pracuje');
              continue;
            }
            const parent = postById.get(parentId);
            if (parent && isOpenOrderStatus(parent.status) && parent.filledQuantity === 0) {
              continue;
            }
            if (!parent) {
              failures.push(brokerOrderId + ': pending noha bez autoritativně určitelného parentu');
              continue;
            }
          }
          const cancelDetail = cancelErrors.get(brokerOrderId)?.message;
          failures.push(
            brokerOrderId + ': '
            + (cancelDetail ? 'nejasný cancel (' + cancelDetail + '), ' : '')
            + 'broker ji stále hlásí jako ' + status,
          );
        }

        // Audit vzniká před jakoukoli pozdější chybou postkontroly a pouze
        // pro ordery, na které sweep skutečně poslal cancel. Už dříve
        // terminální noha nikdy nesmí dostat zavádějící kind=canceled.
        for (const brokerOrderId of attemptedIds) {
          const outcome = postStatus(brokerOrderId);
          if (outcome == null || isOpenOrderStatus(outcome)) continue;
          options.onAudit?.([{
            at,
            leaderEventId: 'flat-sweep-' + accountId + '-' + brokerOrderId,
            accountId,
            brokerOrderId,
            kind: outcome === 'filled' ? 'filled' : outcome === 'rejected' ? 'rejected' : 'canceled',
            reason: parentIds.includes(brokerOrderId)
              ? 'follower flat — osiřelý OSO vstup autoritativně nepracuje'
              : outcome === 'filled'
                ? 'follower flat — ochranná noha se mezitím vyplnila'
                : outcome === 'rejected'
                  ? 'follower flat — ochranná noha skončila rejectem'
                  : 'follower flat — ochranná noha autoritativně nepracuje',
          }]);
        }
        if (netQuantity !== 0) {
          followerFlatConfirmed = false;
          failures.push('broker stále hlásí pozici ' + netQuantity);
        }
        if (failures.length > 0) throw new Error(failures.join(', '));
        await waiveResolvedSweepLifecycles(new Set(
          attemptedIds.filter(id => allLegIds.includes(id)),
        ));
      } finally {
        for (const brokerOrderId of attemptedIds) sweepingProtectiveLegs.delete(brokerOrderId);
      }
    } catch (reason) {
      failSweep(errorOf(reason).message);
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
  const backgroundNonBlockingOutboxKeys = () => {
    const current = currentRuntime();
    return new Set([
      ...[...current.outbox.values()].flatMap(entry => (
        followerCutBackgroundAccounts.has(entry.request.accountId)
        && entry.leaderOrderId.startsWith('manual-flatten:')
          ? [entry.key]
          : []
      )),
      ...[...current.cancelOutbox.values()].flatMap(entry => (
        followerCutBackgroundAccounts.has(entry.accountId)
        && entry.leaderEventId.startsWith('manual-flatten:')
          ? [entry.key]
          : []
      )),
    ]);
  };
  const hasDispatchBlockingStuckOutbox = () => {
    const current = currentRuntime();
    const backgroundOwns = (accountId: number, marker: string | undefined) => (
      followerCutBackgroundAccounts.has(accountId)
      && marker?.startsWith('manual-flatten:') === true
    );
    const blocked = stuckEntries(current.outbox.values()).some(entry => (
      !backgroundOwns(entry.request.accountId, entry.leaderOrderId)
    ))
      || stuckCancelEntries(current.cancelOutbox.values()).some(entry => (
        !backgroundOwns(entry.accountId, entry.leaderEventId)
      ))
      || stuckBracketEntries(current.bracketOutbox.values()).length > 0
      || stuckOsoEntries(current.osoOutbox.values()).length > 0;
    return blocked;
  };

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
  const hasInFlightOutbox = () => {
    const current = currentRuntime();
    const inFlight = (status: string) => status === 'planned' || status === 'sending' || status === 'unknown';
    return [...current.outbox.values()].some(entry => inFlight(entry.status))
      || [...current.cancelOutbox.values()].some(entry => inFlight(entry.status))
      || [...current.bracketOutbox.values()].some(entry => inFlight(entry.status))
      || [...current.osoOutbox.values()].some(entry => inFlight(entry.status));
  };

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
        TERMINAL_REJECT_WAIVE_REASON,
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

      const committed = await durableStore.commit(
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
      const committed = await durableStore.commit(
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
  const followerLossAtRiskSnapshot = (
    accountId: number,
    snapshot: CopierAccountRiskSnapshot,
  ): { realizedLossUsd: number; openLossUsd: number; totalLossUsd: number } => {
    const realizedLossUsd = Math.max(0, -(snapshot.realizedPnlUsd ?? 0));
    const livePositions = positionsByAccount.get(accountId);
    const streamConfirmsFlat = livePositions != null
      && [...livePositions.values()].every(quantity => quantity === 0);
    // Chybějící open P&L se nikdy nenahrazuje cash−netLiq: `amount` může být
    // startovní/stale cash a realizovaná ztráta by se odečetla podruhé (PR5).
    // Nula je zde konzervativní pro reserve cap: ponechá největší nevyčerpaný
    // konfigurovaný cut, takže překročení rezervy nezůstane skryté.
    const openLossUsd = streamConfirmsFlat
      ? 0
      : Math.max(0, -(snapshot.openPnlUsd ?? 0));
    return { realizedLossUsd, openLossUsd, totalLossUsd: realizedLossUsd + openLossUsd };
  };

  const applyPropReserveCap = (
    follower: CopyGroupConfig['followers'][number],
    at: number,
  ): { breached: boolean; totalLossUsd: number; reserveUsd: number; effectiveCutUsd: number } | null => {
    const cutUsd = follower.dailyLossCutUsd ?? 0;
    if (cutUsd <= 0 || follower.enabled === false || follower.mode === 'off'
      || activeFollowerCut(follower.accountId, at)) return null;
    const snapshot = accountRisk.get(follower.accountId);
    if (!snapshot || snapshot.error || snapshot.propLimitUsd == null
      || !Number.isFinite(snapshot.propLimitUsd)
      || (snapshot.realizedPnlUsd != null && !Number.isFinite(snapshot.realizedPnlUsd))
      || at - snapshot.verifiedAt > ACCOUNT_RISK_STALE_MS
      || !sameTradovateSession(snapshot.verifiedAt, at)) return null;
    const { totalLossUsd } = followerLossAtRiskSnapshot(follower.accountId, snapshot);
    const reserveUsd = Math.max(0, snapshot.propLimitUsd);
    // Cap je pro session tighten-only. První nízká rezerva sníží absolutní
    // loss limit; pozdější růst rezervy jej automaticky neuvolní. Tím se
    // z pouhé změny trailing flooru nestane okamžitý close-copy, ale 5% buffer
    // se zachová až do skutečného přiblížení ztráty.
    const candidateCutUsd = Math.max(0, totalLossUsd + reserveUsd * 0.95);
    const previousCap = snapshot.configuredDailyLossCutUsd === cutUsd
      ? snapshot.effectiveDailyLossCutUsd
      : null;
    const effectiveCutUsd = Math.min(
      cutUsd,
      candidateCutUsd,
      previousCap != null && Number.isFinite(previousCap) ? previousCap : Number.POSITIVE_INFINITY,
    );
    const capTightened = effectiveCutUsd + 0.005 < (previousCap ?? cutUsd);
    snapshot.effectiveDailyLossCutUsd = effectiveCutUsd;
    snapshot.configuredDailyLossCutUsd = cutUsd;
    if (capTightened) {
      options.onAudit?.([{
        at,
        leaderEventId: `prop-reserve-cap:${follower.accountId}:${at}`,
        kind: 'follower-cut',
        accountId: follower.accountId,
        source: 'prop-reserve',
        current: totalLossUsd,
        limit: effectiveCutUsd,
        cutUsd,
        reason: `prop-reserve follower ${follower.accountId}: denní cut dynamicky omezen `
          + `${(previousCap ?? cutUsd).toFixed(2)} → ${effectiveCutUsd.toFixed(2)} USD; `
          + `aktuální rezerva ${reserveUsd.toFixed(2)} USD, bez okamžité likvidace`,
      }]);
    }
    return {
      breached: totalLossUsd + 0.005 >= effectiveCutUsd,
      totalLossUsd,
      reserveUsd,
      effectiveCutUsd,
    };
  };
  const followersRequiringVerifiedRisk = (at: number) => {
    const ineligible = currentIneligibleAccounts(at);
    return group.followers.filter(follower => (
      (follower.dailyLossCutUsd ?? 0) > 0
      && follower.enabled !== false
      && follower.mode !== 'off'
      && !ineligible.has(follower.accountId)
      && !activeFollowerCut(follower.accountId, at)
    ));
  };
  const assertVerifiedArmRisk = (at: number): void => {
    for (const follower of followersRequiringVerifiedRisk(at)) {
      const snapshot = accountRisk.get(follower.accountId);
      const invalidReason = !snapshot
        ? 'snapshot chybí'
        : snapshot.error
          ? snapshot.error
          : snapshot.verifiedAt <= 0
            ? 'snapshot nemá platný čas'
            : at - snapshot.verifiedAt > ACCOUNT_RISK_STALE_MS
              ? `snapshot je starší než ${ACCOUNT_RISK_STALE_MS / 1_000} s`
              : !sameTradovateSession(snapshot.verifiedAt, at)
                ? 'snapshot je z jiné broker session'
                : null;
      if (invalidReason) {
        throw new Error(
          `ARM blokován: follower ${follower.accountId} má risk pravidlo, ale nemá čerstvý `
          + `ověřený risk snapshot ve stejné session (${invalidReason}); spusť Kontrolu pozic`,
        );
      }
    }
  };
  const assertTightenOnly = (
    candidate: CopyGroupConfig,
    allowMultiplierIncrease = !gate.armed,
  ): void => {
    rollRiskSessionMemoryIfExpired(clock());
    if (!(sessionArmedAt > 0)) return;
    // Násobek smí růst jen za kopírky, která byla vypnutá už před změnou.
    const weaker = isWeakerRiskConfig(group, candidate, { allowMultiplierIncrease });
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

  /** Součet copied-entry fillů podle follower broker orderu (dedupe podle fillId). */
  const copierEntryFillTotals = new Map<string, number>();
  const copierEntryFillIds = new Set<string>();
  /**
   * Přísnější lineage pro dodatečné potvrzení (leader Position dorovnala až
   * po followerovi): celá pozice followera musí pocházet z fillů jediného
   * copier entry orderu navázaného na vstup aktuální leader epochy. Cizí nebo
   * ruční přírůstek, starší epocha i více vstupů zůstávají neprokázané.
   */
  const exactCopiedEntryNet = (accountId: number, symbol: string, netQuantity: number): boolean => {
    if (!copiedEntryLineage(accountId, symbol, netQuantity)) return false;
    const cause = recentFollowerFillCauses.get(`${accountId}:${symbol}`);
    const epoch = leaderExposureEpoch(symbol);
    if (!cause || !epoch) return false;
    const live = currentRuntime();
    const leaderOrderIds = new Set(epoch.leaderEntryOrderIds);
    const boundToEpoch = [...live.outbox.values()].some(entry => (
      entry.brokerOrderId === cause.brokerOrderId
      && entry.request.accountId === accountId
      && leaderOrderIds.has(entry.leaderOrderId)
    )) || [...live.osoOutbox.values()].some(entry => (
      entry.entryBrokerOrderId === cause.brokerOrderId
      && entry.request.accountId === accountId
      && leaderOrderIds.has(entry.leaderEntryOrderId)
    ));
    if (!boundToEpoch) return false;
    return (copierEntryFillTotals.get(cause.brokerOrderId) ?? 0) * cause.sign === netQuantity;
  };

  const leaderFlatFollowersAt =(symbol: string, leaderNet: number): LeaderFlatFollowerOwnership[] =>
    group.followers.map(follower => {
      const eligibleAtOpen = follower.enabled !== false && follower.mode !== 'off'
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
    requireExactEntryFills = false,
  ) => {
    const epoch = leaderExposureEpoch(symbol);
    if (!epoch || epoch.phase !== 'open' || netQuantity === 0) return;
    const follower = group.followers.find(item => item.accountId === accountId);
    if (!follower || follower.enabled === false || follower.mode === 'off') return;
    const leaderNet = leaderPositions.get(symbol);
    if (leaderNet == null || leaderNet === 0) return;
    const expectedNet = Math.trunc(leaderNet * follower.multiplier);
    if (
      netQuantity !== expectedNet
      || !(requireExactEntryFills
        ? exactCopiedEntryNet(accountId, symbol, netQuantity)
        : copiedEntryLineage(accountId, symbol, netQuantity))
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
    allowWrites = true,
  ) => {
    const existing = leaderFlatGuardTimers.get(epoch.id);
    if (existing) clearTimeout(existing);
    const scheduledAt = clock();
    const delay = Math.max(0, (epoch.graceUntil ?? scheduledAt) - scheduledAt);
    const timer = setTimeout(() => {
      leaderFlatGuardTimers.delete(epoch.id);
      eventTail = eventTail
        .then(() => verifyLeaderFlatEpoch(token, expectedSafetyGeneration, allowWrites))
        .catch(reason => failClosed(reason, { autoClose: false }));
    }, delay);
    leaderFlatGuardTimers.set(epoch.id, timer);
  };

  const rescheduleLeaderFlatEpochAfterGenerationChange = async (
    epoch: LeaderFlatEpoch,
    token: LeaderFlatGuardToken,
    allowWrites: boolean,
  ): Promise<void> => {
    const attempts = (leaderFlatGuardGenerationRetries.get(epoch.id) ?? 0) + 1;
    leaderFlatGuardGenerationRetries.set(epoch.id, attempts);
    if (attempts <= LEADER_FLAT_GENERATION_RETRY_LIMIT) {
      options.onAudit?.([{
        at: clock(), leaderEventId: `leader-flat-generation:${epoch.id}:${attempts}`,
        kind: 'blocked',
        reason: `leader-flat guard přeplánován po změně safety generation (${attempts}/${LEADER_FLAT_GENERATION_RETRY_LIMIT})`,
      }]);
      scheduleLeaderFlatEpochVerification(epoch, token, safetyGeneration, allowWrites);
      return;
    }
    await persistLeaderExposureEpoch({
      ...epoch,
      generation: epoch.generation + 1,
      phase: 'blocked',
      terminalAt: clock(),
      terminalReason: `leader-flat guard vyčerpal ${LEADER_FLAT_GENERATION_RETRY_LIMIT} přeplánování po změně safety generation`,
    });
    failClosed(new Error(
      `Copier fail-closed: leader-flat guard vyčerpal ${LEADER_FLAT_GENERATION_RETRY_LIMIT} přeplánování; stav vyžaduje ruční kontrolu`,
    ), { autoClose: false, episodeId: epoch.id, recordWhenDisarmed: true });
  };

  const groupIsFlat = () => [group.leaderAccountId, ...group.followers.map(item => item.accountId)]
    .filter((accountId): accountId is number => accountId != null)
    .every(accountId => [...(positionsByAccount.get(accountId)?.values() ?? [])]
      .every(quantity => quantity === 0));

  const managementOnlyGroupPositionsAreKnownFlat = () => (
    [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)]
      .filter((accountId): accountId is number => accountId != null)
      .every(accountId => {
        const positions = positionsByAccount.get(accountId);
        return positions != null && [...positions.values()].every(quantity => quantity === 0);
      })
  );

  const hasFollowerExposure = () => group.followers.some(follower => (
    follower.enabled !== false
    && [...(positionsByAccount.get(follower.accountId)?.values() ?? [])]
      .some(quantity => quantity !== 0)
  ));

  const recordDisarm = (
    trigger: CopierDisarmTrigger,
    detail: string,
    copiesOutcome: CopierCopiesOutcome,
    recordOptions: { episodeId?: string; code?: CopierDisarmRecord['code'] } = {},
  ): CopierDisarmRecord => {
    const openEpochIds = (currentRuntime().state.safety.leaderExposureEpochs ?? [])
      .filter(epoch => (
        epoch.groupId === group.id
        && epoch.leaderAccountId === group.leaderAccountId
        && unfinishedLeaderFlatPhase(epoch.phase)
      ))
      .map(epoch => epoch.id);
    const episodeId = recordOptions.episodeId
      ?? (openEpochIds.length === 1 ? openEpochIds[0] : undefined);
    const record = createCopierDisarmRecord({
      at: clock(), trigger, detail, copiesOutcome,
      ...(recordOptions.code ? { code: recordOptions.code } : {}),
      ...(episodeId ? { episodeId } : {}),
    });
    lastDisarm = record;
    disarmHistory.push(record);
    if (disarmHistory.length > COPIER_DISARM_HISTORY_LIMIT) {
      disarmHistory.splice(0, disarmHistory.length - COPIER_DISARM_HISTORY_LIMIT);
    }
    const durable = disarmHistory.map(item => ({ ...item }));
    disarmPersistenceTail = disarmPersistenceTail.then(() => persistSafetyUpdate(current => ({
      ...current,
      disarmHistory: durable,
    }))).catch(reason => {
      options.onError?.(new Error(
        `Historii vypnutí se nepodařilo durable uložit: ${errorOf(reason).message}`,
      ));
    });
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
    const durable = disarmHistory.map(item => ({ ...item }));
    disarmPersistenceTail = disarmPersistenceTail.then(() => persistSafetyUpdate(current => ({
      ...current,
      disarmHistory: durable,
    }))).catch(reason => {
      options.onError?.(new Error(
        `Výsledek vypnutí se nepodařilo durable uložit: ${errorOf(reason).message}`,
      ));
    });
  };

  const disarmAtForEpisode = (episodeId: string): number | undefined => {
    for (let index = disarmHistory.length - 1; index >= 0; index -= 1) {
      if (disarmHistory[index].episodeId === episodeId) return disarmHistory[index].at;
    }
    return undefined;
  };

  const successfulAutoCloseOutcome = (
    recordAt: number,
    acted: boolean,
  ): CopierCopiesOutcome => (
    !acted || disarmHistory[disarmIndexAt(recordAt)]?.copiesOutcome === 'flat'
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
      const committed = await durableStore.commit(
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

  type CopierOwnershipEntry = {
    id: string;
    accountId: number;
    symbol: string;
    status: string;
    updatedAt: number;
    legIds: string[];
    /** Tagy, podle kterých jde u brokera najít i příkaz bez známého ID. */
    tags: string[];
    /** Definitivní reject (broker/policy) — přežije i pozdější „waived“. */
    rejected?: boolean;
  };
  /**
   * Vlastnictví kopírky se odvozuje od durable outboxu: položka se zapíše
   * dřív, než příkaz odejde k brokerovi, takže ji nepřeskočí pád procesu ani
   * pořadí Order/Fill/Position eventů. Outbox se maže jen přepnutím skupiny.
   */
  const copierOwnershipEntries = (): CopierOwnershipEntry[] => {
    const live = currentRuntime();
    const entries: CopierOwnershipEntry[] = [];
    for (const entry of live.outbox.values()) {
      entries.push({
        id: `o:${entry.key}`, accountId: entry.request.accountId, symbol: entry.request.symbol,
        status: entry.status, updatedAt: entry.updatedAt,
        legIds: entry.brokerOrderId ? [entry.brokerOrderId] : [],
        tags: [entry.tag],
        rejected: entry.status === 'rejected' || entry.rejectedBy != null,
      });
    }
    for (const entry of live.bracketOutbox.values()) {
      entries.push({
        id: `b:${entry.key}`, accountId: entry.request.accountId, symbol: entry.request.symbol,
        status: entry.status, updatedAt: entry.updatedAt,
        legIds: [entry.firstBrokerOrderId, entry.secondBrokerOrderId].filter((id): id is string => !!id),
        tags: [entry.tag],
        rejected: entry.status === 'rejected' || (entry.reason?.startsWith(TERMINAL_REJECT_WAIVE_REASON) ?? false),
      });
    }
    for (const entry of live.osoOutbox.values()) {
      entries.push({
        id: `s:${entry.key}`, accountId: entry.request.accountId, symbol: entry.request.symbol,
        status: entry.status, updatedAt: entry.updatedAt,
        legIds: [entry.entryBrokerOrderId, entry.firstBrokerOrderId, entry.secondBrokerOrderId]
          .filter((id): id is string => !!id),
        tags: [entry.tag],
        rejected: entry.status === 'rejected' || (entry.reason?.startsWith(TERMINAL_REJECT_WAIVE_REASON) ?? false),
      });
    }
    return entries;
  };

  /**
   * Kandidát na usazení: konečný stav outboxu, dost starý, aby ho broker
   * REST už znal, a žádná jeho noha lokálně nepracuje. Samotné usazení
   * rozhoduje až autoritativní broker čtení, ne pořadí stream eventů.
   */
  const COPIER_SETTLEMENT_MIN_AGE_MS = options.copierSettlementMinAgeMs ?? 10_000;
  const COPIER_SETTLEMENT_QUIET_MS = options.copierSettlementQuietMs ?? 1_000;
  /**
   * Jak dlouho musí být noha kopie lokálně známá jako ukončená, než flat
   * účet smí kopii usadit. Kryje opožděnou Position projekci už provedeného
   * fillu (REST order „Filled“, REST pozice ještě flat).
   */
  const COPIER_SETTLEMENT_TERMINAL_AGE_MS = options.copierSettlementTerminalAgeMs ?? 30_000;
  const COPIER_SETTLEMENT_SWEEP_MS = 5 * 60_000;
  /** Položka bez známého broker ID: jen definitivní reject nebo stavem potvrzená likvidace. */
  const leglessEntryFinished = (entry: CopierOwnershipEntry) => (
    entry.status === 'rejected' || entry.status === 'confirmed-by-state'
    // Reconciliation potvrzený reject se přepíše na waived; ruční waive
    // nejasného odeslání (bez rejectedBy) dál zůstává „možná kopie“.
    || (entry.status === 'waived' && entry.rejected === true)
  );
  const copierSettlementCandidate = (entry: CopierOwnershipEntry, now: number): boolean => (
    (entry.legIds.length === 0
      ? leglessEntryFinished(entry)
      : entry.status === 'acknowledged' || entry.status === 'confirmed-by-state'
        || entry.status === 'rejected' || entry.status === 'waived')
    && entry.updatedAt <= now - COPIER_SETTLEMENT_MIN_AGE_MS
    && !entry.legIds.some(orderId => liveOrdersByAccount.get(entry.accountId)?.has(orderId))
  );

  const unsettledCopierEntries = (accountId: number): CopierOwnershipEntry[] => {
    const settled = new Set(currentRuntime().state.safety.settledCopierEntries ?? []);
    return copierOwnershipEntries().filter(entry => entry.accountId === accountId && !settled.has(entry.id));
  };
  /** Symboly účtu, kde kopírka od posledního ověřeného flat odeslala příkaz. */
  const unsettledCopierSymbols = (accountId: number): Set<string> => new Set(
    unsettledCopierEntries(accountId).map(entry => entry.symbol),
  );

  /** Lokální čas, kdy jsme nohu kopie poprvé viděli ukončenou (event nebo REST). */
  const copierLegTerminalSeenAt = new Map<string, number>();
  const noteCopierLegTerminal = (orderId: string, at: number) => {
    if (!copierLegTerminalSeenAt.has(orderId)) copierLegTerminalSeenAt.set(orderId, at);
  };

  const copierSettlementTimers = new Set<ReturnType<typeof setTimeout>>();
  const copierSettlementWaiters = new Set<() => void>();
  const settlementPause = (ms: number) => new Promise<void>(resolve => {
    if (stopped) { resolve(); return; }
    const done = () => { copierSettlementWaiters.delete(done); clearTimeout(timer); copierSettlementTimers.delete(timer); resolve(); };
    const timer = setTimeout(done, ms);
    copierSettlementTimers.add(timer);
    copierSettlementWaiters.add(done);
  });
  const stopCopierSettlement = () => {
    for (const timer of copierSettlementTimers) clearTimeout(timer);
    copierSettlementTimers.clear();
    for (const done of [...copierSettlementWaiters]) done();
    copierSettlementPendingAccounts.clear();
  };

  /**
   * Usazení kopií jednoho účtu (5. 10. 2026). Jen za DISARM — za ARM ho
   * přepnutí skupiny nepotřebuje a REST čtení by zbytečně zatěžovala route.
   * Dvě autoritativní kola s odstupem musí ukázat flat symboly kandidátů bez
   * otevřeného příkazu kopírky (ID i tag), každá noha musí být ukončená
   * aspoň COPIER_SETTLEMENT_TERMINAL_AGE_MS a mezi začátkem a commitem nesmí
   * na účet dorazit obchodní událost. Commit se po zápisu ještě jednou
   * ověří a při změně vrátí. Selhání = neusazeno (konzervativně „kopie“).
   */
  const verifyAndSettleCopierAccount = async (accountId: number): Promise<'done' | 'retry'> => {
    const settlementAllowed = () => !stopped && gate.connected && !gate.armed;
    if (!settlementAllowed()) return 'done';
    const now = clock();
    const candidates = unsettledCopierEntries(accountId)
      .filter(entry => copierSettlementCandidate(entry, now));
    if (candidates.length === 0) return 'done';
    const symbols = new Set(candidates.map(entry => entry.symbol));
    // Podle streamu ne-flat: žádné REST čtení. Flat event to spustí znovu.
    if ([...symbols].some(symbol => (positionsByAccount.get(accountId)?.get(symbol) ?? 0) !== 0)) return 'done';
    const versionAtStart = tradeObservationVersionByAccount.get(accountId) ?? 0;
    const generationAtStart = connectionSyncGeneration;
    const legIds = new Set(candidates.flatMap(entry => entry.legIds));
    const legsByEntry = new Map(candidates.map(entry => [entry.id, new Set(entry.legIds)]));
    const quiet = async (): Promise<boolean> => {
      const [positions, orders] = await Promise.all([
        withLeaderEpochDeadline(`copier settlement positions ${accountId}`, broker.listPositions(accountId)),
        withLeaderEpochDeadline(`copier settlement orders ${accountId}`, broker.listOrders(accountId, { fresh: true })),
      ]);
      const readAt = clock();
      const flat = positions
        .filter(position => symbols.has(position.symbol))
        .every(position => position.netQuantity === 0);
      let copierOrderOpen = false;
      for (const order of orders) {
        const tagMatch = candidates.find(entry => entry.tags.some(tag => tag.length > 0 && order.tag.startsWith(tag)));
        if (!legIds.has(order.brokerOrderId) && !tagMatch) continue;
        if (tagMatch) legsByEntry.get(tagMatch.id)?.add(order.brokerOrderId);
        if (isOpenOrderStatus(order.status)) copierOrderOpen = true;
        else noteCopierLegTerminal(order.brokerOrderId, readAt);
      }
      // Noha, kterou broker v order grafu dne už nevrací, je dávno ukončená.
      const listed = new Set(orders.map(order => order.brokerOrderId));
      for (const orderId of legIds) if (!listed.has(orderId)) noteCopierLegTerminal(orderId, readAt);
      return flat && !copierOrderOpen;
    };
    // Ne-flat nebo pracující příkaz: další Position/Order event to spustí
    // znovu; chybu čtení dožene periodický sweep. Opakuje se jen čekání na stáří.
    try {
      if (!await quiet() || !settlementAllowed()) return 'done';
      await settlementPause(COPIER_SETTLEMENT_QUIET_MS);
      if (!settlementAllowed() || !await quiet()) return 'done';
    } catch {
      return 'done';
    }
    const decidedAt = clock();
    const settleable = candidates.filter(entry => [...(legsByEntry.get(entry.id) ?? [])].every(orderId => {
      const seenAt = copierLegTerminalSeenAt.get(orderId);
      return seenAt != null && seenAt <= decidedAt - COPIER_SETTLEMENT_TERMINAL_AGE_MS;
    }));
    const unchanged = () => settlementAllowed()
      && (tradeObservationVersionByAccount.get(accountId) ?? 0) === versionAtStart
      && connectionSyncGeneration === generationAtStart
      && !pendingTradeEventsFor([accountId]);
    if (!unchanged()) return 'done';
    if (settleable.length === 0) return 'retry';
    const commitSettled = async (current: CopierRuntime, ids: ReadonlySet<string>) => {
      const state = {
        ...current.state,
        safety: { ...current.state.safety, settledCopierEntries: [...ids] },
      };
      const committed = await durableStore.commit(
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
    };
    try {
      await processor.mutate(async current => {
        if (!unchanged()) return current;
        const existing = new Set(copierOwnershipEntries().map(entry => entry.id));
        const previous = new Set((current.state.safety.settledCopierEntries ?? [])
          .filter(id => existing.has(id)));
        const next = new Set(previous);
        for (const entry of settleable) if (existing.has(entry.id)) next.add(entry.id);
        const settled = await commitSettled(current, next);
        // Event přijatý během zápisu: usazení vrátit, ne spoléhat na stáří nohou.
        if (unchanged()) return settled;
        return commitSettled(settled, previous);
      });
    } catch {
      return 'done';
    }
    return settleable.length === candidates.length ? 'done' : 'retry';
  };

  const copierSettlementPendingAccounts = new Set<number>();
  let copierSettlementDraining = false;
  const drainCopierSettlement = async () => {
    if (copierSettlementDraining) return;
    copierSettlementDraining = true;
    const retry = new Set<number>();
    try {
      // Po jednom účtu s odstupem: žádný REST burst přes celou skupinu.
      while (!stopped && !gate.armed && copierSettlementPendingAccounts.size > 0) {
        const [accountId] = copierSettlementPendingAccounts;
        copierSettlementPendingAccounts.delete(accountId!);
        if (await verifyAndSettleCopierAccount(accountId!) === 'retry') retry.add(accountId!);
        await settlementPause(COPIER_SETTLEMENT_QUIET_MS);
      }
    } finally {
      copierSettlementDraining = false;
    }
    if (retry.size > 0 && !stopped) {
      const timer = setTimeout(() => {
        copierSettlementTimers.delete(timer);
        for (const accountId of retry) requestCopierSettlement(accountId);
      }, Math.max(COPIER_SETTLEMENT_TERMINAL_AGE_MS, COPIER_SETTLEMENT_QUIET_MS) + COPIER_SETTLEMENT_QUIET_MS);
      (timer as { unref?: () => void }).unref?.();
      copierSettlementTimers.add(timer);
    }
  };
  const requestCopierSettlement = (accountId: number) => {
    if (stopped) return;
    copierSettlementPendingAccounts.add(accountId);
    if (!gate.armed) void drainCopierSettlement();
  };
  /** Zachytí pozdní terminální stav, restart i starší snapshot bez usazení. */
  const sweepCopierSettlement = () => {
    if (stopped) return;
    const settled = new Set(currentRuntime().state.safety.settledCopierEntries ?? []);
    const unsettledLegs = new Set(copierOwnershipEntries()
      .filter(entry => !settled.has(entry.id))
      .flatMap(entry => entry.legIds));
    for (const orderId of copierLegTerminalSeenAt.keys()) {
      if (!unsettledLegs.has(orderId)) copierLegTerminalSeenAt.delete(orderId);
    }
    for (const accountId of new Set(copierOwnershipEntries()
      .filter(entry => !settled.has(entry.id))
      .map(entry => entry.accountId))) {
      requestCopierSettlement(accountId);
    }
  };
  const scheduleCopierSettlementSweep = () => {
    if (stopped) return;
    const timer = setTimeout(() => {
      copierSettlementTimers.delete(timer);
      sweepCopierSettlement();
    }, COPIER_SETTLEMENT_QUIET_MS);
    copierSettlementTimers.add(timer);
  };
  const runCopierSettlementSweepLoop = () => {
    const timer = setTimeout(() => {
      copierSettlementTimers.delete(timer);
      sweepCopierSettlement();
      runCopierSettlementSweepLoop();
    }, COPIER_SETTLEMENT_SWEEP_MS);
    (timer as { unref?: () => void }).unref?.();
    copierSettlementTimers.add(timer);
  };
  runCopierSettlementSweepLoop();

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
      ...(stored.unconfirmedFlatLots ? { unconfirmedFlatLots: stored.unconfirmedFlatLots.map(lot => ({ ...lot })) } : {}),
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
      leaderFillAheadOfPosition.clear();
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
        lastTradingWindowEnd(safety.tradingWindow),
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
    // Mezera mezi dvěma okny není konec dne: vstupy se jen nekopírují.
    if (gate.armed && !gate.shadowMode && stats.windowState === 'outside'
      && isAfterTradingWindowsAt(safety.tradingWindow, at)) {
      const lastEnd = lastTradingWindowEnd(safety.tradingWindow);
      const minute = zonedMinuteOfDay(at, safety.tradingWindow.timeZone) ?? lastEnd;
      addCandidate('window-end', safety.dayRuleActions.windowEnd.atEnd,
        `obchodní okno skončilo (${formatTradingWindows(safety.tradingWindow)}, ${safety.tradingWindow.timeZone})`, true,
        minute, lastEnd);
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
          followerCount: group.followers.filter(follower => follower.enabled !== false && follower.mode !== 'off').length,
          openedAt: lot.openedAt ?? null,
          closedAt: at,
          exitReason: leaderStopOrderIds.has(fill.brokerOrderId)
            ? 'sl'
            : leaderTargetOrderIds.has(fill.brokerOrderId) ? 'tp' : 'manual',
          avgEntryPrice: lot.avgPrice,
          avgExitPrice: fill.price,
          ...(lot.entryOrderIds?.length ? { leaderEntryOrderIds: [...lot.entryOrderIds] } : {}),
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
          ...(fill.brokerOrderId ? { entryOrderIds: [fill.brokerOrderId] } : {}),
        });
      } else {
        const total = Math.abs(lot.netQuantity) + Math.abs(remaining);
        lot.avgPrice = (Math.abs(lot.netQuantity) * lot.avgPrice + Math.abs(remaining) * fill.price) / total;
        lot.netQuantity += remaining;
        lot.maxQuantity = Math.max(lot.maxQuantity ?? 0, Math.abs(lot.netQuantity));
        if (fill.brokerOrderId && !(lot.entryOrderIds ?? []).includes(fill.brokerOrderId)) {
          lot.entryOrderIds = [...(lot.entryOrderIds ?? []), fill.brokerOrderId];
        }
      }
    }

    await persistSafety({ ...currentRuntime().state.safety, dailyStats: stats });
    leaderFillAheadOfPosition.add(fill.symbol);
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
    await persistSafetyUpdate(current => ({
      ...current,
      dayLockUntil: Math.max(current.dayLockUntil, until),
      dayLockReason: reason,
      dayLockTrigger: pending.trigger,
      dayLockAt: now,
    }));
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
    armPreparationReceipt = null;
    armPreparationLastAttemptAt = -Infinity;
    source.requireReconciliation();
  };

  const failClosed = (
    reason: unknown,
    failure: {
      transportLost?: boolean;
      autoClose?: boolean;
      reconcileAfterTerminalFill?: boolean;
      episodeId?: string;
      recordWhenDisarmed?: boolean;
    } = {},
  ) => {
    const wasArmed = gate.armed;
    const wasLiveArmed = gate.armed && !gate.shadowMode;
    invalidateReconciliation();
    lastError = errorOf(reason);
    if (!failure.transportLost) {
      armPreparationIncidentRequiresRecovery = true;
      const manualRecoveryRequired = { at: clock(), reason: lastError.message };
      disarmPersistenceTail = disarmPersistenceTail.then(() => persistSafetyUpdate(current => ({
        ...current,
        manualRecoveryRequired,
      }))).catch(persistenceError => {
        options.onError?.(new Error(
          `Požadavek ruční obnovy se nepodařilo durable uložit: ${errorOf(persistenceError).message}`,
        ));
      });
    }
    const existingSameIncident = lastDisarm
      && lastDisarm.detail === lastError.message
      && lastDisarm.episodeId === failure.episodeId;
    const disarm = (wasArmed || failure.recordWhenDisarmed) && !existingSameIncident
      ? recordDisarm(
          failure.transportLost ? 'transport' : 'fail-closed',
          lastError.message,
          groupIsFlat()
            ? 'flat'
            : 'unknown',
          { episodeId: failure.episodeId },
        )
      : undefined;
    gate = {
      ...gate,
      armed: false,
      shadowMode: true,
      ...(failure.transportLost ? { connected: false } : {}),
    };
    cancelFollowerCutBackgroundLanes(
      failure.transportLost ? 'transport-lost' : 'fail-closed',
    );
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
      pendingReadOnlyConnectionRecovery = false;
    } else if (failure.transportLost) {
      // I výpadek v DISARMED/flat zneplatnil poslední preflight. Po návratu
      // spojení ho obnovíme automaticky, ale výhradně broker-read-only.
      pendingReadOnlyConnectionRecovery = true;
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
          const autoClose = await autoFlattenCopies(trigger, seed);
          if (disarmAt != null) {
            updateDisarmOutcome(
              disarmAt,
              autoClose.flat ? successfulAutoCloseOutcome(disarmAt, autoClose.acted) : 'unknown',
            );
          }
          if (
            recovery.reconcileAfterTerminalFill
            && autoClose.flat
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

      rememberLeaderPosition(pending.symbol, brokerLeaderNet);
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

  /**
   * Autoritativní důkaz, že followera zlikvidovala propka/broker (denní
   * auto-liq, drawdown floor, účet už nesmí obchodovat). Jen čtení; při
   * jakékoli chybě vrací null a volající zůstává fail-closed.
   */
  const classifyFollowerBrokerBreach = async (accountId: number): Promise<string | null> => {
    try {
      const [capabilities, snapshots] = await Promise.all([
        broker.listAccountCapabilities([accountId]),
        broker.listAccountRiskSnapshots([accountId]),
      ]);
      const capability = capabilities.find(item => item.accountId === accountId);
      if (capability && (!capability.active || !capability.canTrade)) {
        return `broker účet už nepovoluje obchodování (active=${capability.active}, canTrade=${capability.canTrade})`;
      }
      const risk = snapshots.find(item => item.accountId === accountId);
      if (!risk) return null;
      if (
        risk.realizedPnlUsd != null && risk.dailyLossAutoLiq != null && risk.dailyLossAutoLiq > 0
        && risk.realizedPnlUsd <= -risk.dailyLossAutoLiq
      ) {
        return `realizovaná ztráta ${risk.realizedPnlUsd.toFixed(2)} USD dosáhla daily loss auto-liq ${risk.dailyLossAutoLiq} USD`;
      }
      // `minNetLiq` je odvozený floor propky (high-watermark − trailing, nejvýš
      // trailing limit), equity je skutečné net liq nebo realizovaný cash.
      // Čerstvý účet (cash = high-watermark = start) tak floor nikdy „nedosáhne“.
      const equity = brokerRiskEquity(risk);
      if (equity != null && risk.minNetLiq != null && equity <= risk.minNetLiq) {
        return `equity ${equity.toFixed(2)} USD dosáhla drawdown flooru ${risk.minNetLiq.toFixed(2)} USD`;
      }
      return null;
    } catch {
      return null;
    }
  };

  /**
   * Follower, kterého zlikvidovala propka, přestává být účastníkem kopie:
   * durable `breached`, úklid vlastních ochranných noh, audit. Skupina
   * zůstává ARMED — ostatní followeři dál drží stejnou expozici jako leader
   * a odzbrojení by jim jen sebralo synchronizaci SL/TP (incident 7. 9.).
   */
  const isolateBreachedFollower = async (accountId: number, symbol: string, reason: string): Promise<boolean> => {
    const now = clock();
    const current = accountEligibility.get(accountId);
    const next = new Map(accountEligibility);
    setEligibilityIn(next, accountId, {
      accountId,
      state: 'breached',
      reason: `propka zlikvidovala účet: ${reason}`,
      at: now,
      ...(current?.lastExecution ? { lastExecution: cloneRejectedExecution(current.lastExecution) } : {}),
    });
    const previous = new Map(accountEligibility);
    accountEligibility.clear();
    for (const [id, entry] of next) accountEligibility.set(id, entry);
    try {
      await persistEligibility();
    } catch (error) {
      accountEligibility.clear();
      for (const [id, entry] of previous) accountEligibility.set(id, entry);
      failClosed(new Error(
        `Copier fail-closed: breach followera ${accountId} nelze durable uložit: ${errorOf(error).message}`,
      ), { autoClose: false });
      return false;
    }
    for (const [key, timer] of pendingFollowerMagnitudeChecks) {
      if (!key.startsWith(`${accountId}:`)) continue;
      clearTimeout(timer);
      pendingFollowerMagnitudeChecks.delete(key);
    }
    for (const [key, pending] of pendingFollowerTransitions) {
      if (pending.accountId !== accountId) continue;
      clearPendingFollowerTransition(key);
    }
    options.onAudit?.([{
      at: now,
      leaderEventId: `follower-breach-isolated:${accountId}:${now}`,
      kind: 'skipped',
      accountId,
      reason: `follower ${accountId} vyřazen z kopie — ${reason}; kopírka pokračuje pro ostatní followery`,
    }]);
    await sweepFollowerProtectiveLegs(accountId, symbol, now);
    return true;
  };

  /**
   * Terminální odmítnutí vstupu followera pro tento symbol (limit pozice
   * propky, risk pravidlo brokera). Důkaz musí být úplný: pro účet a symbol
   * nesmí v outboxu viset nic nevyřízeného a odmítnutý příkaz je vstup ve
   * směru leadera z posledních minut. Bez toho zůstává cesta fail-closed.
   */
  const terminalEntryRejection = (accountId: number, symbol: string, leaderNet: number): OutboxEntry[] | null => {
    const entrySide = leaderNet > 0 ? 'Buy' : 'Sell';
    // Vazba na konkrétní epizodu: jen otevřená epocha leadera a jen vstupní
    // příkazy, které ji otevřely. Starší reject stejného směru nic nevysvětluje.
    const epoch = leaderExposureEpoch(symbol);
    if (!epoch || epoch.phase !== 'open' || epoch.leaderEntryOrderIds.length === 0) return null;
    const now = clock();
    const rejected: OutboxEntry[] = [];
    for (const entry of currentRuntime().outbox.values()) {
      if (entry.request.accountId !== accountId || entry.request.symbol !== symbol) continue;
      // Historie jiné epizody (včetně acknowledged vstupu z rána) nesmí
      // potlačit terminální reject aktuálního leader entry.
      if (!epoch.leaderEntryOrderIds.includes(entry.leaderOrderId)) continue;
      if (
        entry.status === 'planned'
        || entry.status === 'sending'
        || entry.status === 'unknown'
        || entry.status === 'acknowledged'
      ) return null;
      if (entry.status !== 'rejected') continue;
      if (entry.rejectedBy !== 'broker' || entry.request.side !== entrySide || !entry.reason?.trim()) return null;
      if (now - entry.updatedAt > REJECTED_ENTRY_ISOLATION_WINDOW_MS) return null;
      rejected.push(entry);
    }
    return rejected.length > 0 ? rejected : null;
  };

  /**
   * 17. 9. 2026: broker odmítl vstup čtyř Lucid followerů (limit pozice
   * propky), sedm ostatních v obchodě bylo a fail-closed celé skupiny jim
   * sebral řízení exitů. Follower s odmítnutým vstupem do této epizody
   * nepatří: dostane záměrné potlačení s povolenou pozicí 0 (jeho exity se
   * přeskočí, do další epizody vstoupí znovu), odmítnuté položky jsou
   * vysvětlené a nezůstávají stuck, případné ochranné nohy se uklidí.
   * Skupina zůstává ARMED pro followery, kteří v obchodě jsou.
   */
  const sidelineRejectedFollower = async (accountId: number, symbol: string, rejections: readonly OutboxEntry[]): Promise<void> => {
    const now = clock();
    const reason = rejections[0]?.reason?.trim() || 'broker odmítl vstup';
    const rejectedKeys = new Set(rejections.map(entry => entry.key));
    const leaderOrderId = rejections[0]?.leaderOrderId ?? '';
    if (
      rejections.some(entry => entry.leaderOrderId !== leaderOrderId)
      || !await authoritativelyConfirmSuppression(accountId, symbol, leaderOrderId)
    ) {
      throw new Error(
        `Copier fail-closed: odmítnutý follower ${accountId} nemá autoritativní flat/no-working/no-pending důkaz pro aktuální epizodu`,
      );
    }
    for (const [key, timer] of pendingFollowerMagnitudeChecks) {
      if (!key.startsWith(`${accountId}:`)) continue;
      clearTimeout(timer);
      pendingFollowerMagnitudeChecks.delete(key);
    }
    for (const [key, pending] of pendingFollowerTransitions) {
      if (pending.accountId !== accountId) continue;
      clearPendingFollowerTransition(key);
    }
    await processor.mutate(async current => {
      const outbox = new Map(current.outbox);
      let changed = false;
      for (const [key, entry] of outbox) {
        // Jen konkrétní odmítnuté vstupy této epizody, nic jiného téhož účtu.
        if (!rejectedKeys.has(key) || entry.status !== 'rejected') continue;
        outbox.set(key, waiveOutboxEntry(
          entry,
          `${entry.reason?.trim() || reason} — follower vyřazen z této epizody, kopírka pokračuje pro ostatní`,
          now,
        ));
        changed = true;
      }
      if (!changed) return current;
      const committed = await durableStore.commit(
        toSnapshot(
          current.state,
          outbox.values(),
          current.cancelOutbox.values(),
          current.revision,
          current.bracketOutbox.values(),
          current.osoOutbox.values(),
        ),
        current.revision,
      );
      return { ...current, outbox, revision: committed.revision };
    });
    options.onAudit?.([{
      at: now,
      leaderEventId: `follower-entry-rejected-isolated:${accountId}:${now}`,
      kind: 'skipped',
      accountId,
      reason: `follower ${accountId} vyřazen z této epizody — broker odmítl vstup (${reason}); kopírka pokračuje pro ostatní followery`,
    }]);
    await sweepFollowerProtectiveLegs(accountId, symbol, now);
  };

  /**
   * Ochranná noha kopírky z nativního OSO nebo bracketu: symbol a leader
   * entry order, ke kterému patří. Samostatné stopy se nepřiřazují (bez
   * vazby na vstup nejde doložit epochu) — zůstávají fail-closed.
   */
  const protectiveLegOwner = (
    accountId: number,
    brokerOrderId: string,
  ): { symbol: string; leaderEntryOrderId: string } | null => {
    const live = currentRuntime();
    for (const entry of [...live.osoOutbox.values(), ...live.bracketOutbox.values()]) {
      if (entry.request.accountId !== accountId) continue;
      if (entry.firstBrokerOrderId === brokerOrderId || entry.secondBrokerOrderId === brokerOrderId) {
        return { symbol: entry.request.symbol, leaderEntryOrderId: entry.leaderEntryOrderId };
      }
    }
    return null;
  };

  type ProtectiveFillCandidate = {
    accountId: number;
    symbol: string;
    key: string;
    brokerOrderId: string;
    epochId: string;
    leaderEntryOrderId: string;
    confirmedNet: number;
  };

  /**
   * Incident 6. 10. 2026: leader posunul stop, ochranná noha followera se
   * mezitím vyplnila na původní ceně. Modify skončil `filled`; follower je
   * risk-redukčně venku dřív než leader. Kandidát jen pro přesnou ochrannou
   * nohu kopie aktuální epochy s potvrzenou copier lineage.
   */
  const protectiveFilledDuringModify = (item: CopierAuditEntry): ProtectiveFillCandidate | null => {
    if (item.kind !== 'cancel-failed' || !item.key || item.accountId == null) return null;
    const lifecycle = currentRuntime().cancelOutbox.get(item.key);
    if (
      !lifecycle
      || lifecycle.operation !== 'modify'
      || lifecycle.status !== 'abandoned'
      || lifecycle.outcome !== 'filled'
      || lifecycle.accountId !== item.accountId
      || (item.brokerOrderId != null && item.brokerOrderId !== lifecycle.brokerOrderId)
      || followerFillRole(lifecycle.accountId, lifecycle.brokerOrderId) !== 'protective'
    ) return null;
    const owner = protectiveLegOwner(lifecycle.accountId, lifecycle.brokerOrderId);
    if (!owner) return null;
    const epoch = leaderExposureEpoch(owner.symbol);
    if (!epoch || epoch.phase !== 'open' || !epoch.leaderEntryOrderIds.includes(owner.leaderEntryOrderId)) return null;
    const participant = epoch.followers.find(follower => follower.accountId === lifecycle.accountId);
    if (
      !participant
      || !participant.eligibleAtOpen
      || participant.copyLineage !== 'confirmed'
      || !participant.confirmedNetQuantity
    ) return null;
    return {
      accountId: lifecycle.accountId,
      symbol: owner.symbol,
      key: lifecycle.key,
      brokerOrderId: lifecycle.brokerOrderId,
      epochId: epoch.id,
      leaderEntryOrderId: owner.leaderEntryOrderId,
      confirmedNet: participant.confirmedNetQuantity,
    };
  };

  /**
   * První fáze izolace (bez durable zápisu): autoritativně ověří, že vyplněná
   * ochranná noha přesně uzavřela potvrzenou kopii (množství i směr), follower
   * je flat bez pracovních příkazů a leader během ověření nezměnil stav.
   * Úspěch nechá suppression pro epochu; selhání ji odstraní a vyhodí.
   */
  const restoreSuppression = (
    accountId: number,
    symbol: string,
    previous: IntentionalEntrySuppression | undefined,
  ) => {
    const key = intentionalSuppressionKey(accountId, symbol);
    if (previous) intentionalEntrySuppressions.set(key, previous);
    else intentionalEntrySuppressions.delete(key);
  };
  const prepareProtectiveIsolation = async (
    candidate: ProtectiveFillCandidate,
  ): Promise<IntentionalEntrySuppression | undefined> => {
    const leaderAccountId = group.leaderAccountId;
    const previous = intentionalEntrySuppressions.get(intentionalSuppressionKey(candidate.accountId, candidate.symbol));
    const fail = (reason: string): never => {
      restoreSuppression(candidate.accountId, candidate.symbol, previous);
      throw new Error(`Copier fail-closed: follower ${candidate.accountId} — ${reason}`);
    };
    if (leaderAccountId == null) fail('chybí leader');
    const leaderVersionAtStart = tradeObservationVersionByAccount.get(leaderAccountId!) ?? 0;
    if ((leaderPositions.get(candidate.symbol) ?? 0) === 0) fail('leader už není v pozici');
    const lookup = await broker.findOrderById(candidate.accountId, candidate.brokerOrderId);
    const order = lookup.order;
    const expectedSide = candidate.confirmedNet > 0 ? 'Sell' : 'Buy';
    if (
      lookup.completeness !== 'authoritative'
      || !order
      || order.status !== 'filled'
      || order.side !== expectedSide
      || order.filledQuantity !== Math.abs(candidate.confirmedNet)
    ) {
      fail(`vyplněná ochranná noha ${candidate.brokerOrderId} přesně nevysvětluje potvrzenou kopii ${candidate.confirmedNet}`);
    }
    let confirmed = false;
    for (let attempt = 0; attempt < 2 && !confirmed; attempt += 1) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 300));
      confirmed = await authoritativelyConfirmSuppression(
        candidate.accountId,
        candidate.symbol,
        candidate.leaderEntryOrderId,
      );
    }
    if (!confirmed) fail('po vyplnění ochranné nohy během modify nemá autoritativní flat/no-working důkaz');
    if (
      (tradeObservationVersionByAccount.get(leaderAccountId!) ?? 0) !== leaderVersionAtStart
      || pendingTradeEventsFor([leaderAccountId!])
      || leaderExposureEpoch(candidate.symbol)?.id !== candidate.epochId
      || (leaderPositions.get(candidate.symbol) ?? 0) === 0
    ) {
      fail('leader během ověření změnil stav');
    }
    return previous;
  };

  /**
   * Druhá fáze: všechny kandidáty dávky prošly. Jedním commitem prominout
   * přesné cancel-outbox položky; zrušit čekající kontroly jen pro přesný
   * účet+symbol. Žádný kompenzační obchod se neposílá.
   */
  const commitProtectiveIsolation = async (candidates: readonly ProtectiveFillCandidate[]): Promise<void> => {
    for (const candidate of candidates) {
      const transitionKey = followerTransitionKey(candidate.accountId, candidate.symbol);
      const timer = pendingFollowerMagnitudeChecks.get(transitionKey);
      if (timer) {
        clearTimeout(timer);
        pendingFollowerMagnitudeChecks.delete(transitionKey);
      }
      for (const [key, pending] of pendingFollowerTransitions) {
        if (pending.accountId === candidate.accountId && pending.symbol === candidate.symbol) {
          clearPendingFollowerTransition(key);
        }
      }
    }
    const now = clock();
    const keys = new Set(candidates.map(candidate => candidate.key));
    await processor.mutate(async current => {
      const cancelOutbox = new Map(current.cancelOutbox);
      let changed = false;
      for (const [key, entry] of cancelOutbox) {
        if (!keys.has(key) || entry.status !== 'abandoned' || entry.outcome !== 'filled') continue;
        cancelOutbox.set(key, waiveCancelEntry(
          entry,
          `${entry.reason?.trim() || 'modify skončil filled'} — ochranná noha vyplnila dřív než leader; follower vyřazen do konce epizody`,
          now,
        ));
        changed = true;
      }
      if (!changed) return current;
      const committed = await durableStore.commit(
        toSnapshot(
          current.state,
          current.outbox.values(),
          cancelOutbox.values(),
          current.revision,
          current.bracketOutbox.values(),
          current.osoOutbox.values(),
        ),
        current.revision,
      );
      return { ...current, cancelOutbox, revision: committed.revision };
    });
    options.onAudit?.([...new Set(candidates.map(candidate => candidate.accountId))].map(accountId => ({
      at: now,
      leaderEventId: `follower-protective-filled-isolated:${accountId}:${now}`,
      kind: 'skipped' as const,
      accountId,
      reason: `follower ${accountId} vyřazen z této epizody — jeho ochranná noha se vyplnila dřív než leaderova (během posunu); je flat, kopírka pokračuje pro ostatní followery`,
    })));
  };

  const verifyFollowerMagnitude = async (accountId: number, symbol: string) => {
    const key = followerTransitionKey(accountId, symbol);
    if (!pendingFollowerMagnitudeChecks.has(key) || stopped) return;
    pendingFollowerMagnitudeChecks.delete(key);
    const follower = group.followers.find(item => item.accountId === accountId);
    if (!follower
      || follower.enabled === false
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

      rememberLeaderPosition(symbol, leaderNet);
      const followerPositions = positionsByAccount.get(accountId) ?? new Map<string, number>();
      followerPositions.set(symbol, followerNet);
      positionsByAccount.set(accountId, followerPositions);

      if (followerNet === expectedFollowerNet) return;
      const suppression = currentIntentionalSuppression(accountId, symbol);
      if (suppression && followerNet === suppression.allowedNet) return;
      if (followerNet === 0 && leaderNet !== 0) {
        // Follower zmizel z trhu za otevřeného leadera. Než skupinu
        // odzbrojíme, ověříme u brokera, zda ho nezlikvidovala propka —
        // pak je to jeho konec dne, ne rozbitý model reality skupiny.
        const breach = await classifyFollowerBrokerBreach(accountId);
        if (breach) {
          await isolateBreachedFollower(accountId, symbol, breach);
          return;
        }
        const rejections = terminalEntryRejection(accountId, symbol, leaderNet);
        if (rejections) {
          await sidelineRejectedFollower(accountId, symbol, rejections);
          return;
        }
      }
      gate = {
        ...gate,
        divergentAccounts: new Set([...gate.divergentAccounts, accountId]),
      };
      const divergence = new Error(
        `Copier fail-closed: follower ${accountId} má autoritativně pozici ${followerNet} na ${symbol}, `
        + `očekáváno ${expectedFollowerNet} podle leadera ${leaderNet} × ${follower.multiplier}`,
      );
      if (gate.armed) {
        failClosed(divergence, { autoClose: false });
      } else {
        invalidateReconciliation();
        options.onAudit?.([{
          at: clock(), leaderEventId: `disarmed-divergence:${accountId}:${symbol}`, kind: 'blocked',
          accountId, reason: `${divergence.message}; DISARMED audit nezměnil poslední příčinu vypnutí`,
        }]);
      }
    } catch (error) {
      const readFailure = new Error(
        `Copier fail-closed: autoritativní kontrola expozice followera ${accountId} `
        + `na ${symbol} selhala: ${errorOf(error).message}`,
      );
      if (gate.armed) {
        failClosed(readFailure, { autoClose: false });
      } else {
        invalidateReconciliation();
        options.onAudit?.([{
          at: clock(), leaderEventId: `disarmed-divergence-read:${accountId}:${symbol}`, kind: 'blocked',
          accountId, reason: `${readFailure.message}; DISARMED audit nezměnil poslední příčinu vypnutí`,
        }]);
      }
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
    if (copierEntryFillIds.size > 10_000) {
      // Omezená paměť: ztráta součtů jen znemožní dodatečné potvrzení lineage.
      copierEntryFillIds.clear();
      copierEntryFillTotals.clear();
    }
    if (role === 'copied-entry' && !copierEntryFillIds.has(fill.fillId)) {
      copierEntryFillIds.add(fill.fillId);
      copierEntryFillTotals.set(
        fill.brokerOrderId,
        (copierEntryFillTotals.get(fill.brokerOrderId) ?? 0) + fill.quantity,
      );
    }
    const key = followerTransitionKey(fill.accountId, fill.symbol);
    const sign = fill.side === 'Buy' ? 1 : -1;
    const cause: RecentFollowerFillCause = {
      role, sign, brokerOrderId: fill.brokerOrderId, observedAt,
    };
    recentFollowerFillCauses.set(key, cause);

    const cachedFollowerNet = positionsByAccount.get(fill.accountId)?.get(fill.symbol) ?? 0;
    if (
      role === 'copied-exit'
      && (leaderPositions.get(fill.symbol) ?? 0) === 0
      && cachedFollowerNet !== 0
      && Math.sign(cachedFollowerNet) === (fill.side === 'Buy' ? 1 : -1)
    ) {
      recentFollowerFillCauses.delete(key);
      gate = {
        ...gate,
        divergentAccounts: new Set([...gate.divergentAccounts, fill.accountId]),
      };
      failClosed(new Error(
        `Copier fail-closed: leader je flat a follower ${fill.accountId} ${fill.symbol} `
        + `dostal fill zkopírovaného exitu ${fill.brokerOrderId}`,
      ), { autoClose: false });
      return;
    }

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

  /**
   * Definitivní reject VSTUPU followera (limit pozice propky, risk pravidlo
   * brokera) není nejistota: broker příkaz nevytvořil a follower je
   * autoritativně flat, do této epizody nepatří. Vrací outbox položku jen
   * s úplným důkazem (známý snapshot pozic, follower na symbolu flat,
   * důvod od brokera); jinak null a dávka zůstává fail-closed.
   */
  const sidelinableEntryRejection = (item: CopierAuditEntry): OutboxEntry | null => {
    if (item.kind !== 'rejected' || !item.key || item.accountId == null) return null;
    if (!group.followers.some(follower => follower.accountId === item.accountId)) return null;
    const runtime = currentRuntime();
    const entry = runtime.outbox.get(item.key);
    if (
      !entry
      || entry.status !== 'rejected'
      // Jen verdikt brokera z TÉTO dávky; interní policy blok (maxContracts)
      // zůstává kritický jako dřív.
      || entry.rejectedBy !== 'broker'
      || entry.leaderEventId !== item.leaderEventId
      || entry.request.accountId !== item.accountId
      || entry.operationKind === 'liquidate-position'
      || !entry.reason?.trim()
    ) return null;
    // Nic dalšího pro účet a symbol nesmí být rozpracované (částečné plnění,
    // nejasný nebo přijatý vstup) — jinak flat není důkaz, že nikdy nevstoupil.
    // A1 (review 30. 9.): přijatý (acknowledged) příkaz jiné, už uzavřené
    // epizody nic nevysvětluje — `acknowledged` je konečný stav a outbox se
    // nečistí, takže by jinak sideline zablokoval každý dřívější obchod na
    // symbolu. Rozpracované stavy blokují dál bez ohledu na epizodu a
    // sideline stejně potvrzuje flat autoritativním čtením u brokera.
    const epoch = leaderExposureEpoch(entry.request.symbol);
    const currentEpisodeOrderIds = new Set(
      epoch?.phase === 'open' ? epoch.leaderEntryOrderIds : [],
    );
    currentEpisodeOrderIds.add(entry.leaderOrderId);
    for (const other of runtime.outbox.values()) {
      if (other.key === entry.key || other.request.accountId !== item.accountId
        || other.request.symbol !== entry.request.symbol) continue;
      if (other.status === 'planned' || other.status === 'sending' || other.status === 'unknown') return null;
      if (other.status === 'acknowledged' && currentEpisodeOrderIds.has(other.leaderOrderId)) return null;
    }
    const positions = positionsByAccount.get(item.accountId);
    if (!positions || (positions.get(entry.request.symbol) ?? 0) !== 0) return null;
    return entry;
  };

  type ProtectedTargetModifyProof = {
    item: CopierAuditEntry;
    lifecycle: CancelOutboxEntry;
    leaderTargetOrderId: string;
    failedRole: 'stop' | 'target';
    target: BrokerOrder;
    stop: BrokerOrder;
  };

  type ProtectedTargetModifyRecovery = {
    failures: ProtectedTargetModifyProof[];
    protectedAccountIds: number[];
  };

  /**
   * A venue-managed stop/target quantity race is not grounds to market-close
   * every follower when the broker still authoritatively shows a full-size
   * working target AND stop for the exact durable OSO lineage. The proof is
   * deliberately strict: one unknown/rejected/missing leg falls back to the
   * ordinary fail-closed + auto-close path.
   */
  const proveProtectedTargetModifyFailures = async (
    critical: readonly CopierAuditEntry[],
  ): Promise<ProtectedTargetModifyRecovery | null> => {
    if (critical.length === 0 || !critical.every(item => item.kind === 'cancel-failed')) return null;
    const current = currentRuntime();
    const proofs: ProtectedTargetModifyProof[] = [];
    const readWorkingProtection = async (
      accountId: number,
      oso: OsoOutboxEntry,
    ): Promise<{ target: BrokerOrder; stop: BrokerOrder } | null> => {
      if (!oso.firstBrokerOrderId || !oso.secondBrokerOrderId) return null;
      const [positions, targetLookup, stopLookup] = await Promise.all([
        broker.listPositions(accountId),
        broker.findOrderById(accountId, oso.secondBrokerOrderId),
        broker.findOrderById(accountId, oso.firstBrokerOrderId),
      ]);
      if (targetLookup.completeness !== 'authoritative' || stopLookup.completeness !== 'authoritative') return null;
      const target = targetLookup.order;
      const stop = stopLookup.order;
      if (!target || !stop || target.accountId !== accountId || stop.accountId !== accountId) return null;
      if (target.symbol !== oso.request.symbol || stop.symbol !== oso.request.symbol) return null;
      const net = positions
        .filter(position => position.symbol === oso.request.symbol)
        .reduce((sum, position) => sum + position.netQuantity, 0);
      const protectiveSide = net > 0 ? 'Sell' : 'Buy';
      const requiredQuantity = Math.abs(net);
      if (
        net === 0
        || target.status !== 'working'
        || stop.status !== 'working'
        || target.side !== protectiveSide
        || stop.side !== protectiveSide
        || target.orderType !== 'Limit'
        || (stop.orderType !== 'Stop' && stop.orderType !== 'StopLimit')
        || target.filledQuantity !== 0
        || stop.filledQuantity !== 0
        || target.quantity !== requiredQuantity
        || stop.quantity !== requiredQuantity
        || target.limitPrice == null
        || stop.stopPrice == null
      ) return null;
      return { target, stop };
    };
    for (const item of critical) {
      if (!item.key || item.accountId == null || !item.brokerOrderId) return null;
      const lifecycle = current.cancelOutbox.get(item.key);
      if (
        !lifecycle
        || lifecycle.operation !== 'modify'
        || lifecycle.accountId !== item.accountId
        || lifecycle.brokerOrderId !== item.brokerOrderId
        || (lifecycle.status !== 'unknown' && lifecycle.status !== 'abandoned')
      ) return null;
      const protectiveRoles = [...current.state.links.values()].flatMap(links => (
        links
          .filter(link => (
            link.accountId === item.accountId
            && link.brokerOrderId === item.brokerOrderId
            && (link.nativeOsoRole === 'target' || link.nativeOsoRole === 'stop')
          ))
          .map(link => link.nativeOsoRole as 'stop' | 'target')
      ));
      if (protectiveRoles.length !== 1) return null;
      const [failedRole] = protectiveRoles;
      const oso = [...current.osoOutbox.values()].find(entry => (
        entry.request.accountId === item.accountId
        && (failedRole === 'target'
          ? entry.secondBrokerOrderId === item.brokerOrderId
          : entry.firstBrokerOrderId === item.brokerOrderId)
        && entry.firstBrokerOrderId != null
        && entry.secondBrokerOrderId != null
        && entry.status === 'acknowledged'
      ));
      if (!oso) return null;
      const leaderTargetOrderId = oso.leaderTargetOrderId;
      const protection = await readWorkingProtection(item.accountId, oso);
      if (!protection
        || (failedRole === 'target' ? protection.target : protection.stop).brokerOrderId !== item.brokerOrderId) return null;
      proofs.push({ item, lifecycle, leaderTargetOrderId, failedRole, ...protection });
    }
    const targetOrderIds = new Set(proofs.map(proof => proof.leaderTargetOrderId));
    const symbols = new Set(proofs.map(proof => proof.target.symbol));
    if (targetOrderIds.size !== 1 || symbols.size !== 1) return null;
    const leaderTargetOrderId = proofs[0].leaderTargetOrderId;
    const symbol = proofs[0].target.symbol;
    const protectedAccountIds: number[] = [];
    for (const follower of group.followers) {
      const positions = await broker.listPositions(follower.accountId);
      const net = positions
        .filter(position => position.symbol === symbol)
        .reduce((sum, position) => sum + position.netQuantity, 0);
      if (net === 0) continue;
      const oso = [...current.osoOutbox.values()].find(entry => (
        entry.request.accountId === follower.accountId
        && entry.leaderTargetOrderId === leaderTargetOrderId
        && entry.request.symbol === symbol
        && entry.status === 'acknowledged'
      ));
      if (!oso || await readWorkingProtection(follower.accountId, oso) == null) return null;
      protectedAccountIds.push(follower.accountId);
    }
    if (!proofs.every(proof => protectedAccountIds.includes(proof.lifecycle.accountId))) return null;
    return { failures: proofs, protectedAccountIds };
  };

  const enterManagementOnlyAfterProtectedTargetFailure = async (
    critical: readonly CopierAuditEntry[],
  ): Promise<boolean> => {
    const recovery = await proveProtectedTargetModifyFailures(critical);
    if (!recovery) return false;
    const proofs = recovery.failures;
    const at = clock();
    const accountIds = [...recovery.protectedAccountIds].sort((a, b) => a - b);
    const reason = 'Modify ochranné OSO nohy nebyl potvrzen; broker potvrdil plný working target i SL. Nové vstupy jsou pozastavené, otevřené kopie se dál řídí.';
    runtime = await processor.mutate(async current => {
      const cancelOutbox = new Map(current.cancelOutbox);
      let state = current.state;
      const touchedEvents = new Set<string>();
      for (const proof of proofs) {
        const live = cancelOutbox.get(proof.lifecycle.key);
        if (
          !live
          || live.operation !== 'modify'
          || live.brokerOrderId !== proof.lifecycle.brokerOrderId
          || (live.status !== 'unknown' && live.status !== 'abandoned')
        ) throw new Error('Management-only důkaz zestárl před durable commitem');
        cancelOutbox.set(live.key, waiveCancelEntry(
          live,
          `management-only: ${proof.failedRole} zůstal working a OSO kryje ${proof.stop.quantity}`,
          at,
        ));
        touchedEvents.add(live.leaderEventId);
        state = updateFollowerLinkQuantity(state, proof.target.brokerOrderId, proof.target.quantity);
        state = updateFollowerLinkQuantity(state, proof.stop.brokerOrderId, proof.stop.quantity);
      }
      for (const leaderEventId of touchedEvents) {
        const lifecycle = [...cancelOutbox.values()].filter(entry => entry.leaderEventId === leaderEventId);
        if (lifecycle.length > 0 && lifecycle.every(entry => (
          entry.status === 'confirmed' || entry.status === 'waived'
        ))) {
          state = applyResolved(
            state,
            [],
            Math.max(...lifecycle.map(entry => entry.leaderSequence)),
          );
        }
      }
      state = {
        ...state,
        safety: {
          ...state.safety,
          managementOnly: {
            at,
            reason,
            source: 'protected-target-modify',
            accountIds,
          },
        },
      };
      const committed = await durableStore.commit(
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
      return { ...current, state, cancelOutbox, revision: committed.revision };
    });
    lastError = new Error(reason);
    options.onError?.(lastError);
    options.onAudit?.([
      ...proofs.map(proof => ({
        at,
        leaderEventId: proof.item.leaderEventId,
        kind: 'recovered' as const,
        accountId: proof.lifecycle.accountId,
        key: proof.lifecycle.key,
        brokerOrderId: proof.lifecycle.brokerOrderId,
        reason: `management-only: target working, stop working qty=${proof.stop.quantity}`,
      })),
      {
        at,
        leaderEventId: `management-only-${at}`,
        kind: 'blocked' as const,
        reason,
      },
    ]);
    return true;
  };

  const failClosedOnCriticalAudit = async (entries: readonly CopierAuditEntry[]) => {
    // A terminal leader event can arrive during concurrent fan-out: one
    // follower write may have passed the fence while another is revoked.
    // That mixed batch is real possible exposure, not an ordinary skip.
    if (entries.some(item => item.kind === 'dispatched')
      && entries.some(item => item.kind === 'skipped'
        && item.reason?.startsWith('dispatch-revoked:leader-')
        && item.reason.includes('-before-dispatch:'))) {
      failClosed(new Error('Copier fail-closed: leader skončil během částečného follower dispatchu'));
      return;
    }
    const critical = entries.filter(isCriticalAuditEntry);
    if (critical.length === 0) return;
    const unknownStandalonePosition = critical.find(item => (
      item.kind === 'blocked' && item.reasonCode === 'standalone-position-unknown'
    ));
    if (unknownStandalonePosition) {
      // Runner vrací incident jako audit (stejně jako ostatní blokace), ne
      // jako výjimku. Controller jej ale musí zveřejnit v lastError i tehdy,
      // když už byl kvůli leader-flat/cooldownu DISARMED. Nikdy zde
      // neplánujeme auto-close: neznámý je osud jednoho orphan stopu, nikoli
      // důkaz, že zdravé follower pozice mají být zavřeny.
      failClosed(new Error(
        unknownStandalonePosition.reason
          ? `Copier fail-closed: ${unknownStandalonePosition.reason}`
          : 'Copier fail-closed: pozice followera není autoritativně známá',
      ), { autoClose: false });
      return;
    }
    if (!gate.armed) {
      invalidateReconciliation();
      return;
    }
    // 17. 9. 2026 (uživatel potvrdil sjednocení se stream variantou): když
    // jsou VŠECHNY kritické položky definitivně odmítnuté vstupy flat
    // followerů, skupina se nevypíná — ostatní followeři v obchodě jsou a
    // potřebují řízení exitů. Odmítnutí followeři se vyřadí z epizody.
    // Jakákoli jiná nejistota (unknown, abandoned, cancel-failed, blocked)
    // zůstává fail-closed s auto-close.
    const rejectedEntries = critical.map(sidelinableEntryRejection);
    if (rejectedEntries.every((entry): entry is OutboxEntry => entry != null)) {
      for (const entry of rejectedEntries) {
        try {
          await sidelineRejectedFollower(entry.request.accountId, entry.request.symbol, [entry]);
        } catch (reason) {
          failClosed(reason, { autoClose: false });
        }
      }
      return;
    }
    // 6. 10. 2026: všechny kritické položky jsou ochranné nohy kopií, které se
    // vyplnily během modify. Každého takového followera vyřadíme z epizody
    // (s autoritativním flat důkazem); jakákoli jiná nejistota = fail-closed.
    const protectiveFilled = critical.map(protectiveFilledDuringModify);
    if (protectiveFilled.every((item): item is ProtectiveFillCandidate => item != null)) {
      const prepared: ProtectiveFillCandidate[] = [];
      const previousSuppressions: Array<IntentionalEntrySuppression | undefined> = [];
      let failure: Error | null = null;
      // Jeden účet+symbol = jedna izolace. Dvě různé vyplněné nohy téhož
      // followera (OCO to nedovolí) jsou nevysvětlený stav → fail-closed.
      const byFollower = new Map<string, ProtectiveFillCandidate>();
      for (const candidate of protectiveFilled) {
        const followerKey = `${candidate.accountId}:${candidate.symbol}`;
        const existing = byFollower.get(followerKey);
        if (existing && existing.brokerOrderId !== candidate.brokerOrderId) {
          failure = new Error(`Copier fail-closed: follower ${candidate.accountId} má víc vyplněných ochranných noh`);
          break;
        }
        if (!existing) byFollower.set(followerKey, candidate);
      }
      for (const candidate of failure ? [] : byFollower.values()) {
        try {
          previousSuppressions.push(await prepareProtectiveIsolation(candidate));
          prepared.push(candidate);
        } catch (reason) {
          failure = errorOf(reason);
          break;
        }
      }
      if (!failure) {
        try {
          await commitProtectiveIsolation(protectiveFilled);
          return;
        } catch (reason) {
          failure = errorOf(reason);
        }
      }
      // Dávka buď celá, nebo vůbec: vrátit všechny suppression této dávky a
      // pokračovat beze změny původní cestou (cancel outbox zůstal netknutý).
      for (let index = prepared.length - 1; index >= 0; index -= 1) {
        restoreSuppression(prepared[index].accountId, prepared[index].symbol, previousSuppressions[index]);
      }
      options.onAudit?.([{
        at: clock(), leaderEventId: `follower-protective-filled-isolation-failed:${clock()}`,
        kind: 'blocked', reason: failure?.message ?? 'izolace po ochranném fillu selhala',
      }]);
    }
    if (await enterManagementOnlyAfterProtectedTargetFailure(critical)) return;
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
      const pendingSuppressionEntryIds = plan.kind === 'opened'
        ? [...new Set(group.followers.flatMap(follower => {
          const suppression = intentionalEntrySuppressions.get(
            intentionalSuppressionKey(follower.accountId, symbol),
          );
          return suppression != null && suppression.epochId == null && suppression.leaderOrderId
            ? [suppression.leaderOrderId]
            : [];
        }))]
        : [];
      const epochToPersist = plan.kind === 'opened'
        && plan.epoch.leaderEntryOrderIds.length === 0
        && pendingSuppressionEntryIds.length === 1
        ? mergeLeaderFlatEpochLineage(plan.epoch, {
          leaderEntryOrderIds: pendingSuppressionEntryIds,
        })
        : plan.epoch;
      if (plan.kind === 'opened' && epoch) {
        const staleTimer = leaderFlatGuardTimers.get(epoch.id);
        if (staleTimer) clearTimeout(staleTimer);
        leaderFlatGuardTimers.delete(epoch.id);
        leaderFlatGuardGenerationRetries.delete(epoch.id);
      }
      if (plan.kind === 'opened') {
        for (const follower of group.followers) {
          const key = intentionalSuppressionKey(follower.accountId, symbol);
          const suppression = intentionalEntrySuppressions.get(key);
          if (!suppression) continue;
          if (epochToPersist.leaderEntryOrderIds.includes(suppression.leaderOrderId)) {
            intentionalEntrySuppressions.set(key, { ...suppression, epochId: epochToPersist.id });
          } else {
            // Nová epizoda přepisuje/ruší lineage předchozího obchodu.
            intentionalEntrySuppressions.delete(key);
          }
        }
      }
      await persistLeaderExposureEpoch(epochToPersist);
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
    {
      preserveArm = false,
      scopedFailure = false,
      targets,
      cleanupScope,
    }: {
      preserveArm?: boolean;
      scopedFailure?: boolean;
      targets?: readonly ManualFlattenTarget[];
      cleanupScope?: 'account' | 'target-symbol' | 'target-symbol-or-account';
    } = {},
  ) => {
    // `scopedFailure`: selhání se vrací volajícímu jako výjimka a NEodzbrojí
    // celou skupinu — používá follower cut, který smí ovlivnit jen svůj účet
    // (spec RISK_TAB §0/§3.3: vyřazení účtu nikdy nezamyká skupinu).
    if (!preserveArm) {
      gate = { ...gate, armed: false };
      invalidateReconciliation();
      cancelFollowerCutBackgroundLanes(`flatten:${operationId}`);
    }
    const protectedAccountIds = await settleFollowerCutBackgroundAccounts(accountIds);
    const writableAccountIds = accountIds.filter(accountId => !protectedAccountIds.has(accountId));
    const writableTargets = targets?.filter(target => !protectedAccountIds.has(target.accountId));
    const mergeProtectedAccounts = (
      processed: ManualFlattenResult | null,
      label: string,
    ): ManualFlattenResult => {
      const processedByAccount = new Map(processed?.accounts.map(account => [account.accountId, account]));
      const accounts = accountIds.map(accountId => processedByAccount.get(accountId) ?? {
        accountId,
        ok: false,
        canceledOrders: 0,
        submittedClosures: 0,
        error: `${label}: účet má nejasný broker write z background lane; nový write byl bezpečně vynechán a je nutná read-only reconciliation`,
        remainingPositions: 0,
        workingOrders: 0,
      });
      return {
        operationId,
        accountIds: [...accountIds],
        canceledOrders: processed?.canceledOrders ?? 0,
        submittedClosures: processed?.submittedClosures ?? 0,
        flat: protectedAccountIds.size === 0 && processed?.flat === true,
        remainingPositionAccounts: [...new Set([
          ...(processed?.remainingPositionAccounts ?? []),
          ...protectedAccountIds,
        ])],
        workingOrderAccounts: processed?.workingOrderAccounts ?? [],
        accounts,
        failedAccounts: accounts.filter(account => !account.ok).map(account => account.accountId),
      };
    };
    // Flatten je poslední risk-redukční brzda. Kill switch, shozený WS gate
    // ani starý sending/unknown outbox nesmí zabránit ani pokusu o čerstvou
    // autoritativní REST likvidaci. Skutečný transport/rate-limit/broker
    // reject se projeví per-account výsledkem a nikdy se nevydává za flat.
    let result: ManualFlattenResult | null = null;
    try {
      if (writableAccountIds.length > 0) {
        await processor.mutate(async current => {
          const processed = await processManualFlatten({
            runtime: current,
            broker,
            store: durableStore,
            groupId: group.id,
            accountIds: writableAccountIds,
            ...(writableTargets && writableTargets.length > 0 ? { targets: writableTargets } : {}),
            ...(cleanupScope ? { cleanupScope } : {}),
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
      }
    } catch (error) {
      if (!scopedFailure) failClosed(error, preserveArm ? { autoClose: false } : undefined);
      throw error;
    }
    result = mergeProtectedAccounts(result, `Flatten ${operationId}`);
    if (preserveArm) {
      for (const accountId of writableAccountIds) workingOrderAccounts.delete(accountId);
      for (const accountId of result.workingOrderAccounts) workingOrderAccounts.add(accountId);
    } else {
      workingOrderAccounts = new Set([
        ...[...workingOrderAccounts].filter(accountId => protectedAccountIds.has(accountId)),
        ...result.workingOrderAccounts,
      ]);
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
      if (failed.some(account => !protectedAccountIds.has(account.accountId))) throw error;
    }
    if (preserveArm) {
      for (const accountId of writableAccountIds) positionsByAccount.set(accountId, new Map());
    }
    return result;
  };

  /**
   * Ruční Flatten/Flatten All nesmí čekat za běžnou serializovanou frontou.
   * Běží nad odděleným in-memory outboxem a používá výhradně broker-native
   * stavové liquidatePosition. Hlavní durable runtime záměrně nemění: po
   * nouzovém zásahu zůstává skupina DISARMED a vyžaduje novou reconciliation.
   * Cloud command je durable operation envelope; opakování stejného ID v
   * tomto procesu vrací stejný promise a nikdy nevyšle druhou likvidaci.
   */
  const emergencyFlattenOperations = new Map<string, Promise<ManualFlattenResult>>();
  let emergencyFlattenTail: Promise<void> = Promise.resolve();
  const emergencyFlatten = (
    accountIds: readonly number[],
    operationId: string,
    emergencyOptions: {
      targets?: readonly ManualFlattenTarget[];
      cleanupScope?: 'account' | 'target-symbol' | 'target-symbol-or-account';
    } = {},
  ): Promise<ManualFlattenResult> => {
    // Ne-Tradovate adaptéry bez stavového endpointu zachovají původní
    // durable cancel -> přesný Market close cestu. Produkční Tradovate
    // router liquidatePosition vždy poskytuje a používá prioritní lane níže.
    if (!broker.liquidatePosition) return flatten(accountIds, operationId, {
      ...(emergencyOptions.targets ? { targets: emergencyOptions.targets } : {}),
      ...(emergencyOptions.cleanupScope ? { cleanupScope: emergencyOptions.cleanupScope } : {}),
    });
    const key = operationId.trim();
    const existing = emergencyFlattenOperations.get(key);
    if (existing) return existing;

    gate = { ...gate, armed: false };
    invalidateReconciliation();
    cancelFollowerCutBackgroundLanes(`emergency-flatten:${key}`);
    const run = emergencyFlattenTail.then(async () => {
      const protectedAccountIds = await settleFollowerCutBackgroundAccounts(accountIds);
      const writableAccountIds = accountIds.filter(accountId => !protectedAccountIds.has(accountId));
      const writableTargets = emergencyOptions.targets?.filter(target => (
        !protectedAccountIds.has(target.accountId)
      ));
      const live = currentRuntime();
      const isolatedStore = createMemoryCopierStore(toSnapshot(
        live.state,
        live.outbox.values(),
        live.cancelOutbox.values(),
        live.revision,
        live.bracketOutbox.values(),
        live.osoOutbox.values(),
      ));
      const isolatedRuntime = runtimeFromSnapshot(await isolatedStore.load());
      const requestTimeoutMs = Math.max(250, options.flattenBrokerRequestTimeoutMs ?? 20_000);
      const withEmergencyDeadline = <T>(label: string, operation: () => Promise<T>): Promise<T> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(
            `Flatten broker request timeout (${label}, ${requestTimeoutMs} ms)`,
          )), requestTimeoutMs);
        });
        return Promise.race([operation(), deadline]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
      };
      // 17. 9. 2026: Flatten All zavřel 5/12 účtů, protože jediný 5s timeout
      // čtení pozic byl konečný. Čtení jsou idempotentní, takže se po
      // timeoutu/síťové chybě/5xx opakují s rostoucí prodlevou uvnitř
      // rozpočtu a nikdy za celkový deadline. Zápisy (liquidate, cancel)
      // zůstávají u jediného odeslání; jejich výsledek dokazuje jen
      // autoritativní čtení (u nativního liquidate stavově ověřený resend).
      const flattenDeadlineAt = clock() + Math.max(1_000, options.flattenDeadlineMs ?? 180_000);
      const retryBudgetMs = Math.max(0, options.flattenRetryBudgetMs ?? 60_000);
      const emergencyWait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
      const readWithRetry = <T>(label: string, operation: () => Promise<T>): Promise<T> => retryTransient(
        () => withEmergencyDeadline(label, operation),
        {
          deadlineMs: Math.min(retryBudgetMs, Math.max(0, flattenDeadlineAt - clock())),
          initialDelayMs: 1_000,
          maxDelayMs: 5_000,
          sleep: emergencyWait,
          clock,
        },
      );
      // Deadline je schválně pouze na nouzové lane. Nezastavuje ani
      // nepřepisuje běžné broker operace; u stavového liquidate znamená
      // timeout „indeterminate“ a následuje pouze autoritativní read.
      const emergencyBroker: BrokerPort = {
        ...broker,
        liquidatePosition: request => withEmergencyDeadline(
          `liquidate ${request.accountId}/${request.symbol}`,
          () => registerInFlightBrokerWrite(
            request.accountId,
            broker.liquidatePosition!(request),
          ),
        ),
        cancelOrder: (accountId, brokerOrderId) => withEmergencyDeadline(
          `cancel ${accountId}/${brokerOrderId}`,
          () => registerInFlightBrokerWrite(
            accountId,
            broker.cancelOrder(accountId, brokerOrderId),
          ),
        ),
        listPositions: accountId => readWithRetry(
          `positions ${accountId}`,
          () => broker.listPositions(accountId),
        ),
        listOrders: accountId => readWithRetry(
          `orders ${accountId}`,
          () => broker.listOrders(accountId),
        ),
        findOrderById: (accountId, brokerOrderId) => readWithRetry(
          `order ${accountId}/${brokerOrderId}`,
          () => broker.findOrderById(accountId, brokerOrderId),
        ),
        findOrdersByTag: (accountId, tag) => readWithRetry(
          `orders-by-tag ${accountId}/${tag}`,
          () => broker.findOrdersByTag(accountId, tag),
        ),
      };
      const processed = writableAccountIds.length > 0
        ? await processManualFlatten({
          runtime: isolatedRuntime,
          broker: emergencyBroker,
          store: isolatedStore,
          groupId: group.id,
          accountIds: writableAccountIds,
          ...(writableTargets && writableTargets.length > 0 ? { targets: writableTargets } : {}),
          ...(emergencyOptions.cleanupScope ? { cleanupScope: emergencyOptions.cleanupScope } : {}),
          nativeOnly: true,
          operationId: key,
          clock,
          confirmationAttempts: options.flattenConfirmationAttempts,
          confirmationPollMs: options.flattenConfirmationPollMs,
          accountConcurrency: options.flattenAccountConcurrency,
          wait: options.wait,
          deadlineAt: flattenDeadlineAt,
          retryPollMs: options.flattenRetryPollMs,
          liquidateAttempts: options.flattenLiquidateAttempts,
        })
        : null;
      const processedByAccount = new Map(
        processed?.result.accounts.map(account => [account.accountId, account]),
      );
      const accounts = accountIds.map(accountId => processedByAccount.get(accountId) ?? {
        accountId,
        ok: false,
        canceledOrders: 0,
        submittedClosures: 0,
        error: `Nouzový Flatten ${key}: účet má nejasný broker write z background lane; nový write byl bezpečně vynechán a je nutná read-only reconciliation`,
        remainingPositions: 0,
        workingOrders: 0,
      });
      const result: ManualFlattenResult = {
        operationId: key,
        accountIds: [...accountIds],
        canceledOrders: processed?.result.canceledOrders ?? 0,
        submittedClosures: processed?.result.submittedClosures ?? 0,
        flat: protectedAccountIds.size === 0 && processed?.result.flat === true,
        remainingPositionAccounts: [...new Set([
          ...(processed?.result.remainingPositionAccounts ?? []),
          ...protectedAccountIds,
        ])],
        workingOrderAccounts: processed?.result.workingOrderAccounts ?? [],
        accounts,
        failedAccounts: accounts.filter(account => !account.ok).map(account => account.accountId),
      };
      workingOrderAccounts = new Set([
        ...[...workingOrderAccounts].filter(accountId => protectedAccountIds.has(accountId)),
        ...result.workingOrderAccounts,
      ]);
      if (!result.flat) {
        const failed = result.accounts.filter(account => !account.ok);
        const detail = failed
          .map(account => `${account.accountId} (${account.error ?? 'účet není autoritativně flat'})`)
          .join(', ');
        const error = new Error(
          `Flatten selhal: zavřeno ${result.accounts.length - failed.length}/${result.accounts.length} účtů; selhaly ${detail || 'neznámé účty'}`,
        );
        if (failed.some(account => !protectedAccountIds.has(account.accountId))) throw error;
        failClosed(error, { autoClose: false });
      }
      for (const accountId of writableAccountIds) positionsByAccount.set(accountId, new Map());
      return result;
    });
    const guarded = run.catch(error => {
      failClosed(error, { autoClose: false });
      throw error;
    });
    emergencyFlattenOperations.set(key, guarded);
    // Chyba ani neúplný per-account výsledek nejsou idempotentní úspěch.
    // Po odpadnutí ochrany smí operátor zopakovat stejný operationId; čerstvý
    // stavový read zabrání druhému write na už zploštěném účtu.
    void guarded.then(result => {
      if (!result.flat && emergencyFlattenOperations.get(key) === guarded) {
        emergencyFlattenOperations.delete(key);
      }
    }, () => {
      if (emergencyFlattenOperations.get(key) === guarded) {
        emergencyFlattenOperations.delete(key);
      }
    });
    // Další odlišná nouzová operace může čekat pouze za jiným Flattenem,
    // nikdy za leader eventem, journalem ani reconciliation frontou.
    emergencyFlattenTail = guarded.then(() => undefined, () => undefined);
    if (emergencyFlattenOperations.size > 64) {
      const oldest = emergencyFlattenOperations.keys().next().value as string | undefined;
      if (oldest && oldest !== key) emergencyFlattenOperations.delete(oldest);
    }
    return guarded;
  };

  const finiteOrNull = (value: number | null): number | null => (
    value != null && Number.isFinite(value) ? value : null
  );
  const normalizeAccountRiskSnapshot = (
    snapshot: BrokerAccountRiskSnapshot,
  ): CopierAccountRiskSnapshot => {
    const netLiq = finiteOrNull(snapshot.netLiq);
    const cashBalanceUsd = finiteOrNull(snapshot.cashBalanceUsd ?? null);
    const minNetLiq = finiteOrNull(snapshot.minNetLiq);
    const dailyLossAutoLiq = finiteOrNull(snapshot.dailyLossAutoLiq);
    const equity = brokerRiskEquity({ netLiq, cashBalanceUsd });
    const validTimestamp = Number.isFinite(snapshot.at) && snapshot.at > 0;
    return {
      accountId: snapshot.accountId,
      // Neplatný čas se nesmí přepsat lokálním `clock()`: tím by se starý
      // či vadný broker payload změnil na čerstvě ověřený cut signál.
      verifiedAt: validTimestamp ? snapshot.at : 0,
      realizedPnlUsd: finiteOrNull(snapshot.realizedPnlUsd),
      openPnlUsd: finiteOrNull(snapshot.openPnlUsd ?? null),
      netLiq,
      cashBalanceUsd,
      highWaterNetLiq: finiteOrNull(snapshot.highWaterNetLiq ?? null),
      minNetLiq,
      dailyLossAutoLiq,
      trailingMaxDrawdown: finiteOrNull(snapshot.trailingMaxDrawdown),
      trailingMaxDrawdownLimit: finiteOrNull(snapshot.trailingMaxDrawdownLimit ?? null),
      propLimitUsd: dailyLossAutoLiq ?? (
        equity != null && minNetLiq != null ? equity - minNetLiq : null
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
      followers: group.followers.filter(follower => follower.enabled !== false && follower.mode !== 'off').length,
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

  const followerHasCopyToClose = async (
    accountId: number,
    readBroker: Pick<BrokerPort, 'listPositions' | 'listOrders'> = broker,
  ): Promise<boolean> => {
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
      readBroker.listPositions(accountId),
      readBroker.listOrders(accountId),
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
    background?: BackgroundFollowerCutContext,
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
      (background?.broker ?? broker).listPositions(accountId),
      (background?.broker ?? broker).listOrders(accountId),
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
            initialNet: positionSnapshot.get(order.symbol) ?? 0,
            filled: 0,
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
          stuckOutbox: gate.stuckOutbox || hasDispatchBlockingStuckOutbox(),
          nonBlockingOutboxKeys: backgroundNonBlockingOutboxKeys(),
          ineligibleAccounts: new Map(),
        },
        broker: background?.broker ?? dispatchBroker(safetyGeneration, cancelEvent),
        clock,
        store: durableStore,
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
    const manual = cut.source === 'manual';
    options.onAudit?.([{
      at: cut.at,
      leaderEventId: manual
        ? `follower-cut:${cut.accountId}:${cut.operationId ?? cut.at}`
        : `follower-cut:${cut.accountId}:${cut.until}`,
      kind: 'follower-cut',
      accountId: cut.accountId,
      until: cut.until,
      source: cut.source,
      cutUsd: cut.cutUsd,
      current: Math.abs(cut.realizedPnlUsd),
      limit: cut.cutUsd,
      reason: manual
        ? `follower ${cut.accountId} ručně zavřen pouze pro aktuální obchod; čeká na autoritativní flat/no-active celé skupiny`
        : `follower ${cut.accountId} cut: realized=${cut.realizedPnlUsd} USD limit=${cut.cutUsd} USD source=${cut.source}`,
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
    force = false,
  ): { cut: CopierFollowerCut; follower: CopyGroupConfig['followers'][number] } | null => {
    if (!gate.armed || activeFollowerCut(accountId, at)) return null;
    const follower = group.followers.find(item => item.accountId === accountId);
    const cutUsd = follower?.dailyLossCutUsd ?? 0;
    if (!follower || follower.enabled === false || follower.mode === 'off'
      || cutUsd <= 0 || (!force && realizedPnlUsd > -cutUsd)) return null;
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

  class FollowerCutDeadlineError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'FollowerCutDeadlineError';
    }
  }

  type BackgroundFollowerCutContext = {
    broker: BrokerPort;
    deadlineAt: number;
    assertReturnBarrier: () => void;
    abort: (reason: string) => void;
    wait: (ms: number) => Promise<void>;
  };

  const createBackgroundFollowerCutContext = (
    cut: CopierFollowerCut,
  ): BackgroundFollowerCutContext => {
    const accountId = cut.accountId;
    const operationId = cut.operationId ?? `cut-${accountId}-${Math.floor(cut.until / 86_400_000)}`;
    const admittedSafetyGeneration = safetyGeneration;
    const admittedGroupRevision = groupRevision;
    const admittedConnectionGeneration = connectionSyncGeneration;
    const admittedTradeEpoch = tradeEpochGeneration;
    const admittedGroupId = group.id;
    const deadlineMs = Math.max(1, options.followerCutDeadlineMs ?? 90_000);
    const deadlineAt = clock() + deadlineMs;
    const wallDeadlineAt = performance.now() + deadlineMs;
    const requestTimeoutMs = Math.max(
      1,
      options.followerCutBrokerRequestTimeoutMs ?? 10_000,
    );
    let abortBackground!: (reason: string) => void;
    const backgroundAborted = new Promise<string>(resolve => {
      abortBackground = resolve;
    });

    const activeCutStillMatches = () => {
      const active = followerCuts.get(accountId);
      return active?.at === cut.at
        && active.until === cut.until
        && active.operationId === cut.operationId
        && active.closed === null;
    };
    const assertReturnBarrier = () => {
      if (stopped || shutdownRequested) throw new CopierDispatchRevokedError('runtime-stopped');
      if (gate.killSwitch) throw new CopierDispatchRevokedError('kill-switch');
      if (!gate.armed || gate.shadowMode) throw new CopierDispatchRevokedError('disarmed');
      if (!gate.connected) throw new CopierDispatchRevokedError('disconnected');
      if (group.id !== admittedGroupId || groupRevision !== admittedGroupRevision) {
        throw new CopierDispatchRevokedError('group-revision-changed');
      }
      if (safetyGeneration !== admittedSafetyGeneration) {
        throw new CopierDispatchRevokedError('safety-generation-changed');
      }
      if (connectionSyncGeneration !== admittedConnectionGeneration) {
        throw new CopierDispatchRevokedError('connection-generation-changed');
      }
      if (tradeEpochGeneration !== admittedTradeEpoch) {
        throw new CopierDispatchRevokedError('trade-epoch-changed');
      }
      if (!activeCutStillMatches()) throw new CopierDispatchRevokedError('follower-cut-changed');
    };
    const withDeadline = <T>(label: string, operation: () => Promise<T>): Promise<T> => {
      const remainingMs = Math.min(
        requestTimeoutMs,
        deadlineAt - clock(),
        wallDeadlineAt - performance.now(),
      );
      if (remainingMs <= 0) {
        return Promise.reject(new FollowerCutDeadlineError(
          `Follower cut ${accountId} překročil deadline ${deadlineMs} ms (${label})`,
        ));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FollowerCutDeadlineError(
          `Follower cut ${accountId} překročil deadline při ${label}`,
        )), remainingMs);
      });
      const aborted = backgroundAborted.then(reason => {
        throw new CopierDispatchRevokedError(`follower-cut-aborted:${reason}`);
      });
      return Promise.race([operation(), deadline, aborted]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };
    const wait = (ms: number) => {
      const pause = options.wait
        ? options.wait(ms)
        : new Promise<void>(resolve => setTimeout(resolve, ms));
      return Promise.race([
        pause,
        backgroundAborted.then(reason => {
          throw new CopierDispatchRevokedError(`follower-cut-aborted:${reason}`);
        }),
      ]);
    };
    const read = <T>(label: string, operation: () => Promise<T>) => withDeadline(label, operation);
    const write = <T>(label: string, operation: () => Promise<T>) => {
      assertReturnBarrier();
      return withDeadline(label, () => {
        return registerInFlightBrokerWrite(accountId, operation());
      });
    };
    const cutBroker: BrokerPort = {
      ...broker,
      listPositions: id => read(`positions ${id}`, () => broker.listPositions(id)),
      listOrders: id => read(`orders ${id}`, () => broker.listOrders(id)),
      findOrderById: (id, brokerOrderId) => read(
        `order ${id}/${brokerOrderId}`,
        () => broker.findOrderById(id, brokerOrderId),
      ),
      findOrdersByTag: (id, tag) => read(
        `orders-by-tag ${id}/${tag}`,
        () => broker.findOrdersByTag(id, tag),
      ),
      ...(broker.findOrderStatusById ? {
        findOrderStatusById: (id: number, brokerOrderId: string) => read(
          `order-status ${id}/${brokerOrderId}`,
          () => broker.findOrderStatusById!(id, brokerOrderId),
        ),
      } : {}),
      cancelOrder: (id, brokerOrderId) => write(
        `cancel ${id}/${brokerOrderId}`,
        () => broker.cancelOrder(id, brokerOrderId),
      ),
      ...(broker.liquidatePosition ? {
        liquidatePosition: (request: Parameters<NonNullable<BrokerPort['liquidatePosition']>>[0]) => {
          if (request.accountId !== accountId) {
            return Promise.reject(new Error(`Follower cut ${operationId} míří na cizí účet`));
          }
          return write(
            `liquidate ${request.accountId}/${request.symbol}`,
            () => broker.liquidatePosition!(request),
          );
        },
      } : {}),
    };
    return {
      broker: cutBroker,
      deadlineAt,
      assertReturnBarrier,
      abort: abortBackground,
      wait,
    };
  };

  /** 8c in-place close-copy čeká na background lane účtu (7b bariéra, fail-closed po deadline). */
  const waitForFollowerCutBackground = (accountId: number): Promise<void> => (
    awaitFollowerCutBackgroundAccounts([accountId], 'In-place close-copy')
  );

  const trackFollowerCutBackground = <T>(
    accountId: number,
    context: BackgroundFollowerCutContext,
    job: Promise<T>,
  ): Promise<T> => {
    followerCutBackgroundJobs.add(job);
    followerCutBackgroundAccounts.add(accountId);
    followerCutBackgroundJobsByAccount.set(accountId, job);
    followerCutBackgroundAbortByAccount.set(accountId, context.abort);
    void job.finally(() => {
      followerCutBackgroundJobs.delete(job);
      followerCutBackgroundAccounts.delete(accountId);
      if (followerCutBackgroundJobsByAccount.get(accountId) === job) {
        followerCutBackgroundJobsByAccount.delete(accountId);
        followerCutBackgroundAbortByAccount.delete(accountId);
      }
    }).catch(() => undefined);
    return job;
  };

  /**
   * Background lane smí číst ze svého snapshotu, ale každý její outbox
   * přechod se před návratem z commit() atomicky sloučí do hlavního runtime.
   * Tím `planned`/`sending` skutečně předchází broker write i pádu procesu.
   */
  const createBackgroundFlattenStore = (operationId: string): CopierStore => {

    const leaderPrefix = `manual-flatten:${operationId}`;
    return {
      load: () => durableStore.load(),
      async commit(snapshot) {
        const backgroundOutbox = snapshot.outbox.filter(entry => (
          entry.leaderOrderId.startsWith(`${leaderPrefix}:`)
        ));
        const backgroundCancelOutbox = snapshot.cancelOutbox.filter(entry => (
          entry.leaderEventId === leaderPrefix
        ));
        const merged = await processor.mutate(async current => {
          if (backgroundOutbox.length === 0 && backgroundCancelOutbox.length === 0) return current;
          const outbox = new Map(current.outbox);
          const cancelOutbox = new Map(current.cancelOutbox);
          for (const entry of backgroundOutbox) outbox.set(entry.key, entry);
          for (const entry of backgroundCancelOutbox) cancelOutbox.set(entry.key, entry);
          const committed = await durableStore.commit(
            toSnapshot(
              current.state,
              outbox.values(),
              cancelOutbox.values(),
              current.revision,
              current.bracketOutbox.values(),
              current.osoOutbox.values(),
            ),
            current.revision,
          );
          return { ...current, outbox, cancelOutbox, revision: committed.revision };
        });
        return toSnapshot(
          merged.state,
          merged.outbox.values(),
          merged.cancelOutbox.values(),
          merged.revision,
          merged.bracketOutbox.values(),
          merged.osoOutbox.values(),
        );
      },
    };
  };

  const executeFollowerCutAction = async (
    cut: CopierFollowerCut,
    follower: CopyGroupConfig['followers'][number],
    liveSideEffects: boolean,
    emitCopyEvent = true,
    background?: BackgroundFollowerCutContext,
  ): Promise<ManualFlattenResult | null> => {
    const { accountId, at } = cut;
    // Živý cut (spuštěný daty za ARM, emitCopyEvent=true) drží selhání per
    // účet a skupinu neodzbrojuje (spec §0/§3.3). Recovery/restart a
    // update-group cesty (emitCopyEvent=false) běží už DISARMED a nechávají
    // si původní fail-closed chování, aby se nic neobnovovalo naslepo.
    const scopedFailure = emitCopyEvent;
    if (liveSideEffects && !background) {
      await awaitFollowerCutBackgroundAccounts(
        [accountId],
        `Follower cut recovery ${accountId}`,
      );
    }
    if (!liveSideEffects) {
      // Shadow ARM smí risk data i cut stav pozorovat, nikdy však nesmí
      // vytvořit cancel/liquidation side effect.
      if (emitCopyEvent) pushFollowerCutEvent(cut);
      return null;
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
      return null;
    }
    if (effectiveFollowerCutAction(cut, follower) === 'let-run') {
      try {
        // Let-run ponechá existující pozici a její čistě redukující ochranu,
        // ale copier-owned waiting entry/scale-in už po cutu nesmí fillnout.
        await cancelOwnedOpeningOrdersForLetRunCut(accountId, follower, cut, background);
      } catch (reason) {
        if (scopedFailure) await recordFollowerCutFailure(cut, errorOf(reason).message);
        else failClosed(new Error(`Follower cut ${accountId}: ${errorOf(reason).message}`), { autoClose: false });
      }
      if (emitCopyEvent) pushFollowerCutEvent(followerCuts.get(accountId) ?? cut);
      return null;
    }
    let hasKnownCopy: boolean;
    try {
      hasKnownCopy = await followerHasCopyToClose(accountId, background?.broker ?? broker);
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
      return null;
    }
    if (!hasKnownCopy) {
      if (cut.source === 'manual') {
        // Bez potvrzené copier lineage nikdy nelikvidujeme cizí/manuální
        // expozici. Zároveň ale nesmíme vrátit syntetické flat=true, pokud
        // čerstvý broker snapshot ukazuje pozici nebo pracovní příkaz.
        // Takový účet zůstane pro aktuální obchod vyřazený a ostatní účty
        // pokračují; operátor dostane pravdivé per-account selhání.
        try {
          const [positions, orders] = await Promise.all([
            (background?.broker ?? broker).listPositions(accountId),
            (background?.broker ?? broker).listOrders(accountId),
          ]);
          const hasUnownedExposure = positions.some(position => position.netQuantity !== 0)
            || orders.some(order => isOpenOrderStatus(order.status));
          if (hasUnownedExposure) {
            await recordFollowerCutFailure(
              cut,
              'účet nemá potvrzenou copier kopii a broker stále eviduje cizí pozici nebo aktivní příkaz',
            );
            if (emitCopyEvent) pushFollowerCutEvent(followerCuts.get(accountId) ?? cut);
            return null;
          }
        } catch (reason) {
          await recordFollowerCutFailure(
            cut,
            `flat stav účtu bez potvrzené copier kopie nelze ověřit: ${errorOf(reason).message}`,
          );
          if (emitCopyEvent) pushFollowerCutEvent(followerCuts.get(accountId) ?? cut);
          return null;
        }
        const closed = { ...cut, closed: at };
        followerCuts.set(accountId, closed);
        try {
          await persistRiskSafety();
        } catch (reason) {
          failClosed(new Error(
            `Výsledek ručního vyřazení followera ${accountId} nelze durable uložit: ${errorOf(reason).message}`,
          ), { autoClose: false });
          throw reason;
        }
        if (emitCopyEvent) pushFollowerCutEvent(closed);
        return {
          operationId: cut.operationId ?? `cut-${accountId}-${Math.floor(cut.until / 86_400_000)}`,
          accountIds: [accountId],
          canceledOrders: 0,
          submittedClosures: 0,
          flat: true,
          remainingPositionAccounts: [],
          workingOrderAccounts: [],
          accounts: [{ accountId, ok: true, canceledOrders: 0, submittedClosures: 0, remainingPositions: 0, workingOrders: 0 }],
          failedAccounts: [],
        };
      }
      if (emitCopyEvent) pushFollowerCutEvent(cut);
      return null;
    }
    let flattenResult: ManualFlattenResult;
    try {
      if (background) {
        const live = currentRuntime();
        const isolatedRuntime = runtimeFromSnapshot(toSnapshot(
          live.state,
          live.outbox.values(),
          live.cancelOutbox.values(),
          live.revision,
          live.bracketOutbox.values(),
          live.osoOutbox.values(),
        ));
        const ownedSymbols = Object.keys(
          followerCutExecutionProvenance.get(accountId)?.copiedExposureBySymbol ?? {},
        );
        const flattenOperationId = cut.operationId
          ?? `cut-${accountId}-${Math.floor(cut.until / 86_400_000)}`;
        const backgroundStore = createBackgroundFlattenStore(flattenOperationId);
        const processed = await processManualFlatten({
          runtime: isolatedRuntime,
          broker: background.broker,
          store: backgroundStore,
          groupId: group.id,
          accountIds: [accountId],
          ...(ownedSymbols.length > 0 ? {
            targets: ownedSymbols.map(symbol => ({ accountId, symbol })),
            cleanupScope: 'target-symbol' as const,
          } : {}),
          nativeOnly: true,
          operationId: flattenOperationId,
          clock,
          confirmationAttempts: options.followerCutConfirmationAttempts
            ?? options.flattenConfirmationAttempts
            ?? 12,
          confirmationPollMs: options.followerCutConfirmationPollMs
            ?? options.flattenConfirmationPollMs
            ?? 250,
          confirmationMaxPollMs: options.followerCutConfirmationMaxPollMs
            ?? (options.flattenConfirmationPollMs != null ? options.flattenConfirmationPollMs : 4_000),
          accountConcurrency: 1,
          wait: background.wait,
          deadlineAt: background.deadlineAt,
          retryPollMs: Math.max(100, options.flattenRetryPollMs ?? 1_000),
          liquidateAttempts: 1,
        });
        // Pozdní broker výsledek po DISARM/KILL/novějším cutu už smí pouze
        // zůstat v durable outboxu pro read-only recovery.
        background.assertReturnBarrier();
        flattenResult = processed.result;
        if (!flattenResult.flat) {
          const detail = flattenResult.accounts
            .filter(account => !account.ok)
            .map(account => account.error ?? `účet ${account.accountId} není flat`)
            .join('; ');
          const message = `Flatten selhal pro follower cut ${accountId}: ${detail || 'neznámý stav'}`;
          const operationEntries = [...processed.runtime.outbox.values()].filter(entry => (
            entry.request.accountId === accountId
            && entry.leaderOrderId.startsWith(`manual-flatten:${flattenOperationId}:`)
          ));
          const uncertainOperation = operationEntries.some(entry => (
            entry.status === 'sending'
            || entry.status === 'unknown'
            || entry.liquidationAttempt?.status === 'indeterminate'
          ));
          if (uncertainOperation || /deadline|timeout|indeterminate/i.test(detail)) {
            throw new FollowerCutDeadlineError(`Follower cut deadline/nejistý výsledek: ${message}`);
          }
          throw new Error(message);
        }
        workingOrderAccounts.delete(accountId);
        positionsByAccount.set(accountId, new Map());
      } else {
        flattenResult = await flatten(
          [accountId],
          cut.operationId ?? `cut-${accountId}-${Math.floor(cut.until / 86_400_000)}`,
          { preserveArm: true, scopedFailure },
        );
        if (!flattenResult.flat) {
          const detail = flattenResult.accounts
            .filter(account => !account.ok)
            .map(account => `${account.accountId}: ${account.error ?? 'účet není autoritativně flat'}`)
            .join('; ');
          throw new Error(
            `Flatten follower cut ${accountId} není autoritativně potvrzený${detail ? ` (${detail})` : ''}`,
          );
        }
      }
    } catch (reason) {
      if (background) {
        try {
          background.assertReturnBarrier();
        } catch {
          // Návratová bariéra odmítla stale lane: žádné closed=false ani
          // přepis novějšího cutu, pouze povinná nová reconciliation.
          invalidateReconciliation();
          return null;
        }
      }
      if (
        reason instanceof CopierProcessorCommitError
        || processor.recoveryStatus().state !== 'ready'
      ) {
        failClosed(new Error(
          `Follower cut ${accountId}: durable write-ahead selhal: ${errorOf(reason).message}`,
        ), { autoClose: false });
        return null;
      }
      // Jediný pokus, žádný druhý liquidation. Živě: když broker liquidate
      // ODMÍTL (nic neletí, stav účtu je známý), selhání se drží per účet
      // (closed=false, vstupy blokované, exity leadera se kopírují dál, aby
      // se kopie mohla zavřít s leaderem) a skupina zůstává ARM — ostatní
      // followeři nesmí přijít o kopírování kvůli jednomu účtu. Když je ale
      // výsledek liquidate NEZNÁMÝ (odeslán, flat nepotvrzen), platí obecný
      // invariant: neznámý broker stav = fail-closed celé skupiny.
      // Recovery: `flatten` už nastavil fail-closed stav i lastError.
      const liveAfterFailure = currentRuntime();
      const unknownBrokerState = reason instanceof FollowerCutDeadlineError
        || [...liveAfterFailure.outbox.values()].some(entry => (
          entry.request.accountId === accountId
          && (entry.status === 'sending' || entry.status === 'unknown')
        ))
        || [...liveAfterFailure.cancelOutbox.values()].some(entry => (
          entry.accountId === accountId
          && !entry.neverSent
          && (entry.status === 'sending' || entry.status === 'unknown')
        ));
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
      return null;
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
    return flattenResult;
  };

  const scheduleBackgroundFollowerCutAction = (
    cut: CopierFollowerCut,
    follower: CopyGroupConfig['followers'][number],
    liveSideEffects: boolean,
    emitCopyEvent = true,
  ) => {
    const context = createBackgroundFollowerCutContext(cut);
    const job = executeFollowerCutAction(
      cut,
      follower,
      liveSideEffects,
      emitCopyEvent,
      context,
    );
    return trackFollowerCutBackground(cut.accountId, context, job);
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
    const background = scheduleBackgroundFollowerCutAction(
      prepared.cut,
      prepared.follower,
      liveSideEffects,
    );
    // Broker lifecycle nesmí držet eventTail. Chyba se uvnitř akce převede
    // na durable closed=false/fail-closed; catch zde jen zavře unhandled okno.
    void background.catch(() => undefined);
  };

  const manualFollowerTradeOperations = new Map<string, Promise<ManualFlattenResult>>();
  /** B1: durable přijetí cutu dané operace; opakovaný dotaz na ni nesmí čekat na celé zavření. */
  const manualFollowerTradeAdmissions = new Map<string, Promise<void>>();
  const flattenFollowerForCurrentTrade = (
    accountId: number,
    operationId: string,
    onAdmitted?: () => void,
  ): Promise<ManualFlattenResult> => {
    const normalizedOperationId = operationId.trim();
    if (!/^[a-zA-Z0-9:_-]{8,120}$/.test(normalizedOperationId)) {
      return Promise.reject(new Error('Flatten vyžaduje stabilní operationId (8–120 znaků)'));
    }
    const operationKey = `${accountId}:${normalizedOperationId}`;
    const existing = manualFollowerTradeOperations.get(operationKey);
    if (existing) {
      if (onAdmitted) void manualFollowerTradeAdmissions.get(operationKey)?.then(onAdmitted, () => undefined);
      return existing;
    }

    const prepared = eventTail.then(async () => {
      const follower = group.followers.find(item => item.accountId === accountId);
      if (!follower) throw new Error('Do konce obchodu lze vyřadit pouze follower účet');
      if (!gate.connected) throw new Error('Follower nelze zavřít: worker nemá živé spojení s brokerem');
      if (!gate.armed || gate.shadowMode) {
        throw new Error('Tato akce vyžaduje zapnutou LIVE kopírku; jinak použij nouzový Flatten účtu');
      }
      if (gate.killSwitch) throw new Error('Follower nelze vyřadit: kill switch je aktivní');
      const active = activeFollowerCut(accountId);
      if (active) {
        throw new Error(active.source === 'manual'
          ? 'Účet už čeká na další obchod'
          : 'Účet je už vyřazený denním risk limitem');
      }
      if (currentStuckOperations().some(operation => operation.accountId === accountId)) {
        throw new Error('Follower má nevyřešenou broker operaci; selektivní Flatten by nebyl bezpečný');
      }

      const at = clock();
      const cut: CopierFollowerCut = {
        accountId,
        at,
        until: currentDailyStats(at).sessionEndAt,
        realizedPnlUsd: followerRealizedPnlUsd.get(accountId)
          ?? accountRisk.get(accountId)?.realizedPnlUsd
          ?? 0,
        cutUsd: 0,
        source: 'manual',
        scope: 'trade',
        operationId: normalizedOperationId,
        closed: null,
      };
      followerCuts.set(accountId, cut);
      followerCutExecutionProvenance.set(accountId, {
        accountId,
        cutAt: cut.at,
        cutUntil: cut.until,
        mode: 'live',
        copiedExposureBySymbol: copiedExposureEvidenceAtCut(accountId),
      });
      try {
        await persistRiskSafety();
      } catch (reason) {
        followerCuts.delete(accountId);
        followerCutExecutionProvenance.delete(accountId);
        const error = new Error(
          `Ruční vyřazení followera ${accountId} nelze durable uložit: ${errorOf(reason).message}`,
        );
        failClosed(error, { autoClose: false });
        throw error;
      }
      recordFollowerCutAudit(cut);
      onAdmitted?.();
      return { cut, follower };
    });
    // Jen durable admission cutu je serializovaná s leader eventy. Samotné
    // read/liquidate/confirm běží v izolované background lane.
    eventTail = prepared.then(() => undefined, () => undefined);
    // Odmítnuté přijetí se nikdy neohlásí jako přijaté (a nevisí jako
    // neošetřený reject); chybu volající dostane z `run`.
    manualFollowerTradeAdmissions.set(operationKey, prepared.then(() => undefined, () => new Promise<void>(() => undefined)));
    const run = prepared.then(({ cut, follower }) => {
      const action = scheduleBackgroundFollowerCutAction(cut, follower, true);
      return action;
    }).then(result => {
      if (result) return result;
      const state = followerCuts.get(accountId);
      if (state?.closed === false) {
        throw new Error(`Kopii followera ${accountId} se nepodařilo potvrzeně zavřít; ostatní účty pokračují`);
      }
      throw new Error(`Kopii followera ${accountId} se nepodařilo potvrzeně uzavřít`);
    });
    manualFollowerTradeOperations.set(operationKey, run);
    if (manualFollowerTradeOperations.size > 64) {
      const oldest = manualFollowerTradeOperations.keys().next().value as string | undefined;
      if (oldest && oldest !== operationKey) {
        manualFollowerTradeOperations.delete(oldest);
        manualFollowerTradeAdmissions.delete(oldest);
      }
    }
    return run;
  };

  const activeManualTradeCuts = (at = clock()) => [...followerCuts.values()].filter(cut => (
    cut.source === 'manual' && cut.scope === 'trade' && cut.until > at
  ));

  /**
   * Ručně zavřený follower se smí vrátit až po dvojím autoritativním důkazu,
   * že leader i všechny účty skupiny jsou flat a nemají žádný pracovní
   * příkaz. Jakákoli událost pozice/order/fill během čtení výsledek zahodí;
   * okamžitý reverz tak zůstane součástí stejné epizody.
   */
  const maybeReleaseManualTradeCuts = async (currentTradeEventCount = 1): Promise<void> => {
    const cuts = activeManualTradeCuts().filter(cut => !followerCutBackgroundAccounts.has(cut.accountId));
    if (cuts.length === 0 || !gate.connected || !managementOnlyGroupPositionsAreKnownFlat()) return;
    // Trade handler sám tvoří jednu pending událost; heartbeat nikoli. Každá
    // další čekající obchodní událost (např. okamžitý reverz) musí být
    // promítnuta dřív, než se ruční cut uvolní.
    if (pendingBrokerEvents > currentTradeEventCount) return;
    if (currentStuckOperations().length > 0 || hasBrokerUncertainOutbox()) return;
    if (group.leaderAccountId == null) return;

    const generationAtStart = safetyGeneration;
    const observationAtStart = tradeBoundaryObservationVersion;
    const accountIds = [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)];
    const readSnapshot = () => Promise.all(accountIds.map(async accountId => {
      const [positions, orders] = await Promise.all([
        broker.listPositions(accountId),
        broker.listOrders(accountId),
      ]);
      return { accountId, positions, orders };
    }));
    const clean = (rows: Awaited<ReturnType<typeof readSnapshot>>) => rows.every(row => (
      row.positions.every(position => position.netQuantity === 0)
      && row.orders.every(order => !isOpenOrderStatus(order.status))
    ));

    let first: Awaited<ReturnType<typeof readSnapshot>>;
    let second: Awaited<ReturnType<typeof readSnapshot>>;
    try {
      first = await readSnapshot();
      if (!clean(first)) return;
      second = await readSnapshot();
    } catch (reason) {
      options.onAudit?.([{
        at: clock(), leaderEventId: 'manual-trade-cut-release', kind: 'blocked',
        reason: `návrat ručně zavřeného followera čeká na broker snapshot: ${errorOf(reason).message}`,
      }]);
      return;
    }
    if (
      !clean(second)
      || generationAtStart !== safetyGeneration
      || observationAtStart !== tradeBoundaryObservationVersion
      || !gate.connected
      || currentStuckOperations().length > 0
      || hasBrokerUncertainOutbox()
    ) return;

    const signatures = new Map(cuts.map(cut => [cut.accountId, `${cut.at}:${cut.operationId ?? ''}`]));
    if ([...signatures].some(([accountId, signature]) => {
      const current = followerCuts.get(accountId);
      return !current || `${current.at}:${current.operationId ?? ''}` !== signature;
    })) return;

    const removedCuts = new Map<number, CopierFollowerCut>();
    const removedProvenance = new Map<number, CopierFollowerCutExecutionProvenance>();
    for (const cut of cuts) {
      removedCuts.set(cut.accountId, cut);
      const provenance = followerCutExecutionProvenance.get(cut.accountId);
      if (provenance) removedProvenance.set(cut.accountId, provenance);
      followerCuts.delete(cut.accountId);
      followerCutExecutionProvenance.delete(cut.accountId);
    }
    try {
      await persistRiskSafety();
    } catch (reason) {
      for (const [accountId, cut] of removedCuts) followerCuts.set(accountId, cut);
      for (const [accountId, provenance] of removedProvenance) {
        followerCutExecutionProvenance.set(accountId, provenance);
      }
      options.onAudit?.([{
        at: clock(), leaderEventId: 'manual-trade-cut-release', kind: 'blocked',
        reason: `návrat followera nelze durable potvrdit: ${errorOf(reason).message}`,
      }]);
      return;
    }

    for (const row of second) {
      positionsByAccount.set(row.accountId, new Map(
        row.positions.map(position => [position.symbol, position.netQuantity]),
      ));
      rememberLiveOrderSnapshot(row.accountId, row.orders);
      workingOrderAccounts.delete(row.accountId);
    }
    leaderPositions.clear();
    leaderFillAheadOfPosition.clear();
    leaderPositionSnapshotComplete = true;
    lastAuthoritativeReadAt = clock();
    lastBrokerPositionAt = lastAuthoritativeReadAt;
    options.onAudit?.(cuts.map(cut => ({
      at: lastAuthoritativeReadAt as number,
      leaderEventId: `manual-trade-cut-release:${cut.accountId}:${cut.operationId ?? cut.at}`,
      kind: 'recovered' as const,
      accountId: cut.accountId,
      reason: 'follower znovu zařazen po dvojitě potvrzeném flat/no-active celé skupiny',
    })));
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
          openPnlUsd: previous?.openPnlUsd ?? null,
          netLiq: previous?.netLiq ?? null,
          cashBalanceUsd: previous?.cashBalanceUsd ?? null,
          effectiveDailyLossCutUsd: previous?.effectiveDailyLossCutUsd ?? null,
          configuredDailyLossCutUsd: previous?.configuredDailyLossCutUsd ?? null,
          highWaterNetLiq: previous?.highWaterNetLiq ?? null,
          minNetLiq: previous?.minNetLiq ?? null,
          dailyLossAutoLiq: previous?.dailyLossAutoLiq ?? null,
          trailingMaxDrawdown: previous?.trailingMaxDrawdown ?? null,
          trailingMaxDrawdownLimit: previous?.trailingMaxDrawdownLimit ?? null,
          propLimitUsd: previous?.propLimitUsd ?? null,
          error: accountError?.message ?? 'broker risk snapshot chybí',
        });
        continue;
      }
      const previous = accountRisk.get(accountId);
      const normalized = normalizeAccountRiskSnapshot(raw);
      if (previous && sameTradovateSession(previous.verifiedAt, normalized.verifiedAt)) {
        normalized.effectiveDailyLossCutUsd = previous.effectiveDailyLossCutUsd ?? null;
        normalized.configuredDailyLossCutUsd = previous.configuredDailyLossCutUsd ?? null;
      }
      accountRisk.set(accountId, normalized);
    }
    const now = clock();
    const propReserveByAccount = new Map<number, ReturnType<typeof applyPropReserveCap>>();
    for (const follower of group.followers) {
      propReserveByAccount.set(follower.accountId, applyPropReserveCap(follower, now));
    }
    try {
      await persistRiskSafety();
    } catch {
      // Risk poll je read-only observability. Selhání jeho pomocné persistence
      // nesmí přepsat execution lastError. Ověřený limit se ale i tak
      // musí vyhodnotit; teprve durable cut má vlastní fail-closed commit.
    }
    if (!gate.armed) return;
    const preparedCuts: Array<{
      cut: CopierFollowerCut;
      follower: CopyGroupConfig['followers'][number];
    }> = [];
    for (const follower of group.followers) {
      const snapshot = accountRisk.get(follower.accountId);
      if (!snapshot
        || snapshot.error
        || now - snapshot.verifiedAt > ACCOUNT_RISK_STALE_MS
        || !sameTradovateSession(snapshot.verifiedAt, now)) continue;
      const reserveDecision = propReserveByAccount.get(follower.accountId) ?? null;
      const reserveBreach = reserveDecision?.breached === true;
      if (!reserveBreach && snapshot.realizedPnlUsd == null) continue;
      const prepared = prepareFollowerCut(
        follower.accountId,
        snapshot.realizedPnlUsd ?? 0,
        reserveBreach ? 'prop-reserve' : 'broker',
        now,
        reserveBreach,
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
      const background = scheduleBackgroundFollowerCutAction(
        prepared.cut,
        prepared.follower,
        liveSideEffects,
      );
      void background.catch(() => undefined);
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
      // A copied standalone SL/TP is still a resting conditional order when
      // only the leader's leg has filled. It must not suppress orphan recovery.
      // Unknown/sending writes and actual market exits remain in-flight.
      const standingProtection = !guardLiquidation && brokerOrder
        && brokerOrder.orderType !== 'Market'
        && (status === 'working' || status === 'pending');
      evidence.push({
        accountId,
        symbol: epoch.symbol,
        role: guardLiquidation ? 'guard-liquidation' : standingProtection ? 'protective' : 'copied-exit',
        status,
        ...(guardLiquidation ? { epochId: epoch.id } : {}),
        ...(copiedExit ? { leaderOrderId: entry.leaderOrderId } : {}),
        ...(entry.brokerOrderId ? { brokerOrderId: entry.brokerOrderId } : {}),
        updatedAt: brokerOrder?.updatedAt ?? entry.updatedAt,
      });
    }
    const protectiveIds = new Set<string>();
    for (const entry of [...currentRuntime().osoOutbox.values(), ...currentRuntime().bracketOutbox.values()]) {
      if (
        entry.request.accountId !== accountId
        || entry.request.symbol !== epoch.symbol
      ) continue;
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

  const leaderFlatProtectiveEntries = (
    epoch: LeaderFlatEpoch,
    accountId: number,
  ): Array<{
    leaderEntryOrderId: string;
    firstBrokerOrderId?: string;
    secondBrokerOrderId?: string;
    entryBrokerOrderId?: string;
  }> => {
    const leaderEntryOrderIds = new Set(epoch.leaderEntryOrderIds);
    const runtime = currentRuntime();
    return [
      ...[...runtime.bracketOutbox.values()].map(entry => ({
        accountId: entry.request.accountId,
        symbol: entry.request.symbol,
        leaderEntryOrderId: entry.leaderEntryOrderId,
        firstBrokerOrderId: entry.firstBrokerOrderId,
        secondBrokerOrderId: entry.secondBrokerOrderId,
      })),
      ...[...runtime.osoOutbox.values()].map(entry => ({
        accountId: entry.request.accountId,
        symbol: entry.request.symbol,
        leaderEntryOrderId: entry.leaderEntryOrderId,
        firstBrokerOrderId: entry.firstBrokerOrderId,
        secondBrokerOrderId: entry.secondBrokerOrderId,
        entryBrokerOrderId: entry.entryBrokerOrderId,
      })),
    ].filter(entry => (
      entry.accountId === accountId
      && entry.symbol === epoch.symbol
      && leaderEntryOrderIds.has(entry.leaderEntryOrderId)
    ));
  };

  const leaderFlatActiveOrphanLeg = (
    orders: readonly BrokerOrder[],
    ownedLegIds: ReadonlySet<string>,
    osoParentByLeg: ReadonlyMap<string, string>,
  ): BrokerOrder | undefined => {
    const byId = new Map(orders.map(order => [order.brokerOrderId, order]));
    return orders.find(order => {
      if (!ownedLegIds.has(order.brokerOrderId) || !isOpenOrderStatus(order.status)) return false;
      if (order.status !== 'pending') return true;
      const parentId = osoParentByLeg.get(order.brokerOrderId);
      const parent = parentId ? byId.get(parentId) : undefined;
      // Stejná jediná bezpečná výjimka jako ve sweepu: Suspended/pending dítě
      // dosud nevyplněného working OSO vstupu není osiřelá ochranná noha.
      return !(parent && isOpenOrderStatus(parent.status) && parent.filledQuantity === 0);
    });
  };

  async function verifyLeaderFlatEpoch(
    token: LeaderFlatGuardToken,
    expectedSafetyGeneration: number,
    allowWrites: boolean,
  ): Promise<void> {
    if (stopped) return;
    const storedEpoch = currentRuntime().state.safety.leaderExposureEpochs
      ?.find(item => item.id === token.epochId) ?? null;
    const epoch = storedEpoch
      && storedEpoch.groupId === group.id
      && storedEpoch.leaderAccountId === group.leaderAccountId
      ? storedEpoch
      : null;
    if (!isLeaderFlatGuardTokenCurrent(epoch, token) || !gate.connected) return;
    if (safetyGeneration !== expectedSafetyGeneration) {
      await rescheduleLeaderFlatEpochAfterGenerationChange(epoch, token, allowWrites);
      return;
    }

    const accountIds = [...new Set([
      epoch.leaderAccountId,
      ...epoch.followers.map(follower => follower.accountId),
    ])];
    const rows = await Promise.all(accountIds.map(async accountId => {
      const maxSnapshotAttempts = 3;
      const retryWait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
      for (let attempt = 1; attempt <= maxSnapshotAttempts; attempt += 1) {
        try {
          // Dvě position čtení svírají order graph. Samotná kombinace
          // filled OSO parent + flat už není důkaz race: může jít o skutečně
          // osiřelou sesterskou nohu po exitu. Nekonzistence je až změna netu
          // mezi čteními nebo parent fill novější než první position snapshot.
          const positionsBefore = await withLeaderEpochDeadline(
            `leader-flat position-before účet ${accountId}`,
            broker.listPositions(accountId),
          );
          const positionsBeforeObservedAt = clock();
          const orders = await withLeaderEpochDeadline(
            `leader-flat orders účet ${accountId}`,
            broker.listOrders(accountId),
          );
          const positions = await withLeaderEpochDeadline(
            `leader-flat position-after účet ${accountId}`,
            broker.listPositions(accountId),
          );
          if (accountId !== epoch.leaderAccountId) {
            const netBefore = positionsBefore
              .filter(position => position.symbol === epoch.symbol)
              .reduce((sum, position) => sum + position.netQuantity, 0);
            const netAfter = positions
              .filter(position => position.symbol === epoch.symbol)
              .reduce((sum, position) => sum + position.netQuantity, 0);
            const filledParent = [...currentRuntime().osoOutbox.values()]
              .filter(entry => (
                entry.request.accountId === accountId
                && entry.request.symbol === epoch.symbol
                && entry.entryBrokerOrderId
              ))
              .filter(entry => [entry.firstBrokerOrderId, entry.secondBrokerOrderId].some(id => (
                id != null && orders.some(order => (
                  order.brokerOrderId === id && isOpenOrderStatus(order.status)
                ))
              )))
              .map(entry => orders.find(order => order.brokerOrderId === entry.entryBrokerOrderId))
              .find(order => order != null && order.filledQuantity > 0);
            const positionsChanged = netBefore !== netAfter;
            const parentFilledAfterFirstPositionRead = filledParent?.updatedAt != null
              && filledParent.updatedAt > positionsBeforeObservedAt;
            if (positionsChanged || parentFilledAfterFirstPositionRead) {
              const inconsistency = positionsChanged
                ? `pozice ${epoch.symbol} se mezi čteními změnila (${netBefore} -> ${netAfter})`
                : `OSO parent ${filledParent?.brokerOrderId ?? 'unknown'} má fill novější než první čtení pozice ${epoch.symbol}`;
              if (!allowWrites) {
                return {
                  accountId,
                  ok: false as const,
                  inconsistentSnapshot: true as const,
                  error: `read-only watchdog nalezl nekonzistentní broker snapshot (${inconsistency})`,
                };
              }
              if (attempt < maxSnapshotAttempts) {
                // Pevně omezený read-only backoff dává broker snapshotu čas
                // doběhnout; žádný broker write se nikdy neopakuje.
                await retryWait(Math.min(25 * attempt, 50));
                continue;
              }
              return {
                accountId,
                ok: false as const,
                inconsistentSnapshot: true as const,
                error: `nekonzistentní broker snapshot po ${maxSnapshotAttempts} read-only pokusech (${inconsistency})`,
              };
            }
          }
          return { accountId, ok: true as const, positions, orders };
        } catch (reason) {
          return { accountId, ok: false as const, error: errorOf(reason).message };
        }
      }
      return { accountId, ok: false as const, error: 'leader-flat snapshot nemá výsledek' };
    }));

    const current = leaderExposureEpoch(epoch.symbol);
    if (!isLeaderFlatGuardTokenCurrent(current, token) || !gate.connected) return;
    if (safetyGeneration !== expectedSafetyGeneration) {
      await rescheduleLeaderFlatEpochAfterGenerationChange(current, token, allowWrites);
      return;
    }
    const leaderRow = rows.find(row => row.accountId === epoch.leaderAccountId);
    if (!leaderRow?.ok) {
      const detail = leaderRow && !leaderRow.ok ? leaderRow.error : 'leader snapshot chybí';
      await persistLeaderExposureEpoch({
        ...current,
        generation: current.generation + 1,
        phase: 'blocked',
        terminalAt: clock(),
        terminalReason: `leader-flat read selhal: ${detail}`,
      });
      leaderFlatGuardGenerationRetries.delete(epoch.id);
      failClosed(new Error(
        `leader-flat-read-failed: guard nedokázal ověřit, zda leader zůstal flat (${detail})`,
      ), { autoClose: false, episodeId: epoch.id, recordWhenDisarmed: true });
      return;
    }
    const authoritativeLeaderNet = leaderRow.positions
      .filter(position => position.symbol === epoch.symbol)
      .reduce((sum, position) => sum + position.netQuantity, 0);
    if (authoritativeLeaderNet !== 0) {
      await persistLeaderExposureEpoch({
        ...current,
        generation: current.generation + 1,
        phase: 'blocked',
        terminalAt: clock(),
        terminalReason: `leader už není flat (${epoch.symbol} ${authoritativeLeaderNet})`,
      });
      leaderFlatGuardGenerationRetries.delete(epoch.id);
      failClosed(new Error(
        `Copier fail-closed: leader-flat guard zjistil, že leader není flat `
        + `(${epoch.symbol} ${authoritativeLeaderNet}); nový vstup nelze bezpečně přiřadit staré epizodě`,
      ), { autoClose: false, episodeId: epoch.id, recordWhenDisarmed: true });
      return;
    }
    // Cache aktualizujeme až po ověření tokenu; pozdní snapshot staré epochy
    // ani ne-flat leader nesmí přepsat novější obchod nebo jeho denní count.
    for (const row of rows) {
      if (!row.ok) continue;
      // listPositions is a complete account snapshot; an omitted flat symbol
      // must remove the previous exposure from the local display/safety cache.
      const map = new Map<string, number>();
      for (const position of row.positions) map.set(position.symbol, position.netQuantity);
      positionsByAccount.set(row.accountId, map);
      if (row.accountId === epoch.leaderAccountId) {
        const leaderNet = row.positions
          .filter(position => position.symbol === epoch.symbol)
          .reduce((sum, position) => sum + position.netQuantity, 0);
        rememberLeaderPosition(epoch.symbol, leaderNet);
      }
    }

    // Position=0 může dorazit za DISARM dřív, než venue zruší sesterskou
    // OCO/OSO nohu. Guard smí uklidit jen broker ID doložená durable copier
    // outboxem pro přesný účet+symbol; ruční příkaz ani jiný symbol nečte jako
    // oprávnění k cancelu. Po write následuje pouze autoritativní read kontrola.
    for (const row of allowWrites ? rows : []) {
      if (!row.ok || row.accountId === epoch.leaderAccountId) continue;
      const net = row.positions
        .filter(position => position.symbol === epoch.symbol)
        .reduce((sum, position) => sum + position.netQuantity, 0);
      if (net !== 0) continue;
      const protectiveEntries = leaderFlatProtectiveEntries(epoch, row.accountId);
      const ownedLegIds = new Set(protectiveEntries
        .flatMap(entry => [entry.firstBrokerOrderId, entry.secondBrokerOrderId])
        .filter((id): id is string => Boolean(id)));
      const osoParentByLeg = new Map<string, string>();
      for (const entry of protectiveEntries) {
        if (!entry.entryBrokerOrderId) continue;
        for (const id of [entry.firstBrokerOrderId, entry.secondBrokerOrderId]) {
          if (id) osoParentByLeg.set(id, entry.entryBrokerOrderId);
        }
      }
      if (!leaderFlatActiveOrphanLeg(row.orders, ownedLegIds, osoParentByLeg)) continue;
      await sweepFollowerProtectiveLegs(
        row.accountId,
        epoch.symbol,
        clock(),
        { authoritativeOrders: row.orders },
      );
      let remaining: BrokerOrder[];
      try {
        remaining = await withLeaderEpochDeadline(
          `leader-flat post-sweep orders účet ${row.accountId}`,
          broker.listOrders(row.accountId),
        );
      } catch (reason) {
        failClosed(new Error(
          `leader-flat-read-failed: guard nedokázal read-only ověřit úklid ochranné nohy účtu ${row.accountId}: ${errorOf(reason).message}`,
        ), { autoClose: false, episodeId: epoch.id, recordWhenDisarmed: true });
        return;
      }
      const orphan = leaderFlatActiveOrphanLeg(remaining, ownedLegIds, osoParentByLeg);
      if (orphan) {
        failClosed(new Error(
          `Leader-flat guard: doložená osiřelá ochranná noha ${orphan.brokerOrderId} zůstala aktivní nad flat followerem ${row.accountId}`,
        ), { autoClose: false, episodeId: epoch.id, recordWhenDisarmed: true });
        return;
      }
    }

    const evaluationRows = allowWrites ? rows : rows.map(row => {
      if (!row.ok || row.accountId === epoch.leaderAccountId) return row;
      const net = row.positions
        .filter(position => position.symbol === epoch.symbol)
        .reduce((sum, position) => sum + position.netQuantity, 0);
      if (net !== 0) return row;
      const protectiveEntries = leaderFlatProtectiveEntries(epoch, row.accountId);
      const ownedLegIds = new Set(protectiveEntries
        .flatMap(entry => [entry.firstBrokerOrderId, entry.secondBrokerOrderId])
        .filter((id): id is string => Boolean(id)));
      const osoParentByLeg = new Map<string, string>();
      for (const entry of protectiveEntries) {
        if (!entry.entryBrokerOrderId) continue;
        for (const id of [entry.firstBrokerOrderId, entry.secondBrokerOrderId]) {
          if (id) osoParentByLeg.set(id, entry.entryBrokerOrderId);
        }
      }
      const orphan = leaderFlatActiveOrphanLeg(row.orders, ownedLegIds, osoParentByLeg);
      return orphan
        ? {
          accountId: row.accountId,
          ok: false as const,
          error: `read-only watchdog nalezl doloženou osiřelou ochrannou nohu ${orphan.brokerOrderId}; epocha je zablokovaná bez broker write`,
        }
        : row;
    });

    if (safetyGeneration !== expectedSafetyGeneration) {
      await rescheduleLeaderFlatEpochAfterGenerationChange(current, token, allowWrites);
      return;
    }

    const batchAccounts: LeaderFlatAccountBatchSnapshot[] = evaluationRows.map(row => row.ok
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
      ) && !gate.killSwitch && allowWrites,
      exitSettlementGraceMs: leaderFlatExitSettlementGraceMs,
      inflightRetryMs: leaderFlatInflightRetryMs,
    });
    await persistLeaderExposureEpoch(evaluation.epoch);

    if (evaluation.kind === 'resolved') {
      leaderFlatGuardGenerationRetries.delete(epoch.id);
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
      updateDisarmOutcome(disarmAtForEpisode(epoch.id), 'flat');
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
        ), { autoClose: false, episodeId: epoch.id });
      }
      scheduleLeaderFlatEpochVerification(
        evaluation.epoch,
        { epochId: evaluation.epoch.id, generation: evaluation.epoch.generation },
        safetyGeneration,
        allowWrites,
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
    const snapshotErrors = evaluationRows
      .filter((row): row is Extract<typeof evaluationRows[number], { ok: false }> => !row.ok)
      .map(row => `${row.accountId}: ${row.error}`);
    failClosed(new Error(
      `Copier fail-closed: leader je autoritativně flat, follower stav se neshoduje (${evaluation.reason}${snapshotErrors.length > 0 ? `; ${snapshotErrors.join('; ')}` : ''})`,
    ), { autoClose: false, episodeId: epoch.id, recordWhenDisarmed: true });
    const leaderFlatDisarmAt = disarmAtForEpisode(epoch.id);

    if (evaluation.kind !== 'close-targets') {
      leaderFlatGuardGenerationRetries.delete(epoch.id);
      return;
    }
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
      const targetAccountIds = [...new Set(evaluation.targets.map(target => target.accountId))];
      const protectedAccountIds = await settleFollowerCutBackgroundAccounts(targetAccountIds);
      const writableTargets = evaluation.targets.filter(target => (
        !protectedAccountIds.has(target.accountId)
      ));
      if (writableTargets.length > 0) {
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
            store: durableStore,
            groupId: group.id,
            targets: writableTargets,
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
      }
      if (protectedAccountIds.size > 0) {
        const processedAccounts = closeResult?.accounts ?? [];
        const processedAccountIds = new Set(processedAccounts.map(account => account.accountId));
        const protectedAccounts = [...protectedAccountIds]
          .filter(accountId => !processedAccountIds.has(accountId))
          .map(accountId => ({
            accountId,
            ok: false,
            canceledOrders: 0,
            submittedClosures: 0,
            error: `Leader-flat ${epoch.id}: účet má nejasný broker write z background lane; nový write byl bezpečně vynechán a je nutná read-only reconciliation`,
            remainingPositions: 0,
            workingOrders: 0,
          }));
        const accounts = [...processedAccounts, ...protectedAccounts];
        closeResult = {
          operationId: `leader-flat:${epoch.id}`,
          accountIds: targetAccountIds,
          canceledOrders: closeResult?.canceledOrders ?? 0,
          submittedClosures: closeResult?.submittedClosures ?? 0,
          flat: false,
          remainingPositionAccounts: [...new Set([
            ...(closeResult?.remainingPositionAccounts ?? []),
            ...protectedAccountIds,
          ])],
          workingOrderAccounts: closeResult?.workingOrderAccounts ?? [],
          accounts,
          failedAccounts: accounts.filter(account => !account.ok).map(account => account.accountId),
        };
      }
    } catch (reason) {
      failClosed(new Error(
        `Leader-flat cílené zavření selhalo: ${errorOf(reason).message}`,
      ), { autoClose: false, episodeId: epoch.id, recordWhenDisarmed: true });
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
      const failedAccounts = result?.failedAccounts ?? [];
      failClosed(new Error(
        `Leader-flat cílené zavření není autoritativně potvrzené${failedAccounts.length > 0
          ? `; failedAccounts=${failedAccounts.join(',')}`
          : ''}`,
      ), {
        autoClose: false,
        episodeId: epoch.id,
        recordWhenDisarmed: true,
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
    leaderFlatGuardGenerationRetries.delete(epoch.id);
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
  const copierFootprintSymbols = (accountId: number): Set<string> => {
    const symbols = new Set<string>();
    const runtime = currentRuntime();
    if (group.followers.some(follower => (
      follower.accountId === accountId && follower.enabled !== false
    ))) {
      for (const [symbol, quantity] of positionsByAccount.get(group.leaderAccountId!) ?? []) {
        if (quantity !== 0) symbols.add(symbol);
      }
    }
    for (const epoch of runtime.state.safety.leaderExposureEpochs ?? []) {
      if (
        epoch.groupId === group.id
        && epoch.leaderAccountId === group.leaderAccountId
        && unfinishedLeaderFlatPhase(epoch.phase)
        && epoch.followers.some(follower => follower.accountId === accountId)
      ) symbols.add(epoch.symbol);
    }
    for (const entry of runtime.outbox.values()) {
      if (
        entry.request.accountId === accountId
        && entry.operationKind !== 'liquidate-position'
        && (
          entry.status === 'planned'
          || entry.status === 'sending'
          || entry.status === 'unknown'
          || entry.status === 'acknowledged'
        )
      ) symbols.add(entry.request.symbol);
    }
    for (const entry of [...runtime.bracketOutbox.values(), ...runtime.osoOutbox.values()]) {
      if (
        entry.request.accountId === accountId
        && (
          entry.status === 'planned'
          || entry.status === 'sending'
          || entry.status === 'unknown'
          || entry.status === 'acknowledged'
        )
      ) symbols.add(entry.request.symbol);
    }
    for (const pending of currentRuntimePendingExposure.values()) {
      if (pending.accountId === accountId) symbols.add(pending.symbol);
    }
    const cutProvenance = followerCutExecutionProvenance.get(accountId)?.copiedExposureBySymbol;
    for (const symbol of Object.keys(cutProvenance ?? {})) symbols.add(symbol);
    return symbols;
  };

  const reportDisabledFollowerExposure = (context: string): void => {
    for (const follower of group.followers) {
      if (follower.enabled !== false) continue;
      const exposure = [...(positionsByAccount.get(follower.accountId) ?? [])]
        .filter(([, quantity]) => quantity !== 0);
      if (exposure.length === 0) continue;
      const detail = exposure.map(([symbol, quantity]) => `${symbol}=${quantity}`).join(', ');
      const error = new Error(
        `${context}: vypnutý follower ${follower.accountId} drží expozici ${detail}; pouze audit, žádný broker write`,
      );
      options.onAudit?.([{
        at: clock(), leaderEventId: `disabled-follower-exposure:${context}:${follower.accountId}`,
        accountId: follower.accountId, kind: 'blocked', reason: error.message,
      }]);
      options.onError?.(error);
    }
  };

  const autoFlattenCopies = async (
    trigger: CopierAutoClose['trigger'],
    seed: number,
  ): Promise<{ flat: boolean; acted: boolean }> => {
    const scope = group.safety?.armExpiryFlatten ?? DEFAULT_COPY_GROUP_SAFETY.armExpiryFlatten;
    if (scope === 'off' || group.leaderAccountId == null || gate.killSwitch) {
      return { flat: false, acted: false };
    }
    reportDisabledFollowerExposure(`auto-close ${trigger}`);
    const participatingFollowerIds = group.followers
      .filter(follower => follower.enabled !== false)
      .map(follower => follower.accountId);
    const accountIds = scope === 'group'
      ? [group.leaderAccountId, ...participatingFollowerIds]
      : participatingFollowerIds;
    const targets = accountIds.flatMap(accountId => (
      [...copierFootprintSymbols(accountId)].map(symbol => ({ accountId, symbol }))
    ));
    const targetSymbolsByAccount = new Map<number, Set<string>>();
    for (const target of targets) {
      const symbols = targetSymbolsByAccount.get(target.accountId) ?? new Set<string>();
      symbols.add(target.symbol);
      targetSymbolsByAccount.set(target.accountId, symbols);
    }
    const participatingFollowerIdSet = new Set(participatingFollowerIds);
    const unscopedExposure = accountIds.flatMap(accountId => {
      if (!participatingFollowerIdSet.has(accountId) || !targetSymbolsByAccount.has(accountId)) return [];
      const scopedSymbols = targetSymbolsByAccount.get(accountId)!;
      return [...(positionsByAccount.get(accountId) ?? [])]
        .filter(([symbol, quantity]) => quantity !== 0 && !scopedSymbols.has(symbol))
        .map(([symbol, quantity]) => ({ accountId, symbol, quantity }));
    });
    const reportUnscopedExposure = () => {
      const accountIdsWithUnscopedExposure = [...new Set(
        unscopedExposure.map(exposure => exposure.accountId),
      )];
      for (const accountId of accountIdsWithUnscopedExposure) {
        const detail = unscopedExposure
          .filter(exposure => exposure.accountId === accountId)
          .map(exposure => `${exposure.symbol}=${exposure.quantity}`)
          .join(', ');
        const error = new Error(
          `Auto-close ${trigger}: follower ${accountId} má expozici mimo doloženou copier stopu (${detail}); výsledek zůstává neznámý, žádný broker write mimo stopu`,
        );
        options.onAudit?.([{
          at: clock(), leaderEventId: `auto-close-unscoped:${trigger}:${seed}:${accountId}`,
          accountId, kind: 'blocked', reason: error.message,
        }]);
        options.onError?.(error);
      }
    };
    const hasExposure = accountIds.some(accountId =>
      [...(positionsByAccount.get(accountId) ?? [])].some(([symbol, quantity]) => (
        quantity !== 0
        && (
          !targetSymbolsByAccount.has(accountId)
          || targetSymbolsByAccount.get(accountId)?.has(symbol) === true
        )
      )));
    // Nulová lokální expozice nevyžaduje broker side effect; následující
    // reconciliation je právě autoritativní důkaz, že stav zůstal flat.
    if (!hasExposure) {
      if (unscopedExposure.length > 0) {
        reportUnscopedExposure();
        return { flat: false, acted: false };
      }
      return { flat: true, acted: false };
    }
    if (autoCloseEpisodeAttempts >= AUTO_CLOSE_MAX_ATTEMPTS_PER_EPISODE) {
      options.onAudit?.([{
        at: clock(), leaderEventId: `auto-close-limit:${trigger}:${seed}`, kind: 'blocked',
        reason: `auto-close vyčerpal ${AUTO_CLOSE_MAX_ATTEMPTS_PER_EPISODE} pokusů v epizodě — nutný ruční zásah`,
      }]);
      return { flat: false, acted: false };
    }
    autoCloseEpisodeAttempts += 1;
    const operationId = `auto-close:${trigger}:${seed}`;
    const at = clock();
    try {
      const flattenOptions = targets.length > 0 ? {
        targets,
        cleanupScope: 'target-symbol-or-account' as const,
      } : {};
      const result = processor.recoveryStatus().state === 'ready'
        ? await flatten(accountIds, operationId, flattenOptions)
        : await emergencyFlatten(accountIds, operationId, flattenOptions);
      const acted = result.canceledOrders > 0 || result.submittedClosures > 0;
      const flat = result.flat && unscopedExposure.length === 0;
      if (unscopedExposure.length > 0) reportUnscopedExposure();
      lastAutoClose = {
        at, operationId, trigger, scope, accountIds, flat,
        canceledOrders: result.canceledOrders, submittedClosures: result.submittedClosures,
        ...(!flat ? {
          error: `Auto-close není autoritativně potvrzený; failedAccounts=${result.failedAccounts.join(',') || 'neznámé'}${result.accounts
            .filter(account => !account.ok && account.error)
            .map(account => `; ${account.accountId}: ${account.error}`)
            .join('')}`,
        } : {}),
      };
      options.onAudit?.([{
        at: clock(), leaderEventId: operationId, kind: 'blocked',
        reason: `auto-close (${trigger}, ${scope}): zrušeno ${result.canceledOrders} příkazů, zavřeno ${result.submittedClosures} pozic`,
      }]);
      if (flat) {
        autoCloseEpisodeAttempts = 0;
        await syncLiveCopyExposureFlag('clear');
        if (acted) {
          await resolveRejectedExecutions({
            accountIds: group.followers
              .map(follower => follower.accountId)
              .filter(accountId => accountIds.includes(accountId)),
            kind: 'auto-closed',
            at: clock(),
            detail: `auto-close (${trigger}) autoritativně potvrdil followera flat`,
          });
        }
      }
      return { flat, acted };
    } catch (error) {
      lastAutoClose = {
        at, operationId, trigger, scope, accountIds, flat: false,
        canceledOrders: 0, submittedClosures: 0, error: errorOf(error).message,
      };
      failClosed(new Error(`Auto-close kopií (${trigger}) selhal: ${errorOf(error).message}`));
      return { flat: false, acted: false };
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
   * Heartbeat watchdog pro durable epochu, jejíž in-memory timer se ztratil
   * mimo čistý restart/reconnect tok. Pouze obnoví read-only verifikaci;
   * sám nikdy neautorizuje účet ani symbol a nikdy neposílá broker write.
   */
  const ensureLeaderFlatEpochWatchdogs = (): void => {
    if (!gate.connected || gate.killSwitch || stopped) return;
    for (const epoch of currentRuntime().state.safety.leaderExposureEpochs ?? []) {
      if (
        epoch.groupId !== group.id
        || epoch.leaderAccountId !== group.leaderAccountId
        || !(
          epoch.phase === 'grace'
          || epoch.phase === 'waiting-inflight'
          || epoch.phase === 'closing'
        )
        || leaderFlatGuardTimers.has(epoch.id)
      ) continue;
      options.onAudit?.([{
        at: clock(), leaderEventId: `leader-flat-watchdog:${epoch.id}`, kind: 'blocked',
        reason: `leader-flat watchdog obnovil osiřelou nedokončenou epochu (${epoch.phase})`,
      }]);
      scheduleLeaderFlatEpochVerification(epoch, {
        epochId: epoch.id,
        generation: epoch.generation,
      }, safetyGeneration, false);
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
    // `armExpiryFlatten: off` vypíná jen automatickou broker akci, nikoli
    // povinnou read-only kontrolu po reconnectu/resyncu.
    if (gate.killSwitch || group.leaderAccountId == null) {
      pendingConnectionRecovery = false;
      pendingReadOnlyConnectionRecovery = false;
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
          const disabledFollowerIds = new Set(group.followers
            .filter(follower => follower.enabled === false)
            .map(follower => follower.accountId));
          const participatingDivergence = candidate.divergentAccounts
            .filter(accountId => !disabledFollowerIds.has(accountId));
          const participatingWorking = candidate.workingOrderAccounts
            .filter(accountId => !disabledFollowerIds.has(accountId));
          // Kompletní a generation-stable divergence je stále platný
          // snapshot pro stávající detect-only / leader-flat guard větve.
          // Nesmí ale shodit pending ani provést clean-recovery úklid.
          if (
            missingOwnership.length === 0
            && candidate.generationUnchanged
            && participatingWorking.length === 0
            && (
              participatingDivergence.length > 0
              || candidate.divergentAccounts.some(accountId => disabledFollowerIds.has(accountId))
              || candidate.workingOrderAccounts.some(accountId => disabledFollowerIds.has(accountId))
            )
          ) {
            reconciliation = candidate;
            break;
          }
          connectionRecoveryMissingOwnership = missingOwnership;
          const details = [
            missingOwnership.length > 0
              ? `chybí lineage participants ${missingOwnership.map(item => `${item.accountId} (epocha ${item.epochId})`).join(', ')}`
              : '',
            participatingDivergence.length > 0
              ? `divergence=${participatingDivergence.join(',')}`
              : '',
            participatingWorking.length > 0
              ? `working=${participatingWorking.join(',')}`
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
      pendingReadOnlyConnectionRecovery = false;
      connectionRecoveryMissingOwnership = [];
    } else {
      pendingConnectionRecovery = true;
    }
    const guardedSymbols = await resumeLeaderFlatEpochsAfterSnapshot();
    reportDisabledFollowerExposure('connection-recovery');
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
    for (const follower of group.followers.filter(item => item.enabled !== false)) {
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
    const participatingFollowerIds = new Set(group.followers
      .filter(follower => follower.enabled !== false)
      .map(follower => follower.accountId));
    const participatingDivergence = reconciliation.divergentAccounts
      .filter(accountId => participatingFollowerIds.has(accountId));
    if (leaderOpen && participatingDivergence.length === 0) {
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
    const autoClose = await autoFlattenCopies('reconnect', clock());
    if (lastDisarm?.trigger === 'transport') {
      updateDisarmOutcome(
        lastDisarm.at,
        autoClose.flat ? successfulAutoCloseOutcome(lastDisarm.at, autoClose.acted) : 'unknown',
      );
    }
  };

  const readOnlyRecoveryBlocker = (): string | null => {
    if (currentStuckOperations().length > 0 || hasBrokerUncertainOutbox()) {
      return 'nevyřešený durable outbox';
    }
    if ([...followerCuts.values()].some(cut => cut.closed === null)) {
      return 'nedokončený follower cut';
    }
    if (currentRuntime().state.safety.liveCopyOpenSince != null) {
      return 'durable stopa otevřených kopií';
    }
    const unfinishedEpoch = currentRuntime().state.safety.leaderExposureEpochs?.some(epoch => (
      epoch.groupId === group.id
      && epoch.leaderAccountId === group.leaderAccountId
      && unfinishedLeaderFlatPhase(epoch.phase)
    )) === true;
    if (unfinishedEpoch) return 'nedokončená leader exposure epocha';
    if (
      pendingBracketTimers.size > 0
      || pendingOsoTimers.size > 0
      || pendingOsoEvents.size > 0
      || pendingOsoFlushes.size > 0
      || pendingFollowerTransitions.size > 0
      || pendingFollowerMagnitudeChecks.size > 0
      || sweepingProtectiveLegs.size > 0
      || autoCloseInFlight
    ) return 'rozpracovaný order lifecycle';
    return null;
  };

  const armPreparationConfiguration = () => JSON.stringify({
    id: group.id, leaderAccountId: group.leaderAccountId,
    followers: group.followers, safety: group.safety,
    ineligibleAccounts: [...currentIneligibleAccounts().keys()].sort((a, b) => a - b),
  });
  const armPreparationBlocker = (): { blockedBy: CopierArmPreparationBlocker; reason: string } | null => {
    if (stopped || shutdownRequested) return { blockedBy: 'shutdown', reason: 'Worker se ukončuje' };
    if (gate.killSwitch) return { blockedBy: 'kill-switch', reason: 'Kill switch je aktivní' };
    if (startupGroupRepair || startupMissingLeaderRoute) {
      return { blockedBy: 'configuration', reason: 'Nejdřív oprav uloženou skupinu' };
    }
    if (processor.recoveryStatus().state !== 'ready') {
      return { blockedBy: 'starting', reason: 'Durable stav workeru není připravený' };
    }
    if (armPreparationIncidentRequiresRecovery) {
      return { blockedBy: 'incident', reason: 'Po incidentu je potřeba ruční Kontrola pozic' };
    }
    if (lastError) {
      return {
        blockedBy: 'incident',
        reason: `Nejdřív vyřeš incident a proveď Kontrolu pozic: ${lastError.message}`,
      };
    }
    if (pendingConnectionRecovery || currentRuntime().state.safety.managementOnly) {
      return { blockedBy: 'recovery', reason: 'Nejdřív dokonči obnovu otevřených kopií' };
    }
    const recoveryBlocker = readOnlyRecoveryBlocker();
    return recoveryBlocker ? { blockedBy: 'recovery', reason: recoveryBlocker } : null;
  };
  const armPreparationRoutes = (accountIds: readonly number[]): string | null => {
    try {
      const epochs = accountIds.map(accountId => [accountId,
        broker.routeEpoch ? broker.routeEpoch(accountId) : connectionSyncGeneration]);
      return epochs.some(([, epoch]) => epoch == null) ? null : JSON.stringify(epochs);
    } catch { return null; }
  };
  const hasFreshArmPreparation = (checkRisk = true): boolean => {
    const receipt = armPreparationReceipt;
    const now = clock();
    if (!receipt || !gate.connected || gate.armed || armPreparationBlocker()
      || receipt.generation !== safetyGeneration
      || receipt.observation !== brokerObservationVersion
      || receipt.connection !== connectionSyncGeneration
      || receipt.routes == null || receipt.routes !== armPreparationRoutes(receipt.accountIds)
      || receipt.configuration !== armPreparationConfiguration()
      || [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)]
        .some(accountId => accountId == null || (!currentIneligibleAccounts(now).has(accountId)
          && !receipt.accountIds.includes(accountId)))
      || now < receipt.verifiedAt || now - receipt.verifiedAt > ARM_PREPARATION_MAX_AGE_MS
      || !sameTradovateSession(receipt.verifiedAt, now)
      || !positionCheckComplete || source.needsReconciliation()) return false;
    if (checkRisk) {
      try { assertVerifiedArmRisk(now); } catch { return false; }
    }
    return true;
  };
  const recordArmPreparation = (accountIds: number[], routes: string | null) => {
    armPreparationReceipt = {
      generation: safetyGeneration, observation: brokerObservationVersion,
      connection: connectionSyncGeneration, configuration: armPreparationConfiguration(),
      verifiedAt: clock(), accountIds, routes,
    };
    armPreparationError = null;
  };
  const withArmReadDeadline = <T>(read: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Předběžné ověření brokera překročilo 10 s')), 10_000);
    read.then(value => { clearTimeout(timer); resolve(value); }, reason => { clearTimeout(timer); reject(reason); });
  });

  // Unlike connection recovery, a participation toggle does not require
  // every OTHER follower's previously opened copy to have finished. The
  // leader and the selected follower must be flat; unfinished operations
  // anywhere still fence a configuration change.
  const participationLifecyclePending = (): boolean => (
    pendingBracketTimers.size > 0
    || pendingOsoTimers.size > 0
    || pendingOsoEvents.size > 0
    || pendingOsoFlushes.size > 0
    || pendingFollowerTransitions.size > 0
    || pendingFollowerMagnitudeChecks.size > 0
    || sweepingProtectiveLegs.size > 0
    || autoCloseInFlight
    || [...followerCuts.values()].some(cut => cut.closed === null)
  );
  const participationLifecyclePendingFor = (accountIds: readonly number[]): boolean => {
    const scoped = new Set(accountIds);
    const runtime = currentRuntime();
    const pendingStatus = (status: string) => (
      status === 'planned' || status === 'sending' || status === 'unknown'
    );
    return pendingTradeEventsFor(accountIds)
      || pendingBracketTimers.size > 0
      || pendingOsoTimers.size > 0
      || pendingOsoEvents.size > 0
      || pendingOsoFlushes.size > 0
      || [...pendingFollowerTransitions.values()].some(item => scoped.has(item.accountId))
      || [...pendingFollowerMagnitudeChecks.keys()].some(key => accountIds.some(id => key.startsWith(`${id}:`)))
      || [...currentRuntimePendingExposure.values()].some(item => scoped.has(item.accountId))
      || [...runtime.outbox.values()].some(entry => scoped.has(entry.request.accountId) && pendingStatus(entry.status))
      || [...runtime.bracketOutbox.values()].some(entry => scoped.has(entry.request.accountId) && pendingStatus(entry.status))
      || [...runtime.osoOutbox.values()].some(entry => scoped.has(entry.request.accountId) && pendingStatus(entry.status))
      || [...runtime.cancelOutbox.values()].some(entry => scoped.has(entry.accountId) && pendingStatus(entry.status))
      || followerCutBackgroundAccounts.has(accountIds.find(id => id !== group.leaderAccountId) ?? -1)
      || sweepingProtectiveLegs.size > 0
      || autoCloseInFlight;
  };

  /**
   * Po obyčejném reconnectu DISARMED runtime obnoví pre-ARM snapshot bez
   * obchodní akce. Nestačí jen shoda pozic: všechny zapojené účty musí být
   * autoritativně flat a bez working orders a během čtení nesmí přijít nový
   * broker event. Jinak reconciliation zůstává povinná.
   */
  const readFlatPreflightSnapshot = async (
    missingOptionalAccountIds: readonly number[],
  ): Promise<{ clean: boolean; reason: string | null }> => {
    if (group.leaderAccountId == null) throw new Error('Copy group nemá leader účet');
    const generationAtStart = safetyGeneration;
    const observationAtStart = brokerObservationVersion;
    const configurationAtStart = armPreparationConfiguration();
    const connectionAtStart = connectionSyncGeneration;
    const accountIds = [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)];
    const followerIds = new Set(group.followers.map(follower => follower.accountId));
    const explicitOptional = new Set(missingOptionalAccountIds);
    for (const accountId of explicitOptional) {
      if (!Number.isSafeInteger(accountId) || !followerIds.has(accountId)) {
        throw new Error(`Read-only preflight dostal neplatný optional follower účet ${accountId}`);
      }
    }
    const ineligible = currentIneligibleAccounts();
    const optionalFollowers = new Set(group.followers
      .filter(follower => ineligible.has(follower.accountId))
      .map(follower => follower.accountId));
    const routedAccountIds = accountIds.filter(accountId => !explicitOptional.has(accountId));
    const capabilities = await withArmReadDeadline(broker.listAccountCapabilities(routedAccountIds));
    const capabilityByAccount = new Map(capabilities.map(capability => [capability.accountId, capability]));
    const missingRequired = routedAccountIds.filter(accountId => (
      !capabilityByAccount.has(accountId) && !optionalFollowers.has(accountId)
    ));
    const inactive = routedAccountIds.filter(accountId => (
      capabilityByAccount.get(accountId)?.active === false && !optionalFollowers.has(accountId)
    ));
    const readOnlyFollowers = group.followers.filter(follower => (
      capabilityByAccount.get(follower.accountId)?.canTrade === false
      && !optionalFollowers.has(follower.accountId)
    )).map(follower => follower.accountId);
    lastOauthPreflight = {
      missingAccounts: [...new Set([...explicitOptional, ...missingRequired])],
      inactiveAccounts: inactive,
      readOnlyFollowerAccounts: readOnlyFollowers,
    };
    if (missingRequired.length > 0 || inactive.length > 0 || readOnlyFollowers.length > 0) {
      const details = [
        missingRequired.length > 0 ? `missing=${missingRequired.join(',')}` : '',
        inactive.length > 0 ? `inactive=${inactive.join(',')}` : '',
        readOnlyFollowers.length > 0 ? `readOnlyFollowers=${readOnlyFollowers.join(',')}` : '',
      ].filter(Boolean).join(' ');
      throw new Error(`OAuth/account preflight selhal: ${details}`);
    }

    const snapshotAccountIds = routedAccountIds.filter(accountId => {
      const capability = capabilityByAccount.get(accountId);
      return capability?.active === true
        && (accountId === group.leaderAccountId || capability.canTrade === true)
        && (accountId === group.leaderAccountId || !optionalFollowers.has(accountId));
    });
    const routesAtStart = armPreparationRoutes(snapshotAccountIds);
    const snapshots = await withArmReadDeadline(Promise.all(snapshotAccountIds.map(async accountId => {
      const [positions, orders] = await Promise.all([
        broker.listPositions(accountId),
        broker.listOrders(accountId),
      ]);
      return { accountId, positions, orders };
    })));
    if (
      generationAtStart !== safetyGeneration
      || observationAtStart !== brokerObservationVersion
      || configurationAtStart !== armPreparationConfiguration()
      || connectionAtStart !== connectionSyncGeneration
      || routesAtStart !== armPreparationRoutes(snapshotAccountIds)
      || stopped || shutdownRequested || gate.killSwitch
      || !gate.connected
      || gate.armed
    ) throw new Error('stav se změnil během read-only preflightu');

    const nextPositions = new Map<number, Map<string, number>>();
    for (const snapshot of snapshots) {
      nextPositions.set(snapshot.accountId, new Map(
        snapshot.positions.map(position => [position.symbol, position.netQuantity]),
      ));
    }
    const nextLeaderPositions = new Map(
      (snapshots.find(snapshot => snapshot.accountId === group.leaderAccountId)?.positions ?? [])
        .map(position => [position.symbol, position.netQuantity]),
    );
    const nextWorkingOrderAccounts = new Set(snapshots
      .filter(snapshot => snapshot.orders.some(order => isOpenOrderStatus(order.status)))
      .map(snapshot => snapshot.accountId));
    const nextDivergentAccounts = new Set<number>();
    for (const follower of group.followers) {
      if (optionalFollowers.has(follower.accountId) || explicitOptional.has(follower.accountId)) continue;
      const followerPositions = nextPositions.get(follower.accountId) ?? new Map<string, number>();
      const symbols = new Set([...nextLeaderPositions.keys(), ...followerPositions.keys()]);
      for (const symbol of symbols) {
        const expected = follower.enabled === false
          ? 0 : Math.trunc((nextLeaderPositions.get(symbol) ?? 0) * follower.multiplier);
        if ((followerPositions.get(symbol) ?? 0) !== expected) {
          nextDivergentAccounts.add(follower.accountId);
          break;
        }
      }
    }
    const allFlat = snapshots.every(snapshot => (
      snapshot.positions.every(position => position.netQuantity === 0)
    ));

    positionsByAccount.clear();
    for (const [accountId, positions] of nextPositions) positionsByAccount.set(accountId, positions);
    for (const snapshot of snapshots) rememberLiveOrderSnapshot(snapshot.accountId, snapshot.orders);
    lastAuthoritativeReadAt = clock();
    lastBrokerPositionAt = lastAuthoritativeReadAt;
    leaderPositions.clear();
    leaderFillAheadOfPosition.clear();
    for (const [symbol, quantity] of nextLeaderPositions) leaderPositions.set(symbol, quantity);
    leaderPositionSnapshotComplete = nextPositions.has(group.leaderAccountId);
    workingOrderAccounts = nextWorkingOrderAccounts;
    gate = {
      ...gate,
      armed: false,
      sequenceBroken: false,
      divergentAccounts: nextDivergentAccounts,
    };
    positionCheckComplete = allFlat
      && nextWorkingOrderAccounts.size === 0
      && nextDivergentAccounts.size === 0;
    if (positionCheckComplete) source.acknowledgeReconciliation();
    else source.requireReconciliation();

    const reason = [
      nextDivergentAccounts.size > 0 ? `divergence=${[...nextDivergentAccounts].join(',')}` : '',
      nextWorkingOrderAccounts.size > 0 ? `working=${[...nextWorkingOrderAccounts].join(',')}` : '',
      !allFlat ? 'některý účet není flat' : '',
    ].filter(Boolean).join('; ');
    if (positionCheckComplete) recordArmPreparation(snapshotAccountIds, routesAtStart);
    return { clean: positionCheckComplete, reason: reason || null };
  };

  const prepareArm = (refresh = false): Promise<void> => {
    if (armPreparationInFlight) return armPreparationInFlight;
    if (!refresh && hasFreshArmPreparation()) return Promise.resolve();
    const admittedGeneration = safetyGeneration;
    const assertCurrent = () => {
      if (admittedGeneration !== safetyGeneration) throw new Error('Přípravu zapnutí zneplatnila změna stavu nebo DISARM');
      if (gate.armed) throw new Error('Příprava vyžaduje vypnutou kopírku');
      if (!gate.connected) throw new Error('Worker není připojen k brokeru');
      const blocker = armPreparationBlocker();
      if (blocker) throw new Error(blocker.reason);
    };
    armPreparationLastAttemptAt = clock();
    const admittedEvents = eventTail;
    const run = admittedEvents.then(async () => {
      // Startup/reconnect recovery lives on the event lane. Never run the
      // generic read in parallel with it, or occupy its reconciliation lane
      // while waiting for those events (recovery itself needs that lane).
      assertCurrent();
      if (!refresh && hasFreshArmPreparation()) return;
      if (refresh || !hasFreshArmPreparation(false)) {
        const read = reconciliationTail.then(() => {
          assertCurrent();
          return readFlatPreflightSnapshot([]);
        });
        reconciliationTail = read.then(() => undefined, () => undefined);
        const snapshot = await read;
        assertCurrent();
        if (!snapshot.clean) throw new Error(snapshot.reason ?? 'Účty nejsou flat nebo mají pracovní příkazy');
      }
      try { assertVerifiedArmRisk(clock()); } catch {
        scheduleAccountRiskPoll(followersRequiringVerifiedRisk(clock()).map(follower => follower.accountId), true);
        await accountRiskPollTail;
      }
      assertCurrent();
      if (!hasFreshArmPreparation()) throw new Error('Předběžné ověření není aktuální; zapnutí zůstává vypnuté');
      armPreparationError = null;
    });
    const tracked = run.catch(reason => {
      armPreparationError = errorOf(reason).message;
      throw reason;
    }).finally(() => { armPreparationInFlight = null; });
    armPreparationInFlight = tracked;
    return tracked;
  };
  const scheduleArmPreparation = () => {
    const now = clock();
    const tradingWindow = group.safety?.tradingWindow ?? DEFAULT_COPY_GROUP_SAFETY.tradingWindow;
    const activePreparation = tradingWindowStateAt(tradingWindow, now) === 'inside'
      || now <= armPreparationInterestUntil;
    const refreshMs = activePreparation
      ? ARM_PREPARATION_ACTIVE_REFRESH_MS
      : ARM_PREPARATION_IDLE_REFRESH_MS;
    if (!automaticArmPreparation || gate.armed || !gate.connected || stopped || armPreparationInFlight
      || armPreparationBlocker() || recoveryInFlight || pendingReadOnlyConnectionRecovery
      || now - armPreparationLastAttemptAt < refreshMs) return;
    if (hasFreshArmPreparation() && armPreparationReceipt
      && now - armPreparationReceipt.verifiedAt < refreshMs) return;
    void prepareArm(true).catch(() => undefined);
  };

  const runReadOnlyConnectionRecovery = async () => {
    if (!pendingReadOnlyConnectionRecovery || stopped || pendingConnectionRecovery) return;
    // A subsequent transport reconnect cannot acknowledge an earlier incident.
    if (armPreparationIncidentRequiresRecovery) return;
    if (gate.killSwitch || group.leaderAccountId == null) {
      pendingReadOnlyConnectionRecovery = false;
      return;
    }
    if (!gate.connected) return;

    const blockedBy = readOnlyRecoveryBlocker();
    if (blockedBy) {
      invalidateReconciliation();
      options.onAudit?.([{
        at: clock(), leaderEventId: 'connection-preflight', kind: 'blocked',
        reason: `automatická read-only kontrola po reconnectu přeskočena: ${blockedBy}`,
      }]);
      return;
    }

    const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let lastRecoveryError: string | null = null;
    for (let attempt = 0; attempt < 5 && !stopped; attempt += 1) {
      if (attempt > 0) await wait(500);
      if (!gate.connected || pendingConnectionRecovery) return;
      try {
        const missingBefore = options.resolveMissingOptionalAccountIds
          ? [...new Set(await options.resolveMissingOptionalAccountIds(group))]
            .filter(accountId => group.followers.some(follower => follower.accountId === accountId))
            .sort((left, right) => left - right)
          : [];
        const candidate = await readFlatPreflightSnapshot(missingBefore);
        const missingAfter = options.resolveMissingOptionalAccountIds
          ? [...new Set(await options.resolveMissingOptionalAccountIds(group))]
            .filter(accountId => group.followers.some(follower => follower.accountId === accountId))
            .sort((left, right) => left - right)
          : [];
        const sameMissing = missingBefore.length === missingAfter.length
          && missingBefore.every((accountId, index) => accountId === missingAfter[index]);
        if (!sameMissing) {
          positionCheckComplete = false;
          source.requireReconciliation();
          throw new Error('během čtení se změnil seznam dostupných OAuth účtů');
        }
        if (!candidate.clean) {
          options.onAudit?.([{
            at: clock(), leaderEventId: 'connection-preflight', kind: 'blocked',
            reason: `automatická read-only kontrola ponechala runtime DISARMED: ${candidate.reason ?? 'stav není flat/no-working'}`,
          }]);
          return;
        }

        pendingReadOnlyConnectionRecovery = false;
        lastError = null;
        if (lastDisarm?.trigger === 'transport') updateDisarmOutcome(lastDisarm.at, 'flat');
        options.onAudit?.([{
          at: clock(), leaderEventId: 'connection-preflight', kind: 'recovered',
          reason: 'automatická read-only kontrola po reconnectu potvrdila flat/no-working stav; runtime zůstává DISARMED',
        }]);
        return;
      } catch (reason) {
        lastRecoveryError = errorOf(reason).message;
      }
    }

    invalidateReconciliation();
    // V režimu opravy po startu je hlavní příčina už známá (nedostupné účty
    // uložené skupiny); technická chyba recovery ji v UI nesmí přepsat.
    if (!startupGroupRepair) {
      lastError = new Error(
        `Po reconnectu se nepodařilo automaticky potvrdit flat/no-working stav: ${lastRecoveryError ?? 'bez důvodu'}`,
      );
      options.onError?.(lastError);
    }
    options.onAudit?.([{
      at: clock(), leaderEventId: 'connection-preflight', kind: 'blocked',
      reason: `automatická read-only kontrola po reconnectu selhala: ${lastRecoveryError ?? 'bez důvodu'}`,
    }]);
  };

  const scheduleConnectionRecovery = () => {
    if (recoveryInFlight || stopped) return;
    recoveryInFlight = true;
    eventTail = eventTail
      .then(async () => {
        try {
          if (pendingConnectionRecovery) await runConnectionRecovery();
          else await runReadOnlyConnectionRecovery();
        } finally {
          recoveryInFlight = false;
          scheduleArmPreparation();
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
      const autoClose = await autoFlattenCopies('arm-expiry', armedAt);
      updateDisarmOutcome(
        disarm.at,
        autoClose.flat ? successfulAutoCloseOutcome(disarm.at, autoClose.acted) : 'unknown',
      );
    } finally {
      autoCloseInFlight = false;
    }
  };

  const settleOsoFlush = (entryOrderId: string) => {
    pendingOsoResolvers.get(entryOrderId)?.();
    pendingOsoResolvers.delete(entryOrderId);
    pendingOsoFlushes.delete(entryOrderId);
  };

  const flushStandaloneBracketStop = async (entryOrderId: string, admissionGeneration: number) => {
    const pending = bracketCorrelator.standaloneStop(entryOrderId);
    const epoch = pending ? leaderExposureEpoch(pending.symbol) : null;
    if (!pending || !epoch || epoch.phase !== 'open' || !epoch.leaderEntryOrderIds.includes(entryOrderId)) return false;
    if (stopped || !gate.armed || !gate.connected || gate.killSwitch || safetyGeneration !== admissionGeneration) return true;
    const [lookup, positions] = await Promise.all([
      broker.findOrderById(pending.accountId, pending.orderId),
      broker.listPositions(pending.accountId),
    ]);
    if (stopped || !gate.armed || !gate.connected || gate.killSwitch || safetyGeneration !== admissionGeneration) return true;
    const currentEpoch = leaderExposureEpoch(pending.symbol);
    if (currentEpoch?.id !== epoch.id || currentEpoch.phase !== 'open') return true;
    if (lookup.completeness !== 'authoritative') throw new Error('Samostatný SL nemá autoritativní potvrzení');
    const order = lookup.order;
    if (!order || !isOpenOrderStatus(order.status)) return true;
    const net = positions.filter(position => position.symbol === pending.symbol).reduce((sum, position) => sum + position.netQuantity, 0);
    if (net === 0) return true;
    if (order.accountId !== pending.accountId || order.symbol !== pending.symbol || order.side !== pending.side
      || !['Stop', 'StopLimit'].includes(order.orderType)
      || reducingQuantityAgainst(net, order.side, order.quantity) !== order.quantity) {
      throw new Error('Samostatný SL neodpovídá potvrzené otevřené pozici');
    }
    const event = { ...pending, orderType: order.orderType, quantity: order.quantity,
      stopPrice: order.stopPrice, limitPrice: order.limitPrice };
    const adjusted = await cutAwareDispatchFor(event, false);
    if (adjusted.unsafeDivergenceAccounts.length > 0) throw new Error('Samostatný SL: neověřená follower expozice');
    const result = await processor.process({ event, group: adjusted.dispatchGroup,
      context: { ...gate, now: clock(), sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
        stuckOutbox: gate.stuckOutbox || hasDispatchBlockingStuckOutbox(),
        nonBlockingOutboxKeys: backgroundNonBlockingOutboxKeys(),
        ineligibleAccounts: adjusted.ineligibleAccounts },
      broker: dispatchBroker(admissionGeneration, event), clock, store: durableStore, metrics,
      maxConcurrentDispatches: options.maxConcurrentDispatches, deferredReplay: true });
    runtime = result.runtime;
    rememberConditionalMirrorWrites(event, result.audit);
    rememberCurrentRuntimePendingExposure(event, result.plan, result.audit);
    rememberExitOnlyReservations(adjusted.exitOnlyAccounts, result.plan, result.audit);
    if (result.audit.length > 0) options.onAudit?.(result.audit);
    await failClosedOnCriticalAudit(result.audit);
    return true;
  };

  const flushStandaloneOsoEntry = async (entryOrderId: string) => {
    const timer = pendingOsoTimers.get(entryOrderId);
    if (timer) clearTimeout(timer);
    pendingOsoTimers.delete(entryOrderId);
    const pending = pendingOsoEvents.get(entryOrderId);
    const admissionGeneration = pendingOsoGenerations.get(entryOrderId) ?? safetyGeneration;
    pendingOsoGenerations.delete(entryOrderId);
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
      const adjustedDispatch = await cutAwareDispatchFor(pending, increasesExposure);
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
          stuckOutbox: gate.stuckOutbox || hasDispatchBlockingStuckOutbox(),
          nonBlockingOutboxKeys: backgroundNonBlockingOutboxKeys(),
          ineligibleAccounts: adjustedDispatch.ineligibleAccounts,
        },
        broker: dispatchBroker(admissionGeneration, pending),
        clock,
        store: durableStore,
        metrics,
        maxConcurrentDispatches: options.maxConcurrentDispatches,
        // Událost byla zaznamenaná v pořadí; mezitím ji směly předběhnout
        // nesouvisející lifecycle eventy. Viz ProcessLeaderEventOptions.
        deferredReplay: true,
      });
      runtime = result.runtime;
      rememberConditionalMirrorWrites(pending, result.audit);
      rememberCurrentRuntimePendingExposure(pending, result.plan, result.audit);
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      rememberExitOnlyReservations(
        adjustedDispatch.exitOnlyAccounts,
        result.plan,
        result.audit,
      );
      await failClosedOnCriticalAudit(result.audit);
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
    if (!preferLedger && leaderFillAheadOfPosition.has(symbol)
      && stats && at < stats.sessionEndAt) return ledgerNet;
    const cached = leaderPositions.get(symbol) ?? 0;
    // A new/modified order acts on the current position, not on an unfinished
    // historical ownership epoch. Zero must not be confused with missing data.
    // Fills deliberately retain the pre-fill ledger/epoch fallback: a position
    // event can reach zero before its closing fill is delivered.
    if (!preferLedger && (leaderPositions.has(symbol) || leaderPositionSnapshotComplete)) {
      return cached;
    }
    if (cached !== 0) return cached;
    const epoch = leaderExposureEpoch(symbol);
    if (epoch && unfinishedLeaderFlatPhase(epoch.phase) && epoch.lastLeaderNet !== 0
      && !flatReconciledLeaderEpochIds.has(epoch.id)) {
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
  const pendingIsolationCommandForAccount = (accountId: number): boolean => {
    const live = currentRuntime();
    const unresolvedPlaceStatus = (status: string) => (
      status === 'planned' || status === 'sending' || status === 'unknown'
    );
    if ([...live.outbox.values()].some(entry => (
      entry.request.accountId === accountId && unresolvedPlaceStatus(entry.status)
    ))) return true;
    if ([...live.bracketOutbox.values(), ...live.osoOutbox.values()].some(entry => (
      entry.request.accountId === accountId && unresolvedPlaceStatus(entry.status)
    ))) return true;
    if ([...live.cancelOutbox.values()].some(entry => (
      entry.accountId === accountId && unresolvedPlaceStatus(entry.status)
    ))) return true;
    if ([...currentRuntimePendingExposure.values()].some(pending => (
      pending.accountId === accountId
      && (pending.evidenceInvalid || pendingExposureRemaining(pending) > 0)
    ))) return true;
    return [...exitOnlyReservations.values()].some(reservation => (
      reservation.accountId === accountId && reservation.remaining > 0
    ));
  };
  const hasAuthoritativeFlatNoWorking = (accountId: number, symbol: string): boolean => {
    const positions = positionsByAccount.get(accountId);
    const liveOrders = liveOrdersByAccount.get(accountId);
    return positions != null
      && (positions.get(symbol) ?? 0) === 0
      && liveOrders != null
      && ![...liveOrders.values()].some(order => (
        order.symbol === symbol && isOpenOrderStatus(order.status)
      ))
      && !pendingIsolationCommandForAccount(accountId);
  };
  const currentIntentionalSuppression = (
    accountId: number,
    symbol: string,
  ): IntentionalEntrySuppression | null => {
    const key = intentionalSuppressionKey(accountId, symbol);
    const suppression = intentionalEntrySuppressions.get(key);
    const epoch = leaderExposureEpoch(symbol);
    if (!suppression || !epoch || epoch.phase !== 'open') return null;
    const belongsToEpoch = suppression.epochId === epoch.id
      || (suppression.epochId == null
        && epoch.leaderEntryOrderIds.includes(suppression.leaderOrderId));
    if (!belongsToEpoch) return null;
    if (suppression.epochId == null) {
      suppression.epochId = epoch.id;
      intentionalEntrySuppressions.set(key, suppression);
    }
    if (suppression.allowedNet !== 0) return suppression;
    if (
      !suppression.zeroEvidence
      || suppression.observationVersion !== (tradeObservationVersionByAccount.get(accountId) ?? 0)
      || !hasAuthoritativeFlatNoWorking(accountId, symbol)
    ) return null;
    return suppression;
  };
  const authoritativelyConfirmSuppression = async (
    accountId: number,
    symbol: string,
    leaderOrderId: string,
  ): Promise<boolean> => {
    if (!leaderOrderId) return false;
    const generationAtStart = safetyGeneration;
    const observationAtStart = tradeObservationVersionByAccount.get(accountId) ?? 0;
    const epochAtStart = leaderExposureEpoch(symbol);
    // A1: epocha předchozího obchodu na symbolu (uzavřená nebo ve flat
    // grace/closing po exitu leadera) není překážka: on-submit reject přichází
    // dřív, než Position leadera otevře novou, a flat followera níže stejně
    // potvrzuje autoritativní čtení. Blokovaná epocha dál blokuje.
    const liveEpochAtStart = epochAtStart
      && (epochAtStart.phase === 'open' || epochAtStart.phase === 'blocked')
      ? epochAtStart
      : null;
    if (
      liveEpochAtStart
      && (liveEpochAtStart.phase !== 'open'
        || !liveEpochAtStart.leaderEntryOrderIds.includes(leaderOrderId))
    ) return false;
    try {
      const [positions, orders] = await Promise.all([
        broker.listPositions(accountId),
        broker.listOrders(accountId),
      ]);
      if (
        stopped
        || generationAtStart !== safetyGeneration
        || observationAtStart !== (tradeObservationVersionByAccount.get(accountId) ?? 0)
        || leaderExposureEpoch(symbol)?.id !== epochAtStart?.id
        || positions.some(position => position.netQuantity !== 0)
        || orders.some(order => isOpenOrderStatus(order.status))
        || pendingIsolationCommandForAccount(accountId)
      ) return false;
      positionsByAccount.set(accountId, new Map(
        positions.map(position => [position.symbol, position.netQuantity]),
      ));
      rememberLiveOrderSnapshot(accountId, orders);
      intentionalEntrySuppressions.set(intentionalSuppressionKey(accountId, symbol), {
        allowedNet: 0,
        createdAt: clock(),
        leaderOrderId,
        epochId: liveEpochAtStart?.id ?? null,
        observationVersion: observationAtStart,
        zeroEvidence: true,
      });
      return true;
    } catch {
      return false;
    }
  };
  const isolationEligibilityState = (
    accountId: number,
    at = clock(),
  ): 'breached' | 'dll-locked' | null => {
    const stored = accountEligibility.get(accountId);
    if (!stored) return null;
    const state = eligibilityAt(stored, at).state;
    return state === 'breached' || state === 'dll-locked' ? state : null;
  };
  const episodeIsolationFromSnapshot = ({
    accountId,
    symbol,
    positions,
    orders,
    observedAt,
    observationVersion,
  }: {
    accountId: number;
    symbol: string;
    positions: readonly BrokerPosition[];
    orders: readonly BrokerOrder[];
    observedAt: number;
    observationVersion: number;
  }): EpisodeFollowerIsolationEvidence | null => {
    const epoch = leaderExposureEpoch(symbol);
    const eligibilityState = isolationEligibilityState(accountId, observedAt);
    if (
      !epoch
      || epoch.phase !== 'open'
      || !epoch.followers.some(follower => follower.accountId === accountId)
      || eligibilityState == null
      || positions.some(position => position.netQuantity !== 0)
      || orders.some(order => isOpenOrderStatus(order.status))
      || pendingIsolationCommandForAccount(accountId)
    ) return null;
    return {
      accountId,
      symbol,
      epochId: epoch.id,
      eligibilityState,
      observedAt,
      observationVersion,
    };
  };
  const authoritativelyIsolateFollowerForEpisode = async (
    accountId: number,
    symbol: string,
  ): Promise<EpisodeFollowerIsolationEvidence | null> => {
    const epoch = leaderExposureEpoch(symbol);
    if (!epoch || epoch.phase !== 'open' || isolationEligibilityState(accountId) == null) return null;
    const epochId = epoch.id;
    const generationAtStart = safetyGeneration;
    const observationAtStart = tradeObservationVersionByAccount.get(accountId) ?? 0;
    try {
      const [positions, orders] = await Promise.all([
        broker.listPositions(accountId),
        broker.listOrders(accountId),
      ]);
      if (
        stopped
        || generationAtStart !== safetyGeneration
        || observationAtStart !== (tradeObservationVersionByAccount.get(accountId) ?? 0)
        || leaderExposureEpoch(symbol)?.id !== epochId
        || leaderExposureEpoch(symbol)?.phase !== 'open'
      ) return null;
      const observedAt = clock();
      const evidence = episodeIsolationFromSnapshot({
        accountId,
        symbol,
        positions,
        orders,
        observedAt,
        observationVersion: observationAtStart,
      });
      if (!evidence) return null;
      positionsByAccount.set(accountId, new Map(
        positions.map(position => [position.symbol, position.netQuantity]),
      ));
      rememberLiveOrderSnapshot(accountId, orders);
      return evidence;
    } catch {
      return null;
    }
  };
  const rememberIntentionalEntrySuppression = (event: LeaderEvent): void => {
    for (const follower of group.followers) {
      const acceptsEvent = (event.kind === 'submitted' && follower.mode === 'on-submit')
        || (event.kind === 'filled' && follower.mode === 'on-fill');
      if (!acceptsEvent || follower.enabled === false || currentIneligibleAccounts().has(follower.accountId)) continue;
      const key = intentionalSuppressionKey(follower.accountId, event.symbol);
      const authoritativePositions = positionsByAccount.get(follower.accountId);
      if (!authoritativePositions) continue;
      const allowedNet = authoritativePositions.get(event.symbol) ?? 0;
      const liveOrders = liveOrdersByAccount.get(follower.accountId);
      const zeroEvidence = allowedNet === 0
        && liveOrders != null
        && ![...liveOrders.values()].some(order => (
          order.symbol === event.symbol && isOpenOrderStatus(order.status)
        ))
        && !pendingIsolationCommandForAccount(follower.accountId);
      if (allowedNet === 0 && !zeroEvidence) continue;
      const epoch = leaderExposureEpoch(event.symbol);
      intentionalEntrySuppressions.set(key, {
        allowedNet,
        createdAt: event.receivedAt,
        leaderOrderId: event.orderId,
        epochId: epoch?.phase === 'open' && epoch.leaderEntryOrderIds.includes(event.orderId)
          ? epoch.id
          : null,
        observationVersion: tradeObservationVersionByAccount.get(follower.accountId) ?? 0,
        zeroEvidence,
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
    if (safety.managementOnly) {
      const splitExit = allowReducingSlice && leaderReducingQuantityFor(event) > 0;
      rememberIntentionalEntrySuppression(event);
      if (record && !splitExit) {
        const recorded = await processor.record({ event: eventToRecord, group, clock, store: durableStore });
        runtime = recorded.runtime;
        if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      }
      options.onAudit?.([{
        at: event.receivedAt,
        leaderEventId: event.id,
        kind: 'blocked',
        reason: `management-only:${safety.managementOnly.source}`,
      }]);
      if (event.kind === 'submitted') rememberBlockedLeaderEntryOrder(event.orderId);
      return !splitExit;
    }
    if (dayLockPending) {
      const splitExit = allowReducingSlice && leaderReducingQuantityFor(event) > 0;
      rememberIntentionalEntrySuppression(event);
      if (record && !splitExit) {
        const recorded = await processor.record({ event: eventToRecord, group, clock, store: durableStore });
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
      const recorded = await processor.record({ event: eventToRecord, group, clock, store: durableStore });
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
      const recorded = await processor.record({ event, group, clock, store: durableStore });
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
    pending.followerQuantity - Math.max(
      pending.followerOrderReportedFilled,
      pending.followerFillReportedQuantity,
    ),
  );

  const pendingLeaderFillQuantity = (pending: CurrentRuntimePendingExposure) => Math.max(
    pending.leaderOrderReportedFilled,
    pending.leaderCumQuantity,
    currentRuntime().state.leaderCumQty.get(pending.leaderOrderId) ?? 0,
  );

  const sameOrderPrices = (
    left: Pick<BrokerOrder, 'orderType' | 'limitPrice' | 'stopPrice'>,
    right: Pick<BrokerOrder, 'orderType' | 'limitPrice' | 'stopPrice'>,
  ) => (
    left.orderType === right.orderType
    && (left.orderType !== 'Limit' && left.orderType !== 'StopLimit'
      || left.limitPrice === right.limitPrice)
    && (left.orderType !== 'Stop' && left.orderType !== 'StopLimit'
      || left.stopPrice === right.stopPrice)
  );

  const routeEpochFor = (accountId: number): number | null => {
    try {
      return broker.routeEpoch?.(accountId) ?? connectionSyncGeneration;
    } catch (reason) {
      // Dynamická route může účet odebrat mezi eventy. Je to řízený
      // fail-closed důkaz (null), nikoli nechycená výjimka z eventTail.
      if (gate.armed) {
        failClosed(new Error(
          `Copier fail-closed: routeEpoch účtu ${accountId} nelze načíst (${errorOf(reason).message})`,
        ), { autoClose: false });
      }
      return null;
    }
  };

  let routeEpochRefreshTail: Promise<void> = Promise.resolve();
  let routeEpochRefreshScheduled = false;
  const ROUTE_EPOCH_REFRESH_DEADLINE_MS = 2_000;
  const ROUTE_EPOCH_REFRESH_RETRY_MS = 30_000;
  const routeEpochRefreshNextAttemptByPair = new Map<string, number>();

  const withRouteEpochRefreshDeadline = async <T>(work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`route epoch read-only refresh překročil ${ROUTE_EPOCH_REFRESH_DEADLINE_MS} ms`)),
            ROUTE_EPOCH_REFRESH_DEADLINE_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Router bumpuje epochu i při plánované obnově, kterou záměrně nepublikuje
   * jako globální disconnect. Pending lineage je do nového read-only důkazu
   * neplatná; refresh běží mimo eventTail a nikdy neposílá broker write.
   */
  const scheduleRouteEpochRefresh = (): void => {
    if (!gate.armed || routeEpochRefreshScheduled || stopped || currentRuntimePendingExposure.size === 0) return;
    const stale = [...currentRuntimePendingExposure.values()].filter(pending => {
      if (pending.evidenceInvalid) return false;
      const leaderEpoch = group.leaderAccountId == null ? null : routeEpochFor(group.leaderAccountId);
      const followerEpoch = routeEpochFor(pending.accountId);
      return leaderEpoch == null || followerEpoch == null
        || pending.leaderRouteEpoch !== leaderEpoch
        || pending.followerRouteEpoch !== followerEpoch;
    });
    if (stale.length === 0) return;
    const leaderEpochAtSchedule = group.leaderAccountId == null
      ? null
      : routeEpochFor(group.leaderAccountId);
    const epochPairKey = `${leaderEpochAtSchedule ?? 'missing'}|${[...new Map(stale.map(pending => [
      pending.accountId,
      routeEpochFor(pending.accountId),
    ])).entries()].sort(([left], [right]) => left - right).map(([accountId, epoch]) => (
      `${accountId}:${epoch ?? 'missing'}`
    )).join(',')}`;
    if ((routeEpochRefreshNextAttemptByPair.get(epochPairKey) ?? 0) > clock()) return;
    routeEpochRefreshNextAttemptByPair.set(epochPairKey, clock() + ROUTE_EPOCH_REFRESH_RETRY_MS);
    routeEpochRefreshScheduled = true;
    routeEpochRefreshTail = routeEpochRefreshTail.then(async () => {
      const leaderAccountId = group.leaderAccountId;
      if (leaderAccountId == null) return;
      const records = [...currentRuntimePendingExposure.values()].filter(pending => (
        stale.some(item => item.followerBrokerOrderId === pending.followerBrokerOrderId)
      ));
      const accountIds = [...new Set(records.flatMap(pending => [leaderAccountId, pending.accountId]))];
      if (accountIds.some(accountId => routeEpochFor(accountId) == null)) return;
      const routeEpochAtStart = new Map(accountIds.map(accountId => [
        accountId,
        routeEpochFor(accountId),
      ]));
      const observationAtStart = new Map(accountIds.map(accountId => [
        accountId,
        tradeObservationVersionByAccount.get(accountId) ?? 0,
      ]));
      const authoritativeReadAtStart = new Map(accountIds.map(accountId => [
        accountId,
        authoritativeReadVersionByAccount.get(accountId) ?? 0,
      ]));
      const exactOrderKeys = [...new Map(records.flatMap(pending => [
        [`${leaderAccountId}:${pending.leaderOrderId}`, {
          accountId: leaderAccountId,
          brokerOrderId: pending.leaderOrderId,
        }],
        [`${pending.accountId}:${pending.followerBrokerOrderId}`, {
          accountId: pending.accountId,
          brokerOrderId: pending.followerBrokerOrderId,
        }],
      ])).values()];
      const [snapshots, exactOrders] = await withRouteEpochRefreshDeadline(() => Promise.all([
        Promise.all(accountIds.map(async accountId => {
          const [positions, orders] = await Promise.all([
            broker.listPositions(accountId),
            broker.listOrders(accountId),
          ]);
          return { accountId, positions, orders };
        })),
        Promise.all(exactOrderKeys.map(async key => ({
          ...key,
          lookup: await broker.findOrderById(key.accountId, key.brokerOrderId),
        }))),
      ]));
      if (accountIds.some(accountId => (
        (tradeObservationVersionByAccount.get(accountId) ?? 0)
          !== observationAtStart.get(accountId)
      ))) return;
      if (accountIds.some(accountId => (
        (authoritativeReadVersionByAccount.get(accountId) ?? 0)
          !== authoritativeReadAtStart.get(accountId)
        || routeEpochFor(accountId) !== routeEpochAtStart.get(accountId)
      ))) return;
      const byAccount = new Map(snapshots.map(snapshot => [snapshot.accountId, snapshot]));
      const exactOrderByKey = new Map(exactOrders.map(result => [
        `${result.accountId}:${result.brokerOrderId}`,
        result.lookup.completeness === 'authoritative' ? result.lookup.order : undefined,
      ]));
      for (const snapshot of snapshots) {
        positionsByAccount.set(snapshot.accountId, new Map(
          snapshot.positions.map(position => [position.symbol, position.netQuantity]),
        ));
        rememberLiveOrderSnapshot(snapshot.accountId, snapshot.orders);
      }
      // Exact authoritative lookups are part of the same fenced snapshot.
      // Some adapters omit externally-created leader orders from listOrders
      // while findOrderById can still prove them; keep that proof in the
      // stream cache used by the pending-lineage validator below.
      for (const order of exactOrderByKey.values()) {
        if (order) rememberLiveOrder(order);
      }
      for (const pending of records) {
        const current = currentRuntimePendingExposure.get(pending.followerBrokerOrderId);
        if (!current || current.evidenceInvalid) continue;
        const leaderEpoch = routeEpochFor(leaderAccountId);
        const followerEpoch = routeEpochFor(current.accountId);
        if (
          leaderEpoch == null
          || followerEpoch == null
          || leaderEpoch !== routeEpochAtStart.get(leaderAccountId)
          || followerEpoch !== routeEpochAtStart.get(current.accountId)
        ) continue;
        const leaderOrder = exactOrderByKey.get(`${leaderAccountId}:${current.leaderOrderId}`)
          ?? byAccount.get(leaderAccountId)?.orders.find(order => (
            order.brokerOrderId === current.leaderOrderId
          ));
        const followerOrder = exactOrderByKey.get(`${current.accountId}:${current.followerBrokerOrderId}`)
          ?? byAccount.get(current.accountId)?.orders.find(order => (
            order.brokerOrderId === current.followerBrokerOrderId
          ));
        if (
          followerOrder
          && !isOpenOrderStatus(followerOrder.status)
          && conditionalMirrorWritesBySourceOrder.has(current.followerBrokerOrderId)
        ) {
          await evaluateConditionalMirrorSource(current.followerBrokerOrderId, {
            terminalOrder: followerOrder,
          });
        }
        const leaderFilled = pendingLeaderFillQuantity(current);
        const leaderShapeValid = leaderOrder != null
          && leaderOrder.accountId === leaderAccountId
          && leaderOrder.symbol === current.symbol
          && leaderOrder.side === current.side
          && Number.isFinite(leaderOrder.filledQuantity)
          && leaderOrder.filledQuantity >= 0
          && leaderOrder.filledQuantity <= leaderOrder.quantity
          && (leaderFilled >= current.leaderQuantity || isOpenOrderStatus(leaderOrder.status));
        const followerShapeValid = followerOrder != null
          && followerOrder.accountId === current.accountId
          && followerOrder.symbol === current.symbol
          && followerOrder.side === current.side
          && followerOrder.orderType === current.orderType
          && followerOrder.quantity === current.followerQuantity
          && sameOrderPrices(followerOrder, {
            orderType: current.orderType,
            limitPrice: current.followerLimitPrice,
            stopPrice: current.followerStopPrice,
          })
          && Number.isFinite(followerOrder.filledQuantity)
          && followerOrder.filledQuantity >= 0
          && followerOrder.filledQuantity <= followerOrder.quantity
          && isOpenOrderStatus(followerOrder.status);
        if (!leaderShapeValid || !followerShapeValid) {
          currentRuntimePendingExposure.set(current.followerBrokerOrderId, {
            ...current,
            evidenceInvalid: true,
          });
          continue;
        }
        currentRuntimePendingExposure.set(current.followerBrokerOrderId, {
          ...current,
          leaderOrderReportedFilled: Math.max(
            current.leaderOrderReportedFilled,
            leaderOrder.filledQuantity,
          ),
          followerOrderReportedFilled: Math.max(
            current.followerOrderReportedFilled,
            followerOrder.filledQuantity,
          ),
          leaderRouteEpoch: leaderEpoch,
          followerRouteEpoch: followerEpoch,
        });
      }
    }).catch(reason => {
      options.onAudit?.([{
        at: clock(),
        leaderEventId: 'v12-route-epoch-refresh',
        kind: 'blocked',
        reason: `read-only refresh selhal: ${errorOf(reason).message}`,
      }]);
    }).finally(() => {
      routeEpochRefreshScheduled = false;
    });
  };

  const rememberCurrentRuntimePendingExposure = (
    leaderEvent: Pick<
      LeaderEvent,
      'orderId' | 'symbol' | 'side' | 'quantity' | 'orderType' | 'limitPrice' | 'stopPrice'
    >,
    plan: {
      orders: readonly {
        key: string;
        request: {
          accountId: number;
          symbol: string;
          side: 'Buy' | 'Sell';
          quantity: number;
          orderType: BrokerOrder['orderType'];
          limitPrice?: number;
          stopPrice?: number;
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
      const follower = group.followers.find(item => item.accountId === planned.request.accountId);
      if (
        durable?.status !== 'acknowledged'
        || durable.brokerOrderId !== dispatched.brokerOrderId
        || leaderExposureIncreaseByEventId.get(durable.leaderEventId ?? '') !== true
        || durable.request.accountId !== planned.request.accountId
        || durable.request.symbol !== planned.request.symbol
        || durable.request.side !== planned.request.side
        || durable.request.quantity !== planned.request.quantity
        || !follower
      ) continue;
      currentRuntimePendingExposure.set(dispatched.brokerOrderId, {
        key: planned.key,
        accountId: planned.request.accountId,
        leaderOrderId: leaderEvent.orderId,
        followerBrokerOrderId: dispatched.brokerOrderId,
        symbol: planned.request.symbol,
        side: planned.request.side,
        orderType: planned.request.orderType,
        multiplier: follower.multiplier,
        leaderQuantity: leaderEvent.quantity,
        followerQuantity: planned.request.quantity,
        ...(leaderEvent.limitPrice != null ? { leaderLimitPrice: leaderEvent.limitPrice } : {}),
        ...(leaderEvent.stopPrice != null ? { leaderStopPrice: leaderEvent.stopPrice } : {}),
        ...(planned.request.limitPrice != null ? { followerLimitPrice: planned.request.limitPrice } : {}),
        ...(planned.request.stopPrice != null ? { followerStopPrice: planned.request.stopPrice } : {}),
        leaderOrderReportedFilled: liveOrdersByAccount
          .get(group.leaderAccountId!)?.get(leaderEvent.orderId)?.filledQuantity ?? 0,
        leaderCumQuantity: live.state.leaderCumQty.get(leaderEvent.orderId) ?? 0,
        followerOrderReportedFilled: 0,
        followerFillReportedQuantity: 0,
        tradeEpochGeneration,
        connectionSyncGeneration,
        leaderRouteEpoch: routeEpochFor(group.leaderAccountId!),
        followerRouteEpoch: routeEpochFor(planned.request.accountId),
        evidenceInvalid: leaderEvent.symbol !== planned.request.symbol
          || leaderEvent.side !== planned.request.side
          || leaderEvent.orderType !== planned.request.orderType,
        currentFollowerShapeObserved: false,
      });
    }
  };

  const rememberCurrentRuntimePendingOsoExposure = (
    pair: {
      entryOrderId: string;
      symbol: string;
      entrySide: 'Buy' | 'Sell';
      quantity: number;
      entryOrderType: BrokerOrder['orderType'];
    },
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
      const follower = entry
        ? group.followers.find(item => item.accountId === entry.request.accountId)
        : undefined;
      if (
        entry?.status !== 'acknowledged'
        || !entry.entryBrokerOrderId
        || entry.entryBrokerOrderId.startsWith('shadow:')
        || dispatched.brokerOrderId.split(',')[0] !== entry.entryBrokerOrderId
        || leaderExposureIncreaseByEventId.get(entry.leaderEventId) !== true
        || !follower
      ) continue;
      currentRuntimePendingExposure.set(entry.entryBrokerOrderId, {
        key: entry.key,
        accountId: entry.request.accountId,
        leaderOrderId: pair.entryOrderId,
        followerBrokerOrderId: entry.entryBrokerOrderId,
        symbol: entry.request.symbol,
        side: entry.request.side,
        orderType: entry.request.orderType,
        multiplier: follower.multiplier,
        leaderQuantity: pair.quantity,
        followerQuantity: entry.request.quantity,
        ...(entry.request.limitPrice != null ? { leaderLimitPrice: entry.request.limitPrice } : {}),
        ...(entry.request.stopPrice != null ? { leaderStopPrice: entry.request.stopPrice } : {}),
        ...(entry.request.limitPrice != null ? { followerLimitPrice: entry.request.limitPrice } : {}),
        ...(entry.request.stopPrice != null ? { followerStopPrice: entry.request.stopPrice } : {}),
        leaderOrderReportedFilled: liveOrdersByAccount
          .get(group.leaderAccountId!)?.get(pair.entryOrderId)?.filledQuantity ?? 0,
        leaderCumQuantity: live.state.leaderCumQty.get(pair.entryOrderId) ?? 0,
        followerOrderReportedFilled: 0,
        followerFillReportedQuantity: 0,
        tradeEpochGeneration,
        connectionSyncGeneration,
        leaderRouteEpoch: routeEpochFor(group.leaderAccountId!),
        followerRouteEpoch: routeEpochFor(entry.request.accountId),
        evidenceInvalid: pair.symbol !== entry.request.symbol
          || pair.entrySide !== entry.request.side
          || pair.entryOrderType !== entry.request.orderType,
        currentFollowerShapeObserved: false,
      });
    }
  };

  const observeCurrentRuntimePendingExposure = (event: BrokerEvent): void => {
    if (event.type === 'order') {
      const pending = currentRuntimePendingExposure.get(event.order.brokerOrderId);
      if (pending) {
        const followerCoreShapeValid = event.order.accountId === pending.accountId
          && event.order.brokerOrderId === pending.followerBrokerOrderId
          && event.order.symbol === pending.symbol
          && event.order.side === pending.side
          && event.order.orderType === pending.orderType
          && event.order.quantity === pending.followerQuantity
          && sameOrderPrices(event.order, {
            orderType: pending.orderType,
            limitPrice: pending.followerLimitPrice,
            stopPrice: pending.followerStopPrice,
          });
        const followerFillValid = Number.isFinite(event.order.filledQuantity)
          && event.order.filledQuantity >= 0
          && event.order.filledQuantity <= event.order.quantity;
        const staleConfirmedShape = !followerCoreShapeValid
          && !pending.currentFollowerShapeObserved
          && isOpenOrderStatus(event.order.status)
          && event.order.accountId === pending.accountId
          && event.order.symbol === pending.symbol
          && event.order.side === pending.side
          && event.order.orderType === pending.orderType
          && (pending.priorFollowerShapes ?? []).includes(
            `${event.order.quantity}|${event.order.limitPrice ?? ''}|${event.order.stopPrice ?? ''}`,
          );
        const reportedFilled = followerFillValid
          ? Math.max(pending.followerOrderReportedFilled, event.order.filledQuantity)
          : pending.followerOrderReportedFilled;
        const followerFullyFilled = followerCoreShapeValid && followerFillValid
          && Math.max(reportedFilled, pending.followerFillReportedQuantity) >= pending.followerQuantity;
        const followerTerminalWithValidEvidence = followerCoreShapeValid
          && followerFillValid
          && !isOpenOrderStatus(event.order.status);
        if (followerFullyFilled || followerTerminalWithValidEvidence) {
          // Fill event nebo Tradovate mezistav Working+cumQty už dokazuje, že
          // kopie nemá žádnou budoucí expozici. Canceled/rejected/expired
          // kopie s validním tvarem/fillem se rovněž bezpečně retireuje.
          currentRuntimePendingExposure.delete(event.order.brokerOrderId);
        } else {
          currentRuntimePendingExposure.set(event.order.brokerOrderId, {
            ...pending,
            followerOrderReportedFilled: reportedFilled,
            currentFollowerShapeObserved: pending.currentFollowerShapeObserved || followerCoreShapeValid,
            evidenceInvalid: pending.evidenceInvalid
              || (!followerCoreShapeValid && !staleConfirmedShape)
              || !followerFillValid,
          });
        }
      }

      if (event.order.accountId === group.leaderAccountId) {
        for (const [brokerOrderId, candidate] of currentRuntimePendingExposure) {
          if (candidate.leaderOrderId !== event.order.brokerOrderId) continue;
          // Typ/qty/cena jsou měnitelné potvrzeným replace. Ingress leader
          // orderu proto hlídá pouze stabilní identitu symbolu a strany;
          // potvrzený tvar se atomicky uloží níže v updatePending…
          const leaderCoreShapeValid = event.order.symbol === candidate.symbol
            && event.order.side === candidate.side;
          const leaderFillValid = Number.isFinite(event.order.filledQuantity)
            && event.order.filledQuantity >= 0
            && event.order.filledQuantity <= event.order.quantity;
          const reportedFilled = leaderFillValid
            ? Math.max(candidate.leaderOrderReportedFilled, event.order.filledQuantity)
            : candidate.leaderOrderReportedFilled;
          const terminalWithoutFill = !isOpenOrderStatus(event.order.status)
            && reportedFilled <= 0
            && candidate.leaderCumQuantity <= 0;
          currentRuntimePendingExposure.set(brokerOrderId, {
            ...candidate,
            leaderOrderReportedFilled: reportedFilled,
            evidenceInvalid: candidate.evidenceInvalid
              || !leaderCoreShapeValid
              || !leaderFillValid
              || terminalWithoutFill,
          });
        }
      }
      return;
    }
    if (event.type !== 'fill' || seenCurrentRuntimePendingFillIds.has(event.fill.fillId)) return;
    let observed = false;
    for (const [brokerOrderId, pending] of currentRuntimePendingExposure) {
      if (event.fill.accountId === group.leaderAccountId
        && event.fill.brokerOrderId === pending.leaderOrderId) {
        const leaderFillValid = event.fill.symbol === pending.symbol
          && event.fill.side === pending.side
          && Number.isFinite(event.fill.quantity)
          && event.fill.quantity > 0;
        currentRuntimePendingExposure.set(brokerOrderId, {
          ...pending,
          leaderCumQuantity: leaderFillValid
            ? pending.leaderCumQuantity + event.fill.quantity
            : pending.leaderCumQuantity,
          evidenceInvalid: pending.evidenceInvalid
            || !leaderFillValid
            || (leaderFillValid
              && pending.leaderCumQuantity + event.fill.quantity > pending.leaderQuantity),
        });
        observed = true;
      } else if (event.fill.brokerOrderId === pending.followerBrokerOrderId) {
        const followerFillValid = event.fill.accountId === pending.accountId
          && event.fill.symbol === pending.symbol
          && event.fill.side === pending.side
          && Number.isFinite(event.fill.quantity)
          && event.fill.quantity > 0;
        const fillQuantity = followerFillValid
          ? pending.followerFillReportedQuantity + event.fill.quantity
          : pending.followerFillReportedQuantity;
        if (followerFillValid && Math.max(pending.followerOrderReportedFilled, fillQuantity)
          >= pending.followerQuantity) {
          currentRuntimePendingExposure.delete(brokerOrderId);
        } else {
          currentRuntimePendingExposure.set(brokerOrderId, {
            ...pending,
            followerFillReportedQuantity: fillQuantity,
            evidenceInvalid: pending.evidenceInvalid
              || !followerFillValid
              || (followerFillValid && fillQuantity > pending.followerQuantity),
          });
        }
        observed = true;
      }
    }
    if (observed) {
      seenCurrentRuntimePendingFillIds.add(event.fill.fillId);
      while (seenCurrentRuntimePendingFillIds.size > 2_048) {
        const oldest = seenCurrentRuntimePendingFillIds.values().next().value as string | undefined;
        if (!oldest) break;
        seenCurrentRuntimePendingFillIds.delete(oldest);
      }
    }
  };

  const updatePendingExposureAfterConfirmedModify = (event: LeaderEvent): void => {
    if (event.kind !== 'replaced') return;
    for (const [brokerOrderId, pending] of currentRuntimePendingExposure) {
      if (pending.leaderOrderId !== event.orderId) continue;
      const followerQuantity = Math.max(0, Math.floor(event.quantity * pending.multiplier));
      currentRuntimePendingExposure.set(brokerOrderId, {
        ...pending,
        leaderQuantity: event.quantity,
        followerQuantity,
        orderType: event.orderType,
        leaderLimitPrice: event.limitPrice,
        leaderStopPrice: event.stopPrice,
        followerLimitPrice: event.limitPrice,
        followerStopPrice: event.stopPrice,
        priorFollowerShapes: [
          ...(pending.priorFollowerShapes ?? []),
          `${pending.followerQuantity}|${pending.followerLimitPrice ?? ''}|${pending.followerStopPrice ?? ''}`,
        ],
        currentFollowerShapeObserved: false,
      });
    }
  };

  const currentRuntimePendingNet = (
    accountId: number,
    symbol: string,
    followerNet: number,
    expectedPreNet: number,
    triggerOrderId: string,
  ): {
    net: number;
    invalidEvidence: boolean;
    filledLeaderWorkingLimit: boolean;
    filledLeaderWorkingOrderIds: string[];
    zeroFillMirrorOrderIds: string[];
    marketPendingOrderIds: string[];
  } => {
    let net = 0;
    let invalidEvidence = false;
    let filledLeaderWorkingLimit = false;
    const filledLeaderWorkingOrderIds: string[] = [];
    const zeroFillMirrorOrderIds: string[] = [];
    const currentEpochMarketPending = [...currentRuntimePendingExposure.values()]
      .filter(pending => (
        pending.accountId === accountId
        && pending.symbol === symbol
        && pending.orderType === 'Market'
        && !pending.evidenceInvalid
        && pending.tradeEpochGeneration === tradeEpochGeneration
        && pending.connectionSyncGeneration === connectionSyncGeneration
        && pending.leaderRouteEpoch != null
        && pending.followerRouteEpoch != null
        && pending.leaderRouteEpoch === routeEpochFor(group.leaderAccountId as number)
        && pending.followerRouteEpoch === routeEpochFor(pending.accountId)
        && pending.followerOrderReportedFilled === 0
        && pending.followerFillReportedQuantity === 0
      ));
    const currentEpochMarketPendingNet = currentEpochMarketPending.reduce((sum, pending) => (
        sum + (pending.side === 'Buy' ? 1 : -1) * pendingExposureRemaining(pending)
      ), 0);
    const marketPendingOrderIds = currentEpochMarketPending.map(pending => pending.followerBrokerOrderId);
    const marketPendingExplainsExpected = currentEpochMarketPendingNet !== 0
      && followerNet + currentEpochMarketPendingNet === expectedPreNet;
    const followerSymbolBacklog = pendingTradeIngressByKey.get(
      `${accountId}:symbol:${symbol}`,
    ) ?? 0;
    const followerPositionBacklog = pendingTradeIngressByKey.get(
      `${accountId}:position:${symbol}`,
    ) ?? 0;
    const ownMarketOrderBacklog = marketPendingOrderIds.reduce((sum, brokerOrderId) => (
      sum + (pendingTradeIngressByKey.get(`${accountId}:order:${brokerOrderId}`) ?? 0)
    ), 0);
    const ownMarketFillBacklog = marketPendingOrderIds.reduce((sum, brokerOrderId) => (
      sum + (pendingTradeIngressByKey.get(`${accountId}:fill:${brokerOrderId}`) ?? 0)
    ), 0);
    // Obecný symbolový plot smí obejít jen eventy přesných Market kopií.
    // Position řádek je připsán Marketu pouze pokud ve stejné ingress vlně
    // čeká jeho přesný fill; cizí order/position proto zůstane nevysvětlený.
    const followerIngressContainsOnlyOwnMarket = followerSymbolBacklog
      <= ownMarketOrderBacklog + Math.min(followerPositionBacklog, ownMarketFillBacklog);
    for (const pending of currentRuntimePendingExposure.values()) {
      if (pending.accountId !== accountId || pending.symbol !== symbol) continue;
      // Sticky evidence invalidation always wins, including after the leader
      // order is fully filled. It may never be used to justify a write.
      if (pending.evidenceInvalid) {
        invalidEvidence = true;
        continue;
      }
      const leaderFilled = pendingLeaderFillQuantity(pending);
      const followerFilled = Math.max(
        pending.followerOrderReportedFilled,
        pending.followerFillReportedQuantity,
      );
      const leaderOrder = group.leaderAccountId == null
        ? undefined
        : liveOrdersByAccount.get(group.leaderAccountId)?.get(pending.leaderOrderId);
      const followerOrder = liveOrdersByAccount.get(pending.accountId)
        ?.get(pending.followerBrokerOrderId);
      const routeFresh = group.leaderAccountId != null
        && pending.leaderRouteEpoch === routeEpochFor(group.leaderAccountId)
        && pending.followerRouteEpoch === routeEpochFor(pending.accountId);
      const leaderOrderBacklog = group.leaderAccountId == null ? 1
        : (pendingTradeIngressByKey.get(
          `${group.leaderAccountId}:order:${pending.leaderOrderId}`,
        ) ?? 0);
      const leaderPositionBacklog = group.leaderAccountId == null ? 1
        : (pendingTradeIngressByKey.get(
          `${group.leaderAccountId}:position:${symbol}`,
        ) ?? 0);
      const triggeringFillBacklog = group.leaderAccountId == null ? 0
        : (pendingTradeIngressByKey.get(
          `${group.leaderAccountId}:fill:${triggerOrderId}`,
        ) ?? 0);
      const ingressClear = group.leaderAccountId != null
        && leaderOrderBacklog === 0
        // V broker burstu order -> fill -> position je pozice následkem právě
        // kontrolovaného redukujícího orderu. Samotný resent pozice (ING3)
        // tento kauzální důkaz nemá a zůstává fail-closed.
        && (leaderPositionBacklog === 0 || triggeringFillBacklog > 0)
        && (pendingTradeIngressByKey.get(`${pending.accountId}:symbol:${symbol}`) ?? 0) === 0;
      const ownMarketPendingExplainsExpected = marketPendingExplainsExpected
        && followerIngressContainsOnlyOwnMarket
        && leaderOrderBacklog === 0
        && (leaderPositionBacklog === 0 || triggeringFillBacklog > 0);
      const currentEpoch = pending.tradeEpochGeneration === tradeEpochGeneration
        && pending.connectionSyncGeneration === connectionSyncGeneration;
      const streamShapeValid = leaderOrder != null
        && followerOrder != null
        && leaderOrder.accountId === group.leaderAccountId
        && followerOrder.accountId === pending.accountId
        && leaderOrder.symbol === pending.symbol
        && followerOrder.symbol === pending.symbol
        && leaderOrder.side === pending.side
        && followerOrder.side === pending.side
        && leaderOrder.orderType === pending.orderType
        && followerOrder.orderType === pending.orderType
        && followerOrder.quantity === Math.max(0, Math.floor(leaderOrder.quantity * pending.multiplier))
        && sameOrderPrices(leaderOrder, followerOrder)
        && Number.isFinite(leaderOrder.filledQuantity)
        && leaderOrder.filledQuantity >= 0
        && leaderOrder.filledQuantity <= leaderOrder.quantity
        && Number.isFinite(followerOrder.filledQuantity)
        && followerOrder.filledQuantity >= 0
        && followerOrder.filledQuantity <= followerOrder.quantity;
      const streamFresh = routeFresh
        && (ingressClear || ownMarketPendingExplainsExpected)
        && currentEpoch
        && streamShapeValid;
      const streamLeaderFilled = Math.max(leaderFilled, leaderOrder?.filledQuantity ?? 0);
      const streamFollowerFilled = Math.max(followerFilled, followerOrder?.filledQuantity ?? 0);
      const exactPositionWithoutPending = followerNet === expectedPreNet
        || marketPendingExplainsExpected;
      const zeroFillMirror = streamFresh
        && pending.orderType !== 'Market'
        && isOpenOrderStatus(leaderOrder!.status)
        && isOpenOrderStatus(followerOrder!.status)
        && streamLeaderFilled === 0
        && streamFollowerFilled === 0
        && exactPositionWithoutPending;
      const matchedPartialMirror = streamFresh
        && pending.orderType !== 'Market'
        && isOpenOrderStatus(leaderOrder!.status)
        && isOpenOrderStatus(followerOrder!.status)
        && pending.leaderCumQuantity > 0
        && pending.followerFillReportedQuantity > 0
        && streamLeaderFilled > 0
        && streamLeaderFilled < leaderOrder!.quantity
        && leaderOrder!.quantity - streamLeaderFilled > 0
        && followerOrder!.quantity - streamFollowerFilled
          === Math.floor((leaderOrder!.quantity - streamLeaderFilled) * pending.multiplier)
        && exactPositionWithoutPending;
      if (zeroFillMirror) zeroFillMirrorOrderIds.push(pending.followerBrokerOrderId);
      if (zeroFillMirror || matchedPartialMirror) continue;
      const leaderFullyFilled = leaderFilled >= pending.leaderQuantity
        && leaderFilled > 0;
      // Market ACK bez fillu používá původní přesný pending výpočet. Jakmile
      // má leader fill, stejný remaining výpočet platí pro Market i vyplněný
      // Limit. Nevyplněný/partial Limit bez čerstvého stream důkazu je halt.
      if (!leaderFullyFilled
        && !(pending.orderType === 'Market' && currentEpoch
          && leaderFilled === 0 && followerFilled === 0)) {
        invalidEvidence = true;
      }
      const remaining = pendingExposureRemaining(pending);
      if (leaderFullyFilled && remaining > 0 && pending.orderType !== 'Market'
        && followerOrder != null && isOpenOrderStatus(followerOrder.status)) {
        filledLeaderWorkingLimit = true;
        filledLeaderWorkingOrderIds.push(pending.followerBrokerOrderId);
      }
      net += (pending.side === 'Buy' ? 1 : -1) * remaining;
    }
    return {
      net,
      invalidEvidence,
      filledLeaderWorkingLimit,
      filledLeaderWorkingOrderIds,
      zeroFillMirrorOrderIds,
      marketPendingOrderIds: marketPendingExplainsExpected ? marketPendingOrderIds : [],
    };
  };

  type TargetedPendingRead = {
    kind: 'filled-synced' | 'terminal-zero-fill' | 'working-flat' | 'working-matched' | 'unsafe' | 'unverified';
    freshNet?: number;
    order?: BrokerOrder;
    reason?: string;
    accountAllFlat?: boolean;
    noWorkingOrders?: boolean;
    observationVersion?: number;
  };

  const performPendingCopyAndPositionRead = async (
    accountId: number,
    symbol: string,
    brokerOrderId: string,
    expectedPreNet: number,
    includeFreshOrderList = false,
  ): Promise<TargetedPendingRead> => {
    const pending = currentRuntimePendingExposure.get(brokerOrderId);
    if (!pending || pending.accountId !== accountId || pending.symbol !== symbol) {
      return { kind: 'unverified', reason: 'pending lineage mezitím zmizela' };
    }
    try {
      const observationVersion = tradeObservationVersionByAccount.get(accountId) ?? 0;
      const orderLookup = broker.findOrderById(accountId, brokerOrderId).catch(async reason => {
        if (!broker.findOrderStatusById) throw reason;
        const statusLookup = await broker.findOrderStatusById(accountId, brokerOrderId);
        if (statusLookup.completeness !== 'authoritative' || statusLookup.status == null
          || isOpenOrderStatus(statusLookup.status)) throw reason;
        return {
          completeness: 'authoritative' as const,
          observedAt: statusLookup.observedAt,
          order: {
            tag: '',
            brokerOrderId,
            accountId,
            symbol,
            side: pending.side,
            orderType: pending.orderType,
            quantity: pending.followerQuantity,
            filledQuantity: statusLookup.status === 'filled'
              ? pending.followerQuantity
              : Math.max(
                pending.followerOrderReportedFilled,
                pending.followerFillReportedQuantity,
              ),
            ...(pending.followerLimitPrice != null
              ? { limitPrice: pending.followerLimitPrice }
              : {}),
            ...(pending.followerStopPrice != null
              ? { stopPrice: pending.followerStopPrice }
              : {}),
            status: statusLookup.status,
            sourceVersion: `status-only:${statusLookup.status}`,
            updatedAt: statusLookup.observedAt,
          } satisfies BrokerOrder,
        };
      });
      const [lookup, positions, orderList] = await Promise.all([
        orderLookup,
        broker.listPositions(accountId),
        includeFreshOrderList ? broker.listOrders(accountId, { fresh: true }) : Promise.resolve(null),
      ]);
      if (lookup.completeness !== 'authoritative') {
        return { kind: 'unverified', reason: 'lookup kopie nebyl autoritativní' };
      }
      const freshNet = positions
        .filter(position => position.symbol === symbol)
        .reduce((sum, position) => sum + position.netQuantity, 0);
      positionsByAccount.set(accountId, new Map(
        positions.map(position => [position.symbol, position.netQuantity]),
      ));
      authoritativeReadVersionByAccount.set(
        accountId,
        (authoritativeReadVersionByAccount.get(accountId) ?? 0) + 1,
      );
      const order = lookup.order;
      if (!order) return { kind: 'unverified', freshNet, reason: 'kopie u brokera chybí' };
      rememberLiveOrder(order);
      const shapeValid = order.accountId === pending.accountId
        && order.brokerOrderId === pending.followerBrokerOrderId
        && order.symbol === pending.symbol
        && order.side === pending.side
        && order.orderType === pending.orderType
        && order.quantity === pending.followerQuantity
        && sameOrderPrices(order, {
          orderType: pending.orderType,
          limitPrice: pending.followerLimitPrice,
          stopPrice: pending.followerStopPrice,
        })
        && Number.isFinite(order.filledQuantity)
        && order.filledQuantity >= 0
        && order.filledQuantity <= order.quantity;
      if (!shapeValid) return { kind: 'unsafe', freshNet, order, reason: 'kopie má jiný tvar' };
      if (!isOpenOrderStatus(order.status)) {
        if (conditionalMirrorWritesBySourceOrder.has(brokerOrderId)) {
          await evaluateConditionalMirrorSource(brokerOrderId, { terminalOrder: order });
        }
        const observedFill = Math.max(
          order.filledQuantity,
          pending.followerOrderReportedFilled,
          pending.followerFillReportedQuantity,
        );
        currentRuntimePendingExposure.delete(brokerOrderId);
        if (observedFill >= pending.followerQuantity && freshNet === expectedPreNet) {
          return { kind: 'filled-synced', freshNet, order };
        }
        // Incident 5. 10. 2026: leader zrušil zbytek částečně vyplněného vstupu
        // a copier zbytek zrušil i followerovi. Ukončená kopie s částečným
        // plněním je srovnaná jen tehdy, když je leaderův příkaz zrušený a
        // čerstvá pozice followera přesně odpovídá leaderovi před exitem.
        if (observedFill > 0 && observedFill < pending.followerQuantity
          && order.status === 'canceled'
          && leaderOrderCanceled(pending.leaderOrderId)
          && freshNet === expectedPreNet) {
          return { kind: 'filled-synced', freshNet, order };
        }
        if (observedFill === 0 && freshNet === 0
          && (order.status === 'canceled' || order.status === 'rejected')) {
          return {
            kind: 'terminal-zero-fill', freshNet, order,
            accountAllFlat: positions.every(position => position.netQuantity === 0),
            noWorkingOrders: orderList
              ? !orderList.some(candidate => isOpenOrderStatus(candidate.status))
              : undefined,
            observationVersion,
          };
        }
        return {
          kind: 'unsafe', freshNet, order,
          reason: `terminální kopie má fill ${observedFill}/${pending.followerQuantity} a pozici ${freshNet}`,
        };
      }
      const observedFill = Math.max(
        order.filledQuantity,
        pending.followerOrderReportedFilled,
        pending.followerFillReportedQuantity,
      );
      if (observedFill > 0) {
        return { kind: 'unsafe', freshNet, order, reason: `pracující kopie má fill ${observedFill}` };
      }
      if (freshNet === 0) return { kind: 'working-flat', freshNet, order };
      if (freshNet === expectedPreNet) return { kind: 'working-matched', freshNet, order };
      return { kind: 'unsafe', freshNet, order, reason: `pozice ${freshNet} != ${expectedPreNet}` };
    } catch (reason) {
      return { kind: 'unverified', reason: errorOf(reason).message };
    }
  };

  const pendingReadWithin = async (
    operation: Promise<TargetedPendingRead>,
    deadlineMs: number,
  ): Promise<TargetedPendingRead> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<TargetedPendingRead>(resolve => {
          timer = setTimeout(() => resolve({
            kind: 'unverified',
            reason: `cílené V12 čtení překročilo ${deadlineMs} ms`,
          }), deadlineMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const waitForS1bIngressChange = (deadlineAt: number): Promise<boolean> => {
    const remaining = deadlineAt - performance.now();
    if (remaining <= 0) return Promise.resolve(false);
    return new Promise(resolve => {
      const finish = (changed: boolean) => {
        s1bIngressWaiters.delete(wake);
        clearTimeout(timer);
        resolve(changed);
      };
      const wake = () => finish(true);
      s1bIngressWaiters.add(wake);
      const timer = setTimeout(() => finish(false), remaining);
    });
  };

  const waitForS1bStreamResolution = async (
    accountId: number,
    symbol: string,
    brokerOrderId: string,
    expectedPreNet: number,
    ingressBaseline: number,
    deadlineAt: number,
  ): Promise<TargetedPendingRead> => {
    while (performance.now() < deadlineAt) {
      const pending = currentRuntimePendingExposure.get(brokerOrderId);
      if (!pending || pending.accountId !== accountId || pending.symbol !== symbol) {
        return { kind: 'unverified', reason: 'pending lineage mezitím zmizela' };
      }
      const orderEvidence = s1bIngressOrders.get(brokerOrderId);
      const fillEvidence = s1bIngressFillQuantities.get(brokerOrderId);
      const hasNewOrder = (orderEvidence?.version ?? 0) > ingressBaseline;
      const hasNewFill = (fillEvidence?.version ?? 0) > ingressBaseline;
      const observedOrder = hasNewOrder ? orderEvidence?.order : undefined;
      if (observedOrder) {
        const shapeValid = observedOrder.accountId === pending.accountId
          && observedOrder.symbol === pending.symbol
          && observedOrder.side === pending.side
          && observedOrder.orderType === pending.orderType
          && observedOrder.quantity === pending.followerQuantity
          && sameOrderPrices(observedOrder, {
            orderType: pending.orderType,
            limitPrice: pending.followerLimitPrice,
            stopPrice: pending.followerStopPrice,
          })
          && Number.isFinite(observedOrder.filledQuantity)
          && observedOrder.filledQuantity >= 0
          && observedOrder.filledQuantity <= observedOrder.quantity;
        if (!shapeValid) {
          return { kind: 'unsafe', order: observedOrder, reason: 'stream kopie má jiný tvar' };
        }
      }
      if (hasNewFill && fillEvidence && (
        fillEvidence.accountId !== pending.accountId
        || fillEvidence.symbol !== pending.symbol
        || fillEvidence.side !== pending.side
        || fillEvidence.quantity > pending.followerQuantity
      )) {
        return { kind: 'unsafe', reason: 'stream fill kopie má neplatný tvar nebo množství' };
      }
      const observedFill = Math.max(
        observedOrder?.filledQuantity ?? 0,
        hasNewFill ? fillEvidence?.quantity ?? 0 : 0,
      );
      if (observedFill >= pending.followerQuantity) {
        const remaining = Math.max(1, deadlineAt - performance.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const positions = await Promise.race([
            broker.listPositions(accountId),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('ověření follower pozice po stream fillu vypršelo')), remaining);
            }),
          ]);
          const freshNet = positions
            .filter(position => position.symbol === symbol)
            .reduce((sum, position) => sum + position.netQuantity, 0);
          positionsByAccount.set(accountId, new Map(
            positions.map(position => [position.symbol, position.netQuantity]),
          ));
          if (freshNet === expectedPreNet) {
            currentRuntimePendingExposure.delete(brokerOrderId);
            return { kind: 'filled-synced', freshNet, order: observedOrder };
          }
          return {
            kind: 'unsafe', freshNet, order: observedOrder,
            reason: `stream fill kopie má pozici ${freshNet} != ${expectedPreNet}`,
          };
        } catch (reason) {
          return { kind: 'unverified', reason: errorOf(reason).message };
        } finally {
          clearTimeout(timer);
        }
      }
      if (observedOrder && !isOpenOrderStatus(observedOrder.status)) {
        if (observedFill > 0) {
          return {
            kind: 'unsafe', order: observedOrder,
            reason: `terminální stream kopie má partial fill ${observedFill}/${pending.followerQuantity}`,
          };
        }
        const remaining = Math.max(1, deadlineAt - performance.now());
        return pendingReadWithin(
          performPendingCopyAndPositionRead(accountId, symbol, brokerOrderId, expectedPreNet, true),
          remaining,
        );
      }
      if (!await waitForS1bIngressChange(deadlineAt)) break;
    }
    return { kind: 'unverified', reason: 'S1b stream settlement deadline 3000 ms' };
  };

  const readPendingCopyAndPosition = (
    accountId: number,
    symbol: string,
    brokerOrderId: string,
    expectedPreNet: number,
    deadlineMs: number,
    includeFreshOrderList = false,
  ): Promise<TargetedPendingRead> => pendingReadWithin(
    performPendingCopyAndPositionRead(
      accountId,
      symbol,
      brokerOrderId,
      expectedPreNet,
      includeFreshOrderList,
    ),
    deadlineMs,
  );

  const rememberConditionalMirrorWrites = (
    event: LeaderEvent,
    audit: readonly CopierAuditEntry[],
    consumedAccountIds?: readonly number[],
  ): void => {
    const byAccount = conditionalMirrorSourcesByLeaderEvent.get(event.id);
    if (!byAccount) return;
    for (const item of audit) {
      if (item.kind !== 'dispatched' || item.accountId == null || !item.brokerOrderId) continue;
      const sources = byAccount.get(item.accountId) ?? [];
      for (const sourceOrderId of sources) {
        const source = currentRuntimePendingExposure.get(sourceOrderId);
        if (!source) continue;
        const existing = conditionalMirrorWritesBySourceOrder.get(sourceOrderId);
        conditionalMirrorWritesBySourceOrder.set(sourceOrderId, {
          accountId: item.accountId,
          symbol: event.symbol,
          leaderOrderId: source.leaderOrderId,
          multiplier: source.multiplier,
          sourceQuantity: source.followerQuantity,
          sourceFilledQuantity: existing?.sourceFilledQuantity ?? 0,
          dispatchedAt: Math.min(existing?.dispatchedAt ?? item.at, item.at),
          dependentOrderIds: new Set([
            ...(existing?.dependentOrderIds ?? []),
            item.brokerOrderId,
          ]),
        });
      }
    }
    if (consumedAccountIds) {
      for (const accountId of consumedAccountIds) byAccount.delete(accountId);
    } else {
      byAccount.clear();
    }
    if (byAccount.size === 0) conditionalMirrorSourcesByLeaderEvent.delete(event.id);
  };

  const withConditionalDeadline = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} deadline 1000 ms`)), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const evaluateConditionalMirrorSource = async (
    sourceOrderId: string,
    evidence: { fill?: BrokerFill; terminalOrder?: BrokerOrder },
  ): Promise<void> => {
    const conditional = conditionalMirrorWritesBySourceOrder.get(sourceOrderId);
    const fill = evidence.fill;
    const terminalOrder = evidence.terminalOrder;
    if (!conditional) return;
    if (fill && (conditional.accountId !== fill.accountId || conditional.symbol !== fill.symbol)) return;
    if (terminalOrder && (
      conditional.accountId !== terminalOrder.accountId
      || conditional.symbol !== terminalOrder.symbol
    )) return;
    const sourceFilledQuantity = Math.max(
      conditional.sourceFilledQuantity + (fill?.quantity ?? 0),
      terminalOrder?.filledQuantity ?? 0,
    );
    conditional.sourceFilledQuantity = sourceFilledQuantity;
    const terminalUnderfilled = terminalOrder != null
      && terminalOrder.filledQuantity < conditional.sourceQuantity;
    const leaderAccountId = group.leaderAccountId;
    let leaderFilled = currentRuntime().state.leaderCumQty.get(conditional.leaderOrderId) ?? 0;
    let mirrored = sourceFilledQuantity > 0
      && leaderFilled * conditional.multiplier >= sourceFilledQuantity;
    // Fill, který vznikl až po dispatchi závislého orderu, původní zero-fill
    // důkaz nevyvrací. Totéž platí pro už zrcadlený leader fill.
    if (!terminalUnderfilled && (mirrored || (fill != null && fill.filledAt >= conditional.dispatchedAt))) {
      conditionalMirrorWritesBySourceOrder.delete(sourceOrderId);
      return;
    }
    if (fill && leaderAccountId != null) {
      // Follower-first pořadí: právě jedno read-only čtení leader zdroje.
      try {
        const lookup = await withConditionalDeadline(
          'conditional leader lookup',
          () => broker.findOrderById(leaderAccountId, conditional.leaderOrderId),
        );
        if (lookup.completeness === 'authoritative') {
          leaderFilled = Math.max(leaderFilled, lookup.order?.filledQuantity ?? 0);
          mirrored = sourceFilledQuantity > 0
            && leaderFilled * conditional.multiplier >= sourceFilledQuantity;
        }
      } catch {
        // Neověřený leader důkaz nesmí autorizovat další write; pokračuje se
        // konzervativním vyhodnocením závislých orderů a fail-closed.
      }
      if (mirrored && !terminalUnderfilled) {
        conditionalMirrorWritesBySourceOrder.delete(sourceOrderId);
        return;
      }
    }

    conditionalMirrorWritesBySourceOrder.delete(sourceOrderId);
    const canceled: string[] = [];
    const filledDependents: string[] = [];
    const retainedProtective: string[] = [];
    const uncertain: string[] = [];
    let positions: readonly BrokerPosition[];
    let orders: readonly BrokerOrder[];
    try {
      [positions, orders] = await withConditionalDeadline(
        'conditional source snapshot',
        () => Promise.all([
          broker.listPositions(conditional.accountId),
          broker.listOrders(conditional.accountId),
        ]),
      );
      positionsByAccount.set(conditional.accountId, new Map(
        positions.map(position => [position.symbol, position.netQuantity]),
      ));
      authoritativeReadVersionByAccount.set(
        conditional.accountId,
        (authoritativeReadVersionByAccount.get(conditional.accountId) ?? 0) + 1,
      );
    } catch (reason) {
      failClosed(new Error(
        `Copier fail-closed: podmíněný zdroj ${sourceOrderId} byl vyvrácen, read-only snapshot selhal: ${errorOf(reason).message}`,
      ), { autoClose: false });
      return;
    }
    const freshNet = positions
      .filter(position => position.symbol === conditional.symbol)
      .reduce((sum, position) => sum + position.netQuantity, 0);
    const byId = new Map(orders.map(order => [order.brokerOrderId, order]));
    for (const brokerOrderId of conditional.dependentOrderIds) {
      const dependent = byId.get(brokerOrderId);
      if (!dependent || !isOpenOrderStatus(dependent.status)) {
        if (dependent?.status === 'filled') filledDependents.push(brokerOrderId);
        continue;
      }
      const orderSign = dependent.side === 'Buy' ? 1 : -1;
      const riskIncreasing = freshNet === 0 || Math.sign(freshNet) === orderSign;
      if (dependent.orderType === 'Market') {
        uncertain.push(`${brokerOrderId}:Market se neruší`);
        continue;
      }
      if (!riskIncreasing) {
        retainedProtective.push(brokerOrderId);
        continue;
      }
      try {
        await withConditionalDeadline(
          'conditional mirror cancel',
          () => broker.cancelOrder(conditional.accountId, brokerOrderId),
        );
      } catch (reason) {
        uncertain.push(`${brokerOrderId}:${errorOf(reason).message}`);
      }
      // Každý nový write má právě jednu read-only postkontrolu. Ani při
      // timeoutu se cancel neopakuje.
      try {
        const post = await withConditionalDeadline(
          'conditional cancel postcheck',
          () => broker.findOrderById(conditional.accountId, brokerOrderId),
        );
        if (post.completeness !== 'authoritative' || (post.order && isOpenOrderStatus(post.order.status))) {
          uncertain.push(`${brokerOrderId}:postkontrola nepotvrdila terminal`);
        } else if (post.order?.status === 'filled') {
          filledDependents.push(brokerOrderId);
        } else {
          canceled.push(brokerOrderId);
        }
      } catch (reason) {
        uncertain.push(`${brokerOrderId}:postkontrola ${errorOf(reason).message}`);
      }
    }
    for (const brokerOrderId of canceled) options.onAudit?.([{
      at: clock(), leaderEventId: `v12-conditional-${sourceOrderId}`,
      kind: 'canceled', accountId: conditional.accountId, brokerOrderId,
      reason: `vyvrácený podmíněný zdroj ${sourceOrderId}; risk-zvyšující závislý order autoritativně nepracuje`,
    }]);
    for (const brokerOrderId of filledDependents) options.onAudit?.([{
      at: clock(), leaderEventId: `v12-conditional-${sourceOrderId}`,
      kind: 'filled', accountId: conditional.accountId, brokerOrderId,
      reason: `závislý order byl při vyhodnocení zdroje ${sourceOrderId} už vyplněn`,
    }]);
    failClosed(new Error(
      `Copier fail-closed: zdroj ${sourceOrderId} vyvrátil podmíněný mirror; `
      + `zrušeno=${canceled.join(',') || 'nic'}`
      + `${filledDependents.length > 0 ? `; vyplněno=${filledDependents.join(',')}` : ''}`
      + `${retainedProtective.length > 0 ? `; ochranné ponecháno=${retainedProtective.join(',')}` : ''}`
      + `${uncertain.length > 0 ? `; nejisté=${uncertain.join(',')}` : ''}`,
    ), { autoClose: false });
  };

  const s1bCandidatesFor = (
    event: LeaderEvent,
    follower: CopyGroupConfig['followers'][number],
  ) => {
    const preNet = leaderPreFillNetByEventId.get(event.id) ?? 0;
    const followerNet = positionsByAccount.get(follower.accountId)?.get(event.symbol) ?? 0;
    const expectedPreNet = Math.trunc(preNet * follower.multiplier);
    const pendingExposure = currentRuntimePendingNet(
      follower.accountId,
      event.symbol,
      followerNet,
      expectedPreNet,
      event.orderId,
    );
    const filledLeaderCandidates = followerNet !== expectedPreNet
      ? pendingExposure.filledLeaderWorkingOrderIds
      : [];
    const oppositePendingCandidates = [...currentRuntimePendingExposure.values()]
      .filter(pending => (
        pending.accountId === follower.accountId
        && pending.symbol === event.symbol
        && pending.orderType !== 'Market'
        && !pending.evidenceInvalid
        && pending.tradeEpochGeneration === tradeEpochGeneration
        && pending.connectionSyncGeneration === connectionSyncGeneration
        && expectedPreNet !== 0
        && (pending.side === 'Buy' ? 1 : -1) !== Math.sign(expectedPreNet)
      ))
      .map(pending => pending.followerBrokerOrderId);
    // Zbytek kopie, jejíž leader příkaz je už zrušený: o jejím konci rozhodne
    // stejné autoritativní čtení příkazu a pozice, ne pořadí stream eventů.
    const canceledLeaderCandidates = pendingExposure.net !== 0
      ? [...currentRuntimePendingExposure.values()]
        .filter(pending => (
          pending.accountId === follower.accountId
          && pending.symbol === event.symbol
          && pending.orderType !== 'Market'
          && !pending.evidenceInvalid
          && pending.tradeEpochGeneration === tradeEpochGeneration
          && pending.connectionSyncGeneration === connectionSyncGeneration
          && leaderOrderCanceled(pending.leaderOrderId)
        ))
        .map(pending => pending.followerBrokerOrderId)
      : [];
    return {
      followerNet,
      expectedPreNet,
      oppositePendingCandidates,
      candidates: [...new Set([
        ...filledLeaderCandidates,
        ...oppositePendingCandidates,
        ...canceledLeaderCandidates,
      ])],
    };
  };

  const cutAwareDispatchFor = async (
    event: LeaderEvent,
    increasesExposure: boolean,
    dispatchBaseGroup: CopyGroupConfig = group,
  ): Promise<{
    dispatchGroup: CopyGroupConfig;
    ineligibleAccounts: ReadonlyMap<number, string>;
    unsafeDivergenceAccounts: number[];
    exitOnlyAccounts: number[];
  }> => {
    const at = event.receivedAt;
    if (event.kind !== 'submitted' && event.kind !== 'filled') {
      return {
        dispatchGroup: dispatchBaseGroup,
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
        dispatchGroup: dispatchBaseGroup,
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
      safety.managementOnly != null
      || dayLockPending != null
      || ((safety.pauseUntil ?? 0) > at && safety.pauseRule != null)
      || (tradingWindow.enabled
        && tradingWindowStateAt(tradingWindow, event.receivedAt) !== 'inside')
      || blockedLeaderEntryOrderIds.has(event.orderId)
      || staleExitOnlyEventIds.has(event.id)
    );
    const eligibilityIneligible = currentIneligibleAccounts(at);
    const unsafeDivergenceAccounts: number[] = [];
    const exitOnlyAccounts: number[] = [];
    const episodeIsolationByAccount = new Map<number, EpisodeFollowerIsolationEvidence>();
    await Promise.all(dispatchBaseGroup.followers.map(async follower => {
      if (isolationEligibilityState(follower.accountId, at) == null) return;
      const evidence = await authoritativelyIsolateFollowerForEpisode(
        follower.accountId,
        event.symbol,
      );
      if (evidence) episodeIsolationByAccount.set(follower.accountId, evidence);
    }));
    const pendingReadSkipAccounts = new Set<number>();
    const pendingReadUnsafeAccounts = new Map<number, string>();
    const conditionalMirrorCandidates = new Map<number, string[]>();
    if (event.orderType === 'Market' && gate.armed && !gate.shadowMode) {
      await Promise.all(dispatchBaseGroup.followers.map(async follower => {
        const modeAcceptsEvent = event.kind === 'filled'
          ? follower.mode === 'on-fill'
          : follower.mode === 'on-submit';
        if (!modeAcceptsEvent || follower.enabled === false || follower.mode === 'off') return;
        const {
          expectedPreNet,
          oppositePendingCandidates,
          candidates,
        } = s1bCandidatesFor(event, follower);
        // Každý opačný pending je součást rozhodnutí. U více kandidátů nelze
        // jedním order lookupem doložit, který z nich už pozici změnil; větev
        // proto zůstává fail-closed jako před V12 a neposílá přímý exit.
        if (candidates.length === 0) return;
        if (candidates.length !== 1) {
          pendingReadUnsafeAccounts.set(follower.accountId, 'více pending kopií vyžaduje fail-closed');
          return;
        }
        const ingressBaseline = s1bIngressVersion;
        const settlementStartedAt = performance.now();
        const initialRead = performPendingCopyAndPositionRead(
          follower.accountId,
          event.symbol,
          candidates[0],
          expectedPreNet,
        );
        let targeted = await pendingReadWithin(
          initialRead,
          oppositePendingCandidates.length > 0 ? 1_000 : 1_500,
        );
        if (targeted.kind === 'unverified') {
          const settlementDeadlineAt = settlementStartedAt + 3_000;
          const lateRead = initialRead.then(result => (
            result.kind === 'unverified'
              ? new Promise<never>(() => undefined)
              : result
          ));
          targeted = await Promise.race([
            lateRead,
            waitForS1bStreamResolution(
              follower.accountId,
              event.symbol,
              candidates[0],
              expectedPreNet,
              ingressBaseline,
              settlementDeadlineAt,
            ),
          ]);
        }
        if (targeted.kind === 'filled-synced' || targeted.kind === 'working-matched') {
          clearPendingFollowerMagnitudeCheck(follower.accountId, event.symbol);
          clearPendingFollowerTransition(followerTransitionKey(follower.accountId, event.symbol));
          return;
        }
        const shouldCancelWorking = targeted.order != null
          && isOpenOrderStatus(targeted.order.status)
          && targeted.kind === 'working-flat'
          && (
            targeted.freshNet === 0
            || Math.sign(targeted.freshNet ?? 0) === (targeted.order.side === 'Buy' ? 1 : -1)
          );
        let suppressionConfirmedByPostCancel = false;
        if (shouldCancelWorking) {
          let cancelError: Error | null = null;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const postCancelBaseline = s1bIngressVersion;
          try {
            // Jediný risk-snižující write. Při nejasném výsledku se nikdy
            // neopakuje naslepo; účet zůstane v unsafe mapě a skupina haltne.
            await Promise.race([
              dispatchBroker(safetyGeneration, event).cancelOrder(follower.accountId, candidates[0]),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('S1b cancel deadline 1000 ms')),
                  1_000,
                );
              }),
            ]);
          } catch (reason) {
            cancelError = errorOf(reason);
          } finally {
            clearTimeout(timer);
          }
          // ACK cancelu není důkaz nevyplnění. Po úspěchu i chybě následuje
          // právě jedno read-only čtení téže kopie a pozice; write se neopakuje.
          const postCancelStartedAt = performance.now();
          let postCancel = await readPendingCopyAndPosition(
            follower.accountId,
            event.symbol,
            candidates[0],
            expectedPreNet,
            1_000,
            true,
          );
          if (postCancel.kind !== 'filled-synced' && postCancel.kind !== 'terminal-zero-fill') {
            postCancel = await waitForS1bStreamResolution(
              follower.accountId,
              event.symbol,
              candidates[0],
              expectedPreNet,
              postCancelBaseline,
              postCancelStartedAt + 3_000,
            );
          }
          if (postCancel.kind === 'filled-synced') {
            clearPendingFollowerMagnitudeCheck(follower.accountId, event.symbol);
            clearPendingFollowerTransition(followerTransitionKey(follower.accountId, event.symbol));
            return;
          }
          if (postCancel.kind !== 'terminal-zero-fill') {
            s1bUnresolvedCopyOrderIds.set(candidates[0], {
              accountId: follower.accountId,
              symbol: event.symbol,
              leaderEventId: event.id,
            });
            pendingReadUnsafeAccounts.set(
              follower.accountId,
              postCancel.reason
                ?? (cancelError
                  ? `cancel pending kopie měl nejasný výsledek: ${cancelError.message}`
                  : 'postkontrola cancelu nepotvrdila zero-fill terminal'),
            );
            return;
          }
          const currentEpoch = leaderExposureEpoch(event.symbol);
          s1bCanceledZeroFillOrderIds.set(candidates[0], {
            accountId: follower.accountId,
            symbol: event.symbol,
            epochId: currentEpoch?.id ?? null,
          });
          s1bUnresolvedCopyOrderIds.delete(candidates[0]);
          const currentEpochEntryOrderId = currentEpoch?.leaderEntryOrderIds[0];
          if (
            currentEpoch?.phase === 'open'
            && currentEpochEntryOrderId
            && postCancel.accountAllFlat === true
            && postCancel.noWorkingOrders === true
            && postCancel.observationVersion
              === (tradeObservationVersionByAccount.get(follower.accountId) ?? 0)
            && !pendingIsolationCommandForAccount(follower.accountId)
          ) {
            intentionalEntrySuppressions.set(intentionalSuppressionKey(
              follower.accountId,
              event.symbol,
            ), {
              allowedNet: 0,
              createdAt: clock(),
              leaderOrderId: currentEpochEntryOrderId,
              epochId: currentEpoch.id,
              observationVersion: postCancel.observationVersion,
              zeroEvidence: true,
            });
            suppressionConfirmedByPostCancel = true;
          }
          options.onAudit?.([{
            at: clock(),
            leaderEventId: event.id,
            kind: 'canceled',
            accountId: follower.accountId,
            brokerOrderId: candidates[0],
            reason: 'V12: postkontrola potvrdila canceled/rejected kopii s nulovým fillem',
          }]);
          targeted.kind = 'terminal-zero-fill';
        }
        if (targeted.kind === 'terminal-zero-fill') {
          const currentEpochEntryOrderId = leaderExposureEpoch(event.symbol)?.leaderEntryOrderIds[0];
          if (
            !currentEpochEntryOrderId
            || (!suppressionConfirmedByPostCancel && !await authoritativelyConfirmSuppression(
              follower.accountId,
              event.symbol,
              currentEpochEntryOrderId,
            ))
          ) {
            pendingReadUnsafeAccounts.set(
              follower.accountId,
              'po cancelu pending vstupu chybí autoritativní flat/no-working/no-pending důkaz',
            );
            return;
          }
          pendingReadSkipAccounts.add(follower.accountId);
          ineligibleAccounts.set(follower.accountId, 'pending-entry-copy-canceled-before-exit');
          return;
        }
        if (targeted.kind === 'unverified') {
          s1bUnresolvedCopyOrderIds.set(candidates[0], {
            accountId: follower.accountId,
            symbol: event.symbol,
            leaderEventId: event.id,
          });
        }
        pendingReadUnsafeAccounts.set(
          follower.accountId,
          targeted.reason ?? 'cílené čtení nepotvrdilo bezpečnou follower expozici',
        );
      }));
    }
    const followers = dispatchBaseGroup.followers.map(follower => {
      const cut = activeFollowerCut(follower.accountId, at);
      const letRunCut = cut != null && effectiveFollowerCutAction(cut, follower) === 'let-run';
      const modeAcceptsEvent = (event.kind === 'filled' && follower.mode === 'on-fill')
        || (event.kind === 'submitted' && follower.mode === 'on-submit');
      if (!modeAcceptsEvent || follower.enabled === false || (cut && !letRunCut)) {
        return follower;
      }
      if (pendingReadSkipAccounts.has(follower.accountId)) {
        return { ...follower, mode: 'off' as const };
      }
      const pendingReadFailure = pendingReadUnsafeAccounts.get(follower.accountId);
      if (pendingReadFailure) {
        unsafeDivergenceAccounts.push(follower.accountId);
        ineligibleAccounts.set(
          follower.accountId,
          `pending-copy-read-failed:${pendingReadFailure}`,
        );
        return { ...follower, mode: 'off' as const };
      }
      const positionSnapshot = positionsByAccount.get(follower.accountId);
      // Reconciliation ukládá autoritativní mapu účtu; chybějící symbol v
      // existující mapě znamená flat, nikoli „neznámý“. Jinak by follower,
      // kterému pauza zablokovala entry z flat, dostal pozdější Sell exit a
      // otevřel se do shortu.
      const hasPositionSnapshot = positionSnapshot != null;
      const followerNet = positionSnapshot?.get(event.symbol) ?? 0;
      const expectedPreNet = Math.trunc(preNet * follower.multiplier);
      const pendingExposure = currentRuntimePendingNet(
        follower.accountId,
        event.symbol,
        followerNet,
        expectedPreNet,
        event.orderId,
      );
      const pendingNet = pendingExposure.net;
      const conditionalSourceOrderIds = [...new Set([
        ...pendingExposure.zeroFillMirrorOrderIds,
        ...pendingExposure.marketPendingOrderIds,
      ])];
      if (conditionalSourceOrderIds.length > 0) {
        conditionalMirrorCandidates.set(
          follower.accountId,
          conditionalSourceOrderIds,
        );
      }
      const actualPositionHasCurrentLineage = followerNet === 0
        || copiedEntryLineage(follower.accountId, event.symbol, followerNet);
      const exactCurrentPendingExposure = hasPositionSnapshot
        && !pendingExposure.invalidEvidence
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
        pendingExposure.invalidEvidence
          ? true
          : event.orderType === 'Market'
            && followerNet !== expectedPreNet
            && pendingExposure.filledLeaderWorkingLimit
          ? true
          : pendingNet !== 0
          ? !exactCurrentPendingExposure
          : followerNet !== expectedPreNet
      );
      const suppressionKey = intentionalSuppressionKey(follower.accountId, event.symbol);
      let suppression = currentIntentionalSuppression(follower.accountId, event.symbol) ?? undefined;
      if (
        suppression
        && increasesExposure
        && preNet === 0
        && suppression.leaderOrderId !== event.orderId
      ) {
        // Nový vstup z leader flat je začátek nové epizody ještě předtím,
        // než dorazí Position projekce. Stará výjimka nesmí tento vstup
        // ani jeho pozdější exit zdědit.
        intentionalEntrySuppressions.delete(suppressionKey);
        suppression = undefined;
      }
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
      const episodeIsolation = episodeIsolationByAccount.get(follower.accountId);
      const documentedEpisodeIsolation = episodeIsolation != null
        && episodeIsolation.epochId === leaderExposureEpoch(event.symbol)?.id
        && episodeIsolation.symbol === event.symbol
        && followerNet === 0;
      const unresolvedEligibilityIsolation = eligibilityIneligible.has(follower.accountId)
        && !documentedEpisodeIsolation;
      if (
        (unresolvedEligibilityIsolation || (divergedFromLeaderTarget && !documentedSuppression))
        && !letRunCut
        && !entryRestrictionActive
        && !documentedEpisodeIsolation
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
      if (documentedEpisodeIsolation) return follower;
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
    const safeConditionalCandidates = new Map(
      [...conditionalMirrorCandidates].filter(([accountId]) => (
        !pendingReadSkipAccounts.has(accountId)
        && !pendingReadUnsafeAccounts.has(accountId)
        && !unsafeDivergenceAccounts.includes(accountId)
      )),
    );
    if (safeConditionalCandidates.size > 0) {
      const merged = conditionalMirrorSourcesByLeaderEvent.get(event.id) ?? new Map<number, string[]>();
      for (const [accountId, sourceOrderIds] of safeConditionalCandidates) {
        merged.set(accountId, sourceOrderIds);
      }
      conditionalMirrorSourcesByLeaderEvent.set(event.id, merged);
    }
    return {
      dispatchGroup: changed ? { ...dispatchBaseGroup, followers } : dispatchBaseGroup,
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
        initialNet: positionsByAccount.get(order.request.accountId)?.get(order.request.symbol) ?? 0,
        filled: 0,
        groupKey: dispatched.brokerOrderId,
      });
    }
  };

  const sweepExitOnlyReservationsAtFlat = async (
    accountId: number,
    symbol: string,
    at: number,
    sharedBudget?: FlatSweepBudget,
  ): Promise<void> => {
    const reservedIds = [...exitOnlyReservations]
      .filter(([, reservation]) => (
        reservation.accountId === accountId && reservation.symbol === symbol
      ))
      .map(([brokerOrderId]) => brokerOrderId);
    if (reservedIds.length === 0) return;
    const budget = sharedBudget ?? createFlatSweepBudget();
    try {
      const streamStatuses = await streamSweepStatuses(accountId, reservedIds);
      const streamTerminal = new Map([...streamStatuses].filter(([, lookup]) => (
        !isOpenOrderStatus(lookup.status)
      )));
      for (const [brokerOrderId, lookup] of streamTerminal) {
        recordTerminalSweepState(accountId, brokerOrderId, lookup.status);
      }
      const unresolvedIds = reservedIds.filter(id => !streamTerminal.has(id));
      if (unresolvedIds.length === 0) return;

      const orders = await withFlatSweepBudget(
        budget,
        'globální seznam exit-only orderů ' + accountId,
        () => broker.listOrders(accountId),
      );
      const byId = new Map(orders.map(order => [order.brokerOrderId, order]));
      const failures: string[] = [];
      const workingIds: string[] = [];
      for (const brokerOrderId of unresolvedIds) {
        const order = byId.get(brokerOrderId);
        if (order?.status === 'filled') {
          exitOnlyPositionApplied.add(brokerOrderId);
          continue;
        }
        if (order && !isOpenOrderStatus(order.status)) {
          recordTerminalSweepState(accountId, brokerOrderId, order.status);
          continue;
        }
        if (!order) {
          failures.push(brokerOrderId + ': broker order chybí');
          continue;
        }
        workingIds.push(brokerOrderId);
      }
      {
        const cancelErrors = new Map<string, Error>();
        const tombstonedWorkingIds = workingIds.filter(id => flatSweepCancelAttempts.has(id));
        if (tombstonedWorkingIds.length > 0) {
          const positions = await withFlatSweepBudget(
            budget,
            'kontrola exit-only pozice před novým cancelem ' + accountId + '/' + symbol,
            () => broker.listPositions(accountId),
          );
          const netQuantity = positions.find(position => position.symbol === symbol)?.netQuantity ?? 0;
          if (netQuantity !== 0) {
            throw new Error('broker stále hlásí pozici ' + netQuantity + ' před novým cancelem');
          }
          for (const brokerOrderId of tombstonedWorkingIds) {
            flatSweepCancelAttempts.delete(brokerOrderId);
            flatSweepCancelAttemptAccounts.delete(brokerOrderId);
          }
        }
        for (const brokerOrderId of workingIds) {
          flatSweepCancelAttempts.add(brokerOrderId);
          flatSweepCancelAttemptAccounts.set(brokerOrderId, accountId);
        }
        await Promise.all(workingIds.map(async brokerOrderId => {
          try {
            await withFlatSweepCancelDeadline(
              accountId,
              brokerOrderId,
              () => broker.cancelOrder(accountId, brokerOrderId),
            );
          } catch (reason) {
            cancelErrors.set(brokerOrderId, errorOf(reason));
          }
        }));
        const [positions, postOrders] = await Promise.all([
          withFlatSweepBudget(
            budget,
            'postkontrola exit-only pozice ' + accountId + '/' + symbol,
            () => broker.listPositions(accountId),
          ),
          withFlatSweepBudget(
            budget,
            'postkontrola exit-only orderů ' + accountId,
            () => broker.listOrders(accountId),
          ),
        ]);
        const netQuantity = positions.find(position => position.symbol === symbol)?.netQuantity ?? 0;
        if (netQuantity !== 0) failures.push('broker stále hlásí pozici ' + netQuantity);
        const postById = new Map(postOrders.map(order => [order.brokerOrderId, order]));
        for (const brokerOrderId of workingIds) {
          const order = postById.get(brokerOrderId);
          if (order && isOpenOrderStatus(order.status)) {
            const cancelDetail = cancelErrors.get(brokerOrderId)?.message;
            failures.push(
              brokerOrderId + ': '
              + (cancelDetail ? 'nejasný cancel (' + cancelDetail + '), ' : '')
              + 'po cancelu stále ' + order.status,
            );
            continue;
          }
          recordTerminalSweepState(accountId, brokerOrderId, order?.status ?? null);
          options.onAudit?.([{
            at,
            leaderEventId: 'exit-only-flat-sweep:' + accountId + ':' + brokerOrderId,
            kind: 'canceled',
            accountId,
            brokerOrderId,
            reason: 'follower je flat — zbývající exit-only příkaz autoritativně nepracuje',
          }]);
        }
      }
      if (failures.length > 0) throw new Error(failures.join(', '));
    } catch (reason) {
      failClosed(new Error(
        'Copier fail-closed: exit-only sweep ' + accountId + '/' + symbol
        + ' selhal (' + errorOf(reason).message + ')',
      ), { autoClose: false });
    }
  };

  interface FlatSweepIngressWave {
    dispatchVersion: number;
    loadOrders: (accountId: number) => Promise<readonly BrokerOrder[]>;
  }
  type FlatSweepOrderLoadResult =
    | { ok: true; orders: readonly BrokerOrder[] }
    | { ok: false; error: Error };

  let ingressFlatSweepWave: FlatSweepIngressWave | null = null;
  let ingressFlatSweepWaveTimer: ReturnType<typeof setTimeout> | undefined;
  const currentFlatSweepIngressWave = (): FlatSweepIngressWave => {
    if (ingressFlatSweepWave) return ingressFlatSweepWave;
    let loads: Map<number, Promise<FlatSweepOrderLoadResult>> | null = null;
    const loadAccountOrders = (accountId: number): Promise<FlatSweepOrderLoadResult> => (
      broker.listOrders(accountId).then(
        orders => ({ ok: true as const, orders }),
        reason => ({ ok: false as const, error: errorOf(reason) }),
      )
    );
    const wave: FlatSweepIngressWave = {
      dispatchVersion: dispatchObservationVersion,
      async loadOrders(accountId) {
        if (wave.dispatchVersion !== dispatchObservationVersion) {
          return broker.listOrders(accountId);
        }
        if (!loads) {
          // listOrders je u Tradovate globální graf filtrovaný až v adapteru.
          // Souběžný start celé follower vlny proto využije jeho in-flight
          // dedupe a stáhne graf jednou, nikoli jednou na každý flat event.
          loads = new Map(group.followers.map(follower => [
            follower.accountId,
            loadAccountOrders(follower.accountId),
          ]));
        }
        const load = loads.get(accountId) ?? loadAccountOrders(accountId);
        const result = await load;
        if ('error' in result) throw result.error;
        // Dispatch mohl proběhnout během in-flight globálního čtení. Takový
        // snapshot nesmí klasifikovat právě vytvořené nohy jako terminální.
        if (wave.dispatchVersion !== dispatchObservationVersion) {
          return broker.listOrders(accountId);
        }
        return result.orders;
      },
    };
    ingressFlatSweepWave = wave;
    clearTimeout(ingressFlatSweepWaveTimer);
    ingressFlatSweepWaveTimer = setTimeout(() => {
      if (ingressFlatSweepWave === wave) ingressFlatSweepWave = null;
    }, 0);
    return wave;
  };

  const routeGapPositionShape = (positions: readonly BrokerPosition[]) => positions
    .filter(position => position.netQuantity !== 0)
    .map(position => `${position.symbol}:${position.netQuantity}`)
    .sort();
  const routeGapOrderShape = (orders: readonly BrokerOrder[]) => orders
    .filter(order => isOpenOrderStatus(order.status))
    .map(order => [
      order.brokerOrderId,
      order.symbol,
      order.side,
      order.orderType,
      order.quantity,
      order.filledQuantity,
      order.limitPrice ?? '',
      order.stopPrice ?? '',
      order.parentOrderId ?? '',
      order.ocoId ?? '',
      order.linkedOrderId ?? '',
    ].join(':'))
    .sort();

  /**
   * Porovná autoritativní route snapshot s modelem před mezerou a teprve
   * potom cache přepíše čerstvými daty. Neprovádí žádný broker read/write;
   * V12 pending lineage si svůj jediný read-only refresh plánuje zvlášť přes
   * `scheduleRouteEpochRefresh` nad stejným routeEpoch bumpem.
   */
  const controllerCopyOrderIds = (accountId: number): string[] => {
    const live = currentRuntime();
    const ids: string[] = [];
    for (const entry of live.outbox.values()) {
      if (entry.request.accountId === accountId && entry.brokerOrderId) ids.push(entry.brokerOrderId);
    }
    for (const entry of [...live.bracketOutbox.values(), ...live.osoOutbox.values()]) {
      if (entry.request.accountId !== accountId) continue;
      const legs: Array<string | undefined> = [
        'entryBrokerOrderId' in entry ? entry.entryBrokerOrderId as string | undefined : undefined,
        entry.firstBrokerOrderId, entry.secondBrokerOrderId,
      ];
      for (const id of legs) if (id) ids.push(id);
    }
    for (const links of live.state.links.values()) {
      for (const link of links) if (link.accountId === accountId) ids.push(link.brokerOrderId);
    }
    return ids;
  };

  const applyRouteGapSnapshot = (
    event: Extract<BrokerEvent, { type: 'connection' }>,
  ): string | null => {
    const snapshot = event.resync;
    if (!snapshot) return 'route-gap-divergence: resync neobsahuje autoritativní snapshot';
    if (snapshot.complete === false) {
      return `route-gap-divergence: resync snapshot není autoritativní${snapshot.failureReason ? ` (${snapshot.failureReason})` : ''}`;
    }
    const groupAccounts = new Set([
      group.leaderAccountId,
      ...group.followers.map(follower => follower.accountId),
    ].filter((accountId): accountId is number => accountId != null));
    const accountIds = [...new Set(snapshot.accountIds.filter(accountId => groupAccounts.has(accountId)))];
    const declared = new Set(snapshot.accountIds);
    const foreignEntity = [...snapshot.positions, ...snapshot.orders, ...snapshot.gapFills]
      .find(item => !declared.has(item.accountId));
    const differences: string[] = foreignEntity
      ? [`snapshot obsahuje nedeklarovaný účet ${foreignEntity.accountId}`]
      : [];
    if (accountIds.length === 0) differences.push('snapshot neobsahuje žádný účet aktivní skupiny');

    const leaderGapFill = snapshot.gapFills.find(fill => fill.accountId === group.leaderAccountId);
    if (leaderGapFill) {
      differences.push(`leader gap fill ${leaderGapFill.fillId} order ${leaderGapFill.brokerOrderId}`);
    }
    const firstSeenLeaderGapFill = leaderGapFill && (
      !liveOrdersByAccount.get(leaderGapFill.accountId)?.has(leaderGapFill.brokerOrderId)
      && !observedOrderStatusesByAccount.get(leaderGapFill.accountId)?.has(leaderGapFill.brokerOrderId)
    ) ? leaderGapFill : undefined;
    if (firstSeenLeaderGapFill) {
      differences.push(
        `leader příkaz ${firstSeenLeaderGapFill.brokerOrderId} je poprvé viditelný až jako filled (${firstSeenLeaderGapFill.fillId})`,
      );
    }

    for (const accountId of accountIds) {
      const previousPositions = positionsByAccount.get(accountId);
      const previousOrders = liveOrdersByAccount.get(accountId);
      if (!previousPositions || !previousOrders) {
        differences.push(`účet ${accountId} nemá úplný lokální model před mezerou`);
        continue;
      }
      const actualPositions = snapshot.positions.filter(position => position.accountId === accountId);
      const actualOrders = snapshot.orders.filter(order => order.accountId === accountId);
      // D1 (review 30. 9.): skutečný reconnect přichází i uprostřed obchodu.
      // Follower, jehož pozice se v mezeře změnila (typicky fill zkopírovaného
      // SL nebo kopie odeslané těsně před výpadkem), je v pořádku jen tehdy,
      // když teď přesně odpovídá cíli podle živého leadera. Order vyplněný
      // v mezeře už mezi pracovními být nemá.
      const gapFilledOrderIds = new Set(snapshot.gapFills
        .filter(fill => fill.accountId === accountId && accountId !== group.leaderAccountId)
        .map(fill => fill.brokerOrderId));
      const expectedPositionShape = routeGapPositionShape(
        [...previousPositions].map(([symbol, netQuantity]) => ({ accountId, symbol, netQuantity })),
      );
      const actualPositionShape = routeGapPositionShape(actualPositions);
      const gapFollower = group.followers.find(item => item.accountId === accountId);
      // Vysvětlit smí jen filly orderů, které kopírka zná (model před mezerou,
      // dřív viděné ordery, vlastní kopie). Cizí fill (ruční obchod) nebo
      // vyřazený follower se zápornou výjimkou zůstává rozdílem.
      const knownGapOrderIds = new Set([
        ...previousOrders.keys(),
        ...(observedOrderStatusesByAccount.get(accountId)?.keys() ?? []),
        ...controllerCopyOrderIds(accountId),
      ]);
      const matchesLiveLeader = gapFollower != null
        && gapFollower.enabled !== false
        && gapFollower.mode !== 'off'
        && !currentIneligibleAccounts().has(accountId)
        && !activeFollowerCut(accountId)
        && snapshot.gapFills
          .filter(fill => fill.accountId === accountId)
          .every(fill => knownGapOrderIds.has(fill.brokerOrderId))
        && ![...new Set([...previousPositions.keys(), ...actualPositions.map(item => item.symbol)])]
          .some(symbol => currentIntentionalSuppression(accountId, symbol) != null)
        && [...new Set([...leaderPositions.keys(), ...actualPositions.map(item => item.symbol)])]
          .every(symbol => (
            (actualPositions.find(item => item.symbol === symbol)?.netQuantity ?? 0)
            === Math.trunc((leaderPositions.get(symbol) ?? 0) * gapFollower.multiplier)
          ));
      if (JSON.stringify(expectedPositionShape) !== JSON.stringify(actualPositionShape) && !matchesLiveLeader) {
        differences.push(
          `účet ${accountId} pozice model=${expectedPositionShape.join(',') || 'flat'} broker=${actualPositionShape.join(',') || 'flat'}`,
        );
      }
      const expectedOrderShape = routeGapOrderShape(
        [...previousOrders.values()].filter(order => !gapFilledOrderIds.has(order.brokerOrderId)),
      );
      const actualOrderShape = routeGapOrderShape(actualOrders);
      if (JSON.stringify(expectedOrderShape) !== JSON.stringify(actualOrderShape)) {
        differences.push(
          `účet ${accountId} working ordery model=${expectedOrderShape.join(',') || 'žádné'} broker=${actualOrderShape.join(',') || 'žádné'}`,
        );
      }
    }

    // Cache po porovnání vždy odpovídá read-only broker důkazu. Případný
    // failClosed tak nesmí chybně tvrdit, že divergentní účet je flat.
    for (const accountId of accountIds) {
      positionsByAccount.set(accountId, new Map(
        snapshot.positions
          .filter(position => position.accountId === accountId)
          .map(position => [position.symbol, position.netQuantity]),
      ));
      rememberLiveOrderSnapshot(
        accountId,
        snapshot.orders.filter(order => order.accountId === accountId),
      );
      if (snapshot.orders.some(order => order.accountId === accountId && isOpenOrderStatus(order.status))) {
        workingOrderAccounts.add(accountId);
      } else {
        workingOrderAccounts.delete(accountId);
      }
    }
    lastBrokerPositionAt = event.at;
    return differences.length > 0 ? `route-gap-divergence: ${differences.join('; ')}` : null;
  };

  /**
   * A2 (review 30. 9.): nulová výjimka vyřazeného followera je vázaná na
   * verzi obchodních událostí účtu. Neškodná událost, která flat stav
   * nemění (Position 0, pozdní echo odmítnutého/zrušeného orderu bez fillu),
   * ji nesmí zneplatnit, jinak nový SL/TP leadera nedostane nikdo a skupina
   * se vypne. Posouvá se jen o právě jednu událost, fill nikdy.
   */
  const restampZeroSuppressionAfterBenignIngress = (
    event: BrokerEvent,
    ingressObservationVersion: number | undefined,
  ): void => {
    if (ingressObservationVersion == null) return;
    const accountId = event.type === 'position'
      ? event.position.accountId
      : event.type === 'order'
        ? event.order.accountId
        : null;
    if (accountId == null || accountId === group.leaderAccountId) return;
    // Order je neškodný jen jako canceled/rejected bez fillu u příkazu, který
    // controller už zná (dřív viděný order nebo vlastní odmítnutá kopie).
    // Nikdy `filled` a nikdy první výskyt orderu: Tradovate Order(Filled)
    // může přijít dřív než jeho Fill, tedy ještě s filledQuantity 0.
    const knownOrder = (order: BrokerOrder): boolean => (
      observedOrderStatusesByAccount.get(order.accountId)?.has(order.brokerOrderId) === true
      || [...currentRuntime().outbox.values()].some(entry => (
        entry.request.accountId === order.accountId
        && entry.brokerOrderId === order.brokerOrderId
        && (entry.status === 'rejected' || entry.status === 'waived')
      ))
    );
    const benign = event.type === 'position'
      ? event.position.netQuantity === 0
      : event.type === 'order'
        && (event.order.status === 'canceled' || event.order.status === 'rejected')
        && (event.order.filledQuantity ?? 0) === 0
        && knownOrder(event.order);
    if (!benign) return;
    const prefix = intentionalSuppressionKey(accountId, '');
    for (const [key, suppression] of intentionalEntrySuppressions) {
      if (!key.startsWith(prefix)) continue;
      if (suppression.allowedNet !== 0 || !suppression.zeroEvidence) continue;
      if (suppression.observationVersion !== ingressObservationVersion - 1) continue;
      intentionalEntrySuppressions.set(key, { ...suppression, observationVersion: ingressObservationVersion });
    }
  };

  const flushDeferredStaleFailClosed = (): void => {
    const error = deferredStaleFailClosed;
    deferredStaleFailClosed = null;
    if (!error) return;
    if (gate.armed) failClosed(error, { autoClose: false });
    else invalidateReconciliation();
  };

  const handleBrokerEvent = async (
    event: BrokerEvent,
    admissionGeneration: number,
    eventReceivedAt: number,
    flatSweepIngressWave?: FlatSweepIngressWave,
    ingressObservationVersion?: number,
  ) => {
    if (stopped) return;
    restampZeroSuppressionAfterBenignIngress(event, ingressObservationVersion);
    const now = clock();
    if (event.type === 'order') rememberLiveOrder(event.order);
    scheduleRouteEpochRefresh();
    if (event.type === 'heartbeat') {
      gate = { ...gate, lastHeartbeatAt: event.at };
      ensureLeaderFlatEpochWatchdogs();
      await maybeHandleArmExpiry(now);
      await evaluateDailyRules(now);
      scheduleAccountRiskPoll(
        [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)],
      );
      await maybeReleaseManualTradeCuts(0);
      scheduleArmPreparation();
      return;
    }
    if (event.type === 'error') {
      currentRuntimePendingExposure.clear();
      seenCurrentRuntimePendingFillIds.clear();
      conditionalMirrorSourcesByLeaderEvent.clear();
      s1bIngressOrders.clear();
      s1bIngressFillQuantities.clear();
      s1bIngressPositions.clear();
      s1bCanceledZeroFillOrderIds.clear();
      s1bUnresolvedCopyOrderIds.clear();
      failClosed(event.error, { transportLost: true });
      return;
    }
    if (event.type === 'connection') {
      // Snapshot po skutečném reconnectu, jehož disconnect controller viděl
      // (přímý broker bez routeru), je obyčejné obnovení spojení s plnou
      // reconnect recovery; snapshot sám nic neautorizuje.
      if (event.connected && event.resynced && !(event.reconnected && !gate.connected)) {
        // Scoped resync není důkaz agregovaného spojení. Router jej za
        // odpojeného leadera zahazuje; controller drží stejnou fail-closed
        // hranici i pro přímý/legacy broker.
        if (!gate.connected) return;
        const wasArmed = gate.armed;
        source.connection(true);
        gate = { ...gate, lastHeartbeatAt: now };
        const divergence = applyRouteGapSnapshot(event);
        scheduleRouteEpochRefresh();
        if (divergence) {
          const needsStatefulRecovery = hasFollowerExposure();
          if (needsStatefulRecovery) {
            pendingConnectionRecovery = true;
            pendingReadOnlyConnectionRecovery = false;
          }
          if (wasArmed) failClosed(new Error(`Copier fail-closed: ${divergence}`), { autoClose: false });
          else {
            lastError = new Error(`Copier fail-closed: ${divergence}`);
            invalidateReconciliation();
            options.onError?.(lastError);
          }
          if (needsStatefulRecovery) scheduleConnectionRecovery();
        }
        return;
      }
      connectionSyncGeneration += 1;
      const wasArmed = gate.armed;
      const needsStatefulRecovery = wasArmed && !gate.shadowMode && hasFollowerExposure();
      if (!event.connected) {
        currentRuntimePendingExposure.clear();
        seenCurrentRuntimePendingFillIds.clear();
        conditionalMirrorSourcesByLeaderEvent.clear();
        s1bIngressOrders.clear();
        s1bIngressFillQuantities.clear();
        s1bIngressPositions.clear();
        s1bCanceledZeroFillOrderIds.clear();
        s1bUnresolvedCopyOrderIds.clear();
      }
      // Výpadek za živého ARM s otevřenými kopiemi → po reconnectu se
      // rozhodne „podle stavu" (držet synchronní / zavřít osiřelé).
      if (!event.connected && needsStatefulRecovery) {
        pendingConnectionRecovery = true;
        pendingReadOnlyConnectionRecovery = false;
      } else if (!event.connected && !pendingConnectionRecovery) {
        pendingReadOnlyConnectionRecovery = true;
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
      // Skutečný disconnect dál zneplatní preflight a vyžaduje plnou
      // recovery. Plánovaný `resynced` skončil v account-scoped větvi výše
      // a při shodě modelu ARM zachoval.
      if (!event.connected || source.needsReconciliation()) {
        leaderPositionSnapshotComplete = false;
        invalidateReconciliation();
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
          ) {
            pendingConnectionRecovery = true;
            pendingReadOnlyConnectionRecovery = false;
          } else if (!pendingConnectionRecovery) {
            // Čistý start workeru je stejný problém jako obyčejný reconnect:
            // bez automatického fresh snapshotu by po každém restartu zůstal
            // ARM zbytečně blokovaný až do ruční „Kontroly pozic“.
            pendingReadOnlyConnectionRecovery = true;
          }
        }
        if (pendingConnectionRecovery || pendingReadOnlyConnectionRecovery) {
          scheduleConnectionRecovery();
        }
      }
      return;
    }
    await maybeHandleArmExpiry(now);
    if (rollEligibilityToNewSession(now)) await persistEligibility();
    await evaluateDailyRules(now);
    observeCurrentRuntimePendingExposure(event);
    if (
      event.type === 'fill'
      && event.fill.accountId !== group.leaderAccountId
      && s1bCanceledZeroFillOrderIds.has(event.fill.brokerOrderId)
    ) {
      s1bCanceledZeroFillOrderIds.delete(event.fill.brokerOrderId);
      failClosed(new Error(
        `Copier fail-closed: S1b zero-fill cancel kopie ${event.fill.brokerOrderId} dostal pozdější fill`,
      ), { autoClose: false });
    }
    if (event.type === 'fill' && event.fill.accountId !== group.leaderAccountId) {
      const unresolved = s1bUnresolvedCopyOrderIds.get(event.fill.brokerOrderId);
      if (unresolved && (leaderPositions.get(unresolved.symbol) ?? 0) === 0) {
        s1bUnresolvedCopyOrderIds.delete(event.fill.brokerOrderId);
        failClosed(new Error(
          `Copier fail-closed: osiřelý fill S1b kopie ${event.fill.brokerOrderId} `
          + `po leader flat (${unresolved.leaderEventId})`,
        ));
      }
    }
    if (event.type === 'order' && !isOpenOrderStatus(event.order.status)) {
      if (event.order.accountId === group.leaderAccountId) {
        for (const [sourceOrderId, conditional] of conditionalMirrorWritesBySourceOrder) {
          if (conditional.leaderOrderId === event.order.brokerOrderId) {
            conditionalMirrorWritesBySourceOrder.delete(sourceOrderId);
          }
        }
      } else {
        const unresolved = s1bUnresolvedCopyOrderIds.get(event.order.brokerOrderId);
        if (unresolved && (event.order.status === 'canceled' || event.order.status === 'rejected')
          && event.order.filledQuantity === 0) {
          s1bUnresolvedCopyOrderIds.delete(event.order.brokerOrderId);
        }
        for (const [sourceOrderId, conditional] of conditionalMirrorWritesBySourceOrder) {
          conditional.dependentOrderIds.delete(event.order.brokerOrderId);
          if (conditional.dependentOrderIds.size === 0) {
            conditionalMirrorWritesBySourceOrder.delete(sourceOrderId);
          }
        }
        if (event.order.status === 'canceled' || event.order.status === 'rejected') {
          await evaluateConditionalMirrorSource(event.order.brokerOrderId, {
            terminalOrder: event.order,
          });
        }
      }
    }
    if (event.type === 'fill' && event.fill.accountId !== group.leaderAccountId) {
      await evaluateConditionalMirrorSource(event.fill.brokerOrderId, { fill: event.fill });
    }
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
        const explicitPositionAlreadyApplied = exitOnlyPositionApplied.delete(event.fill.brokerOrderId);
        const observedReductionFromInitial = reservation.initialNet !== 0
          && (cachedNet === 0 || Math.sign(cachedNet) === Math.sign(reservation.initialNet))
          && Math.abs(cachedNet) <= Math.abs(reservation.initialNet)
          ? Math.abs(reservation.initialNet) - Math.abs(cachedNet)
          : 0;
        const positionAlreadyApplied = explicitPositionAlreadyApplied
          || observedReductionFromInitial >= reservation.filled + applied;
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
        const suppression = currentIntentionalSuppression(
          reservation.accountId,
          reservation.symbol,
        );
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
        else exitOnlyReservations.set(event.fill.brokerOrderId, {
          ...reservation,
          remaining,
          filled: reservation.filled + event.fill.quantity,
        });
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
    if (
      event.type === 'order' && !isOpenOrderStatus(event.order.status)
      && controllerCopyOrderIds(event.order.accountId).includes(event.order.brokerOrderId)
    ) {
      noteCopierLegTerminal(event.order.brokerOrderId, now);
      requestCopierSettlement(event.order.accountId);
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
      const venueManagedCoverage = knownNet != null && venueManagedProtectiveCoverage({
        link: linked,
        order: event.order,
        positions: [{
          accountId: event.order.accountId,
          symbol: event.order.symbol,
          netQuantity: knownNet,
        }],
      });

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
          const committed = await durableStore.commit(
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
      // Flat je jen podnět: usazení kopie ověří broker REST mimo eventTail.
      if (event.position.netQuantity === 0) requestCopierSettlement(event.position.accountId);
      const accountPositions = positionsByAccount.get(event.position.accountId) ?? new Map<string, number>();
      const previousAccountNet = accountPositions.get(event.position.symbol) ?? 0;
      const transitionKey = followerTransitionKey(event.position.accountId, event.position.symbol);
      const exitOnlyFillReachedFlat = exitOnlyFlatFillAwaitingPosition.delete(transitionKey);
      accountPositions.set(event.position.symbol, event.position.netQuantity);
      positionsByAccount.set(event.position.accountId, accountPositions);
      lastBrokerPositionAt = clock();
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
        // Každý účet dostává minimální REST čas až od začátku svého sweepu.
        // Streamové čtení a první risk-redukující cancel budget nespotřebují.
        const flatSweepBudget = createFlatSweepBudget();
        await sweepFollowerProtectiveLegs(
          event.position.accountId,
          event.position.symbol,
          now,
          {
            ...(protectiveFillCause?.role === 'protective'
              ? { protectiveFillBrokerOrderId: protectiveFillCause.brokerOrderId }
              : {}),
            ...(flatSweepIngressWave
              ? { loadAuthoritativeOrders: () => flatSweepIngressWave.loadOrders(event.position.accountId) }
              : {}),
          },
          flatSweepBudget,
        );
        await sweepExitOnlyReservationsAtFlat(
          event.position.accountId,
          event.position.symbol,
          now,
          flatSweepBudget,
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
        && !leaderFillAheadOfPosition.has(event.position.symbol)
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
          } else if (
            cause.role === 'copied-entry'
            && flatSweepEntryCancelAttempts.has(cause.brokerOrderId)
          ) {
            recentFollowerFillCauses.delete(transitionKey);
            gate = {
              ...gate,
              divergentAccounts: new Set([...gate.divergentAccounts, event.position.accountId]),
            };
            failClosed(new Error(
              `Copier fail-closed: leader je flat a follower ${event.position.accountId} `
              + `${event.position.symbol}:${event.position.netQuantity} otevřel opožděný copied-entry fill `
              + cause.brokerOrderId,
            ));
          } else if (cause.role === 'copied-exit') {
            recentFollowerFillCauses.delete(transitionKey);
            failClosed(new Error(
              `Copier fail-closed: leader je flat a follower ${event.position.accountId} `
              + `${event.position.symbol}:${event.position.netQuantity} otevřel fill zkopírovaného exitu `
              + cause.brokerOrderId,
            ), { autoClose: false });
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
          && follower.enabled !== false
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
        // A successful account-wide snapshot proves flat even when Tradovate
        // omits the symbol. Without it, the first partial fill used to skip the
        // opening transition and reuse a terminal epoch from the previous trade.
        // Disconnect/reconfiguration invalidate this witness; a lone stream row
        // must never establish a zero baseline for other symbols.
        const previousKnown = leaderPositions.has(event.position.symbol) || leaderPositionSnapshotComplete;
        const previousNet = leaderPositions.get(event.position.symbol) ?? 0;
        await handleLeaderPositionTransition(
          event.position.symbol,
          previousKnown,
          previousNet,
          event.position.netQuantity,
          now,
        );
        rememberLeaderPosition(event.position.symbol, event.position.netQuantity);
        for (const follower of group.followers) {
          const followerNet = positionsByAccount.get(follower.accountId)?.get(event.position.symbol) ?? 0;
          const suppression = currentIntentionalSuppression(
            follower.accountId,
            event.position.symbol,
          );
          if (follower.enabled === false
            || follower.mode === 'off'
            || currentIneligibleAccounts().has(follower.accountId)
            || activeFollowerCut(follower.accountId)
            || (suppression != null && followerNet === suppression.allowedNet)) continue;
          const expected = Math.trunc(event.position.netQuantity * follower.multiplier);
          if (event.position.netQuantity !== 0 && followerNet !== expected) {
            scheduleFollowerMagnitudeCheck(follower.accountId, event.position.symbol);
          } else {
            clearPendingFollowerMagnitudeCheck(follower.accountId, event.position.symbol);
          }
          // Incident 5. 10.: Position followera téhož přírůstku dorazila dřív
          // než leaderova a tehdy se nedala potvrdit. Dodatečné potvrzení
          // vyžaduje přísnější důkaz: celá pozice z fillů jediného copier
          // entry orderu aktuální epochy (cizí přírůstek nic nepotvrdí).
          if (event.position.netQuantity !== 0 && followerNet === expected) {
            await strengthenLeaderFlatLineage(follower.accountId, event.position.symbol, followerNet, true);
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
      await maybeReleaseManualTradeCuts();
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
    const leaderEvent = source.observe(event, group.leaderAccountId, sequence, eventReceivedAt);
    if (!leaderEvent) return;
    options.onLeaderEvent?.(leaderEvent);
    // Stabilní klasifikace pro všechny následující větve této události;
    // nesmí se změnit jen proto, že mezitím dorazí Position projekce.
    const eventIncreasesExposure = leaderEventIncreasesExposure(leaderEvent);
    const pendingStaleReversal = staleReversalOrderIds.get(leaderEvent.orderId);
    if (pendingStaleReversal && leaderEvent.kind === 'filled') {
      // I čerstvý fill zpožděného reversalu se kopíruje jen exit-only.
      staleReversalOrderIds.delete(leaderEvent.orderId);
      if (eventIncreasesExposure && leaderReducingQuantityFor(leaderEvent) > 0) {
        staleExitOnlyEventIds.add(leaderEvent.id);
      }
      deferredStaleFailClosed ??= pendingStaleReversal;
    } else if (pendingStaleReversal && (leaderEvent.kind === 'canceled' || leaderEvent.kind === 'rejected')) {
      staleReversalOrderIds.delete(leaderEvent.orderId);
    } else if (pendingStaleReversal && leaderEvent.kind === 'replaced') {
      // Modify by přepočítal exit-only kopii on-submit followerů z celé
      // quantity reversalu a zkopíroval by tak pozdní vstup. Fail-closed
      // ještě před jakýmkoli dispatchem.
      staleReversalOrderIds.delete(leaderEvent.orderId);
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      options.onAudit?.([{
        at: now, leaderEventId: leaderEvent.id, kind: 'blocked',
        reason: `stale-reversal-replaced:${leaderEvent.orderId}`,
      }]);
      const replacedError = new Error(
        'Copier fail-closed: leader změnil zpožděný reversal dřív, než se vyplnil; on-submit followerům odešel jen exit, '
        + 'on-fill followeři exit nedostanou — zkontroluj jejich pozice v Tradovate',
      );
      if (gate.armed) failClosed(replacedError, { autoClose: false });
      else invalidateReconciliation();
      return;
    }
    if (
      eventIncreasesExposure
      && now - leaderEvent.receivedAt > MAX_EXPOSURE_EVENT_AGE_MS
      && leaderReducingQuantityFor(leaderEvent) > 0
    ) {
      // A3: zpožděný reversal. Exit slice je risk-redukující a musí
      // followerům odejít i pozdě (jinak zůstanou v původním směru proti
      // leaderovi); pozdě se nekopíruje jen vstupní část. Fail-closed až
      // po dispatchi exitu, viz `flushDeferredStaleFailClosed`.
      const ageMs = now - leaderEvent.receivedAt;
      staleExitOnlyEventIds.add(leaderEvent.id);
      while (staleExitOnlyEventIds.size > 200) {
        const oldest = staleExitOnlyEventIds.values().next().value as string | undefined;
        if (!oldest) break;
        staleExitOnlyEventIds.delete(oldest);
      }
      options.onAudit?.([{
        at: now,
        leaderEventId: leaderEvent.id,
        kind: 'blocked',
        reason: `stale-exposure-increase-entry-slice:${ageMs}ms`,
      }]);
      const staleError = new Error(
        `Copier fail-closed: stará risk-zvyšující část reversalu leadera (${ageMs} ms) se nebude kopírovat pozdě; followerům odešel jen exit`,
      );
      const hasOnFillFollower = group.followers.some(follower => (
        follower.enabled !== false && follower.mode === 'on-fill'
      ));
      if (leaderEvent.kind === 'submitted' && hasOnFillFollower) {
        staleReversalOrderIds.set(leaderEvent.orderId, staleError);
        while (staleReversalOrderIds.size > 200) {
          const oldest = staleReversalOrderIds.keys().next().value as string | undefined;
          if (!oldest) break;
          staleReversalOrderIds.delete(oldest);
        }
      } else {
        deferredStaleFailClosed ??= staleError;
      }
    } else if (
      eventIncreasesExposure
      && now - leaderEvent.receivedAt > MAX_EXPOSURE_EVENT_AGE_MS
    ) {
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      const ageMs = now - leaderEvent.receivedAt;
      options.onAudit?.([{
        at: now,
        leaderEventId: leaderEvent.id,
        kind: 'blocked',
        reason: `stale-exposure-increase:${ageMs}ms`,
      }]);
      const error = new Error(
        `Copier fail-closed: stará risk-zvyšující událost leadera (${ageMs} ms) se nebude kopírovat pozdě`,
      );
      if (gate.armed) failClosed(error, { autoClose: false });
      else invalidateReconciliation();
      return;
    }
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
        const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
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
          follower.enabled !== false
          && follower.mode === 'on-submit' && linkedAccounts.has(follower.accountId)
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
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
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
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
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
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
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
        const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
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
        const result = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
        runtime = result.runtime;
        if (result.audit.length > 0) options.onAudit?.(result.audit);
        if (result.audit.some(item => item.kind === 'sequence-broken')) {
          failClosed(new Error('Protective leg přišel mimo pořadí'));
          return;
        }
        if (!pendingBracketTimers.has(bracketEntryOrderId)) {
          const timer = setTimeout(() => {
            pendingBracketTimers.delete(bracketEntryOrderId);
            eventTail = eventTail.then(async () => {
              if (!bracketCorrelator.hasPendingPair(bracketEntryOrderId)) return;
              try {
                if (await flushStandaloneBracketStop(bracketEntryOrderId, admissionGeneration)) return;
                options.onAudit?.([{
                  at: clock(), leaderEventId: leaderEvent.id, kind: 'blocked', reason: 'incomplete-bracket-pair',
                }]);
                if (gate.armed) failClosed(new Error(`Bracket ${bracketEntryOrderId} nemá bezpečně spárovaný SL i TP`));
                else invalidateReconciliation();
              } finally { bracketCorrelator.abandonPendingPair(bracketEntryOrderId); }
            }).catch(reason => failClosed(reason));
          }, Math.max(
            0,
            leaderEvent.receivedAt + bracketCorrelator.pendingTimeoutMs() + 250 - clock(),
          ));
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
          stuckOutbox: gate.stuckOutbox || hasDispatchBlockingStuckOutbox(),
          nonBlockingOutboxKeys: backgroundNonBlockingOutboxKeys(),
          ineligibleAccounts: currentBracketIneligibleAccounts(bracketPair.entryOrderId),
        },
        broker: dispatchBroker(admissionGeneration, leaderEvent),
        clock,
        store: durableStore,
        metrics,
        maxConcurrentDispatches: options.maxConcurrentDispatches,
      });
      runtime = result.runtime;
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      await failClosedOnCriticalAudit(result.audit);
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

    // OSO waits for children of a NEW pending entry. A standalone stop/target
    // reducing an already open position has no entry children to discover.
    // Bracket/parent correlation was handled above; keep it intact.
    const standaloneReduction = leaderEvent.kind === 'submitted'
      && !eventIncreasesExposure && !leaderEvent.parentOrderId;
    const osoObservation = standaloneReduction
      ? { kind: 'unrelated' as const }
      : osoCorrelator.observe(leaderEvent);
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
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
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
        pendingOsoGenerations.set(leaderEvent.orderId, admissionGeneration);
        const timer = setTimeout(() => {
          pendingOsoTimers.delete(leaderEvent.orderId);
          pendingOsoEvents.delete(leaderEvent.orderId);
          pendingOsoGenerations.delete(leaderEvent.orderId);
          blockedOsoEntries.delete(leaderEvent.orderId);
          osoCorrelator.release(leaderEvent.orderId);
        }, Math.max(
          0,
          leaderEvent.receivedAt + osoCorrelator.pendingWindowMs() + 50 - clock(),
        ));
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
      pendingOsoGenerations.set(leaderEvent.orderId, admissionGeneration);
      const adjustedDispatch = await cutAwareDispatchFor(leaderEvent, eventIncreasesExposure);
      if (adjustedDispatch.unsafeDivergenceAccounts.length > 0) {
        pendingOsoEvents.delete(leaderEvent.orderId);
        pendingOsoGenerations.delete(leaderEvent.orderId);
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
            stuckOutbox: gate.stuckOutbox || hasDispatchBlockingStuckOutbox(),
            nonBlockingOutboxKeys: backgroundNonBlockingOutboxKeys(),
            ineligibleAccounts: adjustedDispatch.ineligibleAccounts,
          },
          broker: dispatchBroker(admissionGeneration, leaderEvent),
          clock,
          store: durableStore,
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
        await failClosedOnCriticalAudit(exitResult.audit);
      } else {
        const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
        runtime = recorded.runtime;
        if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      }
      let resolveFlush!: () => void;
      const flush = new Promise<void>(resolve => { resolveFlush = resolve; });
      pendingOsoFlushes.set(leaderEvent.orderId, flush);
      pendingOsoResolvers.set(leaderEvent.orderId, resolveFlush);
      const timer = setTimeout(() => {
        void flushStandaloneOsoEntry(leaderEvent.orderId);
      }, Math.max(
        0,
        leaderEvent.receivedAt + osoCorrelator.pendingWindowMs() + 50 - clock(),
      ));
      pendingOsoTimers.set(leaderEvent.orderId, timer);
      return;
    }
    if (osoObservation.kind === 'leg') {
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
      runtime = recorded.runtime;
      if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
      return;
    }
    if (osoObservation.kind === 'pair') {
      const pair = osoObservation.pair;
      const pendingEntry = pendingOsoEvents.get(pair.entryOrderId);
      const entryAdmissionGeneration = pendingOsoGenerations.get(pair.entryOrderId) ?? admissionGeneration;
      pendingOsoGenerations.delete(pair.entryOrderId);
      const previouslyExcluded = osoOpeningExcludedAccounts.get(pair.entryOrderId) ?? new Set<number>();
      osoOpeningExcludedAccounts.delete(pair.entryOrderId);
      const entryWasBlocked = blockedOsoEntries.delete(pair.entryOrderId);
      const timer = pendingOsoTimers.get(pair.entryOrderId);
      if (timer) clearTimeout(timer);
      pendingOsoTimers.delete(pair.entryOrderId);
      pendingOsoEvents.delete(pair.entryOrderId);
      settleOsoFlush(pair.entryOrderId);
      if (entryWasBlocked) {
        const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
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
        ? await cutAwareDispatchFor(pendingEntry, leaderEventIncreasesExposure(pendingEntry))
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
            stuckOutbox: gate.stuckOutbox || hasDispatchBlockingStuckOutbox(),
            nonBlockingOutboxKeys: backgroundNonBlockingOutboxKeys(),
            ineligibleAccounts: adjustedEntryDispatch.ineligibleAccounts,
          },
          broker: dispatchBroker(entryAdmissionGeneration, pendingEntry),
          clock,
          store: durableStore,
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
        await failClosedOnCriticalAudit(exitResult.audit);
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
          stuckOutbox: gate.stuckOutbox || hasDispatchBlockingStuckOutbox(),
          nonBlockingOutboxKeys: backgroundNonBlockingOutboxKeys(),
          ineligibleAccounts: currentEntryIneligibleAccounts(),
        },
        broker: dispatchBroker(entryAdmissionGeneration, leaderEvent,
          [pair.entryOrderId, pair.stopOrderId, pair.targetOrderId]),
        clock,
        store: durableStore,
        metrics,
        maxConcurrentDispatches: options.maxConcurrentDispatches,
      });
      runtime = result.runtime;
      rememberCurrentRuntimePendingOsoExposure(pair, result.audit);
      if (result.audit.length > 0) options.onAudit?.(result.audit);
      await failClosedOnCriticalAudit(result.audit);
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
    const safelyUnmappedReplaceAccounts = new Set<number>();
    if (leaderEvent.kind === 'replaced' && leaderEvent.executionShapeChanged === true) {
      const followerLinks = currentRuntime().state.links.get(leaderEvent.orderId) ?? [];
      for (const follower of group.followers) {
        if (followerLinks.some(link => link.accountId === follower.accountId)) continue;
        if (
          currentIntentionalSuppression(follower.accountId, leaderEvent.symbol) != null
          || (
            followerQuantity(leaderEvent.quantity, follower.multiplier) === 0
            && hasAuthoritativeFlatNoWorking(follower.accountId, leaderEvent.symbol)
          )
        ) safelyUnmappedReplaceAccounts.add(follower.accountId);
      }
      const unmappedFollowers = group.followers.filter(follower => (
        follower.enabled !== false
        && follower.mode === 'on-submit' && !currentIneligibleAccounts().has(follower.accountId)
        && !followerLinks.some(link => link.accountId === follower.accountId)
        && !safelyUnmappedReplaceAccounts.has(follower.accountId)
      ));
      if (unmappedFollowers.length > 0) {
        const error = new Error(
          `Copier fail-closed: leader replace ${leaderEvent.orderId} nemá pending korelaci ani follower link `
          + `pro účty ${unmappedFollowers.map(follower => follower.accountId).join(', ')}`,
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
    if (
      leaderEvent.orderType === 'Market'
      && !eventIncreasesExposure
      && leaderReducingQuantityFor(leaderEvent) > 0
      && group.followers.length > 1
      && (leaderEvent.kind === 'submitted' || leaderEvent.kind === 'filled')
    ) {
      const processAdjusted = async (
        followers: CopyGroupConfig['followers'],
        adjusted: Awaited<ReturnType<typeof cutAwareDispatchFor>>,
        allowSafeFollowersBesideUnsafe: boolean,
      ) => {
        if (adjusted.unsafeDivergenceAccounts.length > 0 && !allowSafeFollowersBesideUnsafe) {
          return { adjusted, processed: false };
        }
        const result = await processor.process({
          event: leaderEvent,
          group: adjusted.dispatchGroup,
          context: {
            ...gate,
            now,
            sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
            stuckOutbox: gate.stuckOutbox || hasDispatchBlockingStuckOutbox(),
            nonBlockingOutboxKeys: backgroundNonBlockingOutboxKeys(),
            ineligibleAccounts: adjusted.ineligibleAccounts,
          },
          broker: dispatchBroker(admissionGeneration, leaderEvent),
          clock,
          store: durableStore,
          metrics,
          maxConcurrentDispatches: options.maxConcurrentDispatches,
        });
        runtime = result.runtime;
        rememberConditionalMirrorWrites(
          leaderEvent,
          result.audit,
          followers.map(follower => follower.accountId),
        );
        rememberCurrentRuntimePendingExposure(leaderEvent, result.plan, result.audit);
        if (result.audit.length > 0) options.onAudit?.(result.audit);
        rememberExitOnlyReservations(
          adjusted.exitOnlyAccounts,
          result.plan,
          result.audit,
        );
        await failClosedOnCriticalAudit(result.audit);
        return { adjusted, processed: true };
      };

      // Followeři bez S1b REST kandidáta musí zůstat v jednom runner callu.
      // Runner uvnitř tohoto callu fan-outuje broker POSTy souběžně, takže
      // pomalý/visící první účet nezablokuje zahájení exitů ostatních.
      const readFollowers: CopyGroupConfig['followers'] = [];
      const immediateFollowers: CopyGroupConfig['followers'] = [];
      const deferredForIngress: CopyGroupConfig['followers'] = [];
      for (const follower of group.followers) {
        const modeAcceptsEvent = leaderEvent.kind === 'filled'
          ? follower.mode === 'on-fill'
          : follower.mode === 'on-submit';
        const needsRead = gate.armed && !gate.shadowMode && modeAcceptsEvent
          && follower.enabled !== false && follower.mode !== 'off'
          && (
            isolationEligibilityState(follower.accountId, leaderEvent.receivedAt) != null
            || s1bCandidatesFor(leaderEvent, follower).candidates.length > 0
          );
        if (needsRead) readFollowers.push(follower);
        else immediateFollowers.push(follower);
      }
      if (readFollowers.length > 0) {
        for (let index = immediateFollowers.length - 1; index >= 0; index -= 1) {
          const follower = immediateFollowers[index];
          if ((pendingTradeIngressByAccount.get(follower.accountId) ?? 0) <= 0) continue;
          immediateFollowers.splice(index, 1);
          deferredForIngress.unshift(follower);
        }
      }

      const immediatePromise = immediateFollowers.length === 0
        ? Promise.resolve(null)
        : cutAwareDispatchFor(
          leaderEvent,
          eventIncreasesExposure,
          { ...group, followers: immediateFollowers },
        ).then(adjusted => processAdjusted(immediateFollowers, adjusted, true));

      const readPromises = readFollowers.map(async follower => {
        const adjusted = await cutAwareDispatchFor(
          leaderEvent,
          eventIncreasesExposure,
          { ...group, followers: [follower] },
        );
        return processAdjusted([follower], adjusted, false);
      });
      const readResults = await Promise.all(readPromises);
      const readUnsafeAccounts = readResults.flatMap(item => item.adjusted.unsafeDivergenceAccounts);
      const deferredResult = deferredForIngress.length === 0 || readUnsafeAccounts.length > 0
        ? null
        : await cutAwareDispatchFor(
          leaderEvent,
          eventIncreasesExposure,
          { ...group, followers: deferredForIngress },
        ).then(adjusted => processAdjusted(deferredForIngress, adjusted, true));
      const immediateResult = await immediatePromise;
      const scoped = [
        ...(immediateResult ? [immediateResult] : []),
        ...readResults,
        ...(deferredResult ? [deferredResult] : []),
      ];
      const unsafeAccounts = scoped.flatMap(item => item.adjusted.unsafeDivergenceAccounts);
      if (unsafeAccounts.length > 0) {
        if (!scoped.some(item => item.processed)) {
          const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
          runtime = recorded.runtime;
          if (recorded.audit.length > 0) options.onAudit?.(recorded.audit);
        }
        gate = {
          ...gate,
          divergentAccounts: new Set([...gate.divergentAccounts, ...unsafeAccounts]),
        };
        options.onAudit?.([{
          at: now,
          leaderEventId: leaderEvent.id,
          kind: 'blocked',
          reason: `unexplained-position-divergence:${unsafeAccounts.join(',')}:${leaderEvent.symbol}`,
        }]);
        failClosed(new Error(
          `Copier fail-closed: nevysvětlená divergence účtů ${unsafeAccounts.join(', ')} před leader exitem ${leaderEvent.symbol}`,
        ), { autoClose: false });
      }
      conditionalMirrorSourcesByLeaderEvent.delete(leaderEvent.id);
      return;
    }

    const cutAwareDispatch = await cutAwareDispatchFor(leaderEvent, eventIncreasesExposure);
    if (cutAwareDispatch.unsafeDivergenceAccounts.length > 0) {
      gate = {
        ...gate,
        divergentAccounts: new Set([
          ...gate.divergentAccounts,
          ...cutAwareDispatch.unsafeDivergenceAccounts,
        ]),
      };
      const recorded = await processor.record({ event: leaderEvent, group, clock, store: durableStore });
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
      group: safelyUnmappedReplaceAccounts.size === 0
        ? cutAwareDispatch.dispatchGroup
        : {
          ...cutAwareDispatch.dispatchGroup,
          followers: cutAwareDispatch.dispatchGroup.followers.map(follower => (
            safelyUnmappedReplaceAccounts.has(follower.accountId)
              ? { ...follower, mode: 'off' as const }
              : follower
          )),
        },
      context: {
        ...gate,
        now,
        sequenceBroken: gate.sequenceBroken || source.needsReconciliation(),
        stuckOutbox: gate.stuckOutbox || hasDispatchBlockingStuckOutbox(),
        nonBlockingOutboxKeys: backgroundNonBlockingOutboxKeys(),
        ineligibleAccounts: cutAwareDispatch.ineligibleAccounts,
      },
      broker: dispatchBroker(admissionGeneration, leaderEvent),
      clock,
      store: durableStore,
      metrics,
      maxConcurrentDispatches: options.maxConcurrentDispatches,
    });
    runtime = result.runtime;
    rememberConditionalMirrorWrites(leaderEvent, result.audit);
    rememberCurrentRuntimePendingExposure(leaderEvent, result.plan, result.audit);
    if (result.audit.length > 0) options.onAudit?.(result.audit);
    rememberExitOnlyReservations(
      cutAwareDispatch.exitOnlyAccounts,
      result.plan,
      result.audit,
    );
    await failClosedOnCriticalAudit(result.audit);

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
      updatePendingExposureAfterConfirmedModify(leaderEvent);
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
  class ReconciliationStaleSnapshotError extends Error {}

  async function performReconciliation(
    reconciliationOptions: CopierReconciliationOptions & { clearLastError?: boolean } = {},
  ): Promise<ReconciliationResult> {
    const requestedGeneration = safetyGeneration;
    reconciliationRequestsPending += 1;
    const reconciliation = reconciliationTail.then(async () => {
      let lastStale: ReconciliationStaleSnapshotError | null = null;
      // První snapshot může zneplatnit order event z vlastního bezpečného
      // sweep cancelu. Třetí a poslední běh ponechá ještě jeden omezený
      // read-only pokus pro skutečný živý event; broker write se neopakuje,
      // protože další snapshot už vidí terminální order.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await runReconciliation(reconciliationOptions, requestedGeneration);
        } catch (reason) {
          if (!(reason instanceof ReconciliationStaleSnapshotError)) throw reason;
          lastStale = reason;
        }
      }
      throw lastStale ?? new ReconciliationStaleSnapshotError('Reconciliation snapshot zůstal zastaralý');
    });
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
      const accountObservationAtStart = new Map(accountIds.map(accountId => [
        accountId,
        tradeObservationVersionByAccount.get(accountId) ?? 0,
      ]));
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
        const state = eligibilityByAccount.get(accountId)?.state ?? 'active';
        const needsOpenEpisodeIsolationProof = group.followers.some(follower => (
          follower.accountId === accountId
          && (state === 'breached' || state === 'dll-locked')
          && (currentRuntime().state.safety.leaderExposureEpochs ?? []).some(epoch => (
            epoch.groupId === group.id
            && epoch.leaderAccountId === group.leaderAccountId
            && epoch.phase === 'open'
            && epoch.followers.some(participant => participant.accountId === accountId)
          ))
        ));
        if (!capability || ((!capability.active || !capability.canTrade) && !needsOpenEpisodeIsolationProof)) {
          return false;
        }
        // BREACHED a stále platný DLL jsou známé exclusions. Expirující DLL
        // už eligibilityAt převedlo na `unverifiable`, takže se načte a po
        // úspěšném snapshotu může bezpečně vrátit do active.
        return needsOpenEpisodeIsolationProof
          || lineageParticipantIds.has(accountId)
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
      const changedAccounts = snapshotAccountIds.filter(accountId => (
        (tradeObservationVersionByAccount.get(accountId) ?? 0)
          !== (accountObservationAtStart.get(accountId) ?? 0)
      ));
      if (changedAccounts.length > 0) {
        const error = new ReconciliationStaleSnapshotError(
          `Reconciliation byla zneplatněna novým stream eventem účtů ${changedAccounts.join(',')}`,
        );
        throw error;
      }
      // Reconciliation je nový account-scoped autoritativní read. Starý
      // tombstone proto u skutečně načtených účtů nesmí navždy blokovat
      // nové rozhodnutí; případný další nejasný cancel si založí nový.
      for (const [brokerOrderId, accountId] of flatSweepCancelAttemptAccounts) {
        if (!byAccount.has(accountId)) continue;
        flatSweepCancelAttempts.delete(brokerOrderId);
        flatSweepCancelAttemptAccounts.delete(brokerOrderId);
      }
      positionsByAccount.clear();
      for (const snapshot of snapshots) {
        positionsByAccount.set(snapshot.accountId, new Map(
          snapshot.positions.map(item => [item.symbol, item.netQuantity]),
        ));
      }
      for (const snapshot of snapshots) rememberLiveOrderSnapshot(snapshot.accountId, snapshot.orders);
      const conditionalRefreshUnverifiedAccounts = new Set<number>();
      // Podmíněné vazby přežívají disconnect. Reconnect/reconciliation je
      // musí porovnat s REST, jinak by odvozený Stop mohl zůstat na flat
      // followerovi jen proto, že zdrojový fill chyběl ve streamu.
      for (const [sourceOrderId, conditional] of [...conditionalMirrorWritesBySourceOrder]) {
        let sourceOrder = byAccount.get(conditional.accountId)?.orders.find(order => (
          order.brokerOrderId === sourceOrderId
        ));
        if (!sourceOrder) {
          try {
            const lookup = await withConditionalDeadline(
              `reconciliation conditional source ${conditional.accountId}/${sourceOrderId}`,
              () => broker.findOrderById(conditional.accountId, sourceOrderId),
            );
            if (lookup.completeness === 'authoritative') sourceOrder = lookup.order;
            if (lookup.completeness === 'authoritative' && !lookup.order) {
              const snapshot = byAccount.get(conditional.accountId);
              const dependentsOpen = snapshot?.orders.some(order => (
                conditional.dependentOrderIds.has(order.brokerOrderId)
                && isOpenOrderStatus(order.status)
              )) ?? true;
              const accountFlat = snapshot?.positions.every(position => position.netQuantity === 0) ?? false;
              if (accountFlat && !dependentsOpen) {
                conditionalMirrorWritesBySourceOrder.delete(sourceOrderId);
                continue;
              }
              conditionalRefreshUnverifiedAccounts.add(conditional.accountId);
            }
          } catch (reason) {
            conditionalRefreshUnverifiedAccounts.add(conditional.accountId);
            options.onAudit?.([{
              at: clock(),
              leaderEventId: `conditional-reconcile-${sourceOrderId}`,
              kind: 'blocked',
              accountId: conditional.accountId,
              brokerOrderId: sourceOrderId,
              reason: `V12 conditional source read selhal: ${errorOf(reason).message}`,
            }]);
          }
        }
        if (sourceOrder && !isOpenOrderStatus(sourceOrder.status)) {
          await evaluateConditionalMirrorSource(sourceOrderId, { terminalOrder: sourceOrder });
        }
      }
      // Runtime-only pending lineage se smí zachovat jen pro follower order,
      // který autoritativní listOrders stále ukazuje jako otevřený. Chybějící
      // nebo terminální follower order už žádnou budoucí expozici nevytvoří;
      // orphan follower, jehož leader chybí/je terminální, naopak zůstává
      // invalidním fail-closed důkazem až do svého terminálního stavu.
      for (const [brokerOrderId, pending] of currentRuntimePendingExposure) {
        const followerOrder = byAccount.get(pending.accountId)?.orders.find(order => (
          order.brokerOrderId === pending.followerBrokerOrderId
        ));
        if (!followerOrder || !isOpenOrderStatus(followerOrder.status)) {
          currentRuntimePendingExposure.delete(brokerOrderId);
          continue;
        }
        const leaderOrder = byAccount.get(group.leaderAccountId)?.orders.find(order => (
          order.brokerOrderId === pending.leaderOrderId
        ));
        const followerShapeValid = followerOrder.accountId === pending.accountId
          && followerOrder.symbol === pending.symbol
          && followerOrder.side === pending.side
          && followerOrder.orderType === pending.orderType
          && followerOrder.quantity === pending.followerQuantity
          && sameOrderPrices(followerOrder, {
            orderType: pending.orderType,
            limitPrice: pending.followerLimitPrice,
            stopPrice: pending.followerStopPrice,
          })
          && Number.isFinite(followerOrder.filledQuantity)
          && followerOrder.filledQuantity >= 0
          && followerOrder.filledQuantity <= pending.followerQuantity;
        const leaderCoreShapeValid = leaderOrder != null
          && leaderOrder.accountId === group.leaderAccountId
          && leaderOrder.symbol === pending.symbol
          && leaderOrder.side === pending.side
          && leaderOrder.orderType === pending.orderType
          && leaderOrder.quantity === pending.leaderQuantity
          && sameOrderPrices(leaderOrder, {
            orderType: pending.orderType,
            limitPrice: pending.leaderLimitPrice,
            stopPrice: pending.leaderStopPrice,
          })
          && Number.isFinite(leaderOrder.filledQuantity)
          && leaderOrder.filledQuantity >= 0
          && leaderOrder.filledQuantity <= pending.leaderQuantity;
        const leaderAlreadyFilled = pendingLeaderFillQuantity(pending) >= pending.leaderQuantity;
        const leaderShapeValid = leaderAlreadyFilled
          ? leaderOrder == null || leaderCoreShapeValid
          : leaderOrder != null && leaderCoreShapeValid && isOpenOrderStatus(leaderOrder.status);
        currentRuntimePendingExposure.set(brokerOrderId, {
          ...pending,
          followerOrderReportedFilled: followerShapeValid
            ? Math.max(pending.followerOrderReportedFilled, followerOrder.filledQuantity)
            : pending.followerOrderReportedFilled,
          leaderOrderReportedFilled: leaderShapeValid && leaderOrder
            ? Math.max(pending.leaderOrderReportedFilled, leaderOrder.filledQuantity)
            : pending.leaderOrderReportedFilled,
          evidenceInvalid: pending.evidenceInvalid || !followerShapeValid || !leaderShapeValid,
        });
      }
      for (const [brokerOrderId, tracked] of s1bCanceledZeroFillOrderIds) {
        const snapshot = byAccount.get(tracked.accountId);
        const followerFlat = snapshot?.positions
          .filter(position => position.symbol === tracked.symbol)
          .every(position => position.netQuantity === 0) ?? false;
        const orderStillOpen = snapshot?.orders.some(order => (
          order.brokerOrderId === brokerOrderId && isOpenOrderStatus(order.status)
        )) ?? true;
        const leaderFlat = (byAccount.get(group.leaderAccountId)?.positions
          .find(position => position.symbol === tracked.symbol)?.netQuantity ?? 0) === 0;
        if (followerFlat && leaderFlat && !orderStillOpen) {
          s1bCanceledZeroFillOrderIds.delete(brokerOrderId);
        }
      }
      for (const [brokerOrderId, tracked] of s1bUnresolvedCopyOrderIds) {
        const snapshot = byAccount.get(tracked.accountId);
        const followerFlat = snapshot?.positions
          .filter(position => position.symbol === tracked.symbol)
          .every(position => position.netQuantity === 0) ?? false;
        const orderStillOpen = snapshot?.orders.some(order => (
          order.brokerOrderId === brokerOrderId && isOpenOrderStatus(order.status)
        )) ?? true;
        if (followerFlat && !orderStillOpen) s1bUnresolvedCopyOrderIds.delete(brokerOrderId);
      }
      lastAuthoritativeReadAt = clock();
      lastBrokerPositionAt = lastAuthoritativeReadAt;
      leaderPositions.clear();
      leaderFillAheadOfPosition.clear();
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
      for (const [symbol, quantity] of reconciledLeaderPositions) rememberLeaderPosition(symbol, quantity);
      let completedCutChanged = false;
      for (const follower of group.followers) {
        const cut = activeFollowerCut(follower.accountId);
        if (!cut || cut.closed !== null) continue;
        const cutAction = effectiveFollowerCutAction(cut, follower);
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
      const divergent = new Set<number>(conditionalRefreshUnverifiedAccounts);
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
        const hasOpenEpisode = (currentRuntime().state.safety.leaderExposureEpochs ?? []).some(epoch => (
          epoch.groupId === group.id
          && epoch.leaderAccountId === group.leaderAccountId
          && epoch.phase === 'open'
          && epoch.followers.some(participant => participant.accountId === follower.accountId)
        ));
        // Účet s autoritativní eligibility exclusion není participantem
        // copieru. Jeho chybějící snapshot proto není divergence zdravých
        // participantů mimo otevřenou epizodu. V otevřené epizodě ale musí
        // projít stejným flat/no-working/no-pending důkazem jako hot-path.
        if (ineligibleAfterReactivation.has(follower.accountId)
          && !lineageParticipantIds.has(follower.accountId)
          && !hasOpenEpisode) continue;
        const followerSnapshot = byAccount.get(follower.accountId);
        const followerPositions = new Map(
          (followerSnapshot?.positions ?? []).map(item => [item.symbol, item.netQuantity]),
        );
        const symbols = new Set([
          ...reconciledLeaderPositions.keys(),
          ...followerPositions.keys(),
          ...(currentRuntime().state.safety.leaderExposureEpochs ?? [])
            .filter(epoch => (
              epoch.groupId === group.id
              && epoch.leaderAccountId === group.leaderAccountId
              && epoch.phase === 'open'
              && epoch.followers.some(participant => participant.accountId === follower.accountId)
            ))
            .map(epoch => epoch.symbol),
        ]);
        const cut = activeFollowerCut(follower.accountId);
        const expectsFlatAfterCut = cut != null && effectiveFollowerCutAction(cut, follower) === 'close-copy';
        for (const symbol of symbols) {
          const leaderNet = reconciledLeaderPositions.get(symbol) ?? 0;
          const expected = follower.enabled === false || expectsFlatAfterCut
            ? 0
            : Math.trunc(leaderNet * follower.multiplier);
          const actual = followerPositions.get(symbol) ?? 0;
          const intentionalLetRun = cut != null && effectiveFollowerCutAction(cut, follower) === 'let-run';
          const pauseSuppression = currentIntentionalSuppression(follower.accountId, symbol);
          const allowedLetRunSubset = intentionalLetRun
            && (
              actual === 0
              || (leaderNet !== 0
                && Math.sign(actual) === Math.sign(leaderNet)
                && Math.abs(actual) <= Math.abs(expected))
            );
          const allowedPausePosition = pauseSuppression != null
            && actual === pauseSuppression.allowedNet;
          const isolationEvidence = followerSnapshot == null
            ? null
            : episodeIsolationFromSnapshot({
              accountId: follower.accountId,
              symbol,
              positions: followerSnapshot.positions,
              orders: followerSnapshot.orders,
              observedAt: lastAuthoritativeReadAt,
              observationVersion: accountObservationAtStart.get(follower.accountId) ?? 0,
            });
          if (
            actual !== expected
            && !allowedLetRunSubset
            && !allowedPausePosition
            && isolationEvidence == null
          ) {
            divergent.add(follower.accountId);
            break;
          }
        }
      }
      // Durable dokončení sweep povinnosti: pád workeru mezi follower flat
      // a potvrzeným cancelem nesmí povinnost ztratit (review, bod 5).
      // Reconciliation je autoritativní moment, kdy se osiřelé working
      // ochranné nohy nad flat followerem dají najít a doprovodit.
      const reconciliationSweepJobs: Promise<void>[] = [];
      const reconciliationResolvedLegs: Array<{
        accountId: number;
        brokerOrderId: string;
        status?: BrokerOrder['status'];
      }> = [];
      for (const follower of group.followers) {
        const snapshot = byAccount.get(follower.accountId);
        if (!snapshot) continue;
        const workingIds = new Set(
          snapshot.orders.filter(order => isOpenOrderStatus(order.status)).map(order => order.brokerOrderId),
        );
        const snapshotStatusById = new Map(
          snapshot.orders.map(order => [order.brokerOrderId, order.status]),
        );
        // Čerstvý account-scoped reconciliation snapshot smí uzavřít starou
        // durable historii. Na rozdíl od ingress-wave snapshotu je ohraničený
        // observation fence a během čtení přes něj nesmí projít nový dispatch.
        const runtimeAtSnapshot = currentRuntime();
        for (const entry of [
          ...runtimeAtSnapshot.bracketOutbox.values(),
          ...runtimeAtSnapshot.osoOutbox.values(),
        ]) {
          if (entry.request.accountId !== follower.accountId) continue;
          for (const brokerOrderId of [entry.firstBrokerOrderId, entry.secondBrokerOrderId]) {
            if (!brokerOrderId) continue;
            const status = snapshotStatusById.get(brokerOrderId);
            if (status == null || !isOpenOrderStatus(status)) {
              reconciliationResolvedLegs.push({
                accountId: follower.accountId,
                brokerOrderId,
                ...(status == null ? {} : { status }),
              });
            }
          }
        }
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
        for (const entry of runtime.outbox.values()) {
          if (
            entry.request.accountId !== follower.accountId
            || !entry.brokerOrderId
            || !isStandaloneProtective(entry)
            || !workingIds.has(entry.brokerOrderId)
          ) continue;
          const net = snapshot.positions.find(item => item.symbol === entry.request.symbol)?.netQuantity ?? 0;
          if (net === 0) flatSymbols.add(entry.request.symbol);
        }
        for (const links of runtime.state.links.values()) {
          for (const link of links) {
            if (
              link.accountId !== follower.accountId
              || !isStandaloneProtective(link)
              || !workingIds.has(link.brokerOrderId)
            ) continue;
            const linkedEntry = [...runtime.outbox.values()].find(entry => (
              entry.brokerOrderId === link.brokerOrderId
            ));
            if (!linkedEntry) continue;
            const net = snapshot.positions.find(item => item.symbol === linkedEntry.request.symbol)?.netQuantity ?? 0;
            if (net === 0) flatSymbols.add(linkedEntry.request.symbol);
          }
        }
        for (const symbol of flatSymbols) {
          reconciliationSweepJobs.push(sweepFollowerProtectiveLegs(
            follower.accountId,
            symbol,
            clock(),
            { authoritativeOrders: snapshot.orders },
          ));
        }
      }
      await Promise.all(reconciliationSweepJobs);
      const changedAfterSnapshot = snapshotAccountIds.filter(accountId => (
        (tradeObservationVersionByAccount.get(accountId) ?? 0)
          !== (accountObservationAtStart.get(accountId) ?? 0)
      ));
      if (changedAfterSnapshot.length > 0) {
        throw new ReconciliationStaleSnapshotError(
          `Reconciliation byla zneplatněna novým stream eventem účtů ${changedAfterSnapshot.join(',')} před finálním zápisem`,
        );
      }
      for (const evidence of reconciliationResolvedLegs) {
        if (evidence.status == null) {
          recordAuthoritativeSweepAbsence(evidence.accountId, evidence.brokerOrderId);
        } else {
          recordTerminalSweepState(evidence.accountId, evidence.brokerOrderId, evidence.status);
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
        leaderPositionSnapshotComplete = byAccount.has(group.leaderAccountId!);
        const epochs = currentRuntime().state.safety.leaderExposureEpochs ?? [];
        const retainedIds = new Set(epochs.map(epoch => epoch.id));
        for (const id of flatReconciledLeaderEpochIds) {
          if (!retainedIds.has(id)) flatReconciledLeaderEpochIds.delete(id);
        }
        if (leaderPositionSnapshotComplete) {
          for (const epoch of epochs) {
            if (epoch.groupId === group.id && epoch.leaderAccountId === group.leaderAccountId
              && (reconciledLeaderPositions.get(epoch.symbol) ?? 0) === 0) {
              flatReconciledLeaderEpochIds.add(epoch.id);
            }
          }
        }
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

  const LEADER_EPOCH_READ_DEADLINE_MS = options.leaderFlatReadTimeoutMs ?? 2_500;
  if (!Number.isFinite(LEADER_EPOCH_READ_DEADLINE_MS) || LEADER_EPOCH_READ_DEADLINE_MS <= 0) {
    throw new Error('leaderFlatReadTimeoutMs musí být kladné číslo');
  }
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
   * edit jednoho ID. REST preflight běží mimo broker eventTail; jeho výsledek
   * se zařadí zpět až po všech mezitím přijatých eventech a znovu ověří fence.
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
    const operation = switchOptions.forceEpoch ? 'Aktivaci skupiny' : 'Změnu skupiny';
    const run = reconfigurationTail.then(async () => {
      // Čekáme jen na eventy přijaté před startem kontroly. Samotná REST čtení
      // nesmějí zadržet nový leader order/fill/position.
      await eventTail;
      if (stopped) throw new Error('Copier runtime is stopped');
      assertTightenOnly(nextGroup);
      if (nextGroup.id !== group.id && !switchOptions.allowGroupChange) {
        throw new Error('Nelze změnit runtime na jinou copy group bez explicitní aktivace');
      }
      assertRuntimeGroup(nextGroup);
      const currentTopology = new Set([
        group.leaderAccountId,
        ...group.followers.map(item => item.accountId),
      ]);
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
      const retirement = switchOptions.retireMissingOldGroup;
      if (retirement && (!Array.isArray(retirement.accountIds)
        || retirement.accountIds.some(accountId => !Number.isSafeInteger(accountId) || accountId <= 0))) {
        throw new Error('Vyřazení nedostupné skupiny obsahuje neplatná ID účtů');
      }
      const retiredAccountIds = new Set(retirement?.accountIds ?? []);
      // Částečné vyřazení je dovolené jen v režimu opravy po startu a jen pro
      // přesně ty účty, které worker při startu v OAuth neviděl. Ostatní účty
      // staré skupiny dál procházejí autoritativní flat/no-working kontrolou.
      const partialRepairRetirement = retirement != null
        && startupGroupRepair?.groupId === group.id
        && startupGroupRepair.unavailableAccountIds.length === retiredAccountIds.size
        && startupGroupRepair.unavailableAccountIds.every(accountId => retiredAccountIds.has(accountId));
      if (retirement && startupGroupRepair?.groupId === group.id && !partialRepairRetirement) {
        throw new Error('V režimu opravy lze vyřadit jen účty nedostupné při startu; runtime zůstává vypnutý');
      }
      if (retirement) {
        const reason = typeof retirement.reason === 'string' ? retirement.reason.trim() : '';
        if (!switchOptions.allowGroupChange || !switchOptions.forceEpoch || gate.armed
          || retirement.groupId !== group.id || reason.length < 20 || reason.length > 500
          || retiredAccountIds.size !== retirement.accountIds.length
          || (!partialRepairRetirement && retiredAccountIds.size !== currentTopology.size)
          || [...retiredAccountIds].some(accountId => !currentTopology.has(accountId))
          || [...nextAccountIds].some(accountId => retiredAccountIds.has(accountId))) {
          throw new Error('Vyřazení nedostupné skupiny má neplatné nebo změněné účty; runtime zůstává vypnutý');
        }
      }
      const removableFollowerIds = new Set(group.followers
        .map(item => item.accountId)
        .filter(accountId => !nextAccountIds.has(accountId) && !leaderIds.has(accountId)));
      const optionalFollowerIds = new Set(switchOptions.missingOptionalAccountIds ?? []);
      for (const accountId of optionalFollowerIds) {
        if (!Number.isSafeInteger(accountId) || !removableFollowerIds.has(accountId)) {
          throw new Error(`${operation} dostala neplatný chybějící optional follower účet ${accountId}`);
        }
      }
      if (retirement && group.followers.some(follower => (
        retiredAccountIds.has(follower.accountId) && !optionalFollowerIds.has(follower.accountId)
      ))) {
        throw new Error('Vyřazení odmítnuto: chybí potvrzená OAuth absence starého followera');
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
        // E2 (review 30. 9.): v režimu opravy recovery nikdy neuspěje, protože
        // nedostupný leader nemá route. Vyřazení právě nedostupných účtů ji
        // nahrazuje; zbylé účty níže projdou autoritativní flat kontrolou.
        recoveryInFlight || (pendingConnectionRecovery && !waivesBlockedRecovery && !partialRepairRetirement)
          ? 'connection recovery'
          : '',
        cooldownPending ? 'cooldown transition' : '',
        dayLockPending ? 'day-lock transition' : '',
      ].filter(Boolean);
      if (pendingReasons.length > 0) {
        throw new Error(`${operation} blokuje rozpracovaný lifecycle: ${pendingReasons.join(', ')}`);
      }
      // Účty, které ze skupiny odcházejí a na kterých kopírka prokazatelně nic
      // svého nemá (5. 10. 2026): žádná nedokončená epizoda s kopií, žádný
      // rozpracovaný příkaz/izolace/cut ani stuck operace. Ruční obchod na
      // takovém účtu je věc uživatele a přepnutí skupiny neblokuje. Zbytek
      // (nová skupina, účty s kopií) dál musí být autoritativně flat.
      const stuckAccountIds = new Set(currentStuckOperations().map(operation => operation.accountId));
      // Durable značka živých kopií (pád za ARM bez dokončené recovery) = bez
      // výjimek: jejich vlastnictví nejde spolehlivě vyloučit.
      const liveCopyTrace = (currentRuntime().state.safety.liveCopyOpenSince ?? 0) > 0;
      const copierFreeLeavingAccountIds = new Set(liveCopyTrace ? [] : [...currentTopology]
        .filter((accountId): accountId is number => accountId != null)
        .filter(accountId => (
          !nextAccountIds.has(accountId)
          && !retiredAccountIds.has(accountId)
          && !optionalFollowerIds.has(accountId)
          && unverifiableFollowerOwnership(new Set([accountId])).length === 0
          && !pendingIsolationCommandForAccount(accountId)
          && !followerCutBackgroundAccounts.has(accountId)
          && !stuckAccountIds.has(accountId)
          // Každá kopie na účtu musí být ověřeně usazená (flat po ukončení
          // všech jejích nohou). Jinak může být fill na cestě a účet musí
          // být flat jako každý jiný účet s kopií.
          && unsettledCopierEntries(accountId).length === 0
        )));
      const leavingAccountIds = [...currentTopology]
        .filter((accountId): accountId is number => accountId != null)
        .filter(accountId => !nextAccountIds.has(accountId));
      let leavingVersionsAtCommit: Map<number, number> | null = null;
      const awaitingSettlementAccountIds = [...currentTopology]
        .filter((accountId): accountId is number => accountId != null)
        .filter(accountId => !nextAccountIds.has(accountId) && !copierFreeLeavingAccountIds.has(accountId)
          && unsettledCopierEntries(accountId).length > 0);
      const requiredAccountIds = accountIds.filter(accountId => !optionalFollowerIds.has(accountId)
        && !retiredAccountIds.has(accountId)
        && !copierFreeLeavingAccountIds.has(accountId));
      for (const accountId of requiredAccountIds) {
        configurationFenceAccountRefs.set(
          accountId,
          (configurationFenceAccountRefs.get(accountId) ?? 0) + 1,
        );
      }
      const observationAtStart = brokerObservationVersion;
      const generationAtStart = safetyGeneration;
      const revisionAtStart = groupRevision;
      const assertFreshPreflight = () => {
        if (stopped || shutdownRequested || gate.armed || gate.killSwitch || !gate.connected
          || safetyGeneration !== generationAtStart || groupRevision !== revisionAtStart
          || brokerObservationVersion !== observationAtStart
          || pendingTradeEventsFor([...requiredAccountIds, ...copierFreeLeavingAccountIds])) {
          throw new Error(`${operation}: stav se změnil během kontroly; opakuj ověření`);
        }
      };
      const releaseFenceAccounts = () => {
        for (const accountId of requiredAccountIds) {
          const remaining = (configurationFenceAccountRefs.get(accountId) ?? 1) - 1;
          if (remaining <= 0) configurationFenceAccountRefs.delete(accountId);
          else configurationFenceAccountRefs.set(accountId, remaining);
        }
      };
      try {
        const capabilities = await withLeaderEpochDeadline(
          'leader capability preflight',
          broker.listAccountCapabilities(requiredAccountIds),
        );
        assertFreshPreflight();
        const capabilityByAccount = new Map(capabilities.map(item => [item.accountId, item]));
        const unavailable = requiredAccountIds.filter(accountId => {
          const capability = capabilityByAccount.get(accountId);
          return !capability || !capability.active || !capability.canTrade;
        });
        if (unavailable.length > 0) {
          throw new Error(`${operation} blokují neaktivní/read-only účty: ${unavailable.join(',')}`);
        }

        const readAccounts = (checkedAccountIds: readonly number[]) => Promise.all(checkedAccountIds.map(async accountId => {
          const [positions, orders] = await Promise.all([
            withLeaderEpochDeadline(`leader position preflight ${accountId}`, broker.listPositions(accountId)),
            withLeaderEpochDeadline(`leader order preflight ${accountId}`, broker.listOrders(accountId)),
          ]);
          return { accountId, positions, orders };
        }));
        const readRound = async () => {
          const [required, leaving] = await Promise.all([
            readAccounts(requiredAccountIds),
            readAccounts([...copierFreeLeavingAccountIds]),
          ]);
          return { required, leaving };
        };
        // Odcházející účet: pozice smí zůstat jen na symbolu, kde kopírka od
        // posledního ověřeného flat nic neodeslala (durable outbox přežije
        // DISARM, pád i restart). Pracovní příkaz kopírky blokuje vždy.
        const assertLeavingSnapshots = (checked: Awaited<ReturnType<typeof readRound>>['leaving']) => {
          const problems: string[] = [];
          for (const snapshot of checked) {
            const marked = unsettledCopierSymbols(snapshot.accountId);
            const copied = snapshot.positions
              .filter(position => position.netQuantity !== 0 && marked.has(position.symbol))
              .map(position => position.symbol);
            if (copied.length > 0) {
              problems.push(`účet ${snapshot.accountId} drží pozici z kopírky (${[...new Set(copied)].join(',')})`);
            }
            const copierOrders = new Set(controllerCopyOrderIds(snapshot.accountId));
            if (snapshot.orders.some(order => isOpenOrderStatus(order.status) && copierOrders.has(order.brokerOrderId))) {
              problems.push(`účet ${snapshot.accountId} má pracovní příkaz kopírky`);
            }
          }
          if (problems.length > 0) {
            throw new Error(`${operation} blokuje odcházející účet: ${problems.join('; ')}. Zavři kopii, nebo účet nech ve skupině`);
          }
        };
        const assertFlatSnapshots = (checked: Awaited<ReturnType<typeof readRound>>['required']) => {
          const nonFlat = checked.filter(snapshot =>
            snapshot.positions.some(position => position.netQuantity !== 0));
          const withWorkingOrders = checked.filter(snapshot =>
            snapshot.orders.some(order => isOpenOrderStatus(order.status)));
          if (nonFlat.length === 0 && withWorkingOrders.length === 0) return;
          const details = [
            nonFlat.length > 0 ? `nonFlat=${nonFlat.map(item => item.accountId).join(',')}` : '',
            withWorkingOrders.length > 0
              ? `working=${withWorkingOrders.map(item => item.accountId).join(',')}`
              : '',
          ].filter(Boolean).join(' ');
          const blockedLeaving = awaitingSettlementAccountIds.filter(accountId => (
            nonFlat.some(item => item.accountId === accountId)
            || withWorkingOrders.some(item => item.accountId === accountId)
          ));
          const hint = blockedLeaving.length > 0
            ? `. Účty ${blockedLeaving.join(',')} opouštějí skupinu, ale kopírka na nich má neověřenou kopii; `
              + 'po vypnutí ji ověří zhruba do minuty od zavření kopií — pokud jsou zavřené, zkus to znovu'
            : '';
          throw new Error(`${operation} vyžaduje účty nové skupiny a účty s kopií kopírky flat a bez příkazů: ${details}${hint}`);
        };
        if (copierFreeLeavingAccountIds.size > 0) {
          options.onAudit?.([{
            at: clock(),
            leaderEventId: `leaving-accounts-without-copies:${group.id}:${nextGroup.id}:${clock()}`,
            kind: 'skipped',
            reason: `účty ${[...copierFreeLeavingAccountIds].sort((a, b) => a - b).join(',')} opouštějí skupinu bez kopie kopírky; jejich ruční pozice/příkazy přepnutí neblokují`,
          }]);
        }
        // Dvě autoritativní kola, tedy pod bezpečnostním stropem tří. Mezi
        // koly není žádný broker write a fence odmítne skutečný stream event.
        let snapshots = await readRound();
        assertFreshPreflight();
        assertFlatSnapshots(snapshots.required);
        assertLeavingSnapshots(snapshots.leaving);
        snapshots = await readRound();
        assertFreshPreflight();
        assertFlatSnapshots(snapshots.required);
        assertLeavingSnapshots(snapshots.leaving);
        const leavingSnapshots = snapshots.leaving;
        // Flat odcházející účet s neusazenou kopií: přepnutí smaže outbox, takže
        // opožděná Position projekce právě ukončené nohy by z kopie udělala
        // „ruční“ pozici. Nohy musí být ukončené aspoň TERMINAL_AGE.
        {
          const checkedAt = clock();
          const freshLegAccounts = awaitingSettlementAccountIds.filter(accountId => (
            unsettledCopierEntries(accountId).some(entry => (
              entry.legIds.length === 0
                ? !leglessEntryFinished(entry)
                : entry.legIds.some(orderId => {
                  const seenAt = copierLegTerminalSeenAt.get(orderId);
                  return seenAt == null || seenAt > checkedAt - COPIER_SETTLEMENT_TERMINAL_AGE_MS;
                })
            ))
          ));
          if (freshLegAccounts.length > 0) {
            for (const accountId of freshLegAccounts) requestCopierSettlement(accountId);
            throw new Error(`${operation}: účty ${freshLegAccounts.join(',')} opouštějí skupinu s právě ukončenou kopií; `
              + 'kopírka ještě ověřuje její konec, zkus to znovu za minutu');
          }
        }
        const pendingCutClosures = tightenedCutClosures(group, nextGroup);

        const apply = eventTail.then(async () => {
        // Všechny eventy přijaté během REST čtení jsou už před námi. Skutečná
        // obchodní/connection změna proto konfiguraci odmítne; heartbeat ne.
        assertFreshPreflight();
        assertLeavingSnapshots(leavingSnapshots);

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
        assertFreshPreflight();
        const {
          liveCopyOpenSince: _dropOpenFlag,
          leaderExposureEpochs: _dropLeaderExposureEpochs,
          // Nová skupina začíná ověřeně: účty zůstávající/nové jsou flat a
          // odcházející pozice bez stopy kopírky patří uživateli.
          settledCopierEntries: _dropSettledCopierEntries,
          ...preservedSafety
        } = current.state.safety;
        // A current broker snapshot settles exposure, not the missing exit price.
        // Archive the unresolved lots atomically with the topology switch; never
        // invent a close fill or reset daily P&L/counters to make the gate pass.
        const stats = preservedSafety.dailyStats;
        if (stats && stats.openLots.some(lot => lot.netQuantity !== 0)) {
          preservedSafety.dailyStats = {
            ...stats,
            openLots: [],
            unconfirmedFlatLots: [
              ...(stats.unconfirmedFlatLots ?? []),
              ...stats.openLots.filter(lot => lot.netQuantity !== 0)
                .map(lot => ({ ...lot, confirmedFlatAt: clock(), leaderAccountId: group.leaderAccountId! })),
            ],
          };
        }
        const cleanState = createCopierState([], 0, [], [], [], preservedSafety);
        // Poslední odmítnutí musí být ještě před durable CAS. Event přijatý
        // během samotného fsyncu už čeká za tímto eventTail krokem; po commitu
        // proto dokončíme přepnutí group v DISARMED stavu místo kombinace
        // stará group + vyčištěný durable runtime.
        assertFreshPreflight();
        leavingVersionsAtCommit = new Map(leavingAccountIds.map(accountId => [
          accountId, tradeObservationVersionByAccount.get(accountId) ?? 0,
        ]));
        const committed = await durableStore.commit(
          toSnapshot(cleanState, [], [], current.revision, [], []),
          current.revision,
        );
        return createRuntime(cleanState, [], [], committed.revision, [], []);
      });
      copierLegTerminalSeenAt.clear();
      // Obchodní událost odcházejícího účtu přijatá během samotného zápisu už
      // nejde odmítnout (stará evidence je pryč). Nesmí ale zapadnout: nová
      // skupina zůstane DISARMED s povinnou reconciliací a hlášením.
      const changedDuringCommit = leavingAccountIds.filter(accountId => (
        (tradeObservationVersionByAccount.get(accountId) ?? 0) !== (leavingVersionsAtCommit?.get(accountId) ?? 0)
      ));
      const commitIngressError = changedDuringCommit.length > 0
        ? new Error(
          `Během přepnutí skupiny dorazila obchodní změna na odcházejících účtech ${changedDuringCommit.join(',')}; `
          + 'zkontroluj jejich pozice — kopírka je už nespravuje',
        )
        : null;
      if (commitIngressError) {
        options.onAudit?.([{
          at: clock(),
          leaderEventId: `switch-commit-ingress:${group.id}:${nextGroup.id}:${clock()}`,
          kind: 'blocked',
          reason: commitIngressError.message,
        }]);
      }
      // Audit smí tvrdit retirement až po úspěšném durable CAS. Při
      // selhání commit() se sem tok nedostane a chyba se propaguje.
      if (retirement) {
        const retiredAt = clock();
        options.onAudit?.([{
          at: retiredAt,
          leaderEventId: `manual-group-retirement:${group.id}:${retiredAt}`,
          kind: 'blocked',
          accountId: group.leaderAccountId,
          reason: `operator-attested retirement of OAuth-missing or inactive accounts of group ${group.id}; accounts=${[...retiredAccountIds].sort((a, b) => a - b).join(',')}; reason=${retirement.reason.trim()}; no broker flat proof for retired accounts`,
        }]);
      }

      // Od tohoto bodu je durable stará epocha pryč a teprve teď se stává
      // nový leader autoritativní pro event source i risk vrstvu.
      group = nextGroup;
      groupRevision += 1;
      for (const pending of pendingCutClosures) {
        await executeFollowerCutAction(pending.cut, pending.follower, true, false);
      }
      options.broker.setCriticalAccounts?.([nextGroup.leaderAccountId]);
      startupMissingLeaderRoute = null;
      if (startupGroupRepair) {
        startupGroupRepair = null;
        if (lastError?.message.startsWith('Uložená skupina má nedostupné účty')) lastError = null;
      }
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
      currentRuntimePendingExposure.clear();
      seenCurrentRuntimePendingFillIds.clear();
      conditionalMirrorSourcesByLeaderEvent.clear();
      conditionalMirrorWritesBySourceOrder.clear();
      flatSweepEntryCancelAttempts.clear();
      flatSweepCancelAttempts.clear();
      flatSweepCancelAttemptAccounts.clear();
      observedOrderStatusesByAccount.clear();
      tradeEpochGeneration += 1;
      blockedLeaderEntryOrderIds.clear();
      intentionalEntrySuppressions.clear();
      exitOnlyReservations.clear();
      exitOnlyPositionApplied.clear();
      exitOnlyFlatFillAwaitingPosition.clear();
      osoOpeningExcludedAccounts.clear();
      leaderPositions.clear();
      positionsByAccount.clear();
      leaderPositionSnapshotComplete = false;
      flatReconciledLeaderEpochIds.clear();
      leaderFillAheadOfPosition.clear();
      for (const snapshot of snapshots.required) {
        positionsByAccount.set(snapshot.accountId, new Map(
          snapshot.positions.map(position => [position.symbol, position.netQuantity]),
        ));
      }
      for (const snapshot of snapshots.required) rememberLiveOrderSnapshot(snapshot.accountId, snapshot.orders);
      lastAuthoritativeReadAt = clock();
      lastBrokerPositionAt = lastAuthoritativeReadAt;
      untrackedTradeSymbols.clear();
      recentFollowerFillCauses.clear();
      for (const timer of pendingFollowerMagnitudeChecks.values()) clearTimeout(timer);
      pendingFollowerMagnitudeChecks.clear();
      for (const timer of leaderFlatGuardTimers.values()) clearTimeout(timer);
      leaderFlatGuardTimers.clear();
      leaderFlatGuardGenerationRetries.clear();
      sweptProtectiveLegs.clear();
      sweepingProtectiveLegs.clear();
      workingOrderAccounts = new Set();
      lastAutoClose = null;
      lastResumeOffer = null;
      autoCloseEpisodeAttempts = 0;
      pendingConnectionRecovery = false;
      pendingReadOnlyConnectionRecovery = false;
      connectionRecoveryMissingOwnership = [];
      recoveryInFlight = false;
      bootRecoveryChecked = true;
      invalidateReconciliation();
      // Nová skupina startuje bez staré chyby; změna během zápisu ale zůstane vidět.
      lastError = commitIngressError;
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
        eventTail = apply.then(() => undefined, () => undefined);
        await apply;
      } finally {
        releaseFenceAccounts();
      }
    });
    reconfigurationTail = run.then(() => undefined, () => undefined);
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

  const unsubscribe = broker.subscribe(event => {

    const ingressPerformanceAt = performance.now();
    observeS1bIngress(event);
    const explicitReceivedAt = (event as BrokerEvent & { receivedAt?: number }).receivedAt;
    const eventReceivedAt = Number.isFinite(explicitReceivedAt)
      ? explicitReceivedAt as number
      : clock();
    const flatSweepIngressWave = event.type === 'position'
      && event.position.netQuantity === 0
      && group.followers.some(follower => follower.accountId === event.position.accountId)
      ? currentFlatSweepIngressWave()
      : undefined;
    if (event.type === 'order'
      && event.order.accountId === group.leaderAccountId
      && (event.order.status === 'rejected' || event.order.status === 'canceled')) {
      terminalLeaderOrdersOnIngress.set(
        `${event.order.accountId}:${event.order.brokerOrderId}`,
        event.order.status,
      );
    }
    const ingressAccountId = event.type === 'order'
      ? event.order.accountId
      : event.type === 'fill'
        ? event.fill.accountId
        : event.type === 'position'
          ? event.position.accountId
          : undefined;
    const ingressSymbol = event.type === 'order'
      ? event.order.symbol
      : event.type === 'fill'
        ? event.fill.symbol
        : event.type === 'position'
          ? event.position.symbol
          : undefined;
    const ingressOrderId = event.type === 'order'
      ? event.order.brokerOrderId
      : event.type === 'fill'
        ? event.fill.brokerOrderId
        : undefined;
    const ingressKeys = ingressAccountId == null || ingressSymbol == null
      ? []
      : [
        `${ingressAccountId}:symbol:${ingressSymbol}`,
        ...(event.type === 'position'
          ? [`${ingressAccountId}:position:${ingressSymbol}`]
          : []),
        ...(event.type === 'fill'
          ? [`${ingressAccountId}:fill:${event.fill.brokerOrderId}`]
          : []),
        ...(ingressOrderId == null
          ? []
          : [`${ingressAccountId}:order:${ingressOrderId}`]),
      ];
    const affectedAccountIds = new Set([
      group.leaderAccountId,
      ...group.followers.map(follower => follower.accountId),
      ...configurationFenceAccountRefs.keys(),
    ]);
    const eventType = (event as { type: string }).type;
    const controlIngress = eventType === 'connection' || eventType === 'error'
      || eventType === 'resynced' || eventType === 'route-gap';
    const tradeIngress = (event.type === 'position' || event.type === 'order' || event.type === 'fill')
      && ingressAccountId != null
      && affectedAccountIds.has(ingressAccountId);
    const leaderTradeIngress = tradeIngress && ingressAccountId === group.leaderAccountId;
    if (leaderTradeIngress) {
      leaderEventQuietUntil = Math.max(
        leaderEventQuietUntil,
        connectionRenewalClock() + connectionRenewalQuietMs,
      );
    }
    if (tradeIngress || controlIngress) {
      // Keepalive `h` pouze dokládá liveness. Nesmí zneplatnit broker-state
      // fence ani předstírat rozpracovanou obchodní událost.
      brokerObservationVersion += 1;
    }
    if (controlIngress) configurationControlVersion += 1;
    if (tradeIngress) {
      tradeBoundaryObservationVersion += 1;
      tradeObservationVersionByAccount.set(
        ingressAccountId!,
        (tradeObservationVersionByAccount.get(ingressAccountId!) ?? 0) + 1,
      );
      pendingTradeIngressByAccount.set(
        ingressAccountId!,
        (pendingTradeIngressByAccount.get(ingressAccountId!) ?? 0) + 1,
      );
      for (const key of ingressKeys) {
        pendingTradeIngressByKey.set(key, (pendingTradeIngressByKey.get(key) ?? 0) + 1);
      }
    }
    if (tradeIngress) pendingBrokerEvents += 1;
    const admissionGeneration = safetyGeneration;
    const ingressObservationVersion = tradeIngress && ingressAccountId != null
      ? tradeObservationVersionByAccount.get(ingressAccountId)
      : undefined;
    eventTail = eventTail
      .then(() => {
        if (tradeIngress && ingressAccountId != null) {
          const remaining = Math.max(0, (pendingTradeIngressByAccount.get(ingressAccountId) ?? 0) - 1);
          if (remaining === 0) pendingTradeIngressByAccount.delete(ingressAccountId);
          else pendingTradeIngressByAccount.set(ingressAccountId, remaining);
          for (const key of ingressKeys) {
            const pending = Math.max(0, (pendingTradeIngressByKey.get(key) ?? 0) - 1);
            if (pending === 0) pendingTradeIngressByKey.delete(key);
            else pendingTradeIngressByKey.set(key, pending);
          }
        }
        return handleBrokerEvent(
          event,
          admissionGeneration,
          eventReceivedAt,
          flatSweepIngressWave,
          ingressObservationVersion,
        ).finally(flushDeferredStaleFailClosed);
      })
      .catch(failClosed)
      .finally(() => {
        if (tradeIngress) pendingBrokerEvents = Math.max(0, pendingBrokerEvents - 1);
        if (leaderTradeIngress) {
          leaderEventQuietUntil = Math.max(
            leaderEventQuietUntil,
            connectionRenewalClock() + connectionRenewalQuietMs,
          );
        }
      });
  });

  return {
    maintenanceRestartBlocker() {
      return readOnlyRecoveryBlocker() ?? this.connectionRenewalBlocker();
    },
    connectionRenewalBlocker() {
      if (autoCloseInFlight) return 'auto-close';
      if (recoveryInFlight || pendingConnectionRecovery || pendingReadOnlyConnectionRecovery
        || reconciliationRequestsPending > 0 || armPreparationInFlight) return 'connection recovery';
      if (hasInFlightOutbox()) return 'durable outbox';
      if (pendingBrokerEvents > 0) return 'leader event queue';
      if (pendingOsoTimers.size > 0 || pendingOsoEvents.size > 0 || pendingOsoFlushes.size > 0) {
        return 'OSO correlation';
      }
      if (connectionRenewalClock() < leaderEventQuietUntil) return 'leader event quiet window';
      return null;
    },
    prepareArm,
    startArmPreparation() {
      automaticArmPreparation = true;
      scheduleArmPreparation();
    },
    noteArmPreparationInterest() {
      armPreparationInterestUntil = Math.max(
        armPreparationInterestUntil,
        clock() + ARM_PREPARATION_INTEREST_MS,
      );
      scheduleArmPreparation();
    },
    arm({ shadowMode = false, ttlMs, requirePreparation = false } = {}) {
      if (stopped) throw new Error('Copier runtime is stopped');
      if (shutdownRequested) throw new Error('Copier runtime se právě bezpečně ukončuje');
      const processorRecovery = processor.recoveryStatus();
      if (processorRecovery.state !== 'ready') {
        throw new Error(
          `Copier nelze armovat: durable reload processoru není dokončen (${processorRecovery.reason})`,
        );
      }
      if (startupGroupRepair) {
        throw new Error(
          `Copier nelze armovat: uložená skupina má nedostupné účty (${startupGroupRepair.unavailableAccountIds.join(', ')}); nejdřív je odeber v editoru skupiny`,
        );
      }
      if (startupMissingLeaderRoute) throw new Error(`Copier nelze armovat: starý leader nemá OAuth route (${startupMissingLeaderRoute.message})`);
      if (gate.killSwitch) throw new Error('Copier nelze armovat: kill switch je aktivní');
      if (ttlMs != null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
        throw new Error('ARM TTL musí být kladný počet milisekund');
      }
      const now = clock();
      if (requirePreparation && !hasFreshArmPreparation()) {
        throw new Error('ARM blokován: předběžné ověření bylo zneplatněno');
      }
      const startedNewRiskSession = rollRiskSessionMemoryIfExpired(now);
      if (!shadowMode) assertVerifiedArmRisk(now);
      if (!group.enabled) throw new Error('Copier nelze armovat: skupina je vypnutá');
      if (!gate.connected) throw new Error('Copier nelze armovat bez dokončeného broker syncu');
      if (hasStuckOutbox()) throw new Error('Copier má nevyřešený outbox');
      if (gate.divergentAccounts.size > 0) throw new Error('Pozice leader/follower se rozcházejí');
      if (workingOrderAccounts.size > 0) throw new Error('Před ARM musí být všechny účty bez pracovních příkazů');
      if (source.needsReconciliation()) {
        throw new Error('Po reconnectu je nutná kontrola pozic; před ARM proveď kontrolu pozic');
      }
      const safety = currentRuntime().state.safety;
      if (!shadowMode && safety.managementOnly) {
        throw new Error('ARM blokován: kopírka je v režimu správy otevřených kopií; po flat proveď Kontrolu pozic');
      }
      if (!shadowMode && currentDailyStats(now).unconfirmedFlatLots?.length) {
        throw new Error('ARM blokován: nepotvrzený výsledek uzavření leadera v této session; ověř close fills a denní risk');
      }
      if (!shadowMode && now < safety.dayLockUntil) {
        throw new Error(`ARM blokován denním lockem: ${safety.dayLockReason ?? 'risk lock'}`);
      }
      const tradingWindow = group.safety?.tradingWindow ?? DEFAULT_COPY_GROUP_SAFETY.tradingWindow;
      if (!shadowMode && tradingWindow.enabled
        && tradingWindowStateAt(tradingWindow, now) !== 'inside') {
        throw new Error(
          `ARM blokován mimo obchodní okno ${formatTradingWindows(tradingWindow)} (${tradingWindow.timeZone})`,
        );
      }
      if (!shadowMode && now < safety.entryCooldownUntil) {
        const remainingMin = Math.ceil((safety.entryCooldownUntil - now) / 60_000);
        throw new Error(`ARM blokován anti-revenge cooldownem ještě ${remainingMin} min`);
      }
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
          follower.enabled !== false && follower.mode !== 'off'
          && !ineligible.has(follower.accountId)
          && !activeFollowerCut(follower.accountId, now));
        if (participatingFollowers.length === 0) {
          throw new Error('ARM blokován: skupina nemá žádný způsobilý follower účet');
        }
      }
      // Kratší z limitů vyhrává: session TTL nesmí ARM prodloužit za výchozí strop.
      const armTtlMs = ttlMs != null ? Math.min(ttlMs, defaultArmTtlMs) : defaultArmTtlMs;
      safetyGeneration += 1;
      tradeEpochGeneration += 1;
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
      if (requirePreparation) {
        // Enforce the verified risk limits immediately, before newly queued
        // leader events, without another REST round-trip. Merely deferring
        // the old forced poll would leave cuts unenforced until a heartbeat.
        eventTail = eventTail.then(() => applyAccountRiskPoll(
          [], currentDailyStats(clock()).sessionEndAt, [],
        )).catch(reason => failClosed(reason, { autoClose: false }));
      } else scheduleAccountRiskPoll(
        [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)], true,
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
      cancelFollowerCutBackgroundLanes('shutdown');
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
    disarm(trigger = 'manual') {
      safetyGeneration += 1;
      armPreparationLastAttemptAt = -Infinity;
      const wasArmed = gate.armed;
      gate = { ...gate, armed: false };
      cancelFollowerCutBackgroundLanes('disarm');
      if (wasArmed) {
        recordDisarm(
          trigger,
          trigger === 'config-change'
            ? 'config-change: kopírka byla vypnuta kvůli uložení execution změny skupiny'
            : trigger === 'connection-removed'
              ? 'OAuth připojení propfirmy bylo odpojeno; worker kopírku vypnul'
              : 'Uživatel vypnul kopírku ručně',
          groupIsFlat() ? 'flat' : 'unknown',
        );
      }
      lastResumeOffer = null;
      // Ruční DISARM zastaví nové kopie. Starý obecný account-wide boot
      // auto-close vypneme, ale durable leader-flat epocha zůstává: pokud
      // leader později zavře, smí dokončit jen prokázanou existující kopii
      // přes přesný account/symbol guard.
      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
      // Odmítnuté a ukončené kopie na flat účtech se usadí hned, ne až sweepem.
      scheduleCopierSettlementSweep();
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
      cancelFollowerCutBackgroundLanes('kill-switch');
      lastResumeOffer = null;
      pendingConnectionRecovery = false;
      pendingReadOnlyConnectionRecovery = false;
      // Kill switch = explicitní freeze; žádná pozdější automatika.
      void syncLiveCopyExposureFlag('clear').catch(() => undefined);
      options.onError?.(lastError);
    },
    reportHostSleep(incident) {
      if (stopped) return;
      if (!Number.isFinite(incident.unresponsiveSince)
        || !Number.isFinite(incident.detectedAt)
        || !Number.isFinite(incident.sleepDurationMs)
        || incident.detectedAt < incident.unresponsiveSince
        || incident.sleepDurationMs <= 0) {
        throw new Error('Neplatný host-sleep incident');
      }
      if (lastHostSleep?.detectedAt === incident.detectedAt) return;
      lastHostSleep = { ...incident };
      const detail = `host-sleep: Mac neodpovídal od ${new Date(incident.unresponsiveSince).toISOString()} `
        + `(${Math.max(1, Math.round(incident.sleepDurationMs / 1_000))} s)`;
      failClosed(new Error(detail), {
        autoClose: false,
        recordWhenDisarmed: true,
      });
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
      scheduleCopierSettlementSweep();
      // Správa otevřených kopií (management-only) se nesmí vypnout ruční
      // Kontrolou pozic — odmítnutí musí přijít dřív než auditovaný DISARM.
      const managementOnly = currentRuntime().state.safety.managementOnly;
      if (
        gate.armed
        && managementOnly
        && !managementOnlyGroupPositionsAreKnownFlat()
      ) {
        throw new Error(
          'Kontrola pozic je během správy otevřených kopií blokovaná, aby nevypnula jejich řízení. '
          + 'Počkej na flat nebo použij Flatten.',
        );
      }
      if (gate.armed) {
        safetyGeneration += 1;
        gate = { ...gate, armed: false };
        recordDisarm(
          'manual',
          'reconcile-request: kopírka byla vypnuta před ruční Kontrolou pozic',
          groupIsFlat() ? 'flat' : 'unknown',
          { code: 'reconcile-request' },
        );
        options.onAudit?.([{
          at: clock(), leaderEventId: 'manual-reconcile-disarm', kind: 'blocked',
          reason: 'Kontrola pozic nejprve auditovaně vypnula ARM; broker cesta zůstává pouze read-only',
        }]);
      }
      const processorRecovery = processor.recoveryStatus();
      if (processorRecovery.state === 'failed') await processor.recover();
      else if (processorRecovery.state === 'reloading') await processor.waitForRecovery();
      // Veřejná Kontrola pozic je explicitní uživatelská recovery akce.
      // Pouze její čistý výsledek smí odstranit starou chybu; automatické
      // reconnect/terminal-fill kontroly incident uživateli neschovávají.
      const result = await performReconciliation({ ...reconciliationOptions, clearLastError: true });
      if (result.authoritativelyClean) {
        await persistSafetyUpdate(current => {
          const { manualRecoveryRequired: _cleared, ...rest } = current;
          return rest;
        });
        armPreparationIncidentRequiresRecovery = false;
      }
      const riskAccountIds = followersRequiringVerifiedRisk(clock()).map(follower => follower.accountId);
      if (result.authoritativelyClean && riskAccountIds.length > 0) {
        // Kontrola pozic je jediná explicitní read-only brána před ARM.
        // Proto ve stejném kroku načte i účty, jejichž pravidla závisejí na
        // dnešním P&L / prop rezervě, a vyčká na jejich aplikaci do runtime.
        scheduleAccountRiskPoll(riskAccountIds, true);
        await accountRiskPollTail;
      }
      if (result.authoritativelyClean && groupIsFlat()) {
        pendingReadOnlyConnectionRecovery = false;
        const safety = currentRuntime().state.safety;
        if (safety.managementOnly) {
          const { managementOnly: _finished, ...rest } = safety;
          await persistSafety(rest);
          options.onAudit?.([{
            at: clock(),
            leaderEventId: 'management-only-cleared',
            kind: 'recovered',
            reason: 'management-only ukončen po autoritativně potvrzeném flat/no-active stavu',
          }]);
        }
      }
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
      // BREACHED je trvalý a nikdy se neruší časem ani reconciliací. Jediná
      // cesta zpět je tato ruční operátorská kontrola s úplným broker důkazem:
      // žádná známka likvidace, známý floor propky a equity nad ním. (17. 9.
      // 2026: čtyři čerstvé funded účty byly vyřazeny kvůli špatnému čtení
      // maxNetLiq/minNetLiq; bez této cesty by zůstaly vyřazené navždy.)
      let breachedProof: string | null = null;
      if (effective?.state === 'breached') {
        const breach = await classifyFollowerBrokerBreach(accountId);
        if (breach) throw new Error(`Účet je BREACHED a broker to potvrzuje: ${breach}`);
        const [risk] = await broker.listAccountRiskSnapshots([accountId]);
        const equity = risk ? brokerRiskEquity(risk) : null;
        if (!risk || equity == null || risk.minNetLiq == null) {
          throw new Error('Účet je BREACHED a broker nevydal floor propky ani equity, kterými by šlo vyřazení zrušit');
        }
        if (equity <= risk.minNetLiq) {
          throw new Error(`Účet je BREACHED: equity ${equity.toFixed(2)} USD není nad floorem propky ${risk.minNetLiq.toFixed(2)} USD`);
        }
        breachedProof = `equity ${equity.toFixed(2)} USD nad floorem propky ${risk.minNetLiq.toFixed(2)} USD`;
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
        reason: breachedProof
          ? `BREACHED zrušen ručním ověřením u brokera: účet aktivní, ${breachedProof}`
          : 'autoritativně ověřeno u brokera po nové session',
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
        reason: breachedProof
          ? `BREACHED zrušen operátorem — broker účet aktivní, ${breachedProof}`
          : 'účet znovu způsobilý — cílené read-only ověření u brokera',
      }]);
      return verified;
    },
    preflightGroupChange(nextGroup, preflightOptions = {}) {
      nextGroup = normalizedRuntimeGroup(nextGroup);
      if (nextGroup.id !== group.id && !preflightOptions.allowGroupChange) {
        throw new Error('Nelze změnit runtime na jinou copy group bez explicitní aktivace');
      }
      assertTightenOnly(nextGroup);
      if (stopped || shutdownRequested || gate.killSwitch) {
        throw new Error('Změnu konfigurace blokuje zastavený worker nebo kill switch');
      }
      // Běžící recovery/reconciliation blokuje vždy. Samotný požadavek na
      // reconciliation (po změně skupiny, po DISARM) za DISARMED ne: ARM cesta
      // ho provede sama až po změně. Jinak ARM z UI, který posílá i konfiguraci
      // skupiny, spadne dřív, než se k reconciliation dostane (29. 9. 2026).
      if (recoveryInFlight || pendingConnectionRecovery || pendingReadOnlyConnectionRecovery
        || reconciliationRequestsPending > 0 || (gate.armed && source.needsReconciliation())) {
        throw new Error('Změnu konfigurace blokuje probíhající connection recovery/reconciliation');
      }
      if (currentStuckOperations().length > 0 || hasBrokerUncertainOutbox()) {
        throw new Error('Změnu konfigurace blokuje nevyřešený durable outbox');
      }
      const currentAccounts = [group.leaderAccountId, ...group.followers.map(item => item.accountId)];
      const weaker = isWeakerRiskConfig(group, nextGroup);
      const inPlaceChange = weaker.length === 0 && (
        isMetadataOnlyGroupChange(group, nextGroup)
        || isInPlaceCutTightening(group, nextGroup)
      );
      const executionChanged = !inPlaceChange;
      if (executionChanged) {
        if (!gate.connected) throw new Error('Změnu execution konfigurace nelze potvrdit bez broker syncu');
        if (pendingTradeEventsFor(currentAccounts) || participationLifecyclePending()) {
          throw new Error('Změnu execution konfigurace blokuje probíhající obchodní lifecycle');
        }
        const nonFlat = currentAccounts.filter(accountId => (
          [...(positionsByAccount.get(accountId)?.values() ?? [])].some(quantity => quantity !== 0)
        ));
        const working = currentAccounts.filter(accountId => (liveOrdersByAccount.get(accountId)?.size ?? 0) > 0);
        if (nonFlat.length > 0 || working.length > 0) {
          throw new Error(
            'Tuto změnu uložit jde jen ve flat stavu — kopírka zůstává zapnutá '
            + 'se stávajícím nastavením'
            + `${nonFlat.length > 0 ? `; nonFlat=${nonFlat.join(',')}` : ''}`
            + `${working.length > 0 ? `; working=${working.join(',')}` : ''}`,
          );
        }
      }
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
    async setFollowerEnabled(accountId, enabled, persistGroup) {
      const follower = group.followers.find(item => item.accountId === accountId);
      const before = follower?.enabled !== false;
      const audit = (outcome: 'changed' | 'blocked', reason: string, after = before) => {
        const at = clock();
        options.onAudit?.([{
          at, leaderEventId: `follower-participation:${group.id}:${accountId}:${participationGeneration}:${at}`,
          kind: 'follower-participation', accountId, reason, participationOutcome: outcome,
          configuredEnabledBefore: before, configuredEnabledAfter: after,
        }]);
      };
      try {
        if (!Number.isSafeInteger(accountId) || !follower) throw new Error('Účet není follower této skupiny');
        if (typeof enabled !== 'boolean') throw new Error('Neplatný stav přepínače followera');
        const eligibility = currentIneligibleAccounts().get(accountId);
        const cut = activeFollowerCut(accountId);
        if (enabled && (eligibility || cut || follower.mode === 'off')) {
          throw new Error(`Follower je automaticky nebo režimem vyřazen: ${eligibility ?? (cut ? `follower-cut:${cut.source}` : 'mode-off')}`);
        }
        if (enabled === before) return group;
        if (stopped || shutdownRequested || !gate.connected || (enabled && gate.killSwitch)) {
          throw new Error('Worker není připravený nebo připojený');
        }
        if (enabled && (source.needsReconciliation() || !positionCheckComplete
          || reconciliationRequestsPending > 0 || recoveryInFlight
          || pendingConnectionRecovery || pendingReadOnlyConnectionRecovery)) {
          throw new Error('Čeká kontrola pozic nebo obnova spojení');
        }
        const leaderAccountId = group.leaderAccountId!;
        const accountIds = [leaderAccountId, accountId];
        if (enabled
          ? (pendingTradeEventsFor(accountIds) || participationLifecyclePending()
            || currentStuckOperations().length > 0 || hasBrokerUncertainOutbox())
          : participationLifecyclePendingFor(accountIds)) {
          throw new Error('Probíhá broker událost, obchodní lifecycle nebo nejasný outbox');
        }
        const generation = safetyGeneration;
        const connectionGeneration = connectionSyncGeneration;
        const controlVersion = configurationControlVersion;
        const participation = participationGeneration;
        const observations = new Map(accountIds.map(id => [id, tradeObservationVersionByAccount.get(id) ?? 0]));
        for (const id of accountIds) {
          if ([...(positionsByAccount.get(id)?.values() ?? [])].some(quantity => quantity !== 0)) {
            throw new Error(`Účet ${id} má podle živého streamu otevřenou pozici`);
          }
          if ((liveOrdersByAccount.get(id)?.size ?? 0) > 0) {
            throw new Error(`Účet ${id} má podle živého streamu čekající příkaz`);
          }
        }
        const assertUnchanged = () => {
          const tradeChanged = accountIds.some(id => (
            (tradeObservationVersionByAccount.get(id) ?? 0) !== observations.get(id)
          ));
          if (stopped || shutdownRequested || !gate.connected || (enabled && gate.killSwitch)
            || safetyGeneration !== generation || connectionSyncGeneration !== connectionGeneration
            || configurationControlVersion !== controlVersion
            || participationGeneration !== participation || tradeChanged || pendingTradeEventsFor(accountIds)
            || (enabled && (source.needsReconciliation() || recoveryInFlight
              || pendingConnectionRecovery || pendingReadOnlyConnectionRecovery
              || reconciliationRequestsPending > 0 || participationLifecyclePending()
              || currentStuckOperations().length > 0
              || hasBrokerUncertainOutbox()))
            || (!enabled && participationLifecyclePendingFor(accountIds))) {
            throw new Error('Stav se během ověření změnil; přepnutí followera opakuj');
          }
        };
        const readRound = async () => withLeaderEpochDeadline('Přepnutí followera', Promise.all(
          accountIds.map(async id => {
            const [positions, orders] = await Promise.all([
              broker.listPositions(id), broker.listOrders(id),
            ]);
            return { accountId: id, positions, orders };
          }),
        ));
        let confirmedSnapshots: Awaited<ReturnType<typeof readRound>> = [];
        // Dvě shodná autoritativní čtení; bezpečnostní strop jsou tři a žádný
        // retry nikdy neposílá broker write.
        for (let round = 0; round < 2; round += 1) {
          const snapshots = await readRound();
          assertUnchanged();
          for (const snapshot of snapshots) {
            if (snapshot.positions.some(position => position.netQuantity !== 0)) {
              throw new Error(`Účet ${snapshot.accountId} má otevřenou pozici`);
            }
            if (snapshot.orders.some(order => isOpenOrderStatus(order.status))) {
              throw new Error(`Účet ${snapshot.accountId} má čekající nebo pracovní příkaz`);
            }
          }
          confirmedSnapshots = snapshots;
        }
        assertUnchanged();
        // REST čtení záměrně proběhlo mimo eventTail. Až aplikace výsledku
        // se zařadí za broker eventy a znovu ověří stejné scoped verze.
        const run = eventTail.then(async () => {
          assertUnchanged();
          const previous = group;
          const next = normalizedRuntimeGroup({
            ...previous,
            followers: previous.followers.map(item => item.accountId === accountId
              ? { ...item, enabled }
              : item),
          });
          try {
            await persistGroup(next);
            // Ingress is synchronous while the store fsyncs. Its event stays
            // behind this eventTail item; roll back before it may dispatch.
            assertUnchanged();
          } catch (reason) {
            try {
              await persistGroup(previous);
            } catch (rollbackError) {
              failClosed(new Error(`Participation persistence/rollback uncertain: ${String(rollbackError)}`));
            }
            throw reason;
          }
          group = next;
          groupRevision += 1;
          participationGeneration += 1;
          // The two fresh rounds are now the authoritative flat baseline.
          for (const snapshot of confirmedSnapshots) {
            positionsByAccount.set(snapshot.accountId, new Map(
              snapshot.positions.map(position => [position.symbol, position.netQuantity]),
            ));
            rememberLiveOrderSnapshot(snapshot.accountId, snapshot.orders);
          }
          lastAuthoritativeReadAt = clock();
          lastBrokerPositionAt = lastAuthoritativeReadAt;
          audit('changed', `ruční účast změněna ${before} → ${enabled}`, enabled);
          return group;
        });
        eventTail = run.then(() => undefined, () => undefined);
        return await run;
      } catch (reason) {
        audit('blocked', errorOf(reason).message);
        throw reason;
      }
    },
    updateGroup(nextGroup) {
      const wasArmed = gate.armed;
      // Jakýkoli pokus o změnu konfigurace nejdřív zavře live dispatch.
      gate = { ...gate, armed: false };
      if (recoveryInFlight || pendingConnectionRecovery || reconciliationRequestsPending > 0) {
        throw new Error('Změnu konfigurace blokuje probíhající connection recovery/reconciliation');
      }
      if (nextGroup.id !== group.id) throw new Error('Nelze změnit runtime na jinou copy group');
      nextGroup = normalizedRuntimeGroup(nextGroup);
      assertTightenOnly(nextGroup, !wasArmed);
      if (nextGroup.leaderAccountId !== group.leaderAccountId) {
        throw new Error('Změna leadera vyžaduje bezpečný reconfigureGroup preflight');
      }
      const pendingCutClosures = tightenedCutClosures(group, nextGroup);
      group = nextGroup;
      groupRevision += 1;
      invalidateReconciliation();
      if (pendingCutClosures.length > 0) {
        const run = eventTail.then(async () => {
          for (const pending of pendingCutClosures) {
            await executeFollowerCutAction(pending.cut, pending.follower, !gate.shadowMode, true);
          }
        });
        eventTail = run.then(() => undefined, reason => {
          failClosed(reason, { autoClose: false });
        });
      }
    },
    updateGroupMetadata(nextGroup) {
      nextGroup = normalizedRuntimeGroup(nextGroup);
      if (!isMetadataOnlyGroupChange(group, nextGroup)) {
        throw new Error('Metadata cesta smí měnit pouze name, color a bezpečně zpřísněná safety pravidla');
      }
      if (recoveryInFlight || pendingConnectionRecovery || pendingReadOnlyConnectionRecovery
        || reconciliationRequestsPending > 0) {
        throw new Error('Změnu metadat blokuje probíhající connection recovery/reconciliation');
      }
      const weaker = isWeakerRiskConfig(group, nextGroup);
      if (weaker.length > 0) {
        throw new Error(`Metadata cesta smí safety pouze zpřísnit: ${weaker.join(', ')}`);
      }
      assertTightenOnly(nextGroup);
      group = nextGroup;
      groupRevision += 1;
    },
    async updateGroupRiskInPlace(nextGroup) {
      nextGroup = normalizedRuntimeGroup(nextGroup);
      if (!isInPlaceCutTightening(group, nextGroup)) {
        throw new Error('In-place cesta smí pouze přidat/snížit cut nebo změnit let-run na close-copy');
      }
      if (recoveryInFlight || pendingConnectionRecovery || pendingReadOnlyConnectionRecovery
        || reconciliationRequestsPending > 0) {
        throw new Error('Zpřísnění cutu blokuje probíhající connection recovery/reconciliation');
      }
      assertTightenOnly(nextGroup);
      const expectedRevision = groupRevision;
      const run = eventTail.then(async () => {
        if (groupRevision !== expectedRevision) {
          throw new Error('Zpřísnění cutu: konfigurace se změnila; opakuj uložení');
        }
        // Kandidáty počítáme až za dříve přijatými eventy. Změna revision
        // nejdřív zastaví starou background lane před jejím dalším broker
        // zápisem; close-copy začne až po doběhnutí již rozběhnutého zápisu.
        const pendingCutClosures = tightenedCutClosures(group, nextGroup);
        group = nextGroup;
        groupRevision += 1;
        for (const pending of pendingCutClosures) {
          await waitForFollowerCutBackground(pending.cut.accountId);
          try {
            await executeFollowerCutAction(
              pending.cut,
              pending.follower,
              !gate.shadowMode,
              true,
            );
          } catch (reason) {
            failClosed(reason, { autoClose: false });
          }
        }
      });
      eventTail = run.then(() => undefined, () => undefined);
      await run;
    },
    async flattenAccount(accountId, operationId) {
      const allowed = new Set([
        group.leaderAccountId as number,
        ...group.followers.map(follower => follower.accountId),
      ]);
      if (!allowed.has(accountId)) throw new Error('Účet není součástí této copy group');
      return emergencyFlatten([accountId], operationId);
    },
    async flattenFollowerTrade(accountId, operationId, flattenOptions) {
      return flattenFollowerForCurrentTrade(accountId, operationId, flattenOptions?.onAdmitted);
    },
    async flattenGroup(operationId) {
      if (group.leaderAccountId == null) throw new Error('Copy group nemá leader účet');
      return emergencyFlatten(
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
        const committed = await durableStore.commit(
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
        armPreparation: (() => {
          const blocker = armPreparationBlocker();
          return {
            state: armPreparationInFlight || recoveryInFlight ? 'checking'
              : blocker ? 'blocked'
                : hasFreshArmPreparation() ? 'ready' : 'needed',
            verifiedAt: armPreparationReceipt?.verifiedAt ?? null,
            reason: blocker?.reason ?? armPreparationError,
            blockedBy: blocker?.blockedBy ?? null,
            manualRecoveryRequired: blocker?.blockedBy === 'incident',
          };
        })(),
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
        exposure: (() => {
          if (lastAuthoritativeReadAt == null || !gate.connected) return null;
          const positions = [...positionsByAccount].flatMap(([accountId, bySymbol]) => [...bySymbol]
            .filter(([, netQuantity]) => netQuantity !== 0)
            .map(([symbol, netQuantity]) => ({ accountId, symbol, netQuantity })));
          const leaderHeld = positionsByAccount.get(group.leaderAccountId as number);
          const symbols = new Set(positions.map(position => position.symbol));
          const followers = group.followers.map(follower => {
            const id = follower.accountId;
            if (follower.enabled === false) {
              const held = positionsByAccount.get(id);
              const nonFlat = held == null || [...held.values()].some(quantity => quantity !== 0);
              const working = (liveOrdersByAccount.get(id)?.size ?? 0) > 0;
              return nonFlat || working || gate.divergentAccounts.has(id)
                ? { accountId: id, ok: false, detail: working
                  ? 'vypnutý follower má aktivní příkaz'
                  : 'vypnutý follower není flat' }
                : { accountId: id, ok: true, detail: 'ručně vypnutý follower' };
            }
            if (follower.mode === 'off') return { accountId: id, ok: true, detail: 'vypnutý follower' };
            if (gate.divergentAccounts.has(id)) return { accountId: id, ok: false, detail: 'pozice se liší od leadera' };
            if (workingOrderAccounts.has(id)) return { accountId: id, ok: false, detail: 'aktivní příkazy mimo kopii' };
            const eligibility = accountEligibility.get(id)?.state;
            if (eligibility === 'breached') return { accountId: id, ok: false, detail: 'účet zlikvidován propkou' };
            if (eligibility === 'dll-locked') return { accountId: id, ok: false, detail: 'denní limit účtu' };
            const held = positionsByAccount.get(id);
            if (!held) return { accountId: id, ok: false, detail: 'pozice neověřena' };
            const activeCut = activeFollowerCut(id);
            if (activeCut) return {
              accountId: id,
              ok: true,
              detail: activeCut.source === 'manual' && activeCut.scope === 'trade'
                ? 'ručně zavřen — čeká na další obchod'
                : 'vyřazen limitem do konce session',
            };
            for (const symbol of symbols) {
              const expected = Math.trunc((leaderHeld?.get(symbol) ?? 0) * follower.multiplier);
              const actual = held.get(symbol) ?? 0;
              if (actual === expected) continue;
              const suppression = intentionalEntrySuppressions.get(intentionalSuppressionKey(id, symbol));
              if (suppression && actual === suppression.allowedNet) {
                return { accountId: id, ok: true, detail: 'vyřazen z této epizody' };
              }
              return { accountId: id, ok: false, detail: `${symbol}: drží ${actual}, očekáváno ${expected}` };
            }
            return { accountId: id, ok: true, detail: null };
          });
          const members = new Set([group.leaderAccountId as number, ...group.followers.map(follower => follower.accountId)]);
          const orders = [...liveOrdersByAccount].flatMap(([accountId, byId]) => (members.has(accountId)
            ? [...byId.values()].map(order => ({
              accountId,
              brokerOrderId: order.brokerOrderId,
              symbol: order.symbol,
              side: order.side,
              orderType: order.orderType,
              quantity: order.quantity,
              filledQuantity: order.filledQuantity,
              limitPrice: order.limitPrice ?? null,
              stopPrice: order.stopPrice ?? null,
              status: order.status,
              updatedAt: order.updatedAt,
            }))
            : []));
          return {
            verifiedAt: Math.max(lastAuthoritativeReadAt, lastBrokerPositionAt ?? 0),
            positions,
            followers,
            orders,
          };
        })(),
        lastError: lastError?.message ?? null,
        ...(lastDisarm ? { lastDisarm: { ...lastDisarm } } : {}),
        disarmHistory: disarmHistory.map(record => ({ ...record })),
        hostSleep: lastHostSleep ? { ...lastHostSleep } : null,
        startupGroupRepair: startupGroupRepair
          ? { ...startupGroupRepair, unavailableAccountIds: [...startupGroupRepair.unavailableAccountIds] }
          : null,
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
        managementOnly: current.state.safety.managementOnly
          ? {
            ...current.state.safety.managementOnly,
            accountIds: [...current.state.safety.managementOnly.accountIds],
          }
          : null,
        sessionArmedAt: effectiveSessionArmedAt,
        followerCuts: [...followerCuts.values()]
          .filter(cut => cut.until > statusNow
            && group.followers.some(follower => follower.accountId === cut.accountId))
          .map(cut => ({ ...cut })),
        followerParticipation: group.followers.map(follower => {
          const configuredEnabled = follower.enabled !== false;
          const eligibility = currentIneligibleAccounts(statusNow).get(follower.accountId);
          const cut = activeFollowerCut(follower.accountId, statusNow);
          const automaticExclusion = eligibility ?? (cut ? `follower-cut:${cut.source}` : undefined);
          const blockers: string[] = [];
          const enabling = !configuredEnabled;
          if (!gate.connected || stopped || shutdownRequested) blockers.push('Worker není připojený');
          if (enabling && (lastAuthoritativeReadAt == null || statusNow - lastAuthoritativeReadAt > 5 * 60_000
            || !positionsByAccount.has(group.leaderAccountId!)
            || !positionsByAccount.has(follower.accountId))) blockers.push('Snapshot pozic není čerstvý');
          if (enabling && (source.needsReconciliation() || !positionCheckComplete)) blockers.push('Čeká kontrola pozic');
          if (enabling && automaticExclusion) blockers.push(`Automatické vyřazení: ${automaticExclusion}`);
          if (enabling && follower.mode === 'off') blockers.push('Režim replikace je vypnutý');
          if ([...(positionsByAccount.get(group.leaderAccountId!)?.values() ?? [])].some(quantity => quantity !== 0)) {
            blockers.push('Leader má otevřenou pozici');
          }
          if ([...(positionsByAccount.get(follower.accountId)?.values() ?? [])].some(quantity => quantity !== 0)) {
            blockers.push('Follower má otevřenou pozici');
          }
          if ((liveOrdersByAccount.get(group.leaderAccountId!)?.size ?? 0) > 0) blockers.push('Leader má čekající příkaz');
          if ((liveOrdersByAccount.get(follower.accountId)?.size ?? 0) > 0) blockers.push('Follower má čekající příkaz');
          if (enabling
            ? (pendingTradeEventsFor([group.leaderAccountId!, follower.accountId])
              || participationLifecyclePending())
            : participationLifecyclePendingFor([group.leaderAccountId!, follower.accountId])) {
            blockers.push('Probíhá obchodní lifecycle');
          }
          if (enabling && (hasBrokerUncertainOutbox() || reconciliationRequestsPending > 0
            || recoveryInFlight || pendingConnectionRecovery || pendingReadOnlyConnectionRecovery)) {
            blockers.push('Nejasný outbox nebo obnova spojení');
          }
          if (enabling && gate.killSwitch) blockers.push('Kill switch je aktivní');
          return {
            accountId: follower.accountId,
            configuredEnabled,
            effectiveEnabled: configuredEnabled && follower.mode !== 'off' && !automaticExclusion,
            canToggle: blockers.length === 0,
            blockers,
            ...(automaticExclusion ? { automaticExclusion } : {}),
          };
        }),
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
        const observedDisarmPersistence = disarmPersistenceTail;
        await observedDisarmPersistence;
        await processor.waitForRecovery();
        const observedPreparation = armPreparationInFlight;
        if (observedPreparation) await observedPreparation.catch(() => undefined);
        const observedRiskPoll = accountRiskPollTail;
        await observedRiskPoll;
        const observedRouteEpochRefresh = routeEpochRefreshTail;
        await observedRouteEpochRefresh;
        const observedFollowerCuts = [...followerCutBackgroundJobs];
        if (observedFollowerCuts.length > 0) {
          await Promise.all(observedFollowerCuts.map(job => job.catch(() => undefined)));
        }
        const observedShutdown = shutdownPromise;
        if (observedShutdown) await observedShutdown;
        const pendingFlushes = [...pendingOsoFlushes.values()];
        if (pendingFlushes.length > 0) await Promise.all(pendingFlushes);
        if (
          observed === eventTail
          && observedDisarmPersistence === disarmPersistenceTail
          && observedRiskPoll === accountRiskPollTail
          && observedRouteEpochRefresh === routeEpochRefreshTail
          && followerCutBackgroundJobs.size === 0
          && observedShutdown === shutdownPromise
          && observedPreparation === armPreparationInFlight
          && pendingOsoFlushes.size === 0
        ) return;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stopCopierSettlement();
      gate = { ...gate, armed: false, connected: false };
      cancelFollowerCutBackgroundLanes('stop');
      for (const timer of pendingBracketTimers.values()) clearTimeout(timer);
      pendingBracketTimers.clear();
      for (const timer of pendingOsoTimers.values()) clearTimeout(timer);
      pendingOsoTimers.clear();
      pendingOsoEvents.clear();
      pendingOsoGenerations.clear();
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
      conditionalMirrorSourcesByLeaderEvent.clear();
      conditionalMirrorWritesBySourceOrder.clear();
      s1bCanceledZeroFillOrderIds.clear();
      s1bUnresolvedCopyOrderIds.clear();
      s1bIngressOrders.clear();
      s1bIngressFillQuantities.clear();
      s1bIngressFillIds.clear();
      s1bIngressPositions.clear();
      s1bIngressWaiters.clear();
      liveOrderGenerationsByAccount.clear();
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
      leaderFlatGuardGenerationRetries.clear();
      recentFollowerFillCauses.clear();
      flatSweepEntryCancelAttempts.clear();
      flatSweepCancelAttempts.clear();
      flatSweepCancelAttemptAccounts.clear();
      observedOrderStatusesByAccount.clear();
      clearTimeout(ingressFlatSweepWaveTimer);
      ingressFlatSweepWave = null;
      for (const entryOrderId of [...pendingOsoResolvers.keys()]) settleOsoFlush(entryOrderId);
      unsubscribe();
    },
  };
}

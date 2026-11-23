/**
 * Typy stavu kopírky, které sdílený LIVE kód (obrazovka, karty obchodu, toasty, hlášení plnění) čte.
 * Vytaženo 23. 11. 2026 z jádra Tradovate kopírky, které je smazané (archiv: tag
 * `archive/tradovate-final-20261123`). Jsou to JEN typy — žádné chování. V appce dnes žádná kopírka neběží
 * (`lib/liveNoCopier.ts` dává prázdný stav); typy zůstávají, dokud je sdílený LIVE kód čte, a budoucí
 * Rithmic kopírka si nadefinuje vlastní.
 */
import type { COPIER_LEADER_DAILY_STATS_LABEL } from './copierDailyStatsLabels';
import type { CopierDisarmRecord } from './copierDisarmReason';
import type { GroupLimitTradeState } from './groupLimitProtocol';
import type { PendingCancelContext, PendingOwnEntry } from './liveCancelPending';
import type { BareLeaderTrade } from './manualBareClose';
import type { TradovateAccountDisplayFeedState } from './tradovateAccountDisplayTypes';
import type { TradovateRequestHealth, TradovateWorkerAccountCoverage } from './tradovateRequestControl';
import type { OrderSide } from '../services/brokerPort';
import type { CopierAccountEligibility, CopierClosedTrade, CopierDailyRule, CopierManualEntryStatus, CopierManualOrderActionRecord, CopierRuleWarning } from '../services/copierEngine';
import type { CopyGroupConfig, DayLockTrigger, LiveCopyTradingCommandResult } from '../services/liveCopyTrading';

export interface LocalCopierAgentDevice {
  state: 'pairing-required' | 'paired';
  deviceId: string;
  connectionId: string;
  deviceName: string;
  /** Present only until the authenticated AlphaTrade UI confirms pairing. */
  deviceSecret?: string;
  publicKey?: string;
}

export type CopierSnapshotHealthState =
  | 'disabled'
  | 'checking'
  | 'ready'
  | 'cdp-offline'
  | 'layout-missing'
  | 'capture-failed'
  | 'upload-failed';

export interface CopierSnapshotHealth {
  enabled: boolean;
  /** Novější worker umí bezpečně restartovat TradingView s lokálním CDP. */
  repairSupported?: boolean;
  state: CopierSnapshotHealthState;
  layoutName: string;
  chartIdConfigured: boolean;
  cdpReachable: boolean;
  targetFound: boolean;
  lastCheckedAt: number | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  /** A health probe must not acknowledge a missing historical image. */
  lastFailure?: { id: string; at: number; phase: 'capture' | 'upload' | 'storage'; code: string } | null;
  pendingUploads?: number;
}

export interface CopierJournalRecorderStatus {
  connectionId: string;
  state: 'recording' | 'degraded';
  queued: number;
  maxQueued: number;
  /** Position-relevant observations lost since worker start; each loss left a recording gap. */
  dropped: number;
  /** Command-history observations lost since worker start; positions stay provable. */
  droppedLowPriority: number;
  deduplicated: number;
  lastGapAt: number | null;
  lastGapReason: string | null;
  lastWriteMs: number | null;
  lastPersistedAt: number | null;
  lastUploadedAt: number | null;
  error: string | null;
}

export interface LocalCopierAgentInstallation {
  version: 1;
  /** Plný commit SHA zdrojového stromu použitého pro bundle. */
  gitSha: string;
  /** true = bundle vznikl ze stromu s necommitnutými nebo untracked změnami. */
  dirty: boolean;
  installedAt: string;
}

export interface LocalCopierAgentStatus {
  version: 1;
  /** Additive feature negotiation. Older version-1 workers omit this field. */
  capabilities?: string[];
  environment: 'demo';
  nonce: string;
  group: CopyGroupConfig;
  controller: CopierControllerStatus;
  startedAt: string;
  /**
   * F1b′ (2. 11. 2026): nečinná durable delivery relaye, ke které smí server navázat příkaz
   * a poslat ho podepsaným pushem. Jen relay status workeru; prohlížeč ho nedostane.
   */
  relayIdle?: { deliveryId: string } | null;
  /**
   * Pořadí sestavení statusu v tomto běhu workeru (monotónní) a čas sestavení
   * (hodiny workeru). Jen pro řazení zobrazení pozice v grafu (expozice z kanálu
   * vs. poll, docs/LIVE_HOT_PATH_PLAN.md §10); nic neautorizují. Starší workery
   * pole nemají.
   */
  displaySeq?: number;
  displayBuiltAt?: number;
  /** Durable provenance instalačního bundle; starší workery pole nemají. */
  installation?: LocalCopierAgentInstallation;
  /** Primární relay zařízení; zachováno kvůli kompatibilitě starších UI. */
  device?: LocalCopierAgentDevice;
  /** Jedno odvolatelné zařízení pro každé samostatné OAuth připojení. */
  devices?: LocalCopierAgentDevice[];
  /** Diagnostika obrázků je read-only a nikdy neblokuje broker execution. */
  snapshotHealth?: CopierSnapshotHealth;
  /** Diagnostika záznamu historie (evidence); jen zobrazení, nikdy neautorizuje broker akce. */
  journalHealth?: CopierJournalRecorderStatus[];
  /**
   * Aktuální ceny z otevřených grafů TradingView (lokální CDP), jen pro
   * zobrazení (Live Activity čekajícího limitu). Nikdy nevstupují do
   * rozhodování copieru; chybí, když TradingView neběží.
   */
  marketPrices?: CopierMarketPrice[];
  /**
   * Hlídač upozornění na cenu (2. 11. 2026): stav vlákna a stáří ceny/synchronizace v ms
   * při sestavení statusu. Jen zobrazení „kdo hlídá“; starší workery pole nemají.
   */
  priceAlertWatch?: CopierPriceAlertWatchStatus | null;
  /** Read-only display snapshots; never authorize broker actions. */
  requestHealth?: TradovateRequestHealth[];
  accountDisplay?: TradovateAccountDisplayFeedState[];
  /** Využití Tradovate API a stav session každého OAuth spojení workeru; jen zobrazení. */
  connectionUsage?: CopierConnectionUsage[];
  /**
   * Nové propfirmy bez CLI (4. 10. 2026): scope spárovaného Macu a připojení,
   * která worker načte po nejbližším bezpečném restartu. Jen zobrazení.
   */
  connectionDiscovery?: CopierConnectionDiscoveryStatus;
}

export interface CopierPriceAlertWatchStatus {
  state: 'watching' | 'no-price' | 'no-sync' | 'off' | 'tripped';
  alerts: number;
  priceAgeMs: number | null;
  syncAgeMs: number | null;
}

export interface CopierConnectionDiscoveryStatus {
  /** null = seznam připojení se zatím nepodařilo načíst. */
  scope: 'owner' | 'connection' | null;
  deviceId: string;
  /** Připojení načtená přes souhlas (mimo manifest); manifestová určují `devices`. */
  loadedConnectionIds: string[];
  /** Připojení čekající na bezpečný restart (kopírka vypnutá, flat). */
  pendingConnectionIds: string[];
  /** Účty každého načteného připojení (adresář při startu + živý feed); guard odpojení. */
  connectionAccounts?: Array<{ connectionId: string; accountIds: number[] }>;
  failedConnections: Array<{ connectionId: string; attempts: number; nextAttemptAt: number; lastError: string }>;
}

export interface CopierConnectionUsage {
  connectionId: string;
  /** REST volání workeru na tento token. */
  rest: { minute: number; hour: number };
  /** WebSocket požadavky (authorize, syncrequest, …). */
  ws: { minute: number; hour: number };
  /** Jen `user/syncrequest`: Tradovate limit 300/h na IP rozsah /24, sdílený se vším na téže síti. Starší worker pole nemá. */
  syncRequests?: { minute: number; hour: number };
  streamConnected: boolean;
  /** Fáze socketu: idle | connecting | authorizing | syncing | connected | closing | waiting. */
  phase: string;
  /** Poslední zavření socketu od Tradovate nebo od nás. */
  lastClose: { at: number; code: number | null; reason: string; clean: boolean | null; initiatedBy: 'remote' | 'local' } | null;
  /** Tradovate penalizace (p-ticket) syncu: do kdy broker čeká; null bez penalizace. */
  penaltyUntil: number | null;
  consecutiveSyncTimeouts: number;
}

export interface CopierMarketPrice {
  /** Symbol bez burzovního prefixu (`MNQ1!`, `MNQU6`). */
  symbol: string;
  price: number;
  /** Epoch ms čtení na workeru. */
  at: number;
  /** Kontinuální `1!` kontrakt; v rollover týdnu se může lišit od obchodovaného. */
  continuous?: boolean;
}

export interface LocalCopierAgentCommandResult {
  ok: true;
  status: LocalCopierAgentStatus;
  result?: LiveCopyTradingCommandResult;
}

export interface CopierLeaderDisplayFill {
  fillId: string;
  orderId: string;
  /** Čas plnění u brokera (ms). */
  at: number;
  price: number;
  side: 'Buy' | 'Sell';
  quantity: number;
  role: 'entry' | 'exit';
}

export interface CopierLeaderDisplayFills {
  symbol: string;
  episodeId?: string;
  /** Epizoda začala z flat a je celá (jinak šipky nekreslit). */
  fromFlat: boolean;
  /** Mezera v řadě (neznámá pozice před fillem, resync) — epizoda neúplná. */
  gap?: true;
  /** Pozice leadera po posledním fillu epizody (znaménko = strana). */
  netAfter: number;
  fills: CopierLeaderDisplayFill[];
}

export type CopierStuckOperationKind = 'place' | 'bracket' | 'oso' | 'cancel-or-modify';

export type CopierArmPreparationBlocker =
  | 'incident'
  | 'kill-switch'
  | 'starting'
  | 'recovery'
  | 'configuration'
  | 'shutdown';

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
  groupLimitTrades?: GroupLimitTradeState[];
  /**
   * Obchody leadera, které teď jde z grafu spravovat (fáze 2a/2b): vlastní
   * vstup nebo kopírkou sledované OSO/bracket s živými nohami. Jen pro výběr
   * v UI — worker při změně vše ověří znovu u brokera.
   */
  manageableLeaderTrades?: Array<{
    source: 'own' | 'tracked';
    /** Čekající Limit/Stop bez nohou: jde jen zrušit, cenu z čáry posunout nejde. */
    bare?: boolean;
    entryOperationId?: string;
    leaderEntryOrderId: string;
    symbol: string;
    side: 'Buy' | 'Sell';
    /** Průměrná cena vyplnění vstupu leadera od brokera (filly) — podklad pro „SL na BE“; null = neznámá. */
    entryAvgPrice?: number | null;
  }>;
  /**
   * C8 (3. 11. 2026): vlastní holý Market bez SL/TP, který jde zavřít × (`close-position`
   * s `entryOperationId` a `expect = { price: referencePrice, quantity }`). Jen sólo skupina;
   * výběr = nejnovější, acknowledged, holý, bez nohou, otevřený. Jen zobrazení (INV-UI-01/03) —
   * worker při zavření vše ověří znovu u brokera. Chybí u starého workeru (capability).
   */
  bareLeaderTrade?: BareLeaderTrade | null;
  /** SL a TP po jedné: obchod s 0 až 2 nohami, na kterém jdou nohy měnit. Jen zobrazení. */
  bareLegTrade?: BareLeaderTrade | null;
  barePartial?: { entryOperationId: string; price: number | null; orderType: string; quantity: number; filledQuantity: number } | null;
  /**
   * C7 (3. 11. 2026): vlastní čekající vstupy leadera (ruční vstup z grafu i přikoupení) s nulovým
   * fillem, které „Zrušit čekající“ zruší (N× `cancel-entry`). Ochranné nohy pozice, nohy čekajícího
   * vstupu, částečně vyplněný vstup ani cizí příkazy sem z definice nepatří. Jen zobrazení
   * (INV-UI-01/03) — worker při zrušení vše ověří znovu čerstvým REST čtením. Chybí u starého workeru.
   */
  pendingOwnEntries?: PendingOwnEntry[];
  /** C7: co „Zrušit čekající“ VĚDOMĚ nechá (text potvrzení) a proč teď zrušit nejde; null = neznámé. */
  pendingCancelContext?: PendingCancelContext | null;
  /**
   * INV-TRAD-07: pracující příkazy typu, který appka nezná (TrailingStop, MIT, … zadané v
   * Tradovate) na účtech skupiny. Jen zobrazení (INV-UI-03) — blokují vstup, přikoupení i správu.
   */
  unsupportedOrders?: Array<{ accountId: number; symbol: string; brokerOrderId: string; type: string; side: OrderSide; quantity: number }>;
  /**
   * Pozice leadera složená z vlastních lístků (přikoupení, 3. 11. 2026) — jen pro UI:
   * čáry SL/TP celé pozice, „Přikoupit“, čekající přikoupení. Jen se zapnutým přikoupením.
   * Nic neautorizuje: worker při odeslání a správě vše ověří znovu (INV-UI-01).
   */
  leaderPositions?: Array<{
    symbol: string;
    side: 'Buy' | 'Sell';
    quantity: number;
    /** Nejstarší lístek pozice — klíč správy celé pozice (`scope: 'position'`). */
    baseEntryOperationId: string;
    ticketEntryIds: string[];
    tickets: number;
    /** VWAP fillů lístků od brokera (podklad BE); null = neznámý. */
    avgPrice: number | null;
    stopPrice: number | null;
    targetPrice: number | null;
    stopUniform: boolean;
    targetUniform: boolean;
    pendingAdd: { operationId: string; entryBrokerOrderId: string; orderType: string; quantity: number; filled: number; price: number | null } | null;
    canAdd: boolean;
    addBlockedReason?: string;
    canManage: boolean;
    manageBlockedReason?: string;
    /** Částečné zavření (jen zobrazení): počet kontraktů nejnovějšího lístku, který jde zavřít celý; chybí = nenabízet. */
    reduceQuantity?: number;
  }>;
  /** Všechny nevyřešené změny ručních vstupů, i starší než posledních 10 — jen zobrazení. */
  unresolvedManualOrderActions?: Array<{
    operationId: string;
    action: string;
    status: 'sending' | 'unknown';
    updatedAt: number;
    symbol?: string;
    reason?: string;
  }>;
  /** Poslední změny ručních vstupů z grafu (fáze 2a) — jen zobrazení. */
  manualOrderActions?: Array<{
    operationId: string;
    entryOperationId: string;
    action: CopierManualOrderActionRecord['action'];
    status: CopierManualOrderActionRecord['status'];
    createdAt: number;
    updatedAt: number;
    fromPrice: number | null;
    toPrice: number | null;
    reason?: string;
    /** Display-only korelace prvního brokerového účinku ještě před durable výsledkem. */
    displayAt?: number;
    displayStage?: 'order' | 'fill' | 'position';
    /** C7: `cancel-entry` skončil vyplněním vstupu (pozice je otevřená) — push nesmí tvrdit „vstup dál čeká“. */
    resultCode?: CopierManualOrderActionRecord['resultCode'];
  }>;
  /**
   * Front kontrakt MNQ podle brokera (2. 11. 2026) a kdy se naposledy přečetl —
   * původ kontraktu pro Limit/Stop bez IBKR; null = neznámý. Zobrazení + výběr kontraktu v panelu.
   */
  brokerFrontContract?: { contract: string; at: number } | null;
  /** Poslední ruční vstupy z grafu (fáze 1b) — jen zobrazení, autorita je durable záznam. */
  manualEntries?: Array<{
    operationId: string;
    status: CopierManualEntryStatus;
    createdAt: number;
    updatedAt: number;
    symbol: string;
    side: 'Buy' | 'Sell';
    quantity: number;
    /** Typ u brokera (`Market` = nativní Market bez ceny). */
    orderType?: 'Limit' | 'Stop' | 'Market';
    /** Holý Market bez SL/TP (telefonní lišta); `protected` = nohy už doplněné. */
    bare?: true;
    protected?: boolean;
    /** false = leader na symbolu od fillu zplochl (holý vstup uzavřený). */
    open?: boolean;
    price?: number;
    referencePrice?: number;
    timing?: { queuedAt?: number; startedAt?: number; dispatchAt?: number; ackAt?: number; committedAt?: number;
      orderAt?: number; filledOrderAt?: number; fillAt?: number; fillAvg?: number; fillQty?: number; positionAt?: number };
    reason?: string;
    entryBrokerOrderId?: string;
    cancel?: 'sending' | 'sent' | 'failed';
    /**
     * C12: výsledek zrušení ověřený stavem u brokera (`canceled` = zrušen s fillem 0). UI smí
     * napsat „zrušen“ jen u `canceled` — nikdy u vyplněného. Jen zobrazení (INV-UI-03).
     */
    cancelVerified?: 'canceled' | 'ended' | 'filled' | 'partially-filled' | 'working' | 'unverified';
    /** C12: proč worker vstup zrušil (konec okna, pauza CME, vypnutí…). Jen zobrazení. */
    cancelReason?: string;
    /**
     * C12: kdy se čekající vstup sám zruší podle časových pravidel (pauza CME 15:55 CT, vypršení
     * ARM) a proč. Jen zobrazení (INV-UI-01/03) — nic neautorizuje; brzdy a konec okna ruší hned.
     */
    autoCancelAt?: number;
    autoCancelReason?: 'cme-halt' | 'arm-expiry';
    /**
     * C12 (oponentura kolo 1, P2): poslední incident k čekajícímu vstupu (kdy + text). Watchdog z něj
     * pošle per-záznamový push i při už otevřeném fail-closed a za kill. Jen zobrazení (INV-UI-03).
     */
    pendingIncident?: { at: number; text: string };
  }>;
  /** Režim opravy po startu s nepoužitelnou uloženou skupinou (null = normální běh). */
  startupGroupRepair?: { groupId: string; unavailableAccountIds: number[] } | null;
  /**
   * Skupina workeru je smazaná: worker běží bez skupiny, nic nekopíruje ani
   * nehlídá a zapnout jde až jiná (nově aktivovaná) skupina. `group` ve
   * statusu agenta je pak jen poslední známý zástupce, ne execution skupina.
   */
  retiredGroup?: { groupId: string; at: number } | null;
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
  /** Účty vyřazené z aktuální leader epizody („mimo synchron“); vrátí se samy u dalšího obchodu. */
  accountSyncPauses?: Array<{
    accountId: number;
    symbol: string;
    reasonCode: 'entry-rejected' | 'protective-filled-early';
    reason: string;
    pausedAt: number;
  }>;
  /**
   * Followeři, jejichž kopie vstupu ještě čeká v knize, zatímco leaderův
   * příkaz je celý vyplněný (12. 10. 2026). Nejde o divergenci: když leader
   * skončí dřív, kopie se zruší a follower obchod vynechá.
   */
  awaitingCopiedEntries?: Array<{ accountId: number; symbol: string; since: number }>;
  /** Durable incident čekající na lidské potvrzení v ON (8. 10. 2026). */
  manualRecovery?: { id: string; at: number; reason: string } | null;
  /**
   * „Zapnout bez tohoto účtu“: ručně vypnutí followeři, jejichž vlastní
   * expozici kopírka neřídí (klasifikace workeru, ne jen konfigurace).
   */
  excludedForeignFollowers?: number[];
  /** Flat zapojených účtů (bez vyřazených cizích); `groupFlat` zůstává přes všechny. */
  participatingGroupFlat?: boolean;
  /**
   * Automatické pokračování po výpadku spojení (10. 10. 2026). `ready` jen
   * říká, že smí projít stejnou bránou jako ruční ON; zapíná agent.
   */
  transportResume?: {
    disarmAt: number;
    armExpiresAt: number;
    phase: 'waiting' | 'ready' | 'declined' | 'resumed';
    reason: string | null;
    at: number;
  } | null;
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
    streamCoverage?: TradovateWorkerAccountCoverage[];
    /**
     * Kontinuita streamu účtu od poslední REST baseline (`BrokerPort.streamContinuity`), kterou
     * obchodní události nezruší; stejné kontroly jako `streamCoverage` (backlog, merge, shoda
     * snímku streamu s cache). JEN zobrazení grafu — řízení REST čtení ji nepoužívá.
     */
    streamContinuity?: TradovateWorkerAccountCoverage[];
    /**
     * Proč účet nemá řádek dokladu / kontinuity, nebo proč je jeho řádek nepoužitelný
     * (`no-baseline-proof`, `no-continuity-anchor`, `stream-positions-unavailable`,
     * `stream-orders-unavailable`, `controller-positions-unknown`, `controller-orders-unknown`,
     * `stream-cache-mismatch`, `trade-ingress-pending`, `error:…`). Jen diagnostika a zobrazení.
     */
    streamCoverageGaps?: Array<{ accountId: number; source: 'proof' | 'continuity'; reason: string }>;
    /**
     * Kdy worker naposledy atestoval kontinuitu VŠECH účtů skupiny (živý synchronizovaný stream,
     * bez mezery, backlogu a neshody snímku s cache, stejná session). Při zdravém streamu se
     * obnovuje s každým statusem; `verifiedAt` zůstává časem autoritativního čtení. Jen zobrazení.
     */
    continuityAttestedAt?: number;
    /** `avgPrice` = průměrný vstup (broker `netPrice` ze streamu, jinak z fillů), jen když sedí na kusy (zobrazení). */
    positions: Array<{ accountId: number; symbol: string; netQuantity: number; avgPrice?: number }>;
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
      /** Vazby bracketu (OSO rodič, OCO pár) — jen zobrazení. */
      parentOrderId?: string;
      ocoId?: string;
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
    /**
     * „Zapnout bez tohoto účtu“: zapnutý follower s vlastní pozicí/příkazy
     * jde vyřadit i s nimi (jen za DISARM, leader flat, bez stopy kopírky).
     */
    exclusionWithExposure?: { allowed: boolean; reason: string | null };
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
  /** Plnění leadera aktuální epizody pro šipky v grafu (2. 11. 2026) — jen zobrazení, nic z toho nečte risk ani příkazy. */
  leaderFills?: CopierLeaderDisplayFills | null;
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
    /** Ztráta, ze které jdou pravidla dne: přísnější z ledgeru a čistého P&L brokera (2. 11. 2026). */
    lossPnlUsd?: number;
    lossPnlSource?: 'ledger' | 'broker';
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

export interface CopierAccountRiskSnapshot {
  accountId: number;
  /** Čas broker dotazu; snapshot starší než 90 s je „neověřeno". */
  verifiedAt: number;
  realizedPnlUsd: number | null;
  /** Obchodní den brokerova `realizedPnlUsd` (`YYYY-MM-DD`); null = neznámý. */
  realizedTradeDate?: string | null;
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

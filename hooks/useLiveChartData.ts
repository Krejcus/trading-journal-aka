import { useEffect, useMemo, useRef } from 'react';
import type { TradovateAccountDataResult } from '../lib/tradovateAccountDataTypes';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { LiveFillMarker } from '../lib/liveFillMarkers';
import {
  EMPTY_LIVE_WORKING_KEY,
  liveWorkingAccountIds,
  liveWorkingOrdersVerified,
  liveWorkingOrderView,
  type LiveWorkingOrdersView,
} from '../lib/liveWorkingOrderLines';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { WORKER_EXPOSURE_MAX_AGE_MS } from '../lib/tradovateWorkerExposureOverlay';
import { LIVE_CHART_UNVERIFIED_NOTE, holdLastDrawnPosition, liveChartDisplayAccounts, liveChartDrawnMemory, liveChartDrawnMemoryKey, markLiveChartPositionProjection, markUnverifiedFlat, projectLiveChartExposure, rememberLiveChartDrawn } from '../lib/liveChartExposureProjection';
import { LIVE_UNVERIFIED_LINE_COLOR } from '../lib/liveChartOrderLines';
import { currentTradovateClientReadSeq, noteTradovateWorkerShown, tradovateWorkerShownSeq } from '../lib/tradovateClientReadOrder';
import { tradovateCopyTradeOrders, tradovateCopyTradeSnapshot } from '../lib/tradovateCopyTradeBridge';
import { tradeCardFeeRates } from '../lib/liveTradeCard';
import { buildLiveTradeGroup, liveChartDisarm, liveTradeGroupKey, type LiveChartDisarm } from '../lib/liveTradeGroupSource';
import { liveChartPosition, NO_LIVE_CHART_POSITION, type LiveChartPosition } from '../lib/liveChartPosition';
import type { JournalLiveTarget } from '../lib/journalLivePosition';
import type { LiveTradeGroup, LiveTradeTarget } from '../lib/liveTradeTarget';
import { useLiveTradeCardView } from './useLiveTradeCardView';
import type { WorkerCoverageOwner } from '../lib/tradovateWorkerCoverage';

const NO_COVERAGE_OWNERS: ReadonlyMap<number, WorkerCoverageOwner> = new Map();

/**
 * Data LIVE → Graf ze stejných vstupů jako přehled LIVE (jen zobrazení):
 * skupina a účty, živá pozice zvoleného cíle a stav tlačítka Vypnout.
 * Volá ho desk; obrazovka grafu dostane jen hotové modely.
 */
export function useLiveChartData(input: {
  enabled: boolean;
  data: TradovateAccountDataResult | null;
  /** Exact OAuth membership from connectionData; roles never establish ownership. */
  coverageOwners?: ReadonlyMap<number, WorkerCoverageOwner>;
  profiles: TradovateAccountProfile[];
  agentStatus: LocalCopierAgentStatus | null;
  /** Kdy přišel pollovaný status — čerstvost workeru (verdikty, zapnutost kopírky). */
  agentStatusObservedAt: number | null;
  /** Stáří zobrazené expozice (F2a: novější z kanálu, jinak = agentStatusObservedAt); jen overlay pozic. */
  exposureObservedAt?: number | null;
  /** Čerstvý stav této instance (`armStatusRef.fresh`: ne obnovený, ne po grace). */
  statusFresh: boolean;
  /**
   * Stav workeru je z pollu této instance, ne obnovená cache. Stav workeru (s dokladem i bez)
   * graf kreslí jen při `statusTrusted && statusFresh`; sekvenční plot nad REST platí vždy.
   */
  statusTrusted?: boolean;
  /** Účty se zobrazovacími hodnotami přehledu (dnešní výsledek, limit). */
  displayAccounts: readonly LiveAccount[];
  group: CopyGroupConfig | null;
  nameOf: (accountId: number) => string;
  root: string;
  target: LiveTradeTarget;
  now: number;
  /** Přihlášený uživatel — část klíče paměti držené pozice (nikdy nesměšovat identity). */
  userId?: string | null;
}): { group: LiveTradeGroup | null; groupKey: string; position: LiveChartPosition; disarm: LiveChartDisarm | null; working: LiveChartWorkingSource } {
  const { enabled, data, profiles, agentStatus, agentStatusObservedAt, statusFresh, group, now } = input;
  const exposureObservedAt = input.exposureObservedAt === undefined ? agentStatusObservedAt : input.exposureObservedAt;
  const coverageOwners = input.coverageOwners ?? NO_COVERAGE_OWNERS;
  // Graf kreslí ze stavu workeru i bez dokladu kontinuity (jen zobrazení, štítek „neověřeno“);
  // starší REST nepřepíše novější stav workeru. Autorizační data desku se nemění.
  // Sekvence REST požadavků v okamžiku, kdy graf naposledy kreslil účet ze stavu workeru:
  // jen čtení zahájené až potom ho smí nahradit (pozdní starší odpověď nevyrobí flat). Drží ji
  // modul `tradovateClientReadOrder` (přežije remount grafu), ne tato komponenta.
  const statusTrusted = input.statusTrusted ?? statusFresh;
  const projected = useMemo(() => (enabled ? projectLiveChartExposure(data, agentStatus, exposureObservedAt, now, coverageOwners, {
    statusFresh, trusted: statusTrusted, lastWorkerShownSeq: tradovateWorkerShownSeq(),
  }) : null), [enabled, data, agentStatus, exposureObservedAt, now, coverageOwners, statusFresh, statusTrusted]);
  const chartData = projected?.data ?? null;
  // Po renderu (konzervativně: požadavek zahájený mezitím se počítá jako starší).
  useEffect(() => {
    if (!projected) return;
    noteTradovateWorkerShown(projected.workerShown, currentTradovateClientReadSeq());
  }, [projected]);
  const projectedAccounts = useMemo(() => (chartData ? tradovateCopyTradeSnapshot(chartData, profiles).accounts : []), [chartData, profiles]);
  const unverifiedKey = projectedAccounts.filter(account => account.displayProjection === 'worker-unverified').map(account => account.id).join(',');
  // Jedna množina pro všechny cesty zobrazení (pozice, karta ochrany, skupina, pracující příkazy).
  const unverifiedIds = useMemo<ReadonlySet<number>>(() => new Set(unverifiedKey ? unverifiedKey.split(',').map(Number) : []), [unverifiedKey]);
  // Kreslení: neověřená projekce se smí nakreslit (označená v souhrnu pozice), ale obecný
  // predikát ověřeného čtení ji odmítá — kopie bez značky jen pro tuto zobrazovací větev.
  const accounts = useMemo(() => liveChartDisplayAccounts(projectedAccounts), [projectedAccounts]);
  const orders = useMemo(() => (chartData ? tradovateCopyTradeOrders(chartData) : []), [chartData]);
  const feeRates = useMemo(() => (chartData ? tradeCardFeeRates(chartData.accounts) : new Map<string, number>()), [chartData]);
  const controller = agentStatus?.controller ?? null;

  const tradeGroup = useMemo(() => (enabled ? buildLiveTradeGroup({
    group,
    controller,
    statusFresh,
    displayAccounts: input.displayAccounts,
    positionAccounts: accounts,
    orders,
    nameOf: input.nameOf,
    root: input.root,
    now,
    unverifiedAccountIds: unverifiedIds,
  }) : null), [enabled, group, controller, statusFresh, input.displayAccounts, accounts, orders, input.nameOf, input.root, now, unverifiedIds]);
  const groupKey = liveTradeGroupKey(tradeGroup);

  // Pohled na pozici: skupina jen z kopírujících účtů (vyřazený follower
  // s vlastní pozicí do souhrnu nepatří), účet mimo skupinu sám za sebe.
  const excludedKey = statusFresh ? (controller?.excludedForeignFollowers ?? []).join(',') : '';
  const { viewGroup, requested } = useMemo<{ viewGroup: CopyGroupConfig | null; requested: JournalLiveTarget }>(() => {
    const excluded = new Set(excludedKey ? excludedKey.split(',').map(Number) : []);
    const inCopy = group ? { ...group, followers: group.followers.filter(follower => !excluded.has(follower.accountId)) } : null;
    if (input.target.kind === 'group') return { viewGroup: inCopy, requested: 'group' };
    const accountId = Number(input.target.accountId);
    const member = group && (group.leaderAccountId === accountId || group.followers.some(follower => follower.accountId === accountId));
    if (member) return { viewGroup: group, requested: accountId };
    return {
      viewGroup: { id: `outside:${accountId}`, name: 'Účet mimo skupinu', enabled: true, leaderAccountId: accountId, followers: [] },
      requested: accountId,
    };
  }, [group, excludedKey, input.target]);
  const workerFresh = statusFresh && agentStatusObservedAt != null && now - agentStatusObservedAt <= WORKER_EXPOSURE_MAX_AGE_MS;
  const view = useLiveTradeCardView({
    active: enabled && viewGroup != null,
    accounts,
    orders,
    feeRates,
    group: viewGroup,
    target: requested,
    worker: workerFresh ? agentStatus : null,
    now,
  });
  const computedPosition = useMemo(() => {
    if (!enabled || !viewGroup) return NO_LIVE_CHART_POSITION;
    const viewIds = requested === 'group'
      // Leader a kopírující followeři (ručně vypnutý follower s vlastní pozicí vstup leadera neblokuje).
      ? [viewGroup.leaderAccountId, ...viewGroup.followers.filter(follower => follower.mode !== 'off' && follower.enabled !== false).map(follower => follower.accountId)]
      : [requested];
    return markUnverifiedFlat(markLiveChartPositionProjection(liveChartPosition(view, requested), unverifiedIds), viewIds, unverifiedIds);
  }, [enabled, viewGroup, view, requested, unverifiedIds]);
  // Návrat na tab / krátce neznámý stav: podržet poslední nakreslenou pozici jako neověřenou,
  // dokud nepřijde nová (nejdéle `LIVE_CHART_HOLD_LAST_DRAWN_MS` = 5 s); ověřený flat hned (DEMO 10. 11., bod 3).
  // Paměť žije v MODULU (checklist: remount grafu nesmí bliknout na flat), klíč = cíl pohledu.
  // Klíč = identita skupiny i vlastníků účtů (leader a členové): po přepnutí skupiny nebo
  // změně leadera/followerů se nikdy nedrží pozice jiného leadera (review Codexu).
  const targetKey = liveChartDrawnMemoryKey(viewGroup, requested, { userId: input.userId, owners: coverageOwners });
  const held = holdLastDrawnPosition(enabled ? liveChartDrawnMemory(targetKey, now) : null, computedPosition, now);
  if (enabled) rememberLiveChartDrawn(targetKey, held.memory);
  else rememberLiveChartDrawn(targetKey, null);
  const position = useKeyedValue(held.shown);
  const disarm = liveChartDisarm(controller, statusFresh);
  // U5: podklad pracujících příkazů ze stejného čtení příkazů jako karta (jen zobrazení).
  const working = useMemo(() => liveChartWorkingSource({
    enabled: enabled && viewGroup != null,
    accounts,
    orders,
    target: input.target,
    leaderAccountId: viewGroup?.leaderAccountId,
    position,
    now,
    unverifiedAccountIds: unverifiedIds,
  }), [enabled, viewGroup, accounts, orders, input.target, position, now, unverifiedIds]);
  return { group: tradeGroup, groupKey, position, disarm, working };
}

/**
 * Podklad pracujících příkazů v grafu (U5, 3. 11. 2026) z read modelu pohledu. Bez
 * `pendingAdd` — čekající přikoupení zná až desk (stojí na pozici z tohoto hooku);
 * čáry skládá `liveChartWorkingOrders`. Jen zobrazení (INV-UI-01/03/04).
 */
export interface LiveChartWorkingSource {
  /** Příkazy z read modelu brokera (REST, stejný zdroj jako karta obchodu); neověřené = []. */
  orders: readonly LiveOrder[];
  /** Účty pohledu: skupina = leader, jeden účet = ten účet (`liveWorkingAccountIds`). */
  accountIds: readonly number[];
  /** Ověřené čtení příkazů všech účtů pohledu A pozice bez `issue` (`liveWorkingOrdersVerified`). */
  verified: boolean;
  /** Pozice grafu (co už kreslí čáry pozice) a její kontrakt. */
  position: LiveChartPosition;
  /** Příkazy aspoň jednoho účtu pohledu jsou z neověřené projekce workeru → čáry „neověřeno“. */
  unverified?: boolean;
}

/** Podklad pracujících příkazů z dat hooku; fail-closed (vypnutý pohled, neověřené čtení = nic). */
export function liveChartWorkingSource(input: {
  enabled: boolean;
  accounts: readonly LiveAccount[];
  orders: readonly LiveOrder[];
  target: LiveTradeTarget;
  /** Leader pohledu (skupina workeru); u pohledu jednoho účtu se nepoužije. */
  leaderAccountId: number | null | undefined;
  position: LiveChartPosition;
  now: number;
  unverifiedAccountIds?: ReadonlySet<number>;
}): LiveChartWorkingSource {
  if (!input.enabled) return { orders: [], accountIds: [], verified: false, position: input.position };
  const accountIds = liveWorkingAccountIds(input.target, input.leaderAccountId);
  const verified = liveWorkingOrdersVerified({ accounts: input.accounts, accountIds, positionIssue: input.position.issue, now: input.now });
  const unverified = accountIds.some(id => input.unverifiedAccountIds?.has(id) === true);
  return { orders: verified ? input.orders : [], accountIds, verified, position: input.position, ...(unverified ? { unverified: true } : {}) };
}

/**
 * Pracující příkazy pro graf — PC prop `workingOrders`, telefon slot `workingOrders` (U5).
 * JEN ZOBRAZENÍ: čáry `live-working` nejde táhnout ani zrušit (`isLiveDisplayOnlyLine`), nic
 * z nich nejde do příkazu ani do „co jsem viděl“ (`expect` dál ze `summary`).
 */
export interface LiveChartWorkingOrders extends LiveWorkingOrdersView {
  /**
   * Kontrakt čar (pozice, jinak front podle brokera); null = nic. Graf, který ví, že ukazuje
   * jiný kontrakt (IBKR `previewSymbolFromChartSource`), je nemá kreslit.
   */
  contract: string | null;
}

const noWorkingOrders = (): LiveChartWorkingOrders => ({ lines: [], badges: [], key: EMPTY_LIVE_WORKING_KEY, contract: null });

/**
 * Čáry pracujících příkazů z podkladu hooku + co ví jen desk. `key` = celý obsah (kontrakt,
 * čáry, štítky), takže `useKeyedValue` drží objekt, dokud se obraz nezmění. Nikdy nevyhodí výjimku.
 */
export function liveChartWorkingOrders(
  source: LiveChartWorkingSource | null | undefined,
  extras: {
    /** Čekající přikoupení, které už kreslí čára pozice s × (`LiveTicketScaleIn.pendingAdd`). */
    pendingAdd?: { price: number | null; orderType?: string | null } | null;
    /** Front kontrakt podle brokera (čerstvý) — kontrakt grafu, když pozice není. */
    frontContract?: string | null;
    /** Hodnota bodu pro $ u rozjeté nohy (MNQ = 2); bez ní jen cena a body. */
    pointValue?: number | null;
  } = {},
): LiveChartWorkingOrders {
  try {
    if (!source || source.verified !== true) return noWorkingOrders();
    const contract = source.position.symbol ?? extras.frontContract ?? null;
    const view = liveWorkingOrderView({
      orders: source.orders,
      accountIds: source.accountIds,
      verified: source.verified,
      contract,
      drawn: { position: source.position.summary, symbol: source.position.symbol, pendingAdd: extras.pendingAdd ?? null },
      pointValue: extras.pointValue ?? null,
    });
    if (view.lines.length === 0 && view.badges.length === 0) return noWorkingOrders();
    // Druhý kanál čar nese týž stav jako čáry pozice: z neověřené projekce tlumeně a se štítkem.
    const lines = source.unverified === true
      ? view.lines.map(line => ({ ...line, color: LIVE_UNVERIFIED_LINE_COLOR, label: `${line.label} · ${LIVE_CHART_UNVERIFIED_NOTE}`, title: `${line.title} Neověřeno — stav workeru bez dokladu.` }))
      : view.lines;
    return { lines, badges: view.badges, contract, key: JSON.stringify([contract, source.unverified === true, lines, view.badges]) };
  } catch {
    return noWorkingOrders();
  }
}

/**
 * Šipky plnění leadera pro PC graf (U4) — stejný zdroj jako telefon (`liveFillMarkersFromStatus`),
 * JEN ZOBRAZENÍ (INV-UI-03): nikdy do příkazů, náhledu ani relaye.
 */
export interface LiveChartFills {
  /** Obsahový klíč — graf se překreslí jen při změně šipek. */
  key: string;
  fills: readonly LiveFillMarker[];
  /** Obchod plnění je otevřený (šipky bez výstupu); undefined = neznámo. */
  open: boolean | undefined;
  /** Kontrakt plnění (`MNQZ6`) — šipky jen nad stejným kontraktem grafu. */
  symbol?: string;
}

/** Výstup `liveFillMarkersFromStatus` s obsahovým klíčem; bez šipek = prázdný pohled (`key: 'none'`). */
export function liveChartFills(input: { fills: readonly LiveFillMarker[]; open: boolean | undefined; symbol?: string } | null | undefined): LiveChartFills {
  const fills = input?.fills ?? [];
  if (fills.length === 0) return { key: 'none', fills: [], open: undefined };
  return {
    key: JSON.stringify([input?.symbol ?? null, input?.open ?? null, fills]),
    fills,
    open: input?.open,
    ...(input?.symbol ? { symbol: input.symbol } : {}),
  };
}

/**
 * Vrátí předchozí objekt, dokud se nezmění jeho `key`. Desk se překresluje každou sekundu
 * (čerstvost stavu); graf a jeho memo mají dostat nový objekt jen při změně obsahu.
 */
export function useKeyedValue<T extends { key: string }>(value: T): T {
  const ref = useRef(value);
  if (ref.current.key !== value.key) ref.current = value;
  return ref.current;
}

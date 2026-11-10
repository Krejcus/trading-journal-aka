import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';
import type { TradovateAccountDataAccount, TradovateAccountDataResult } from './tradovateAccountDataTypes';
import type { WorkerCoverageOwner } from './tradovateWorkerCoverage';
import { tradovateAccountReadState } from './tradovateLiveReadState';
import {
  overlayWorkerAccount,
  overlayWorkerExposure,
  workerExposureOverlayContext,
  WORKER_EXPOSURE_MAX_AGE_MS,
  WORKER_POSITION_MISMATCH_DETAIL,
} from './tradovateWorkerExposureOverlay';
import type { LiveChartPosition } from './liveChartPosition';
import type { LiveAccount } from '../services/tradecopiaLiveService';

/**
 * ZOBRAZOVACÍ projekce expozice pro LIVE → Graf (PC i telefon), 10. 11. 2026.
 *
 * Od dd393f72 přebírá `overlayWorkerExposure` stav workeru jen s platným dokladem
 * kontinuity streamu; worker doklad ruší při každé obchodní události
 * (`observeTradeIngress`), takže graf hned po fillu / posunu SL spadl na starší REST
 * a čáry přišly za 5–22 s nebo zmizely. Tahle projekce je jen pro graf:
 *
 * - účty s dokladem: beze změny (`overlayWorkerExposure`);
 * - účty, které worker prokazatelně zná, se živým socketem svého připojení, bez dokladu:
 *   pozice a příkazy z workeru označené `displayProjection: 'worker-unverified'` (štítek
 *   „neověřeno“, tlumené čáry bez ovládání) — jen čerstvý neobnovený stav ≤ 8 s;
 * - pořadí: dokud worker žije, jeho stav vždy přednost (REST ho nepřepíše). Když worker
 *   zmlkne, REST čtení, které dorazilo (místní hodiny) dřív, než graf naposledy kreslil
 *   stav workeru, je starší — neutrální „neověřené“ bez čar (INV-UI-01), nikdy flat.
 *
 * Autorizace se tím NEMĚNÍ: `overlayWorkerExposure` v desku (přehled, způsobilost,
 * plán čtení REST) dál vyžaduje doklad, `isLiveAccountReadVerified` taky; příkazy
 * z neověřené projekce desk odmítne (`liveChartProjectionManageBlock`).
 */

/**
 * Jako INV-UI-03 („expozice workeru nejvýš 8 s stará, platí i pro LIVE“): starší
 * pozorování workeru graf jako stav nekreslí.
 */
export const LIVE_CHART_WORKER_PROJECTION_MAX_AGE_MS = WORKER_EXPOSURE_MAX_AGE_MS;
/** Ručně vypnutý režim followera: worker ho hlásí OK bez čtení pozice. */
const WORKER_FOLLOWER_OFF_DETAIL = 'vypnutý follower';
export const LIVE_CHART_UNVERIFIED_MANAGE_TEXT = 'Pozice v grafu je zatím jen ze stavu workeru bez dokladu (neověřeno) — nic se neodeslalo. Zkus to za chvilku.';

const unavailable = { availability: 'unavailable' as const, count: 0, httpStatus: null };

/** Účty, jejichž pozici worker prokazatelně zná (pravidlo před dd393f72, INV-UI-03). */
export function workerKnownAccounts(status: LocalCopierAgentStatus | null | undefined): Set<number> {
  const exposure = status?.controller?.exposure;
  const known = new Set<number>();
  if (!exposure) return known;
  const leaderId = typeof status?.group?.leaderAccountId === 'number' ? status.group.leaderAccountId : null;
  const members = new Set<number>([
    ...(leaderId != null ? [leaderId] : []),
    ...(status?.group?.followers ?? []).map(follower => follower.accountId),
  ]);
  if (leaderId != null) known.add(leaderId);
  for (const follower of exposure.followers ?? []) {
    if ((follower.ok && follower.detail !== WORKER_FOLLOWER_OFF_DETAIL)
      || (follower.detail != null && WORKER_POSITION_MISMATCH_DETAIL.test(follower.detail))) known.add(follower.accountId);
  }
  for (const position of exposure.positions) known.add(position.accountId);
  for (const id of [...known]) if (!members.has(id)) known.delete(id);
  return known;
}

/**
 * Socket připojení, kterému účet patří, worker hlásí jako živý (`connectionUsage`).
 * Bez toho (starší worker, jiné připojení dole) by chybějící řádek pozice vypadal jako
 * flat — takový účet se neprojektuje (neznámo ≠ 0).
 */
export function workerConnectionStreamLive(status: LocalCopierAgentStatus | null | undefined, owner: WorkerCoverageOwner | undefined): boolean {
  if (!owner) return false;
  const rows = (status?.connectionUsage ?? []).filter(row => row.connectionId === owner.connectionId);
  return rows.length === 1 && rows[0].streamConnected === true && rows[0].phase === 'connected';
}

/**
 * Místní čas, kdy dorazilo aktuální REST čtení pozic a příkazů účtu (hodiny prohlížeče,
 * stejné jako `observedAt` workeru — žádné porovnání s hodinami serveru).
 */
export interface LiveChartRestArrival { positionsAsOf: string | null; ordersAsOf: string | null; positionsAt: number; ordersAt: number }

/** Aktualizuje místní časy příchodu REST čtení; nové `asOf` = nový příchod (`now`). */
export function trackLiveChartRestArrivals(
  previous: ReadonlyMap<number, LiveChartRestArrival>,
  data: TradovateAccountDataResult | null | undefined,
  now: number,
): Map<number, LiveChartRestArrival> {
  const next = new Map<number, LiveChartRestArrival>();
  for (const account of data?.accounts ?? []) {
    const read = tradovateAccountReadState(account, data!);
    const before = previous.get(account.id);
    next.set(account.id, {
      positionsAsOf: read.positionsAsOf,
      ordersAsOf: read.ordersAsOf,
      positionsAt: before && before.positionsAsOf === read.positionsAsOf ? before.positionsAt : now,
      ordersAt: before && before.ordersAsOf === read.ordersAsOf ? before.ordersAt : now,
    });
  }
  return next;
}

export interface LiveChartProjectionInput {
  /** Čerstvý NEOBNOVENÝ stav této instance (`agentStatusFresh && !agentStatusRestored`). */
  statusFresh: boolean;
  /** Pozorování workeru je z této instance (ne obnovená cache); jinak žádná projekce ani plot. */
  trusted: boolean;
  /** Místní příchody REST čtení (`trackLiveChartRestArrivals`). */
  restArrivals: ReadonlyMap<number, LiveChartRestArrival>;
  /** Kdy (místní hodiny) graf naposledy kreslil účet ze stavu workeru. */
  lastWorkerShownAt: ReadonlyMap<number, number>;
}

export interface LiveChartProjectionResult<T> {
  data: T | null;
  /** Účty, které teď kreslí stav workeru (s dokladem i bez) — pro `lastWorkerShownAt`. */
  workerShown: number[];
}

export function projectLiveChartExposure<T extends TradovateAccountDataResult>(
  data: T | null,
  status: LocalCopierAgentStatus | null | undefined,
  observedAtMs: number | null | undefined,
  now: number,
  owners: ReadonlyMap<number, WorkerCoverageOwner>,
  input: LiveChartProjectionInput,
): LiveChartProjectionResult<T> {
  const proven = overlayWorkerExposure(data, status, observedAtMs, now, owners);
  if (!proven) return { data: null, workerShown: [] };
  if (!input.trusted) return { data: proven, workerShown: [] };
  const exposure = status?.controller?.exposure;
  const observed = observedAtMs != null && Number.isFinite(observedAtMs) && observedAtMs <= now + 5_000 ? observedAtMs : null;
  const workerLive = input.statusFresh && observed != null && status?.controller?.connected === true && !!exposure?.orders
    && now - observed <= LIVE_CHART_WORKER_PROJECTION_MAX_AGE_MS;
  const known = workerLive ? workerKnownAccounts(status) : new Set<number>();
  const context = workerLive && exposure ? workerExposureOverlayContext(proven, exposure) : null;
  const workerShown: number[] = [];
  let changed = false;
  const accounts = proven.accounts.map((account): TradovateAccountDataAccount => {
    if (account.readState?.displayStreamCoverage) { workerShown.push(account.id); return account; }
    // Worker žije a účet zná: vždy jeho stav (pořadí workeru řeší fence pollu a `displaySeq` kanálu).
    if (context && observed != null && known.has(account.id) && workerConnectionStreamLive(status, owners.get(account.id))) {
      changed = true;
      workerShown.push(account.id);
      return overlayWorkerAccount(account, proven, context, observed, null);
    }
    // Graf účet nedávno kreslil ze stavu workeru: REST čtení, které dorazilo dřív, je starší
    // a ten stav nepřepíše — neutrální „neověřeno“ (bez čar), dokud nedorazí novější REST.
    const shownAt = input.lastWorkerShownAt.get(account.id);
    const arrival = input.restArrivals.get(account.id);
    if (shownAt != null && (!arrival || arrival.positionsAt <= shownAt || arrival.ordersAt <= shownAt)) {
      changed = true;
      const readState = tradovateAccountReadState(account, proven);
      const { displayStreamCoverage: _proof, displayProjection: _projection, ...rest } = readState;
      return { ...account, readState: { ...rest, positions: unavailable, orders: unavailable } };
    }
    return account;
  });
  return { data: changed ? { ...proven, accounts } : proven, workerShown };
}

/** Pozice grafu stojí aspoň na jednom účtu z neověřené projekce workeru → označit. */
export function markLiveChartPositionProjection(
  position: LiveChartPosition,
  unverifiedAccountIds: ReadonlySet<number>,
): LiveChartPosition {
  const summary = position.summary;
  if (!summary || unverifiedAccountIds.size === 0) return position;
  const touched = summary.rows.some(row => unverifiedAccountIds.has(row.accountId))
    || (summary.leader != null && unverifiedAccountIds.has(summary.leader.accountId));
  if (!touched) return position;
  return { ...position, key: `${position.key}|neověřeno`, summary: { ...summary, unverified: true } };
}

/**
 * Brána odeslání správy z grafu: neověřená projekce nikdy neautorizuje příkaz
 * (INV-UI-01/03). null = smí dál (rozhoduje worker a broker). Text obsahuje
 * „nic se neodeslalo“, takže UI hlásí „Neodesláno“, ne neznámý výsledek.
 */
export function liveChartProjectionManageBlock(position: Pick<LiveChartPosition, 'summary'> | null | undefined): string | null {
  return position?.summary?.unverified === true ? LIVE_CHART_UNVERIFIED_MANAGE_TEXT : null;
}

/**
 * Kopie účtů jen pro kreslení grafu (karta, čáry, pracující příkazy): bez značky projekce,
 * aby se neověřený stav workeru vůbec nakreslil. Mimo `useLiveChartData` se nepoužívá;
 * neověřenost nese dál `summary.unverified` (`markLiveChartPositionProjection`).
 */
export function liveChartDisplayAccounts(accounts: readonly LiveAccount[]): LiveAccount[] {
  return accounts.map(account => {
    if (account.displayProjection !== 'worker-unverified') return account;
    const { displayProjection: _projection, ...rest } = account;
    return rest;
  });
}

import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';
import type { TradovateAccountDataAccount, TradovateAccountDataResult } from './tradovateAccountDataTypes';
import type { WorkerCoverageOwner } from './tradovateWorkerCoverage';
import { tradovateAccountReadState } from './tradovateLiveReadState';
import { shouldAcceptCopierStatus } from './copierStatusPollFence';
import {
  overlayWorkerAccount,
  overlayWorkerExposure,
  workerExposureOverlayContext,
  WORKER_EXPOSURE_MAX_AGE_MS,
  WORKER_POSITION_MISMATCH_DETAIL,
} from './tradovateWorkerExposureOverlay';
import { MNQ_TICK, type LiveChartPosition } from './liveChartPosition';
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
 *   „neověřeno“, tlumené čáry). Snižování rizika (zavřít, zrušit vstup, utáhnout SL, BE,
 *   přidat SL/TP) z nich jde odeslat — worker je znovu ověří. Zvětšení rizika ne.
 *   Jen čerstvý neobnovený stav ≤ 8 s;
 * - pořadí workeru: `startedAt` + `revision` a `displaySeq` (INV-FRESH-02). Starší snímek
 *   se do grafu nevrátí. REST se řadí vlastním `requestedAt` (začátek čtení), ne časem
 *   příchodu do prohlížeče. Dokud worker žije, jeho stav má přednost. Když zmlkne, REST
 *   starší než čtení, které už pod tím stavem leželo, je neutrální „neověřené“ bez čar
 *   (INV-UI-01), nikdy flat.
 *
 * Autorizace ověřeného čtení se NEMĚNÍ: `overlayWorkerExposure` v desku (přehled,
 * způsobilost, plán čtení REST) dál vyžaduje doklad, `isLiveAccountReadVerified` taky.
 * Neověřená projekce nepotvrzuje ochranu. Zvětšení rizika z ní desk neodešle
 * (`liveChartProjectionActionBlock`).
 */

/**
 * Jako INV-UI-03 („expozice workeru nejvýš 8 s stará, platí i pro LIVE“): starší
 * pozorování workeru graf jako stav nekreslí.
 */
export const LIVE_CHART_WORKER_PROJECTION_MAX_AGE_MS = WORKER_EXPOSURE_MAX_AGE_MS;
/** Ručně vypnutý režim followera: worker ho hlásí OK bez čtení pozice. */
const WORKER_FOLLOWER_OFF_DETAIL = 'vypnutý follower';
export const LIVE_CHART_UNVERIFIED_RISK_TEXT = 'Pozice v grafu je neověřená — tahle změna riziko nezmenšuje, nic se neodeslalo. Zavřít a utáhnout SL jde hned.';

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
 * Čas začátku REST čtení (`readState.requestedAt` — hodiny serveru, který čtení spustil).
 * Ne čas, kdy odpověď dorazila do prohlížeče: pozdní odpověď staršího čtení nesmí
 * přebít novější.
 */
export interface LiveChartRestArrival {
  positionsAsOf: string | null;
  ordersAsOf: string | null;
  requestedAt: number | null;
}

/** Drží nejnovější `requestedAt`. Starší odpověď, která dorazí později, ho nevrátí. */
export function trackLiveChartRestArrivals(
  previous: ReadonlyMap<number, LiveChartRestArrival>,
  data: TradovateAccountDataResult | null | undefined,
): Map<number, LiveChartRestArrival> {
  const next = new Map<number, LiveChartRestArrival>();
  for (const account of data?.accounts ?? []) {
    const read = tradovateAccountReadState(account, data!);
    const parsed = Date.parse(read.requestedAt ?? '');
    const requestedAt = Number.isFinite(parsed) ? parsed : null;
    const before = previous.get(account.id);
    if (before && before.requestedAt != null && (requestedAt == null || requestedAt < before.requestedAt)) {
      next.set(account.id, before);
      continue;
    }
    next.set(account.id, { positionsAsOf: read.positionsAsOf, ordersAsOf: read.ordersAsOf, requestedAt });
  }
  return next;
}

/** Běh workeru (`startedAt`) + monotónní `revision` a zobrazovací `displaySeq`. */
export interface LiveChartWorkerCursor {
  startedAt: string;
  revision: number;
  displaySeq: number | null;
}

export function liveChartWorkerCursor(status: {
  startedAt?: string;
  displaySeq?: number;
  controller?: { revision?: number };
} | null | undefined): LiveChartWorkerCursor | null {
  const startedAt = status?.startedAt;
  const revision = status?.controller?.revision;
  if (typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))) return null;
  if (typeof revision !== 'number' || !Number.isFinite(revision)) return null;
  const displaySeq = status.displaySeq;
  return {
    startedAt,
    revision,
    displaySeq: typeof displaySeq === 'number' && Number.isFinite(displaySeq) ? displaySeq : null,
  };
}

/** Starší revision nebo `displaySeq` téhož běhu se nepřijme (INV-FRESH-02). Bez kurzoru jen první snímek. */
export function liveChartWorkerCursorAccepts(previous: LiveChartWorkerCursor | null, next: LiveChartWorkerCursor | null): boolean {
  if (!next) return previous == null;
  if (!shouldAcceptCopierStatus(
    { startedAt: next.startedAt, controller: { revision: next.revision } },
    previous ? { startedAt: previous.startedAt, controller: { revision: previous.revision } } : null,
  )) return false;
  return !(previous && previous.startedAt === next.startedAt && previous.displaySeq != null && next.displaySeq != null && next.displaySeq < previous.displaySeq);
}

/**
 * Starší snímek workeru nechá poslední přijatou projekci, jen dokud je stav čerstvý
 * a příchozí kurzor existuje. `held` = tahle odpověď je přehozený poll, graf zůstává
 * u novějšího obrazu. Jakmile stav není čerstvý nebo status zmizel, projekce se
 * spočítá znovu a držení se pustí — zmlklý worker nesmí nechat poslední potvrzené čáry.
 */
export function selectLiveChartProjection<T>(
  hold: { cursor: LiveChartWorkerCursor | null; projected: T } | null,
  incoming: LiveChartWorkerCursor | null,
  input: { statusFresh: boolean },
  project: () => T,
): { cursor: LiveChartWorkerCursor | null; projected: T; held: boolean } {
  if (!input.statusFresh || incoming == null) return { cursor: incoming, projected: project(), held: false };
  if (hold && !liveChartWorkerCursorAccepts(hold.cursor, incoming)) return { ...hold, held: true };
  return { cursor: incoming, projected: project(), held: false };
}

export interface LiveChartProjectionInput {
  /** Čerstvý NEOBNOVENÝ stav této instance (`agentStatusFresh && !agentStatusRestored`). */
  statusFresh: boolean;
  /** Pozorování workeru je z této instance (ne obnovená cache); jinak žádná projekce ani plot. */
  trusted: boolean;
  /** REST čtení seřazená podle vlastního `requestedAt` (`trackLiveChartRestArrivals`). */
  restArrivals: ReadonlyMap<number, LiveChartRestArrival>;
  /**
   * `requestedAt` REST čtení, které už bylo v datech, když graf účet naposledy kreslil
   * ze stavu workeru. Chybějící klíč = účet se ze workeru ještě nekreslil. Hodnota null =
   * kreslil, ale REST čas neměl.
   */
  lastWorkerRestAt: ReadonlyMap<number, number | null>;
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
    // Graf účet kreslil ze stavu workeru. Novější je jen REST, jehož vlastní `requestedAt`
    // (začátek čtení) je přísně po čtení, které pod tím stavem už leželo. Pozdní odpověď
    // staršího čtení ho nepřepíše — neutrální „neověřeno“ bez čar, nikdy flat.
    const heldRest = input.lastWorkerRestAt.get(account.id);
    const incomingRest = input.restArrivals.get(account.id)?.requestedAt ?? null;
    if (heldRest !== undefined && !(heldRest != null && incomingRest != null && incomingRest > heldRest)) {
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

export type LiveChartProjectionAction =
  | { action: 'close-position' | 'cancel-entry' | 'attach-brackets' | 'add-stop' | 'add-target' | 'remove-target' }
  | { action: 'move-stop'; nextPrice: number | null | undefined }
  | { action: 'move-target' | 'move-limit' | 'scale-in' | 'entry' | 'remove-stop' };

/** Utažení SL o aspoň jeden tick směrem k trhu. Posun dál nebo o nulu riziko nezmenšuje. */
export function stopTightens(side: 'long' | 'short', current: number, next: number, tick = MNQ_TICK): boolean {
  if (!(tick > 0) || !Number.isFinite(current) || !Number.isFinite(next)) return false;
  const currentTick = Math.round(current / tick);
  const nextTick = Math.round(next / tick);
  return side === 'long' ? nextTick > currentTick : nextTick < currentTick;
}

/**
 * Brána odeslání z neověřené projekce. null = smí dál (rozhoduje worker a broker).
 * Snižování rizika (zavřít, zrušit vstup, utáhnout SL, přidat ochranu) projde.
 * Zvětšení rizika ne. Ověřená pozice se touhle branou neblokuje. Text odmítnutí
 * obsahuje „nic se neodeslalo“.
 */
export function liveChartProjectionActionBlock(
  position: { summary?: { unverified?: boolean; side?: 'long' | 'short'; stop?: number | null } | null } | null | undefined,
  action: LiveChartProjectionAction,
): string | null {
  if (position?.summary?.unverified !== true) return null;
  switch (action.action) {
    case 'close-position':
    case 'cancel-entry':
    case 'attach-brackets':
    case 'add-stop':
    case 'add-target':
    case 'remove-target':
      return null;
    case 'move-stop': {
      const summary = position.summary;
      const current = summary?.stop;
      const next = action.nextPrice;
      if (!summary?.side || current == null || next == null || !Number.isFinite(current) || !Number.isFinite(next)) {
        return LIVE_CHART_UNVERIFIED_RISK_TEXT;
      }
      return stopTightens(summary.side, current, next) ? null : LIVE_CHART_UNVERIFIED_RISK_TEXT;
    }
    default:
      return LIVE_CHART_UNVERIFIED_RISK_TEXT;
  }
}

/** Akce `manage-leader-order` → brána projekce. Neznámá akce se při neověření neodešle. */
export function liveChartManageProjectionAction(action: string, newPrice?: number): LiveChartProjectionAction {
  if (action === 'move-stop') return { action: 'move-stop', nextPrice: newPrice };
  if (action === 'close-position' || action === 'cancel-entry' || action === 'attach-brackets') return { action };
  if (action === 'move-target' || action === 'move-limit') return { action };
  return { action: 'move-limit' };
}

/** SL/TP po jedné → brána projekce. */
export function liveChartBareProjectionAction(intent: { kind: 'add' | 'move' | 'remove'; leg: 'stopLoss' | 'takeProfit'; price?: number | null }): LiveChartProjectionAction {
  if (intent.kind === 'add') return intent.leg === 'stopLoss' ? { action: 'add-stop' } : { action: 'add-target' };
  if (intent.kind === 'remove') return intent.leg === 'stopLoss' ? { action: 'remove-stop' } : { action: 'remove-target' };
  if (intent.leg === 'stopLoss') return { action: 'move-stop', nextPrice: intent.price };
  return { action: 'move-target' };
}

/**
 * Kopie účtů pro kartu a čáry pozice: bez značky projekce, aby se neověřený stav
 * workeru vůbec nakreslil. Pracující příkazy tuhle kopii nedostanou — bez značky by
 * jejich čtení vypadalo ověřené. Mimo `useLiveChartData` se nepoužívá; neověřenost
 * pozice nese dál `summary.unverified` (`markLiveChartPositionProjection`).
 */
export function liveChartDisplayAccounts(accounts: readonly LiveAccount[]): LiveAccount[] {
  return accounts.map(account => {
    if (account.displayProjection !== 'worker-unverified') return account;
    const { displayProjection: _projection, ...rest } = account;
    return rest;
  });
}

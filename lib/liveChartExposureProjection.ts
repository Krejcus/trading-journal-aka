import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';
import type { TradovateAccountDataAccount, TradovateAccountDataResult } from './tradovateAccountDataTypes';
import { coveredWorkerAccounts, type WorkerCoverageOwner } from './tradovateWorkerCoverage';
import type { TradovateWorkerAccountCoverage } from './tradovateRequestControl';
import { tradovateAccountReadState } from './tradovateLiveReadState';
import { verifiedReadAvailability } from './liveReadFreshness';
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
 * - nejdřív vždy sekvenční plot nad REST (`guardStaleRestReads`), pak stav workeru jen
 *   z čerstvého neobnoveného statusu (`trusted && statusFresh`);
 * - účty s dokladem: `overlayWorkerExposure` (jen za téže podmínky);
 * - účty, které worker prokazatelně zná, se živým socketem svého připojení, bez dokladu:
 *   pozice a příkazy z workeru označené `displayProjection: 'worker-unverified'` (štítek
 *   „neověřeno“, tlumené čáry; tažení vypnuté) — jen čerstvý neobnovený stav ≤ 8 s;
 * - pořadí: dokud worker žije, jeho stav vždy přednost (REST ho nepřepíše). Když worker
 *   zmlkne, REST čtení ZAHÁJENÉ (sekvence požadavků, `lib/tradovateClientReadOrder.ts`)
 *   dřív, než graf naposledy kreslil stav workeru, je starší, i kdyby dorazilo později —
 *   neutrální „neověřené“ bez čar (INV-UI-01), nikdy flat.
 *
 * Autorizace se tím NEMĚNÍ: `overlayWorkerExposure` v desku (přehled, způsobilost,
 * plán čtení REST) dál vyžaduje doklad, `isLiveAccountReadVerified` taky; z neověřené pozice
 * projdou jen akce snižující riziko (`lib/liveChartRiskPolicy.ts`), worker vše ověří znovu.
 */

/**
 * Jako INV-UI-03 („expozice workeru nejvýš 8 s stará, platí i pro LIVE“): starší
 * pozorování workeru graf jako stav nekreslí.
 */
export const LIVE_CHART_WORKER_PROJECTION_MAX_AGE_MS = WORKER_EXPOSURE_MAX_AGE_MS;
/** Ručně vypnutý režim followera: worker ho hlásí OK bez čtení pozice. */
const WORKER_FOLLOWER_OFF_DETAIL = 'vypnutý follower';

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

/** Sekvence zahájení REST čtení pozic a příkazů účtu (`lib/tradovateClientReadOrder.ts`). */
export function liveChartRestReadSeq(account: TradovateAccountDataAccount): { positions: number; orders: number } {
  return { positions: account.readState?.clientPositionsReadSeq ?? 0, orders: account.readState?.clientOrdersReadSeq ?? 0 };
}

/**
 * REST čtení účtu bylo zahájeno až PO okamžiku, kdy graf naposledy kreslil stav workeru
 * (sekvence požadavků, ne čas příchodu ani hodiny serveru) — pozice i příkazy.
 */
export function restReadStartedAfter(account: TradovateAccountDataAccount, shownSeq: number): boolean {
  const read = liveChartRestReadSeq(account);
  return read.positions > shownSeq && read.orders > shownSeq;
}

export interface LiveChartProjectionInput {
  /** Čerstvý NEOBNOVENÝ stav této instance (`agentStatusFresh && !agentStatusRestored`). */
  statusFresh: boolean;
  /** Pozorování workeru je z této instance (ne obnovená cache); jinak žádná projekce ani plot. */
  trusted: boolean;
  /**
   * Pro každý účet: nejvyšší sekvence REST požadavku přidělená v okamžiku, kdy graf naposledy
   * kreslil jeho stav ze workeru (`currentTradovateClientReadSeq()`).
   */
  lastWorkerShownSeq: ReadonlyMap<number, number>;
}

export interface LiveChartProjectionResult<T> {
  data: T | null;
  /** Účty, které teď kreslí stav workeru (s dokladem i bez) — pro `lastWorkerShownSeq`. */
  workerShown: number[];
  /**
   * Účty ověřené JEN kotvou kontinuity (ne plným dokladem). Kotva nepozná vynechanou událost
   * (NEOVĚŘENO conformance testem) → z nich neprojdou akce zvětšující možnou ztrátu
   * (`summary.continuityOnly`, `lib/liveChartRiskPolicy.ts`; review Codexu 5e9b2aef).
   */
  continuityOnly?: number[];
}

/**
 * KROK 1 projekce (vždy první, před jakýmkoli overlayem, zkratkou dokladu nebo návratem):
 * REST čtení účtu zahájené DŘÍV, než graf naposledy kreslil jeho stav ze workeru, je starší —
 * jeho pozice a příkazy jsou neutrálně „unavailable“ (nikdy flat), dokud nedorazí čtení
 * zahájené až potom. Nezávisí na statusu workeru, čerstvosti, cache ani dokladu (INV-UI-01/03).
 */
/**
 * Účty s platnou kontinuitou streamu od REST baseline (`exposure.streamContinuity`) — tytéž
 * kontroly jako doklad (`coveredWorkerAccounts`), jen jiný zdroj řádků. Jen graf.
 */
export function workerContinuityAccounts(
  status: LocalCopierAgentStatus | null | undefined,
  observedAtMs: number | null | undefined,
  owners: ReadonlyMap<number, WorkerCoverageOwner>,
  now: number,
): Map<number, TradovateWorkerAccountCoverage> {
  const rows = (status?.controller?.exposure as { streamContinuity?: TradovateWorkerAccountCoverage[] } | null | undefined)?.streamContinuity;
  const result = new Map<number, TradovateWorkerAccountCoverage>();
  if (!rows?.length) return result;
  const receipt = { status: { controller: { connected: status?.controller?.connected, exposure: { streamCoverage: rows } } }, observedAt: observedAtMs };
  for (const [accountId, owner] of owners) {
    const row = coveredWorkerAccounts(receipt, owner, [accountId], now).get(accountId);
    if (row) result.set(accountId, row);
  }
  return result;
}

/**
 * Přehled LIVE (review Codexu 9aa17b7, bod 4): zobrazení pozic a příkazů stojí na STEJNÉ
 * kontinuitě streamu jako graf (`workerContinuityAccounts`), aby přehled neukazoval „Pozice
 * neověřeny“, když graf tentýž účet už ověřil. Jen účty, které už nemají doklad z
 * `overlayWorkerExposure` (data předaná sem už ho mají započtený), jen z čerstvého neobnoveného
 * statusu této instance. JEN ZOBRAZENÍ: řízení REST čtení, kopírka, způsobilost účtů ani
 * příkazy tento výsledek nečtou, ty dál stojí výhradně na dokladu (INV-UI-01/03).
 */
export function overlayWorkerContinuityForDisplay<T extends TradovateAccountDataResult>(
  data: T | null,
  status: LocalCopierAgentStatus | null | undefined,
  observedAtMs: number | null | undefined,
  now: number,
  owners: ReadonlyMap<number, WorkerCoverageOwner>,
  input: { statusFresh: boolean; trusted: boolean },
): T | null {
  if (!data || !input.statusFresh || !input.trusted) return data;
  const exposure = status?.controller?.exposure;
  const observed = observedAtMs != null && Number.isFinite(observedAtMs) && observedAtMs <= now + 5_000 ? observedAtMs : null;
  if (observed == null || status?.controller?.connected !== true || !exposure?.orders || now - observed > LIVE_CHART_WORKER_PROJECTION_MAX_AGE_MS) return data;
  const continuity = workerContinuityAccounts(status, observedAtMs, owners, now);
  if (!continuity.size) return data;
  const context = workerExposureOverlayContext(data, exposure);
  let changed = false;
  const accounts = data.accounts.map((account): TradovateAccountDataAccount => {
    if (account.readState?.displayStreamCoverage) return account;
    const continuous = continuity.get(account.id);
    if (!continuous) return account;
    changed = true;
    return overlayWorkerAccount(account, data, context, continuous.lastDataAt, continuous);
  });
  return changed ? { ...data, accounts } : data;
}

export function guardStaleRestReads<T extends TradovateAccountDataResult>(
  data: T | null,
  lastWorkerShownSeq: ReadonlyMap<number, number>,
): T | null {
  if (!data) return null;
  let changed = false;
  const accounts = data.accounts.map((account): TradovateAccountDataAccount => {
    const shownSeq = lastWorkerShownSeq.get(account.id);
    if (shownSeq == null || restReadStartedAfter(account, shownSeq)) return account;
    changed = true;
    const { displayStreamCoverage: _proof, displayProjection: _projection, ...rest } = tradovateAccountReadState(account, data);
    return { ...account, readState: { ...rest, positions: unavailable, orders: unavailable } };
  });
  return changed ? { ...data, accounts } : data;
}

/** Pracující příkaz jako porovnatelný otisk (id, kusy, ceny). */
const workingOrderPrint = (order: TradovateAccountDataAccount['orders'][number]) =>
  `${order.id}|${order.quantity ?? ''}|${order.price ?? ''}|${order.stopPrice ?? ''}`;

/** Jak staré REST čtení smí kontinuitu potvrdit (kratší než obecných 45 s; review b174135a). */
export const LIVE_CHART_REST_CONFIRM_MAX_AGE_MS = 20_000; // > klidové čtení ve flatu (15 s), jinak by potvrzení blikalo

/**
 * Čerstvé ověřené REST čtení pozic i příkazů (≤ `LIVE_CHART_REST_CONFIRM_MAX_AGE_MS`) se shoduje s kontinuitou:
 * stejný net na každém kontraktu a stejné pracující příkazy (id, kusy, ceny). Jinak fail-closed.
 */
export function restConfirmsContinuity(
  rest: TradovateAccountDataAccount,
  shown: TradovateAccountDataAccount,
  data: TradovateAccountDataResult,
  now: number,
): boolean {
  const state = tradovateAccountReadState(rest, data);
  const fresh = (asOf: string | null | undefined) => {
    const at = Date.parse(asOf ?? '');
    return Number.isFinite(at) && at <= now + 1_000 && now - at <= LIVE_CHART_REST_CONFIRM_MAX_AGE_MS;
  };
  if (!verifiedReadAvailability(state.positions.availability) || !verifiedReadAvailability(state.orders.availability)) return false;
  if (!fresh(state.positionsAsOf) || !fresh(state.ordersAsOf)) return false;
  const nets = (account: TradovateAccountDataAccount) => account.positions
    .filter(position => position.netPosition !== 0)
    .map(position => `${position.symbol ?? position.contractId}:${position.netPosition}`).sort().join(',');
  const working = (account: TradovateAccountDataAccount) => account.orders
    .filter(order => order.status === 'Working').map(workingOrderPrint).sort().join(',');
  return nets(rest) === nets(shown) && working(rest) === working(shown);
}

export function projectLiveChartExposure<T extends TradovateAccountDataResult>(
  data: T | null,
  status: LocalCopierAgentStatus | null | undefined,
  observedAtMs: number | null | undefined,
  now: number,
  owners: ReadonlyMap<number, WorkerCoverageOwner>,
  input: LiveChartProjectionInput,
): LiveChartProjectionResult<T> {
  // KROK 1: sekvenční plot nad REST daty — na všech cestách, bez výjimky.
  const guarded = guardStaleRestReads(data, input.lastWorkerShownSeq);
  if (!guarded) return { data: null, workerShown: [] };
  // KROK 2: stav workeru (s dokladem i bez) graf kreslí JEN z čerstvého statusu této instance.
  // Obnovená cache (`trusted: false`) ani nečerstvý status se jako stav workeru nepromítnou
  // — ani s časově platným dokladem kontinuity (review Codexu, 4. kolo).
  if (!input.trusted || !input.statusFresh) return { data: guarded, workerShown: [] };
  // KROK 3: overlay — účty s dokladem (`overlayWorkerExposure`), pak známé účty bez dokladu.
  const proven = overlayWorkerExposure(guarded, status, observedAtMs, now, owners)!;
  // Kontinuita streamu od REST baseline (`exposure.streamContinuity`, přežije obchodní událost):
  // stejné kontroly jako doklad (session, route, socket, sync, backlog, merge, shoda snímku
  // s cache, stáří ≤ 8 s) — z čerstvého neobnoveného statusu ověří účet i s otevřenou pozicí.
  const continuity = workerContinuityAccounts(status, observedAtMs, owners, now);
  const exposure = status?.controller?.exposure;
  const observed = observedAtMs != null && Number.isFinite(observedAtMs) && observedAtMs <= now + 5_000 ? observedAtMs : null;
  const workerLive = observed != null && status?.controller?.connected === true && !!exposure?.orders
    && now - observed <= LIVE_CHART_WORKER_PROJECTION_MAX_AGE_MS;
  const known = workerLive ? workerKnownAccounts(status) : new Set<number>();
  const context = workerLive && exposure ? workerExposureOverlayContext(proven, exposure) : null;
  const workerShown: number[] = [];
  const continuityOnly: number[] = [];
  // Potvrzení kontinuity bere SUROVÉ REST čtení (před plotem): plot posouvá každý render grafu,
  // takže by odfiltroval skoro každé čtení (review b174135a). Plot dál řídí jen kreslení.
  const rawRestById = new Map((data?.accounts ?? []).map(item => [item.id, item] as const));
  let changed = false;
  const accounts = proven.accounts.map((account): TradovateAccountDataAccount => {
    if (account.readState?.displayStreamCoverage) { workerShown.push(account.id); return account; }
    const continuous = continuity.get(account.id);
    if (context && continuous) {
      changed = true;
      workerShown.push(account.id);
      const shown = overlayWorkerAccount(account, proven, context, continuous.lastDataAt, continuous);
      // Nezávislé čerstvé REST čtení od brokera (zahájené po posledním zobrazení stavu workeru —
      // starší odfiltroval plot v kroku 1), které se s kontinuitou shoduje, vynechanou událost
      // vylučuje → plně ověřeno, ne mezistupeň (review 5e9b2aef/f63859c2: kontinuita nesmí být
      // přísnější než REST na mainu; jinak by přikoupení a vstupy stály po celou pozici).
      const raw = rawRestById.get(account.id);
      if (!raw || !data || !restConfirmsContinuity(raw, shown, data, now)) continuityOnly.push(account.id);
      return shown;
    }
    // Worker žije a účet zná: vždy jeho stav (pořadí workeru řeší fence pollu a `displaySeq` kanálu).
    if (context && observed != null && known.has(account.id) && workerConnectionStreamLive(status, owners.get(account.id))) {
      changed = true;
      workerShown.push(account.id);
      return overlayWorkerAccount(account, proven, context, observed, null);
    }
    return account;
  });
  return { data: changed ? { ...proven, accounts } : proven, workerShown, continuityOnly };
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
  // Všechny cesty zobrazení ochrany nesou stav: souhrn, text krytí i řádky účtů (karta PC,
  // telefonní list). Neověřený řádek nikdy „kryje celou pozici“.
  const rows = summary.rows.map(row => (unverifiedAccountIds.has(row.accountId)
    ? { ...row, unverified: true, protectedFully: false } : row));
  return {
    ...position,
    key: `${position.key}|${LIVE_CHART_UNVERIFIED_NOTE}`,
    summary: { ...summary, unverified: true, protection: `${summary.protection} · ${LIVE_CHART_UNVERIFIED_NOTE}`, rows },
  };
}

/**
 * Neznámé ≠ flat (review Codexu a09c4176): pohled bez pozice, který stojí na neověřené projekci
 * workeru (např. leader bez dokladu ani kontinuity), není ověřený flat — dostane `issueKind:
 * 'stale'`, takže ho graf nekreslí jako čistý flat (krátce podrží poslední stav jako neověřený)
 * a brána nového vstupu ho odmítne (`createLiveChartCommandGuard().entry`).
 */
export function markUnverifiedFlat(
  position: LiveChartPosition,
  viewAccountIds: ReadonlyArray<number | null | undefined>,
  unverifiedAccountIds: ReadonlySet<number>,
): LiveChartPosition {
  if (position.summary || position.issue != null || unverifiedAccountIds.size === 0) return position;
  if (!viewAccountIds.some(id => id != null && unverifiedAccountIds.has(id))) return position;
  return { ...position, key: `${position.key}|flat-${LIVE_CHART_UNVERIFIED_NOTE}`, issue: `Pozice ${LIVE_CHART_UNVERIFIED_NOTE}`, issueKind: 'stale' };
}

/**
 * Pohled stojí aspoň na jednom účtu ověřeném jen kotvou kontinuity (podle ÚČTŮ POHLEDU, ne jen
 * řádků s pozicí — critic 677895e0: follower „flat“ z kotvy i flat leader po uzavření). Pozice →
 * `summary.continuityOnly`; flat bez issue → `position.continuityOnly`. Zobrazení beze změny;
 * brána odmítne akce zvětšující možnou ztrátu a JAKÝKOLI nový vstup (vynechaná událost může skrývat
 * expozici kdekoli na účtu). Neověřená pozice / issue mají přednost.
 */
export function markLiveChartContinuityOnly(
  position: LiveChartPosition,
  viewAccountIds: ReadonlyArray<number | null | undefined>,
  continuityAccountIds: ReadonlySet<number>,
): LiveChartPosition {
  if (continuityAccountIds.size === 0) return position;
  const summary = position.summary;
  const ids = new Set<number>(viewAccountIds.filter((id): id is number => id != null));
  if (summary) {
    for (const row of summary.rows) ids.add(row.accountId);
    if (summary.leader) ids.add(summary.leader.accountId);
  }
  if (![...ids].some(id => continuityAccountIds.has(id))) return position;
  if (summary) {
    if (summary.unverified === true) return position;
    return { ...position, key: `${position.key}|kontinuita`, summary: { ...summary, continuityOnly: true } };
  }
  if (position.issue != null) return position;
  return { ...position, key: `${position.key}|kontinuita`, continuityOnly: true };
}

/** Jediný text stavu „neověřeno“ pro všechny cesty zobrazení grafu. */
export const LIVE_CHART_UNVERIFIED_NOTE = 'neověřeno';


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

/**
 * Nejdéle tak dlouho graf podrží poslední nakreslenou pozici, když nový pohled je jen
 * „neznámý“ (issue) — např. návrat na tab, než přijde nový status (DEMO 10. 11.: 600–680 ms
 * bez čar). Krátce (review Codexu): neznámý stop-out nesmí dlouho zakrývat stará pozice.
 */
export const LIVE_CHART_HOLD_LAST_DRAWN_MS = 5_000;

export interface LiveChartDrawnMemory { position: LiveChartPosition; at: number }

/**
 * Drží poslední nakreslený stav jako NEOVĚŘENÝ, dokud nepřijde nový: jen když nový pohled je
 * jen neověřené čtení (`issueKind` `stale` / `orders-stale`) — nikdy přes rozjetí, dobíhající
 * kopii, chybějící účet, ověřený flat ani jinou pozici — a nejdéle
 * `LIVE_CHART_HOLD_LAST_DRAWN_MS` od posledního skutečného vykreslení. Držená pozice je jen
 * zobrazení: všechny řádky `unverified`, takže z ní projdou jen akce snižující riziko (INV-UI-01/03).
 */
export function holdLastDrawnPosition(
  memory: LiveChartDrawnMemory | null,
  next: LiveChartPosition,
  now: number,
): { shown: LiveChartPosition; memory: LiveChartDrawnMemory | null } {
  if (next.summary) return { shown: next, memory: { position: next, at: now } };
  // Ověřený flat (bez issue) = pozice opravdu není: hned flat, paměť pryč.
  if (next.issue == null) return { shown: next, memory: null };
  // Držet jen u NEOVĚŘENÉHO ČTENÍ. Rozjetá skupina, dobíhající kopie, chybějící účet nebo jiný
  // cíl je skutečný stav: štítek hned, žádná poslední známá poloha (INV-UI-01/03).
  if (next.issueKind !== 'stale' && next.issueKind !== 'orders-stale') return { shown: next, memory: null };
  if (!memory || now - memory.at > LIVE_CHART_HOLD_LAST_DRAWN_MS || now < memory.at - 1_000) return { shown: next, memory: null };
  const held = memory.position;
  const ids = new Set([...held.summary!.rows.map(row => row.accountId), ...(held.summary!.leader ? [held.summary!.leader.accountId] : [])]);
  const marked = markLiveChartPositionProjection({ ...held, summary: { ...held.summary!, unverified: undefined } }, ids);
  // Vždy neověřená, i bez řádků účtů: brána grafu pak pustí jen akce snižující riziko
  // (`lib/liveChartRiskPolicy.ts`); worker je ověří znovu u brokera (expect, net, kotva).
  return { shown: { ...marked, key: `${marked.key}|drženo`, summary: { ...marked.summary!, unverified: true } }, memory };
}

/**
 * Poslední nakreslený stav grafu podle cíle pohledu („group“ / id účtu) — v MODULU, ne
 * v komponentě: remount grafu (přepnutí záložky, PC ↔ telefon) ho nesmaže, takže i po remountu
 * se drží jako neověřený, dokud nepřijde nový (nejvýš `LIVE_CHART_HOLD_LAST_DRAWN_MS`).
 */
const drawnMemoryByTarget = new Map<string, LiveChartDrawnMemory>();
/**
 * Klíč paměti = IDENTITA pohledu: id skupiny, leader, množina followerů a požadovaný cíl
 * (review 6bb8ef7) — přepnutí skupiny nebo změna vlastníků účtů nikdy nepodrží pozici jiného leadera.
 */
export function liveChartDrawnMemoryKey(
  group: { id?: string | null; leaderAccountId?: number | null; followers?: ReadonlyArray<{ accountId: number }> | null } | null | undefined,
  requested: unknown,
  /** Identita (review Codexu a09c4176): uživatel a OAuth připojení + prostředí každého účtu pohledu. */
  identity: { userId?: string | null; owners?: ReadonlyMap<number, WorkerCoverageOwner> } = {},
): string {
  const ids = [group?.leaderAccountId, ...(group?.followers ?? []).map(follower => follower.accountId),
    typeof requested === 'number' ? requested : null].filter((id): id is number => id != null);
  const owners = [...new Set(ids)].sort((a, b) => a - b).map(id => {
    const owner = identity.owners?.get(id);
    return owner ? `${id}@${owner.environment}:${owner.connectionId}` : `${id}@?`;
  });
  return JSON.stringify([identity.userId ?? null, owners, group?.id ?? null, group?.leaderAccountId ?? null,
    (group?.followers ?? []).map(follower => follower.accountId).sort((a, b) => a - b), requested ?? null]);
}
/** Paměť cíle; při čtení zahodí všechny záznamy starší než okno držení (mapa neroste). */
export function liveChartDrawnMemory(target: string, now = Date.now()): LiveChartDrawnMemory | null {
  for (const [key, memory] of drawnMemoryByTarget) {
    if (now - memory.at > LIVE_CHART_HOLD_LAST_DRAWN_MS) drawnMemoryByTarget.delete(key);
  }
  return drawnMemoryByTarget.get(target) ?? null;
}
export function rememberLiveChartDrawn(target: string, memory: LiveChartDrawnMemory | null): void {
  if (memory) drawnMemoryByTarget.set(target, memory);
  else drawnMemoryByTarget.delete(target);
}
/** Jen pro testy. */
export const resetLiveChartDrawnMemoryForTests = () => drawnMemoryByTarget.clear();

/**
 * Živá pozice a čekající příkazy v grafu deníku — jen zobrazení.
 *
 * Stejný výpočet jako karta obchodu v LIVE (`buildTradeCard`): skupina =
 * vážený vstup a SL/TP leadera, jeden účet = jeho vstup a jeho SL/TP.
 * Nic odsud nesmí autorizovat příkaz (INV-UI-01/03): neověřené čtení pozic
 * (starší než 45 s) čáry neukáže vůbec — ne poslední známou polohu.
 */

import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { buildTradeCard, type TradeCardModel, type TradeCardRowInput } from './liveTradeCard';
import { formatReadAge, isLiveAccountReadVerified, liveAccountReadAgeMs } from './liveReadFreshness';
import { futuresSymbolRoot } from '../services/futuresContractSpecs';
import { WORKER_POSITION_DIVERGENT_DETAIL, WORKER_POSITION_MISMATCH_DETAIL } from './tradovateWorkerExposureOverlay';

/** Otevřené P&L starší než tohle (REST v penalizaci, výpadek) se v deníku neukáže. */
export const JOURNAL_PNL_MAX_AGE_MS = 15_000;
/** Rozdíl kusů hlášený workerem (kopie vstupu i výstupu chvíli dobíhá) musí trvat aspoň tak dlouho. */
export const WORKER_MISMATCH_CONFIRM_MS = 5_000;
/** Ostatní rozjetí (z dat účtů, ne-OK verdikt workeru) musí trvat déle než
 * jeden cyklus čtení z brokera v deníku (6 s) i s rezervou. */
export const JOURNAL_DIVERGENCE_CONFIRM_MS = 10_000;

/**
 * Jak moc deník dneška potřebuje čtení z brokera (App podle toho volí tempo):
 * `watch` = dívá se, bez pozice; `position` = otevřená pozice (živé P&L).
 */
export type JournalLiveInterest = 'off' | 'watch' | 'position';

/** `group` = celá skupina (výchozí), číslo = jeden účet skupiny. */
export type JournalLiveTarget = 'group' | number;

export interface JournalLiveOption {
  id: JournalLiveTarget;
  label: string;
}

/**
 * Proč pohled pozici neukazuje (štítek to řekne, čáry se nekreslí):
 * `stale` = čtení pozic starší než 45 s, `missing-account` = účet skupiny
 * v datech chybí (druhé připojení vypadlo), `orders-stale` = čekající vstup
 * z neověřeného čtení příkazů, `settling` = účty se liší kratší dobu, než
 * trvá dobíhání kopie, `divergent` = účty skupiny se liší (jiný směr,
 * kontrakt, osiřelá pozice či příkaz) — jeden souhrn by lhal, viz LIVE.
 */
export type JournalLiveIssue = 'stale' | 'missing-account' | 'orders-stale' | 'settling' | 'divergent';

/** Verdikty čerstvého workeru o followerech (null = verdikty nejsou). */
export interface WorkerMismatches {
  /** Rozdíl kusů hlášený kratší dobu než okno potvrzení. */
  pending: ReadonlySet<number>;
  /** Rozdíl kusů trvající celé okno, nebo rozjetí potvrzené kopírkou. */
  confirmed: ReadonlySet<number>;
  /** OK verdikt workeru: kopie sedí, nebo kopírka followera vědomě neřídí
   * (u „vypnutý follower“ pozici nečte — ta pak zůstává z REST). */
  ok: ReadonlySet<number>;
}

export interface JournalLiveView {
  model: TradeCardModel | null;
  options: JournalLiveOption[];
  /** Skutečně zobrazený pohled (zmizelý účet → skupina). */
  target: JournalLiveTarget;
  /** Model je ověřený a dá se kreslit (žádný `issue`). */
  verified: boolean;
  issue: JournalLiveIssue | null;
  /** Stáří nejstaršího použitelného čtení pozic (ms); null = žádné. */
  readAgeMs: number | null;
  /** Pohled hlásí rozjetí (dobíhá i potvrzené); hook drží, od kdy (`divergenceSince`). */
  divergenceCandidate: boolean;
  /** Skupina s vypnutou kopírkou (podle čerstvého workeru): bez poplachu o rozjetí. */
  copierOff: boolean;
  /** Souhrn jen jednoho účtu skupiny (jediný s expozicí při vypnuté kopírce). */
  scopeLabel: string | null;
}

export const EMPTY_JOURNAL_LIVE_VIEW: JournalLiveView = {
  model: null, options: [], target: 'group', verified: false, issue: null, readAgeMs: null,
  divergenceCandidate: false, copierOff: false, scopeLabel: null,
};

const groupRows = (group: CopyGroupConfig, byId: ReadonlyMap<number, LiveAccount>): TradeCardRowInput[] => {
  const rows: TradeCardRowInput[] = [];
  if (group.leaderAccountId != null) {
    const account = byId.get(group.leaderAccountId);
    rows.push({ account, accountId: group.leaderAccountId, name: account?.name ?? String(group.leaderAccountId), isLeader: true });
  }
  for (const follower of group.followers) {
    const account = byId.get(follower.accountId);
    rows.push({ account, accountId: follower.accountId, name: account?.name ?? String(follower.accountId), isLeader: false });
  }
  return rows;
};

export function buildJournalLiveView(input: {
  accounts: readonly LiveAccount[];
  orders: readonly LiveOrder[];
  feeRates: ReadonlyMap<string, number>;
  group: CopyGroupConfig | null;
  target: JournalLiveTarget;
  /** Verdikty čerstvého workeru o followerech; null/chybí = jen data účtů. */
  workerMismatches?: WorkerMismatches | null;
  /** Od kdy pohled hlásí rozjetí (`divergenceCandidate`), podle skutečného času. */
  divergenceSince?: number | null;
  /** Kopírka zapnutá podle čerstvého workeru; null/chybí = neznámo. */
  copierArmed?: boolean | null;
  now?: number;
}): JournalLiveView {
  const now = input.now ?? Date.now();
  if (!input.group) return EMPTY_JOURNAL_LIVE_VIEW;
  const byId = new Map(input.accounts.map(account => [account.id, account]));
  const rows = groupRows(input.group, byId);
  const members = rows.filter((row): row is TradeCardRowInput & { account: LiveAccount; accountId: number } => row.account != null && row.accountId != null);
  if (members.length === 0) return EMPTY_JOURNAL_LIVE_VIEW;
  const options: JournalLiveOption[] = [
    { id: 'group', label: 'Celá skupina' },
    ...members.map(row => ({ id: row.accountId, label: row.isLeader ? `${row.name} (leader)` : row.name })),
  ];
  const single = typeof input.target === 'number' ? members.find(row => row.accountId === input.target) : undefined;
  const target: JournalLiveTarget = single ? single.accountId : 'group';
  const viewRows = single ? [{ ...single, isLeader: true }] : rows;
  const viewMembers = single ? [single] : members;
  const ages = viewMembers.map(row => liveAccountReadAgeMs(row.account, 'positions', now));
  const readAgeMs = ages.some(age => age == null) ? null : Math.max(0, ...(ages as number[]));
  const copierOff = !single && input.copierArmed === false;
  const result = (model: TradeCardModel | null, issue: JournalLiveIssue | null, scopeLabel: string | null = null): JournalLiveView => ({
    model: issue ? null : model, options, target, verified: issue == null, issue, readAgeMs,
    divergenceCandidate: false, copierOff, scopeLabel: issue ? null : scopeLabel,
  });
  // Otevřené P&L jen čerstvé a ke známému vstupu: kusy může mít worker už
  // nové (přikoupení, otočení), P&L je z REST a v penalizaci by stálo minuty.
  const finalize = (model: TradeCardModel, scopeLabel: string | null = null): JournalLiveView => {
    if (model.kind === 'position' && model.openPnl != null) {
      const fresh = model.entry != null && model.accounts.every(account => {
        const at = account.openPnlAsOf ? Date.parse(account.openPnlAsOf) : Number.NaN;
        return Number.isFinite(at) && now - at <= JOURNAL_PNL_MAX_AGE_MS;
      });
      if (!fresh) return result({ ...model, openPnl: null, mark: null }, null, scopeLabel);
    }
    return result(model, null, scopeLabel);
  };
  // Rozjetí musí trvat celé okno (výstup, vstup on-submit, otočení i zrušení
  // se ke followerům kopírují se zpožděním). Jeden společný začátek pro
  // všechny cesty, ať se okna navzájem nenulují.
  const settle = (): JournalLiveView => ({
    ...result(null, now - (input.divergenceSince ?? now) >= JOURNAL_DIVERGENCE_CONFIRM_MS ? 'divergent' : 'settling'),
    divergenceCandidate: true,
  });
  // Potvrzené rozjetí drží okno dál: krátký výpadek heartbeatu ho nevrátí na „dobíhá“.
  const diverged = (): JournalLiveView => ({ ...result(null, 'divergent'), divergenceCandidate: true });
  const verdicts = single ? null : input.workerMismatches ?? null;
  const holds = (row: { account: LiveAccount }) => row.account.positions.some(position => position.netPosition !== 0);
  // Skupina bez některého účtu (druhé OAuth připojení) není celá — nedoplňovat.
  if (!single && members.length !== rows.length) return result(null, 'missing-account');
  // Neověřené pozice: žádný model, aby se nikde nekreslila stará poloha.
  if (!viewMembers.every(row => isLiveAccountReadVerified(row.account, 'positions', now))) return result(null, 'stale');
  // Čistě vypnutá kopírka: followeři kopírovat nemají, rozdíl proti leaderovi
  // není porucha. Ukázat, co účty skutečně drží nebo mají v příkazech; jediný
  // takový účet = jeho vlastní pohled. Souhrn jen když obsáhne každý účet
  // s expozicí — jinak (jiný směr či kontrakt, zbylý příkaz jinde) výběr účtu.
  if (copierOff) {
    const exposed = members.filter(row => holds(row)
      || input.orders.some(order => order.working && order.accountId === row.accountId));
    if (exposed.length === 0) return result(null, null);
    const only = exposed.length === 1 ? exposed[0] : null;
    const offRows = exposed.some(row => row.isLeader) ? exposed : exposed.map((row, index) => ({ ...row, isLeader: index === 0 }));
    const offModel = buildTradeCard(only ? [{ ...only, isLeader: true }] : offRows, input.orders, input.feeRates, now);
    if (offModel?.kind === 'pending' && !offModel.verified) return result(null, 'orders-stale');
    const missing = exposed.filter(row => !offModel?.accounts.some(account => account.accountId === row.accountId));
    if (!offModel || missing.length > 0) {
      // Expozice jen z neověřeného čtení příkazů není jistá.
      return result(null, missing.every(row => !holds(row) && !isLiveAccountReadVerified(row.account, 'orders', now)) ? 'orders-stale' : 'divergent');
    }
    // Souhrn tvrdí „všechno, co skupina má“ — jen s ověřenými příkazy všech členů.
    if (!members.every(row => isLiveAccountReadVerified(row.account, 'orders', now))) return result(null, 'orders-stale');
    if (offModel.accounts.length === 1) return finalize(offModel, offModel.accounts[0].name);
    // Čekající vstupy víc účtů bez kopírky nemají společnou cenu ani typ —
    // průměr by kreslil vstup tam, kde žádný příkaz neleží.
    if (offModel.kind === 'pending') return result(null, 'divergent');
    // Bez kopírky účty nejsou synchronní: SL/TP čárou jen když je společná všem.
    return finalize({ ...offModel, ladder: { stop: offModel.stop.price, target: offModel.target.price } });
  }
  const model = buildTradeCard(viewRows, input.orders, input.feeRates, now);
  // Čekající vstup existuje jen v příkazech — z neověřeného čtení se nekreslí.
  if (model?.kind === 'pending' && !model.verified) return result(null, 'orders-stale');
  // Souhrn skupiny jen pro souměrnou kopii. Worker potvrdil rozjetí → hned.
  // Leader flat a follower drží (osiřelá pozice, nebo dobíhající kopie):
  // souhrn jen když má každý držící follower OK verdikt čerstvého workeru
  // (kopírka ho vědomě neřídí); jinak okno potvrzení.
  if (!single && model?.kind === 'position') {
    if (verdicts && members.some(row => verdicts.confirmed.has(row.accountId))) return diverged();
    if (!members.some(row => row.isLeader && holds(row))
      && !(verdicts && members.every(row => row.isLeader || !holds(row) || verdicts.ok.has(row.accountId)))) return settle();
  }
  if (!model) {
    // Bez souhrnu, ale s expozicí: buď se účty liší (jiný směr, otočení),
    // nebo osiřelý příkaz — ten je jistý jen z ověřeného čtení příkazů.
    const ids = new Set(viewMembers.map(row => row.accountId));
    if (verdicts && members.some(row => verdicts.confirmed.has(row.accountId))) return diverged();
    if (viewMembers.some(holds)) return settle();
    if (!input.orders.some(order => order.working && order.accountId != null && ids.has(order.accountId))) return result(null, null);
    return viewMembers.every(row => isLiveAccountReadVerified(row.account, 'orders', now)) ? settle() : result(null, 'orders-stale');
  }
  return finalize(model);
}

/**
 * Zapnutost kopírky pro pohled deníku z čerstvého heartbeatu: `true` = zapnutá,
 * `false` = výslovně ručně vypnutá a v klidu, `null` = neznámo nebo vypnutá
 * čímkoli jiným — fail-closed (rozjetí) i výpadek spojení vypínají kopírku
 * ve stejné revizi, takže tam poplachy o rozjetí platí dál. Seznam povolených
 * (ruční vypnutí), ne zakázaných: nový důvod vypnutí poplachy neztiší.
 * Záznam vypnutí se obnovuje z historie, proto musí být z tohoto běhu
 * workeru (`startedAt`) a s kopiemi flat — jinak může být ze včerejška.
 * Známé omezení: vypnutí bez nového záznamu po pozdějším zapnutí (cooldown,
 * day lock, změna skupiny…) by starý ruční záznam z téhož běhu nepřebilo.
 */
export function journalCopierArmed(controller: {
  armed: boolean;
  killSwitch?: boolean;
  connected?: boolean;
  lastError?: string | null;
  manualRecovery?: unknown;
  transportResume?: { phase: string } | null;
  lastDisarm?: { trigger: string; at: number; copiesOutcome?: string } | null;
} | null | undefined, startedAt?: string | null): boolean | null {
  if (!controller) return null;
  if (controller.armed) return true;
  const resuming = controller.transportResume?.phase === 'waiting' || controller.transportResume?.phase === 'ready';
  const runStart = startedAt ? Date.parse(startedAt) : Number.NaN;
  const disarm = controller.lastDisarm;
  return disarm?.trigger === 'manual'
    && disarm.copiesOutcome === 'flat'
    && Number.isFinite(runStart) && Number.isFinite(disarm.at) && disarm.at >= runStart
    && controller.connected !== false
    && !resuming
    && controller.lastError == null
    && controller.manualRecovery == null
    && !controller.killSwitch ? false : null;
}

export interface WorkerFollowerVerdict {
  accountId: number;
  ok: boolean;
  detail?: string | null;
}

/**
 * Potvrzené rozjetí followerů podle verdiktů čerstvého workeru: „pozice se
 * liší od leadera“ hned, rozdíl kusů až po `WORKER_MISMATCH_CONFIRM_MS`
 * (kopie vstupu chvíli trvá). `since` = od kdy účet rozdíl hlásí.
 */
export function confirmWorkerMismatches(
  followers: readonly WorkerFollowerVerdict[],
  since: ReadonlyMap<number, number>,
  now: number,
): { since: Map<number, number>; confirmed: Set<number>; pending: Set<number>; ok: Set<number> } {
  const nextSince = new Map<number, number>();
  const confirmed = new Set<number>();
  const pending = new Set<number>();
  const ok = new Set<number>();
  for (const follower of followers) {
    if (follower.ok) ok.add(follower.accountId);
    if (follower.ok || !follower.detail) continue;
    if (follower.detail === WORKER_POSITION_DIVERGENT_DETAIL) {
      confirmed.add(follower.accountId);
      continue;
    }
    if (!WORKER_POSITION_MISMATCH_DETAIL.test(follower.detail)) continue;
    const first = since.get(follower.accountId) ?? now;
    nextSince.set(follower.accountId, first);
    if (now - first >= WORKER_MISMATCH_CONFIRM_MS) confirmed.add(follower.accountId);
    else pending.add(follower.accountId);
  }
  return { since: nextSince, confirmed, pending, ok };
}

export type LivePriceLineKind = 'entry' | 'pending' | 'stop' | 'target';

export interface LivePriceLine {
  id: LivePriceLineKind;
  price: number;
  color: string;
  style: 'solid' | 'dashed';
  title: string;
}

/** Barvy SL/TP jako u uložených obchodů v grafu (services/journalChartPrimitive). */
export const LIVE_STOP_COLOR = '#ef4444';
export const LIVE_TARGET_COLOR = '#10b981';
const LONG_COLOR = '#3b82f6';
const SHORT_COLOR = '#f59e0b';

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const pointsLabel = (points: number) => `${points > 0 ? '+' : points < 0 ? '−' : ''}${Math.abs(Math.round(points * 4) / 4).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} b`;
const typeLabel = (type: string | null) => {
  const key = (type ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return key === 'limit' ? 'LMT' : key === 'stop' ? 'STP' : key === 'stoplimit' ? 'STP LMT' : (type ?? '').toUpperCase();
};

/**
 * Čáry pro graf: vstup (nebo čekající vstup) a SL/TP. SL/TP bere úrovně
 * pohledu (`ladder` = leader skupiny, u jednoho účtu jeho vlastní), body od
 * vstupu ve směru obchodu jako na kartě obchodu.
 */
export function journalLivePriceLines(model: TradeCardModel | null): LivePriceLine[] {
  if (!model || !finite(model.entry)) return [];
  const long = model.direction === 1;
  const lines: LivePriceLine[] = [model.kind === 'position'
    ? { id: 'entry', price: model.entry, color: long ? LONG_COLOR : SHORT_COLOR, style: 'solid', title: `${long ? 'LONG' : 'SHORT'} ${model.quantity}` }
    : { id: 'pending', price: model.entry, color: long ? LONG_COLOR : SHORT_COLOR, style: 'dashed', title: `${long ? 'BUY' : 'SELL'} ${typeLabel(model.entryType)} ${model.quantity}` }];
  const level = (price: number | null, id: 'stop' | 'target', color: string, label: string) => {
    if (!finite(price)) return;
    lines.push({ id, price, color, style: 'dashed', title: `${label} ${pointsLabel((price - model.entry!) * model.direction)}` });
  };
  level(model.ladder.stop, 'stop', LIVE_STOP_COLOR, 'SL');
  level(model.ladder.target, 'target', LIVE_TARGET_COLOR, 'TP');
  return lines;
}

/** Patří pozice do panelu? MNQ a NQ mají stejnou cenu indexu. */
export function livePositionMatchesRoot(symbol: string, root: string): boolean {
  const family = (value: string) => (value === 'MNQ' || value === 'NQ' ? 'NQ' : value === 'MES' || value === 'ES' ? 'ES' : value);
  return family(futuresSymbolRoot(symbol)) === family(root.trim().toUpperCase());
}

/** Text místo čísel, když pohled není ověřený (štítek grafu dne i LIVE → Graf). */
export function journalLiveIssueLabel(view: Pick<JournalLiveView, 'issue' | 'readAgeMs' | 'copierOff'>): string | null {
  const age = view.readAgeMs != null ? ` · čtení před ${formatReadAge(view.readAgeMs)}` : '';
  switch (view.issue) {
    case 'stale': return `Pozice neověřené${age}`;
    case 'missing-account': return 'Pozice neověřené · účet skupiny chybí v datech';
    case 'orders-stale': return 'Příkazy neověřené';
    case 'settling': return 'Kopie dobíhá…';
    case 'divergent': return view.copierOff ? 'Kopírka vypnutá · účty se liší, vyber účet' : 'Účty skupiny se liší · viz LIVE';
    default: return null;
  }
}

import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import type { CopierControllerStatus } from '../services/copierRuntimeController';
import { liveDailyLossRemainingDisplay, liveDailyPnlDisplay } from './liveBalanceDisplay';
import { isLiveAccountReadVerified } from './liveReadFreshness';
import { livePositionMatchesRoot } from './journalLivePosition';
import type { LiveTradeAccount, LiveTradeAccountRole, LiveTradeGroup, LiveTradeMoney } from './liveTradeTarget';

/**
 * Data účtů pro LIVE → Graf (jen zobrazení) ze stejných vstupů jako přehled
 * LIVE: skupina workeru, jeho čerstvý stav a snapshot účtů z brokera.
 * Žije na straně desku — obrazovka grafu dostane jen hotový model
 * (tests/liveTradingScreenGuards.test.ts: graf nesmí importovat kopírku).
 *
 * Pravidla (docs/COPIER_INVARIANTS.md):
 * - stav kopírky pro výběr účtu jen z ČERSTVÉHO stavu (INV-UI-01); obnovený,
 *   starý nebo čekající na automatické pokračování = neověřeno/zapnuto;
 * - vyřazení (INV-PART-03) jen z čerstvého `excludedForeignFollowers`;
 * - dnešní výsledek a „Do limitu“ stejnou funkcí jako přehled (jeden zdroj
 *   pravdy, se stářím); neznámé = null, nikdy 0 ani „flat“.
 */

type CopierController = Pick<CopierControllerStatus, 'armed' | 'transportResume' | 'excludedForeignFollowers' | 'followerParticipation'>;

const resumePending = (controller: Pick<CopierControllerStatus, 'transportResume'>) => (
  controller.transportResume?.phase === 'waiting' || controller.transportResume?.phase === 'ready'
);

/**
 * Kopírka je prokazatelně vypnutá: čerstvý stav, `armed: false` a žádné
 * čekající automatické pokračování (INV-RECON-04 — to by ji samo zapnulo).
 */
export function copierProvablyOff(controller: Pick<CopierControllerStatus, 'armed' | 'transportResume'> | null | undefined, statusFresh: boolean): boolean {
  return statusFresh && controller != null && controller.armed === false && !resumePending(controller);
}

/** Stav kopírky pro pravidla výběru účtu: `null` = neověřeno (pravidla počítají se zapnutou). */
export function copierArmedForRules(controller: Pick<CopierControllerStatus, 'armed' | 'transportResume'> | null | undefined, statusFresh: boolean): boolean | null {
  if (copierProvablyOff(controller, statusFresh)) return false;
  return statusFresh && controller?.armed === true ? true : null;
}

export interface LiveChartDisarm {
  /** Text tlačítka; čekající automatické pokračování se ruší stejným příkazem. */
  label: string;
  /** Stav není ověřený — před vypnutím potvrzení jako na přehledu. */
  unverified: boolean;
}

/**
 * Vypnutí v grafu: vždy, kromě prokazatelně vypnuté kopírky (INV-UI-02).
 * Nezávisí na skupině ani na čerstvém stavu.
 */
export function liveChartDisarm(controller: Pick<CopierControllerStatus, 'armed' | 'transportResume'> | null | undefined, statusFresh: boolean): LiveChartDisarm | null {
  if (copierProvablyOff(controller, statusFresh)) return null;
  const pendingResume = controller != null && controller.armed === false && resumePending(controller);
  return { label: pendingResume ? 'Zrušit automatické pokračování' : 'Vypnout kopírku', unverified: !statusFresh };
}

const money = (display: { value: number | null; stale: boolean }, note?: string | null): LiveTradeMoney => (
  { value: display.value, stale: display.value != null && display.stale, ...(note ? { note } : {}) }
);

const PRICE = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Krátký štítek na čáru příkazu: první písmeno a poslední tři číslice jména. */
export function shortAccountLabel(name: string): string {
  const digits = name.replace(/\D/g, '');
  const letter = name.trim().charAt(0).toUpperCase();
  return digits.length >= 2 ? `${letter}${digits.slice(-3)}` : name.trim().slice(0, 4);
}

const plural = (count: number) => (count === 1 ? 'příkaz' : count < 5 ? 'příkazy' : 'příkazů');

/**
 * Pozice účtu pro přehled: v kořeni grafu s průměrnou cenou (po změně
 * velikosti cena neznámá = „—“, nikdy stará), jiné symboly jako počet;
 * flat s čekajícími příkazy jako „flat · N příkazů“. Neověřené čtení = null.
 */
export function liveAccountPositionText(account: LiveAccount, orders: readonly LiveOrder[], root: string, now: number): string | null {
  if (!isLiveAccountReadVerified(account, 'positions', now)) return null;
  const open = account.positions.filter(position => position.netPosition !== 0);
  const inRoot = open.filter(position => livePositionMatchesRoot(position.symbol, root));
  const other = open.length - inRoot.length;
  const parts = inRoot.map(position => (
    `${position.netPosition > 0 ? '+' : ''}${position.netPosition} @ ${position.netPrice != null ? PRICE.format(position.netPrice) : '—'}`
  ));
  if (other > 0) parts.push(`+${other} jiný symbol`);
  if (parts.length) return parts.join(', ');
  if (!isLiveAccountReadVerified(account, 'orders', now)) return 'flat · příkazy ?';
  const working = orders.filter(order => order.accountId === account.id && order.working).length;
  return working ? `flat · ${working} ${plural(working)}` : 'flat';
}

export function buildLiveTradeGroup(input: {
  group: Pick<CopyGroupConfig, 'leaderAccountId' | 'followers'> | null;
  controller: CopierController | null | undefined;
  statusFresh: boolean;
  /** Účty se zobrazovacími hodnotami (dnešní výsledek, limit) — stejné jako přehled. */
  displayAccounts: readonly LiveAccount[];
  /** Účty s pozicemi z čerstvého překryvu workeru. */
  positionAccounts: readonly LiveAccount[];
  orders: readonly LiveOrder[];
  nameOf: (accountId: number) => string;
  root: string;
  now: number;
}): LiveTradeGroup | null {
  const { group, controller, statusFresh, now } = input;
  if (!group || group.leaderAccountId == null) return null;
  const display = new Map(input.displayAccounts.map(account => [account.id, account]));
  const positions = new Map(input.positionAccounts.map(account => [account.id, account]));
  const excludedIds = new Set(statusFresh ? controller?.excludedForeignFollowers ?? [] : []);
  const participation = new Map((statusFresh ? controller?.followerParticipation ?? [] : []).map(entry => [entry.accountId, entry]));
  const account = (accountId: number, role: LiveTradeAccountRole, multiplier: number, extra: Partial<LiveTradeAccount> = {}): LiveTradeAccount => {
    const name = input.nameOf(accountId);
    const shown = display.get(accountId);
    const remaining = liveDailyLossRemainingDisplay(shown, now);
    const remainingNote = remaining.value == null ? remaining.reason : remaining.cappedByDrawdown ? 'omezeno rezervou DD' : null;
    const withPositions = positions.get(accountId);
    return {
      id: String(accountId),
      accountId,
      name,
      short: shortAccountLabel(name),
      role,
      multiplier,
      dayPnl: money(liveDailyPnlDisplay(shown, now)),
      dayRemaining: money(remaining, remainingNote),
      position: withPositions ? liveAccountPositionText(withPositions, input.orders, input.root, now) : null,
      ...extra,
    };
  };
  const followers = group.followers.map(follower => {
    const excluded = excludedIds.has(follower.accountId);
    const entry = participation.get(follower.accountId);
    const inactiveReason = excluded ? null
      : follower.enabled === false ? 'vypnutý ve skupině'
        : entry && !entry.effectiveEnabled ? entry.automaticExclusion ?? entry.blockers[0] ?? 'nekopíruje'
          : null;
    return account(follower.accountId, 'follower', follower.multiplier, {
      ...(excluded ? { excluded: true } : {}),
      ...(inactiveReason ? { inactiveReason } : {}),
    });
  });
  const members = new Set([group.leaderAccountId, ...group.followers.map(follower => follower.accountId)]);
  const outside = input.displayAccounts
    .filter(candidate => !members.has(candidate.id))
    .map(candidate => account(candidate.id, 'outside', 1));
  return {
    leader: account(group.leaderAccountId, 'leader', 1),
    followers,
    outside,
    armed: copierArmedForRules(controller, statusFresh),
    sample: false,
  };
}

/** Obsahový klíč skupiny — graf se překreslí jen při skutečné změně. */
export function liveTradeGroupKey(group: LiveTradeGroup | null): string {
  if (!group) return '';
  const money = (value: LiveTradeMoney) => `${value.value ?? '-'}${value.stale ? 's' : ''}${value.note ?? ''}`;
  return JSON.stringify([group.armed, group.sample, ...[group.leader, ...group.followers, ...group.outside].map(entry => [
    entry.id, entry.name, entry.role, entry.multiplier, entry.excluded ?? false, entry.inactiveReason ?? '',
    money(entry.dayPnl), money(entry.dayRemaining), entry.position ?? null,
  ])]);
}

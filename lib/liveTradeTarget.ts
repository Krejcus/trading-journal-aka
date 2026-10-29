/**
 * Kam jde objednávka ze živého grafu: celá skupina (leader + kopírka), nebo
 * jen jeden účet. Jen UI — o tom, co smí odejít k brokerovi, rozhoduje až
 * odesílání přes jádro kopírky (zatím nezapojené).
 *
 * Pravidla výběru drží invarianty kopírky (docs/COPIER_INVARIANTS.md):
 * - ruční pozice na followerovi, který je ve skupině, je za zapnuté kopírky
 *   rozjetí a kopírka zastaví celou skupinu (INV-DIVERGENCE-01, halt-group);
 * - vyřazený follower od kopírky nic nedostane a jeho pozice se nepočítá
 *   (INV-PART-03) — jde obchodovat kdykoli;
 * - leader samostatně jen při vypnuté kopírce, jinak by se obchod rozkopíroval.
 */

export type LiveTradeAccountRole = 'leader' | 'follower' | 'outside';

export interface LiveTradeAccount {
  id: string;
  name: string;
  /** Krátký štítek na čáru příkazu v grafu (např. „T3“). */
  short: string;
  role: LiveTradeAccountRole;
  /** Follower vyřazený z kopírování („Zapnout bez tohoto účtu“ na LIVE). */
  excluded?: boolean;
  /** Násobek velikosti leadera (jen follower). */
  multiplier: number;
  dayPnlUsd: number;
  dayLimitUsd: number;
}

export interface LiveTradeGroup {
  leader: LiveTradeAccount;
  followers: LiveTradeAccount[];
  /** Účty, které v žádné skupině nejsou. */
  outside: LiveTradeAccount[];
  /**
   * Stav kopírky ze stavu workeru (jen zobrazení, INV-UI-01/03). `null` =
   * neověřeno — pravidla výběru pak počítají se zapnutou kopírkou.
   */
  armed: boolean | null;
  /** Ukázková data (do napojení na stav workeru) — UI je musí označit. */
  sample: boolean;
}

export type LiveTradeTarget = { kind: 'group' } | { kind: 'account'; accountId: string };

export const GROUP_TARGET: LiveTradeTarget = { kind: 'group' };

export const allTradeAccounts = (group: LiveTradeGroup): LiveTradeAccount[] => (
  [group.leader, ...group.followers, ...group.outside]
);

/** Follower, který se účastní kopírování (není vyřazený). */
export const followerInCopy = (account: LiveTradeAccount) => account.role === 'follower' && !account.excluded;

export const participatingFollowers = (group: LiveTradeGroup) => group.followers.filter(followerInCopy);

/**
 * Proč účet nejde obchodovat samostatně, nebo `null`, když jde. Text se
 * ukazuje v nabídce u zašedlého účtu.
 */
export const soloTradeBlockReason = (account: LiveTradeAccount, armed: boolean | null): string | null => {
  if (armed === false || !(account.role === 'leader' || followerInCopy(account))) return null;
  if (armed == null) return 'Stav kopírky není ověřený — počítám se zapnutou (obchod by se mohl rozkopírovat nebo rozjet skupinu)';
  return account.role === 'leader'
    ? 'Kopírka je zapnutá — obchod by se rozkopíroval na celou skupinu'
    : 'Kopírka je zapnutá — ruční pozice na účtu ve skupině = rozjetí a kopírka zastaví celou skupinu';
};

export const targetAccount = (group: LiveTradeGroup, target: LiveTradeTarget): LiveTradeAccount | null => (
  target.kind === 'account' ? allTradeAccounts(group).find(account => account.id === target.accountId) ?? null : null
);

/**
 * Cíl, který při současném stavu platí. Když se zapne kopírka a vybraný
 * samostatný účet tím přestane být dostupný, vrací se na skupinu — panel
 * nesmí dál tvrdit „jen T1“, když by to už nešlo.
 */
export const effectiveTarget = (group: LiveTradeGroup, target: LiveTradeTarget): LiveTradeTarget => {
  if (target.kind === 'group') return target;
  const account = targetAccount(group, target);
  return account && soloTradeBlockReason(account, group.armed) == null ? target : GROUP_TARGET;
};

/**
 * Kolik účtů ponese příkaz (součet násobků). Skupina za zapnuté kopírky =
 * leader + kopírující followeři; vypnutá kopírka nebo jeden účet = 1.
 */
export const targetMultiplier = (group: LiveTradeGroup, target: LiveTradeTarget): number => {
  if (target.kind === 'account' || group.armed === false) return 1;
  return 1 + participatingFollowers(group).reduce((sum, account) => sum + account.multiplier, 0);
};

/** Účet, jehož denní limit hlídá panel: vybraný účet, u skupiny leader. */
export const limitAccount = (group: LiveTradeGroup, target: LiveTradeTarget): LiveTradeAccount => (
  targetAccount(group, target) ?? group.leader
);

/**
 * Ukázková skupina pro UI, dokud panel nečte stav workeru (další session).
 * Jen v dev buildu; jména a čísla jsou vymyšlená a UI je označuje „ukázka“.
 * Stav kopírky (`armed`) sem obrazovka dosazuje skutečný ze stavu workeru.
 */
export const SAMPLE_LIVE_TRADE_GROUP: LiveTradeGroup = {
  leader: { id: 'lucid-50k', name: 'Lucid 50K', short: 'L50', role: 'leader', multiplier: 1, dayPnlUsd: -388, dayLimitUsd: 1000 },
  followers: [
    { id: 'tradeify-50k-1', name: 'Tradeify 50K · 1', short: 'T1', role: 'follower', multiplier: 1, dayPnlUsd: -402, dayLimitUsd: 1000 },
    { id: 'tradeify-50k-2', name: 'Tradeify 50K · 2', short: 'T2', role: 'follower', multiplier: 1, dayPnlUsd: -371, dayLimitUsd: 1000 },
    { id: 'tradeify-50k-3', name: 'Tradeify 50K · 3', short: 'T3', role: 'follower', excluded: true, multiplier: 1, dayPnlUsd: -395, dayLimitUsd: 1000 },
    { id: 'tradeify-50k-4', name: 'Tradeify 50K · 4', short: 'T4', role: 'follower', multiplier: 1, dayPnlUsd: -380, dayLimitUsd: 1000 },
  ],
  outside: [
    { id: 'tradeify-100k', name: 'Tradeify 100K', short: 'T100', role: 'outside', multiplier: 1, dayPnlUsd: -120, dayLimitUsd: 2000 },
  ],
  armed: null,
  sample: true,
};

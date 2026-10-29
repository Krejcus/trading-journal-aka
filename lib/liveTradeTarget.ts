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

/**
 * Částka pro zobrazení se stářím (stejná pravidla jako přehled LIVE,
 * `lib/liveBalanceDisplay.ts`). `value: null` = neznámo („—“, nikdy 0).
 */
export interface LiveTradeMoney {
  value: number | null;
  /** Poslední známá hodnota, ne čerstvá — UI ji tlumí. */
  stale: boolean;
  /** Proč hodnota chybí nebo je omezená (např. „bez denního limitu“). */
  note?: string | null;
}

export const UNKNOWN_MONEY: LiveTradeMoney = { value: null, stale: false };

export interface LiveTradeAccount {
  id: string;
  /** Tradovate id účtu (skutečná skupina); ukázka ho nemá. */
  accountId?: number;
  name: string;
  /** Krátký štítek na čáru příkazu v grafu (např. „T3“). */
  short: string;
  role: LiveTradeAccountRole;
  /** Follower vyřazený z kopírování („Zapnout bez tohoto účtu“ na LIVE) — jen z čerstvého stavu workeru. */
  excluded?: boolean;
  /**
   * Follower, který nekopíruje z jiného důvodu (ruční vypnutí, cut, DLL…).
   * Od rozjetí ho pravidla nevyjímají — samostatně za zapnuté kopírky nejde.
   */
  inactiveReason?: string | null;
  /** Násobek velikosti leadera (jen follower). */
  multiplier: number;
  /** Dnešní realizovaný výsledek. */
  dayPnl: LiveTradeMoney;
  /** Kolik zbývá do denního limitu (vč. otevřené ztráty, omezené rezervou DD) — jako přehled LIVE. */
  dayRemaining: LiveTradeMoney;
  /** Pozice pro přehled účtů („+2 @ 29 650,25“, „flat · 1 příkaz“); null = neověřeno („—“, nikdy „flat“). */
  position?: string | null;
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

/** Follower, který se účastní kopírování (není vyřazený ani teď vypnutý — cut, DLL…). */
export const followerInCopy = (account: LiveTradeAccount) => account.role === 'follower' && !account.excluded && !account.inactiveReason;

export const participatingFollowers = (group: LiveTradeGroup) => group.followers.filter(followerInCopy);

/**
 * Proč účet nejde obchodovat samostatně, nebo `null`, když jde. Text se
 * ukazuje v nabídce u zašedlého účtu.
 */
export const soloTradeBlockReason = (account: LiveTradeAccount, armed: boolean | null): string | null => {
  if (armed === false) return null;
  // Neověřený stav: i členství ve skupině může být ze starého stavu, takže ani účet „mimo skupinu“.
  if (armed == null) return 'Stav kopírky není ověřený — počítám se zapnutou (obchod by se mohl rozkopírovat nebo rozjet skupinu)';
  if (account.role === 'outside' || (account.role === 'follower' && account.excluded)) return null;
  if (account.role === 'follower' && account.inactiveReason) {
    return `Follower je ve skupině, jen teď nekopíruje (${account.inactiveReason}) — ruční pozice by byla rozjetí`;
  }
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
 * Účty, jejichž denní limit příkaz ohrozí, s násobkem rizika: vybraný účet,
 * u skupiny leader a za zapnuté kopírky i kopírující followeři.
 */
export const limitAccounts = (group: LiveTradeGroup, target: LiveTradeTarget): Array<{ account: LiveTradeAccount; multiplier: number }> => {
  const single = targetAccount(group, target);
  if (single) return [{ account: single, multiplier: 1 }];
  const followers = group.armed === false ? [] : participatingFollowers(group);
  return [{ account: group.leader, multiplier: 1 }, ...followers.map(account => ({ account, multiplier: account.multiplier }))];
};

/**
 * Ukázková skupina pro vývoj UI bez workeru. Jen v dev buildu a jen se
 * zapnutým přepínačem (`at:dev:live-chart-sample`) — nikdy jako náhrada,
 * když skutečná skupina chybí. Jména a čísla jsou vymyšlená, UI je označuje.
 */
const sampleMoney = (value: number): LiveTradeMoney => ({ value, stale: false });
const sample = (id: string, name: string, short: string, role: LiveTradeAccountRole, pnl: number, remaining: number, excluded = false): LiveTradeAccount => (
  { id, name, short, role, multiplier: 1, dayPnl: sampleMoney(pnl), dayRemaining: sampleMoney(remaining), position: null, ...(excluded ? { excluded } : {}) }
);
export const SAMPLE_LIVE_TRADE_GROUP: LiveTradeGroup = {
  leader: sample('lucid-50k', 'Lucid 50K', 'L50', 'leader', -388, 612),
  followers: [
    sample('tradeify-50k-1', 'Tradeify 50K · 1', 'T1', 'follower', -402, 598),
    sample('tradeify-50k-2', 'Tradeify 50K · 2', 'T2', 'follower', -371, 629),
    sample('tradeify-50k-3', 'Tradeify 50K · 3', 'T3', 'follower', -395, 605, true),
    sample('tradeify-50k-4', 'Tradeify 50K · 4', 'T4', 'follower', -380, 620),
  ],
  outside: [sample('tradeify-100k', 'Tradeify 100K', 'T100', 'outside', -120, 1880)],
  armed: null,
  sample: true,
};

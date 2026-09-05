import type { LiveSnapshot } from './tradecopiaLiveService';

export type CopyReplicationMode = 'off' | 'on-submit' | 'on-fill';

export interface CopyFollowerConfig {
  accountId: number;
  mode: CopyReplicationMode;
  multiplier: number;
  /**
   * Tvrdý strop absolutní otevřené expozice follower účtu na jeden symbol.
   * Multiplier škáluje, strop řeže. Bez hodnoty se nic neomezuje.
   */
  maxContracts?: number;
  /**
   * „Max ztráta": realizovaná denní ztráta účtu v USD (vč. poplatků, z broker
   * snapshotu), při které účet vypadne z kopírování do konce session.
   * 0/undefined = vypnuto. Skupina se nezamyká, ostatní followeři jedou dál.
   */
  dailyLossCutUsd?: number;
  /** Co s otevřenou kopií účtu při vyřazení. Default `close-copy`. */
  onCut?: CopyFollowerCutAction;
}

export type CopyFollowerCutAction = 'close-copy' | 'let-run';

/**
 * Co udělat s otevřenými kopiemi, když copier přestane kopírovat —
 * expirací ostrého ARM (konec broker session) NEBO fail-closed chybou za
 * živého ARM. `followers` zavře jen kopie — leader je ruka uživatele a
 * zůstává jeho; `group` zavře i leadera. Zavření je čistě risk-redukující:
 * ruší working příkazy a market-close k nule, nikdy nezvětší |pozici| ani
 * neotočí směr.
 */
export type ArmExpiryFlattenScope = 'off' | 'followers' | 'group';

export type DayLockTrigger =
  | 'manual'
  | 'daily-loss'
  | 'losing-trades'
  | 'max-trades'
  | 'window-end';

export interface CopyGroupTradingWindowSlot {
  from: string;
  to: string;
}

export interface CopyGroupTradingWindow {
  enabled: boolean;
  from: string;
  to: string;
  timeZone: string;
  /**
   * Další obchodní okna téhož dne (max 2, celkem 3), seřazená podle začátku,
   * bez překryvu s hlavním oknem i mezi sebou. Mezi okny se nekopíruje,
   * zámek dne se spouští až po konci posledního okna.
   */
  additional?: CopyGroupTradingWindowSlot[];
}

export const MAX_TRADING_WINDOW_SLOTS = 3;

/** Všechna okna (hlavní + další) seřazená chronologicky. */
export const tradingWindowSlotsOf = (window: Pick<CopyGroupTradingWindow, 'from' | 'to' | 'additional'>): CopyGroupTradingWindowSlot[] => (
  [{ from: window.from, to: window.to }, ...(window.additional ?? [])]
    .map(slot => ({ from: slot.from, to: slot.to }))
    .sort((a, b) => minutesOfDay(a.from) - minutesOfDay(b.from))
);

/** Platné jen když žádná dvě okna nekolidují a je jich nejvýše MAX_TRADING_WINDOW_SLOTS. */
export const tradingWindowSlotsValid = (slots: readonly CopyGroupTradingWindowSlot[]): boolean => {
  if (slots.length === 0 || slots.length > MAX_TRADING_WINDOW_SLOTS) return false;
  const sorted = [...slots].sort((a, b) => minutesOfDay(a.from) - minutesOfDay(b.from));
  for (let index = 0; index < sorted.length; index += 1) {
    const slot = sorted[index];
    if (!HH_MM.test(slot.from) || !HH_MM.test(slot.to) || minutesOfDay(slot.from) >= minutesOfDay(slot.to)) return false;
    if (index > 0 && minutesOfDay(slot.from) < minutesOfDay(sorted[index - 1].to)) return false;
  }
  return true;
};

/**
 * Akce pravidla dne: pauza vyprší sama a blokuje jen nové vstupy leadera
 * (exity se kopírují), zámek dne drží do konce broker session a čeká na flat.
 * Viz docs/RISK_TAB_SPEC_20260905.md §1–§2.
 */
export type CopierRuleAction =
  | { kind: 'pause'; minutes: number }
  | { kind: 'lock' };

export interface CopyGroupDayRuleActions {
  /** `beforeLimit` se spouští při `losingTrades === max - 1` (jen pro max >= 2). */
  losingTrades: { beforeLimit: CopierRuleAction | null; atLimit: CopierRuleAction };
  /** `at80Percent` při realizované ztrátě <= -0.8 × limit. */
  dailyLoss: { at80Percent: CopierRuleAction | null; atLimit: CopierRuleAction };
  maxTrades: { atLimit: CopierRuleAction };
  windowEnd: { atEnd: CopierRuleAction };
}

export interface CopyGroupSafetySettings {
  positionReconciler: boolean;
  disableReplicationOnBreach: boolean;
  autoCloseFollowerPositions: boolean;
  preventHedging: boolean;
  /**
   * Anti-revenge cooldown: po návratu leadera na flat se copier sám
   * odzbrojí a ostrý re-ARM je blokovaný tolik minut. 0 = vypnuto.
   * Blokuje se ARM, ne jednotlivé objednávky — obě strany jsou flat,
   * takže nevzniká záměrná divergence.
   */
  entryCooldownMinutes: number;
  /**
   * Vypnutí copieru (expirace ARM i fail-closed) nesmí nechat kopie viset
   * bez dozoru. Default `followers`: follower účty se flatten-ou, leader
   * zůstává uživateli.
   */
  armExpiryFlatten: ArmExpiryFlattenScope;
  /**
   * Auto day-lock: realizovaná denní ztráta leadera v USD, při které se
   * copier po zploštění skupiny sám zamkne do konce broker session.
   * 0 = vypnuto. Nikdy nezasahuje uprostřed obchodu — lock čeká na flat.
   */
  dailyLossLimitUsd: number;
  /** Auto day-lock po N ztrátových obchodech leadera za den. 0 = vypnuto. */
  dailyMaxLosingTrades: number;
  /** Auto day-lock po N uzavřených obchodech leadera za session. 0 = vypnuto. */
  dailyMaxTrades: number;
  /** Denní vstupní okno. Přes půlnoc se záměrně nepodporuje. */
  tradingWindow: CopyGroupTradingWindow;
  /** Akce jednotlivých pravidel dne (pauza / zámek). Staré skupiny dostanou DEFAULT. */
  dayRuleActions: CopyGroupDayRuleActions;
}

export const DEFAULT_DAY_RULE_ACTIONS: CopyGroupDayRuleActions = {
  losingTrades: { beforeLimit: { kind: 'pause', minutes: 20 }, atLimit: { kind: 'lock' } },
  // Denní ztráta má jednu akci (na limitu); 80 % zůstává jen varováním.
  dailyLoss: { at80Percent: null, atLimit: { kind: 'lock' } },
  maxTrades: { atLimit: { kind: 'pause', minutes: 30 } },
  windowEnd: { atEnd: { kind: 'lock' } },
};

export const cloneDayRuleActions = (actions: CopyGroupDayRuleActions): CopyGroupDayRuleActions => ({
  losingTrades: { beforeLimit: actions.losingTrades.beforeLimit ? { ...actions.losingTrades.beforeLimit } : null, atLimit: { ...actions.losingTrades.atLimit } },
  dailyLoss: { at80Percent: actions.dailyLoss.at80Percent ? { ...actions.dailyLoss.at80Percent } : null, atLimit: { ...actions.dailyLoss.atLimit } },
  maxTrades: { atLimit: { ...actions.maxTrades.atLimit } },
  windowEnd: { atEnd: { ...actions.windowEnd.atEnd } },
});

const sanitizeRuleAction = (value: unknown, allowNull: boolean): CopierRuleAction | null | undefined => {
  if (value == null) return allowNull ? null : undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<{ kind: string; minutes: number }>;
  if (raw.kind === 'lock') return { kind: 'lock' };
  if (raw.kind === 'pause'
    && typeof raw.minutes === 'number'
    && Number.isSafeInteger(raw.minutes)
    && raw.minutes >= 1
    && raw.minutes <= 720) return { kind: 'pause', minutes: raw.minutes };
  return undefined;
};

/** Chybějící pole = DEFAULT (staré skupiny), neplatná hodnota = null (fail-closed). */
export function sanitizeDayRuleActions(value: unknown): CopyGroupDayRuleActions | null {
  if (value === undefined) return cloneDayRuleActions(DEFAULT_DAY_RULE_ACTIONS);
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<Record<keyof CopyGroupDayRuleActions, Record<string, unknown>>>;
  const pick = (group: Record<string, unknown> | undefined, key: string, fallback: CopierRuleAction | null, allowNull: boolean) => {
    if (group === undefined) return fallback;
    if (typeof group !== 'object' || group === null || Array.isArray(group)) return undefined;
    return key in group ? sanitizeRuleAction(group[key], allowNull) : fallback;
  };
  const d = DEFAULT_DAY_RULE_ACTIONS;
  const losingBefore = pick(raw.losingTrades, 'beforeLimit', d.losingTrades.beforeLimit, true);
  const losingAt = pick(raw.losingTrades, 'atLimit', d.losingTrades.atLimit, false);
  const loss80 = pick(raw.dailyLoss, 'at80Percent', d.dailyLoss.at80Percent, true);
  const lossAt = pick(raw.dailyLoss, 'atLimit', d.dailyLoss.atLimit, false);
  const tradesAt = pick(raw.maxTrades, 'atLimit', d.maxTrades.atLimit, false);
  const windowEnd = pick(raw.windowEnd, 'atEnd', d.windowEnd.atEnd, false);
  if (losingBefore === undefined || loss80 === undefined
    || !losingAt || !lossAt || !tradesAt || !windowEnd) return null;
  return {
    losingTrades: { beforeLimit: losingBefore, atLimit: losingAt },
    dailyLoss: { at80Percent: loss80, atLimit: lossAt },
    maxTrades: { atLimit: tradesAt },
    windowEnd: { atEnd: windowEnd },
  };
}

export const DEFAULT_COPY_GROUP_SAFETY: CopyGroupSafetySettings = {
  positionReconciler: true,
  // Divergence nikdy nesmí být jen informační. Bezpečný výchozí stav je
  // zastavit další replikaci; runtime navíc používá policy `halt-group`.
  disableReplicationOnBreach: true,
  autoCloseFollowerPositions: true,
  preventHedging: true,
  entryCooldownMinutes: 0,
  // Expirovaný ARM s otevřenými kopiemi je fail-open na risk. Výchozí je
  // proto zavřít followery; leader zůstává v rukách uživatele.
  armExpiryFlatten: 'followers',
  dailyLossLimitUsd: 0,
  dailyMaxLosingTrades: 0,
  dailyMaxTrades: 0,
  tradingWindow: {
    enabled: false,
    from: '15:30',
    to: '22:00',
    timeZone: 'Europe/Prague',
  },
  dayRuleActions: cloneDayRuleActions(DEFAULT_DAY_RULE_ACTIONS),
};

export interface CopyGroupConfig {
  id: string;
  name: string;
  enabled: boolean;
  leaderAccountId: number | null;
  followers: CopyFollowerConfig[];
  color?: string;
  safety?: CopyGroupSafetySettings;
  localOnly?: boolean;
}

export type LiveCopyTradingCommand =
  | { type: 'create-group'; group: CopyGroupConfig }
  | {
    type: 'update-group';
    group: CopyGroupConfig;
    /** UI posílá jen po samostatném potvrzení ownership warningu. */
    waiveUnverifiableFollowerOwnership?: true;
  }
  | { type: 'delete-group'; groupId: string }
  | { type: 'set-group-enabled'; groupId: string; enabled: boolean }
  | { type: 'set-replication'; groupId: string; accountId: number; mode: CopyReplicationMode }
  | { type: 'set-multiplier'; groupId: string; accountId: number; multiplier: number }
  | { type: 'flatten-account'; groupId: string; accountId: number; operationId: string }
  /** Ruční uzavření stuck operace — nikdy neposílá broker příkaz. */
  | { type: 'resolve-stuck-operation'; groupId: string; kind: 'place' | 'bracket' | 'oso' | 'cancel-or-modify'; key: string; reason: string }
  | { type: 'flatten-group'; groupId: string; operationId: string }
  | { type: 'cancel-order'; groupId: string; orderId: number };

export type LiveCopyTradingCommandResult =
  | { type: 'configuration'; group: CopyGroupConfig }
  | {
    type: 'flatten';
    operationId: string;
    accountIds: number[];
    canceledOrders: number;
    submittedClosures: number;
    flat: boolean;
    remainingPositionAccounts: number[];
    workingOrderAccounts: number[];
  };

export interface LiveCopyTradingAdapter {
  execute(command: LiveCopyTradingCommand): Promise<LiveCopyTradingCommandResult | void>;
}

export interface CopyGroupValidation {
  valid: boolean;
  errors: string[];
  /** Strukturované UI podklady; `errors` zůstává kvůli starším volajícím. */
  issues?: CopyGroupValidationIssue[];
}

export type CopyGroupValidationIssueCode =
  | 'group-name-required'
  | 'leader-required'
  | 'leader-unavailable'
  | 'followers-required'
  | 'follower-unavailable'
  | 'leader-is-follower'
  | 'duplicate-follower'
  | 'invalid-multiplier'
  | 'invalid-max-contracts'
  | 'invalid-daily-loss-cut'
  | 'invalid-cut-action'
  | 'invalid-safety';

export interface CopyGroupValidationIssue {
  code: CopyGroupValidationIssueCode;
  accountId?: number;
  message: string;
}

export interface CopyGroupUnavailableAccounts {
  leaderAccountId: number | null;
  followerAccountIds: number[];
}

/**
 * Vrátí členy uložené skupiny, které v aktuálním autoritativním OAuth
 * snapshotu vůbec nejsou. Snapshot může být během refresh krátce neúplný,
 * proto tahle funkce topologii sama nemění — jen ji zpřístupní UI a ARM bráně.
 */
export function unavailableCopyGroupAccounts(
  group: CopyGroupConfig,
  availableAccountIds: Iterable<number>,
): CopyGroupUnavailableAccounts {
  const available = new Set(availableAccountIds);
  return {
    leaderAccountId: group.leaderAccountId != null && !available.has(group.leaderAccountId)
      ? group.leaderAccountId
      : null,
    followerAccountIds: group.followers
      .filter(follower => !available.has(follower.accountId))
      .map(follower => follower.accountId),
  };
}

/**
 * Ruční oprava stale follower ID. Nikdy nehádá náhradu podle názvu nebo
 * podobného čísla; nové ID musí uživatel vybrat z aktuálního OAuth snapshotu.
 * Režim replikace zůstane zachovaný, ale účetní risk parametry se resetují.
 * Multiplier a maxContracts patří konkrétnímu účtu; jejich tichý přenos na
 * jinou identitu je nebezpečnější než vyžádat jejich nové ruční nastavení v UI.
 */
export function replaceCopyGroupFollowerAccount(
  group: CopyGroupConfig,
  staleAccountId: number,
  replacementAccountId: number,
): CopyGroupConfig {
  if (staleAccountId === replacementAccountId) return group;
  if (replacementAccountId === group.leaderAccountId) return group;
  if (group.followers.some(follower => follower.accountId === replacementAccountId)) return group;
  if (!group.followers.some(follower => follower.accountId === staleAccountId)) return group;
  return {
    ...group,
    followers: group.followers.map(follower => follower.accountId === staleAccountId
      ? { accountId: replacementAccountId, mode: follower.mode, multiplier: 1 }
      : follower),
  };
}

export function copyGroupsFromSnapshot(snapshot: LiveSnapshot): CopyGroupConfig[] {
  return snapshot.groups.map(group => ({
    id: group.id,
    name: group.name,
    enabled: group.followers.some(follower => follower.replicate),
    leaderAccountId: group.leaderAccountId,
    followers: group.followers.map(follower => ({
      accountId: follower.accountId,
      mode: follower.replicate ? 'on-submit' : 'off',
      multiplier: normalizeMultiplier(follower.scale),
    })),
    safety: { ...DEFAULT_COPY_GROUP_SAFETY },
  }));
}

/**
 * Refresh živých hodnot nesmí zahodit rozepsanou lokální konfiguraci. Nové
 * skupiny ze serveru se přidají, existující UI konfigurace zůstane zachovaná.
 */
export function mergeCopyGroups(
  current: CopyGroupConfig[],
  snapshot: LiveSnapshot,
): CopyGroupConfig[] {
  const remote = copyGroupsFromSnapshot(snapshot);
  const currentById = new Map(current.map(group => [group.id, group]));
  const merged = remote.map(group => currentById.get(group.id) ?? group);
  for (const group of current) {
    if (group.localOnly && !merged.some(candidate => candidate.id === group.id)) merged.push(group);
  }
  return merged;
}

const copyGroupAccountKey = (group: CopyGroupConfig): string => {
  const leader = Number.isSafeInteger(group.leaderAccountId) ? Number(group.leaderAccountId) : 0;
  const followers = group.followers.map(item => item.accountId).sort((a, b) => a - b);
  return `${leader}:${followers.join(',')}`;
};

/**
 * Běžící execution runtime je autoritativní pro topologii a násobky skupiny.
 * Aktuální broker snapshot může být dočasně neúplný, proto dostupnost účtu
 * nesmí měnit topologii runtime ani mazat lokální skupiny. Zachováme její
 * uživatelský název/vzhled podle stabilního id (nebo přesné shody účtů).
 */
export function adoptRuntimeCopyGroup(
  current: CopyGroupConfig[],
  availableAccountIds: Iterable<number>,
  runtimeGroup: CopyGroupConfig,
): CopyGroupConfig[] {
  const available = new Set(availableAccountIds);
  const runtimeIds = [runtimeGroup.leaderAccountId, ...runtimeGroup.followers.map(item => item.accountId)];
  if (runtimeIds.some(accountId => !Number.isSafeInteger(accountId))) {
    return current;
  }

  const runtimeKey = copyGroupAccountKey(runtimeGroup);
  const sameId = current.find(group => group.id === runtimeGroup.id);
  const exactTopology = current.filter(group => copyGroupAccountKey(group) === runtimeKey);
  // Překrývající uložené šablony jsou povolené. Bez shody stabilního ID
  // proto topologii adoptujeme jen tehdy, když je kandidát právě jeden.
  const matching = sameId ?? (exactTopology.length === 1 ? exactTopology[0] : undefined);
  // Skupiny žijí v localStorage, tedy zvlášť na každém zařízení, zatímco
  // worker je sdílený. Shoda id znamená, že worker tuhle skupinu zná
  // z posledního uložení — jeho název je pak čerstvější a přejmenování
  // z jiného zařízení se musí propsat. Spárování jen podle složení účtů
  // je naopak uživatelova lokální skupina, kde by generický název workeru
  // („Lokální DEMO agent") přepsal jeho vlastní.
  const matchedById = matching != null && matching.id === runtimeGroup.id;
  const preferLocal = matching != null && !matchedById;
  const authoritative: CopyGroupConfig = {
    ...runtimeGroup,
    ...(matching?.name && (preferLocal || !runtimeGroup.name) ? { name: matching.name } : {}),
    ...(matching?.color && (preferLocal || !runtimeGroup.color) ? { color: matching.color } : {}),
    ...(matching?.safety && (preferLocal || !runtimeGroup.safety) ? { safety: matching.safety } : {}),
  };
  const retained = current.filter(group => {
    if (group.id === authoritative.id || group === matching) return false;
    if (!group.localOnly) return true;
    const ids = [group.leaderAccountId, ...group.followers.map(item => item.accountId)];
    return ids.every(accountId => Number.isSafeInteger(accountId) && available.has(Number(accountId)));
  });
  const next = [authoritative, ...retained];
  return JSON.stringify(next) === JSON.stringify(current) ? current : next;
}

export function validateCopyGroup(
  group: CopyGroupConfig,
  availableAccountIds: Iterable<number>,
): CopyGroupValidation {
  const available = new Set(availableAccountIds);
  const issues: CopyGroupValidationIssue[] = [];
  const add = (issue: CopyGroupValidationIssue) => issues.push(issue);
  if (!group.name.trim()) add({ code: 'group-name-required', message: 'Zadej název skupiny.' });
  if (group.leaderAccountId == null) add({ code: 'leader-required', message: 'Vyber leader účet.' });
  else if (!available.has(group.leaderAccountId)) {
    add({
      code: 'leader-unavailable',
      accountId: group.leaderAccountId,
      message: 'Vybraný leader účet není dostupný.',
    });
  }
  if (group.followers.length === 0) add({ code: 'followers-required', message: 'Vyber alespoň jeden follower účet.' });
  const seen = new Set<number>();
  for (const follower of group.followers) {
    if (!available.has(follower.accountId)) {
      add({
        code: 'follower-unavailable',
        accountId: follower.accountId,
        message: `Follower účet ${follower.accountId} není dostupný.`,
      });
    }
    if (follower.accountId === group.leaderAccountId) {
      add({ code: 'leader-is-follower', accountId: follower.accountId, message: 'Leader nemůže být zároveň follower.' });
    }
    if (seen.has(follower.accountId)) {
      add({ code: 'duplicate-follower', accountId: follower.accountId, message: 'Follower účet je ve skupině vícekrát.' });
    }
    seen.add(follower.accountId);
    if (!Number.isFinite(follower.multiplier) || follower.multiplier <= 0 || follower.multiplier > 100) {
      add({ code: 'invalid-multiplier', accountId: follower.accountId, message: 'Multiplier musí být větší než 0 a nejvýše 100.' });
    }
    if (follower.maxContracts != null
      && (!Number.isSafeInteger(follower.maxContracts) || follower.maxContracts < 1)) {
      add({ code: 'invalid-max-contracts', accountId: follower.accountId, message: 'Max kontrakty musí být celé číslo alespoň 1.' });
    }
    if (follower.dailyLossCutUsd != null && follower.dailyLossCutUsd !== 0 && !validDailyLossCut(follower.dailyLossCutUsd)) {
      add({ code: 'invalid-daily-loss-cut', accountId: follower.accountId, message: '„Max ztráta“ musí být od 0,01 do 1 000 000 USD a mít nejvýše 2 desetinná místa.' });
    }
    if (follower.onCut != null && !validFollowerCutAction(follower.onCut)) {
      add({ code: 'invalid-cut-action', accountId: follower.accountId, message: 'Akce při vyřazení musí být „zavřít kopii" nebo „nechat dojet".' });
    }
  }
  if (sanitizeSafety(group.safety) == null) {
    add({ code: 'invalid-safety', message: 'Pravidla dne obsahují neplatnou hodnotu.' });
  }
  const uniqueIssues = issues.filter((issue, index) => issues.findIndex(candidate => (
    candidate.code === issue.code
    && candidate.accountId === issue.accountId
    && candidate.message === issue.message
  )) === index);
  const errors = [...new Set(uniqueIssues.map(issue => issue.message))];
  return { valid: errors.length === 0, errors, issues: uniqueIssues };
}

/** UI text odvozený ze struktury; doménové legacy `errors` nijak nepřepisuje. */
export function copyGroupValidationMessages(
  validation: CopyGroupValidation,
  accountLabel: (accountId: number) => string,
): string[] {
  if (!validation.issues) return validation.errors;
  return validation.issues.map(issue => {
    if (issue.code === 'leader-unavailable' && issue.accountId != null) {
      const label = accountLabel(issue.accountId);
      return label === `Účet ${issue.accountId}`
        ? `Vybraný leader ${label} není dostupný.`
        : `Vybraný leader účet ${label} není dostupný.`;
    }
    if (issue.code === 'follower-unavailable' && issue.accountId != null) {
      const label = accountLabel(issue.accountId);
      return label === `Účet ${issue.accountId}`
        ? `Follower ${label} není dostupný.`
        : `Follower účet ${label} není dostupný.`;
    }
    return issue.message;
  }).filter((message, index, messages) => messages.indexOf(message) === index);
}

/**
 * Ověří durable skupinu při startu lokálního execution runtime.
 *
 * Účet, který zmizel z aktuálního OAuth snapshotu, běžně znamená chybnou
 * topologii a worker musí fail-closed skončit. Jediná výjimka je follower,
 * kterého durable eligibility už před restartem označila jako neaktivního
 * (DLL/BREACHED/unverifiable). Takový účet runtime stejně nesmí dispatchovat,
 * ale worker musí naběhnout DISARMED, aby ho uživatel mohl z UI bezpečně
 * odebrat. Leader zůstává povinný vždy.
 */
export function validateStoredCopyGroupForStartup(
  group: CopyGroupConfig,
  accounts: ReadonlyArray<{ id: number; active: boolean; canTrade: boolean }>,
  eligibility: ReadonlyArray<{ accountId: number; state: string }>,
): CopyGroupValidation {
  const available = new Set(accounts.map(account => account.id));
  const knownIneligibleFollowers = new Set(
    eligibility
      .filter(entry => entry.state !== 'active')
      .map(entry => entry.accountId)
      .filter(accountId => group.followers.some(follower => follower.accountId === accountId)),
  );
  const validation = validateCopyGroup(group, [
    ...available,
    ...knownIneligibleFollowers,
  ]);
  const errors = [...validation.errors];
  for (const accountId of [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)]) {
    if (accountId == null) continue;
    const isLeader = accountId === group.leaderAccountId;
    if (!isLeader && knownIneligibleFollowers.has(accountId)) continue;
    const account = accounts.find(candidate => candidate.id === accountId);
    if (account && (!account.active || !account.canTrade)) {
      errors.push(`Účet ${accountId} z uložené copy group není aktivní pro execution.`);
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function normalizeMultiplier(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(100, Math.max(0.01, Math.round(value * 100) / 100));
}

export function sanitizeCopyGroups(value: unknown): CopyGroupConfig[] | null {
  if (!Array.isArray(value)) return null;
  const groups: CopyGroupConfig[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null;
    const raw = candidate as Partial<CopyGroupConfig>;
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.enabled !== 'boolean') return null;
    if (raw.leaderAccountId !== null && typeof raw.leaderAccountId !== 'number') return null;
    if (!Array.isArray(raw.followers)) return null;
    const followers: CopyFollowerConfig[] = [];
    for (const followerCandidate of raw.followers) {
      if (!followerCandidate || typeof followerCandidate !== 'object') return null;
      const follower = followerCandidate as Partial<CopyFollowerConfig>;
      if (typeof follower.accountId !== 'number') return null;
      if (follower.mode !== 'off' && follower.mode !== 'on-submit' && follower.mode !== 'on-fill') return null;
      if (typeof follower.multiplier !== 'number') return null;
      const maxContracts = follower.maxContracts;
      if (maxContracts != null && (!Number.isSafeInteger(maxContracts) || maxContracts < 1)) return null;
      const dailyLossCutUsd = follower.dailyLossCutUsd;
      if (dailyLossCutUsd != null && dailyLossCutUsd !== 0 && !validDailyLossCut(dailyLossCutUsd)) return null;
      const onCut = follower.onCut;
      if (onCut != null && !validFollowerCutAction(onCut)) return null;
      followers.push({
        accountId: follower.accountId,
        mode: follower.mode,
        multiplier: normalizeMultiplier(follower.multiplier),
        ...(maxContracts != null ? { maxContracts } : {}),
        ...(dailyLossCutUsd != null && dailyLossCutUsd !== 0 ? { dailyLossCutUsd: Math.round(dailyLossCutUsd * 100) / 100 } : {}),
        ...(onCut != null ? { onCut } : {}),
      });
    }
    const safety = sanitizeSafety(raw.safety);
    if (!safety) return null;
    groups.push({
      id: raw.id,
      name: raw.name,
      enabled: raw.enabled,
      leaderAccountId: raw.leaderAccountId,
      followers,
      ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
      safety,
      ...(raw.localOnly === true ? { localOnly: true } : {}),
    });
  }
  return groups;
}

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const validTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
};

const minutesOfDay = (value: string): number => {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};

/**
 * Safety parser used by local storage, relay and worker boundaries.
 * Missing fields are legacy and receive defaults. Present malformed new
 * fields are rejected instead of silently disabling a safety rule.
 */
export function sanitizeCopyGroupSafety(value: unknown): CopyGroupSafetySettings | null {
  if (value == null) {
    return {
      ...DEFAULT_COPY_GROUP_SAFETY,
      tradingWindow: { ...DEFAULT_COPY_GROUP_SAFETY.tradingWindow },
      dayRuleActions: cloneDayRuleActions(DEFAULT_DAY_RULE_ACTIONS),
    };
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<CopyGroupSafetySettings>;
  const dayRuleActions = sanitizeDayRuleActions(raw.dayRuleActions);
  if (!dayRuleActions) return null;
  const dailyMaxTrades = raw.dailyMaxTrades == null
    ? DEFAULT_COPY_GROUP_SAFETY.dailyMaxTrades
    : raw.dailyMaxTrades;
  if (!Number.isSafeInteger(dailyMaxTrades) || dailyMaxTrades < 0 || dailyMaxTrades > 200) {
    return null;
  }
  const windowRaw = raw.tradingWindow;
  let tradingWindow: CopyGroupTradingWindow;
  if (windowRaw == null) {
    tradingWindow = { ...DEFAULT_COPY_GROUP_SAFETY.tradingWindow };
  } else {
    if (typeof windowRaw !== 'object' || Array.isArray(windowRaw)) return null;
    const candidate = windowRaw as Partial<CopyGroupTradingWindow>;
    if (
      typeof candidate.enabled !== 'boolean'
      || typeof candidate.from !== 'string'
      || typeof candidate.to !== 'string'
      || typeof candidate.timeZone !== 'string'
      || !HH_MM.test(candidate.from)
      || !HH_MM.test(candidate.to)
      || minutesOfDay(candidate.from) >= minutesOfDay(candidate.to)
      || !validTimeZone(candidate.timeZone)
    ) return null;
    let additional: CopyGroupTradingWindowSlot[] | undefined;
    if (candidate.additional !== undefined) {
      if (!Array.isArray(candidate.additional)) return null;
      const slots: CopyGroupTradingWindowSlot[] = [];
      for (const raw of candidate.additional) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const slot = raw as Partial<CopyGroupTradingWindowSlot>;
        if (typeof slot.from !== 'string' || typeof slot.to !== 'string') return null;
        slots.push({ from: slot.from, to: slot.to });
      }
      if (!tradingWindowSlotsValid([{ from: candidate.from, to: candidate.to }, ...slots])) return null;
      additional = slots.length > 0
        ? slots.sort((a, b) => minutesOfDay(a.from) - minutesOfDay(b.from))
        : undefined;
    }
    tradingWindow = {
      enabled: candidate.enabled,
      from: candidate.from,
      to: candidate.to,
      timeZone: candidate.timeZone,
      ...(additional ? { additional } : {}),
    };
  }
  return {
    positionReconciler: typeof raw.positionReconciler === 'boolean' ? raw.positionReconciler : DEFAULT_COPY_GROUP_SAFETY.positionReconciler,
    // Migruj i dříve uložené skupiny s nebezpečným `false`. Dokud nemáme
    // explicitně schválený isolate-account režim, divergence vždy fail-closes.
    disableReplicationOnBreach: true,
    autoCloseFollowerPositions: typeof raw.autoCloseFollowerPositions === 'boolean' ? raw.autoCloseFollowerPositions : DEFAULT_COPY_GROUP_SAFETY.autoCloseFollowerPositions,
    preventHedging: typeof raw.preventHedging === 'boolean' ? raw.preventHedging : DEFAULT_COPY_GROUP_SAFETY.preventHedging,
    entryCooldownMinutes:
      typeof raw.entryCooldownMinutes === 'number'
        && Number.isFinite(raw.entryCooldownMinutes)
        && raw.entryCooldownMinutes >= 0
        ? Math.min(720, Math.floor(raw.entryCooldownMinutes))
        : DEFAULT_COPY_GROUP_SAFETY.entryCooldownMinutes,
    armExpiryFlatten:
      raw.armExpiryFlatten === 'off' || raw.armExpiryFlatten === 'followers' || raw.armExpiryFlatten === 'group'
        ? raw.armExpiryFlatten
        : DEFAULT_COPY_GROUP_SAFETY.armExpiryFlatten,
    dailyLossLimitUsd:
      typeof raw.dailyLossLimitUsd === 'number'
        && Number.isFinite(raw.dailyLossLimitUsd)
        && raw.dailyLossLimitUsd >= 0
        ? Math.min(1_000_000, Math.round(raw.dailyLossLimitUsd * 100) / 100)
        : DEFAULT_COPY_GROUP_SAFETY.dailyLossLimitUsd,
    dailyMaxLosingTrades:
      typeof raw.dailyMaxLosingTrades === 'number'
        && Number.isSafeInteger(raw.dailyMaxLosingTrades)
        && raw.dailyMaxLosingTrades >= 0
        ? Math.min(50, raw.dailyMaxLosingTrades)
        : DEFAULT_COPY_GROUP_SAFETY.dailyMaxLosingTrades,
    dailyMaxTrades,
    tradingWindow,
    dayRuleActions,
  };
}

/** Sdílená validace follower limitů (UI, store, relay, worker). */
export const validDailyLossCut = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= 0.01
  && value <= 1_000_000
  && Math.abs((value * 100) - Math.round(value * 100)) < 1e-9
);
export const validFollowerCutAction = (value: unknown): value is CopyFollowerCutAction => (
  value === 'close-copy' || value === 'let-run'
);

function sanitizeSafety(value: unknown): CopyGroupSafetySettings | null {
  return sanitizeCopyGroupSafety(value);
}

export function createLocalCopyGroupId(now = Date.now()): string {
  return `local-${now}`;
}

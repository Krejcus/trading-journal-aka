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
}

/**
 * Co udělat s otevřenými kopiemi, když copier přestane kopírovat —
 * expirací ostrého ARM (konec broker session) NEBO fail-closed chybou za
 * živého ARM. `followers` zavře jen kopie — leader je ruka uživatele a
 * zůstává jeho; `group` zavře i leadera. Zavření je čistě risk-redukující:
 * ruší working příkazy a market-close k nule, nikdy nezvětší |pozici| ani
 * neotočí směr.
 */
export type ArmExpiryFlattenScope = 'off' | 'followers' | 'group';

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
  | 'invalid-max-contracts';

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
      followers.push({
        accountId: follower.accountId,
        mode: follower.mode,
        multiplier: normalizeMultiplier(follower.multiplier),
        ...(maxContracts != null ? { maxContracts } : {}),
      });
    }
    groups.push({
      id: raw.id,
      name: raw.name,
      enabled: raw.enabled,
      leaderAccountId: raw.leaderAccountId,
      followers,
      ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
      safety: sanitizeSafety(raw.safety),
      ...(raw.localOnly === true ? { localOnly: true } : {}),
    });
  }
  return groups;
}

function sanitizeSafety(value: unknown): CopyGroupSafetySettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_COPY_GROUP_SAFETY };
  const raw = value as Partial<CopyGroupSafetySettings>;
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
  };
}

export function createLocalCopyGroupId(now = Date.now()): string {
  return `local-${now}`;
}

import type { LiveSnapshot } from './tradecopiaLiveService';

export type CopyReplicationMode = 'off' | 'on-submit' | 'on-fill';

export interface CopyFollowerConfig {
  accountId: number;
  mode: CopyReplicationMode;
  multiplier: number;
  /**
   * Tvrdý strop kontraktů na jednu follower objednávku (prop risk limit).
   * Multiplier škáluje, strop řeže. Bez hodnoty se nic neomezuje.
   */
  maxContracts?: number;
}

export interface CopyGroupSafetySettings {
  positionReconciler: boolean;
  disableReplicationOnBreach: boolean;
  autoCloseFollowerPositions: boolean;
  preventHedging: boolean;
}

export const DEFAULT_COPY_GROUP_SAFETY: CopyGroupSafetySettings = {
  positionReconciler: true,
  // Divergence nikdy nesmí být jen informační. Bezpečný výchozí stav je
  // zastavit další replikaci; runtime navíc používá policy `halt-group`.
  disableReplicationOnBreach: true,
  autoCloseFollowerPositions: true,
  preventHedging: true,
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
  | { type: 'update-group'; group: CopyGroupConfig }
  | { type: 'delete-group'; groupId: string }
  | { type: 'set-group-enabled'; groupId: string; enabled: boolean }
  | { type: 'set-replication'; groupId: string; accountId: number; mode: CopyReplicationMode }
  | { type: 'set-multiplier'; groupId: string; accountId: number; multiplier: number }
  | { type: 'flatten-account'; groupId: string; accountId: number; operationId: string }
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

export function validateCopyGroup(
  group: CopyGroupConfig,
  availableAccountIds: Iterable<number>,
): CopyGroupValidation {
  const available = new Set(availableAccountIds);
  const errors: string[] = [];
  if (!group.name.trim()) errors.push('Zadej název skupiny.');
  if (group.leaderAccountId == null) errors.push('Vyber leader účet.');
  else if (!available.has(group.leaderAccountId)) errors.push('Vybraný leader účet není dostupný.');
  if (group.followers.length === 0) errors.push('Vyber alespoň jeden follower účet.');
  const seen = new Set<number>();
  for (const follower of group.followers) {
    if (!available.has(follower.accountId)) errors.push(`Follower účet ${follower.accountId} není dostupný.`);
    if (follower.accountId === group.leaderAccountId) errors.push('Leader nemůže být zároveň follower.');
    if (seen.has(follower.accountId)) errors.push('Follower účet je ve skupině vícekrát.');
    seen.add(follower.accountId);
    if (!Number.isFinite(follower.multiplier) || follower.multiplier <= 0 || follower.multiplier > 100) {
      errors.push('Multiplier musí být větší než 0 a nejvýše 100.');
    }
    if (follower.maxContracts != null
      && (!Number.isSafeInteger(follower.maxContracts) || follower.maxContracts < 1)) {
      errors.push('Max kontrakty musí být celé číslo alespoň 1.');
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
  };
}

export function createLocalCopyGroupId(now = Date.now()): string {
  return `local-${now}`;
}

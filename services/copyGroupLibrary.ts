import {
  DEFAULT_COPY_GROUP_SAFETY,
  sanitizeCopyGroups,
  type CopyGroupConfig,
} from './liveCopyTrading';
import { supabase } from './supabase';

export const LEGACY_COPY_GROUPS_STORAGE_KEY = 'alphatrade_live_copytrade_draft_groups';
const COPY_GROUPS_CACHE_PREFIX = 'alphatrade:copy-groups:v1:';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface CopyGroupRow {
  group_id: string;
  config: unknown;
  updated_at: string;
}

export interface CopyGroupLibrarySnapshot {
  groups: CopyGroupConfig[];
  needsLegacyImport: boolean;
  source: 'cloud' | 'cache' | 'empty';
}

const cacheKey = (userId: string) => `${COPY_GROUPS_CACHE_PREFIX}${userId}`;
const COPY_GROUP_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const isValidAccountId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const isValidStoredGroup = (group: CopyGroupConfig): boolean => {
  if (!COPY_GROUP_ID_PATTERN.test(group.id) || group.id.length > 120) return false;
  if (!group.name.trim() || group.name.length > 120 || group.followers.length > 100) return false;
  if (group.leaderAccountId != null && !isValidAccountId(group.leaderAccountId)) return false;
  const accountIds = new Set<number>();
  for (const follower of group.followers) {
    if (!isValidAccountId(follower.accountId) || follower.accountId === group.leaderAccountId) return false;
    if (accountIds.has(follower.accountId)) return false;
    accountIds.add(follower.accountId);
    if (!Number.isFinite(follower.multiplier)) return false;
  }
  return new TextEncoder().encode(JSON.stringify(group)).byteLength <= 65_536;
};

export const copyGroupForStorage = (group: CopyGroupConfig): CopyGroupConfig => {
  const { localOnly: _localOnly, ...stored } = group;
  return {
    ...stored,
    enabled: false,
    followers: stored.followers.map(follower => ({ ...follower })),
    safety: { ...(stored.safety ?? DEFAULT_COPY_GROUP_SAFETY) },
  };
};

const sanitizeStoredGroups = (value: unknown): CopyGroupConfig[] | null => {
  const sanitized = sanitizeCopyGroups(value);
  return sanitized?.map(copyGroupForStorage) ?? null;
};

const asCachedGroups = (groups: readonly CopyGroupConfig[]): CopyGroupConfig[] => groups.map(group => ({
  ...copyGroupForStorage(group),
  // Uložený profil nesmí zmizet jen proto, že právě není v execution snapshotu.
  localOnly: true,
}));

const readGroups = (storage: StorageLike | undefined, key: string): CopyGroupConfig[] | null => {
  if (!storage) return null;
  try {
    return sanitizeStoredGroups(JSON.parse(storage.getItem(key) ?? 'null'));
  } catch {
    return null;
  }
};

export const readCopyGroupCache = (
  userId: string,
  fallback: readonly CopyGroupConfig[],
  storage: StorageLike | undefined = typeof window === 'undefined' ? undefined : window.localStorage,
): CopyGroupConfig[] => {
  const cached = readGroups(storage, cacheKey(userId))
    ?? readGroups(storage, LEGACY_COPY_GROUPS_STORAGE_KEY);
  return cached ? asCachedGroups(cached) : fallback.map(copyGroupForStorage);
};

export const writeCopyGroupCache = (
  userId: string,
  groups: readonly CopyGroupConfig[],
  storage: StorageLike | undefined = typeof window === 'undefined' ? undefined : window.localStorage,
): void => {
  if (!userId || !storage) return;
  try {
    storage.setItem(cacheKey(userId), JSON.stringify(groups.map(copyGroupForStorage)));
  } catch {
    // Cache is optional. Supabase remains authoritative.
  }
};

const groupsFromRows = (rows: readonly CopyGroupRow[]): CopyGroupConfig[] => {
  const groups = rows.flatMap(row => {
    const sanitized = sanitizeStoredGroups([row.config]);
    if (!sanitized || sanitized.length !== 1 || sanitized[0].id !== row.group_id) return [];
    return asCachedGroups(sanitized);
  });
  if (groups.length !== rows.length) throw new Error('Cloudová knihovna obsahuje neplatnou copy group.');
  return groups;
};

export async function loadCopyGroupLibrary(
  userId: string,
  fallback: readonly CopyGroupConfig[],
): Promise<CopyGroupLibrarySnapshot> {
  if (!userId) return { groups: fallback.map(copyGroupForStorage), needsLegacyImport: false, source: 'empty' };
  const cached = readCopyGroupCache(userId, fallback);
  const { data, error } = await supabase
    .from('copy_groups')
    .select('group_id,config,updated_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Copy groups se nepodařilo načíst: ${error.message}`);
  const groups = groupsFromRows((data ?? []) as CopyGroupRow[]);
  if (groups.length > 0) {
    writeCopyGroupCache(userId, groups);
    return { groups, needsLegacyImport: false, source: 'cloud' };
  }
  if (cached.length > 0) return { groups: cached, needsLegacyImport: true, source: 'cache' };
  writeCopyGroupCache(userId, []);
  return { groups: [], needsLegacyImport: false, source: 'empty' };
}

export async function saveCopyGroup(userId: string, group: CopyGroupConfig): Promise<CopyGroupConfig> {
  if (!userId) throw new Error('Pro uložení copy group chybí přihlášený uživatel.');
  const stored = copyGroupForStorage(group);
  const sanitized = sanitizeStoredGroups([stored]);
  if (!sanitized || sanitized.length !== 1 || !isValidStoredGroup(sanitized[0])) {
    throw new Error('Copy group má neplatnou konfiguraci.');
  }
  const normalized = sanitized[0];
  const { data, error } = await supabase
    .from('copy_groups')
    .upsert({
      user_id: userId,
      group_id: normalized.id,
      config: normalized,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,group_id' })
    .select('group_id,config,updated_at')
    .single();
  if (error) throw new Error(`Copy group se nepodařilo uložit: ${error.message}`);
  return groupsFromRows([data as CopyGroupRow])[0];
}

export async function importCopyGroups(userId: string, groups: readonly CopyGroupConfig[]): Promise<CopyGroupConfig[]> {
  if (groups.length === 0) return [];
  const saved: CopyGroupConfig[] = [];
  // Sekvenční zápis je jednorázový a udržuje přesnou chybu konkrétní skupiny;
  // běžné následné úpravy zapisují vždy jen jeden řádek.
  for (const group of groups) saved.push(await saveCopyGroup(userId, group));
  writeCopyGroupCache(userId, saved);
  return saved;
}

export async function deleteCopyGroup(userId: string, groupId: string): Promise<void> {
  if (!userId) throw new Error('Pro smazání copy group chybí přihlášený uživatel.');
  const { error } = await supabase
    .from('copy_groups')
    .delete()
    .eq('user_id', userId)
    .eq('group_id', groupId);
  if (error) throw new Error(`Copy group se nepodařilo smazat: ${error.message}`);
}

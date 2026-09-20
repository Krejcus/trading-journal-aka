/** Presentation only. A restored value must never authorize a copier command. */
export interface CopierPowerDisplay { connected: boolean; confirmedAt: number }
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const COPIER_POWER_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
export const COPIER_POWER_WARNING_DELAY_MS = 8_000;
export const copierPowerDisplayKey = (userId: string, groupId: string) =>
  userId && groupId ? `alphatrade_copier-power-display_v1:${encodeURIComponent(userId)}:${encodeURIComponent(groupId)}` : '';
function localStorageSafe(): StorageLike | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}
export function readCopierPowerDisplay(key: string, storage = localStorageSafe(), now = Date.now()): CopierPowerDisplay | null {
  if (!key || !storage) return null;
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    return value && typeof value.connected === 'boolean' && Number.isFinite(value.confirmedAt)
      && value.confirmedAt <= now && now - value.confirmedAt <= COPIER_POWER_CACHE_MAX_AGE_MS
      ? { connected: value.connected, confirmedAt: value.confirmedAt } : null;
  } catch { return null; }
}
export function writeCopierPowerDisplay(key: string, connected: boolean, storage = localStorageSafe(), now = Date.now()): void {
  if (!key || !storage) return;
  try {
    const previous = readCopierPowerDisplay(key, storage, now);
    if (previous?.connected === connected && now - previous.confirmedAt < 60_000) return;
    storage.setItem(key, JSON.stringify({ connected, confirmedAt: now }));
  } catch { /* Private mode: the mounted view still retains its last confirmation. */ }
}

import type { LiveAccount } from '../services/tradecopiaLiveService';

export const LIVE_READ_MAX_AGE_MS = 45_000;
export const verifiedReadAvailability = (availability: string | undefined) =>
  availability === 'available' || availability === 'empty';

export function isLiveAccountReadVerified(account: LiveAccount, source: 'positions' | 'orders' | 'cash', now = Date.now()): boolean {
  const availability = account[`${source}Availability`];
  // Legacy shadow accounts do not carry the OAuth read-state contract.
  if (availability == null) return true;
  const capturedAt = Date.parse(account[`${source}UpdatedAt`] ?? '');
  return verifiedReadAvailability(availability)
    && Number.isFinite(capturedAt)
    && capturedAt <= now + 1_000
    && now - capturedAt <= LIVE_READ_MAX_AGE_MS;
}

/** Older than this, the last known read is shown with an explicit age instead of silently. */
export const LIVE_READ_STALE_MS = 120_000;

/** Age of the last usable read in ms; null when the read is unavailable or has no timestamp. */
export function liveAccountReadAgeMs(account: LiveAccount, source: 'positions' | 'orders' | 'cash', now = Date.now()): number | null {
  const availability = account[`${source}Availability`];
  if (availability == null) return 0;
  if (!verifiedReadAvailability(availability)) return null;
  const capturedAt = Date.parse(account[`${source}UpdatedAt`] ?? '');
  if (!Number.isFinite(capturedAt) || capturedAt > now + 1_000) return null;
  return Math.max(0, now - capturedAt);
}

/**
 * Last known values stay on screen; only a read older than LIVE_READ_STALE_MS
 * (or an unavailable one) is labelled. A fresh poll normally replaces the
 * data within a second of the app coming back to the foreground.
 */
export function liveReadStaleLabel(account: LiveAccount, source: 'positions' | 'orders' | 'cash', now = Date.now()): string | null {
  if (isLiveAccountReadVerified(account, source, now)) return null;
  const ageMs = liveAccountReadAgeMs(account, source, now);
  if (ageMs == null) return 'nedostupné';
  if (ageMs <= LIVE_READ_STALE_MS) return null;
  return `před ${formatReadAge(ageMs)}`;
}

export function formatReadAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1_000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

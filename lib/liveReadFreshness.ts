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

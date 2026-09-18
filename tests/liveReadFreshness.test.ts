import { describe, expect, it } from 'vitest';
import { formatReadAge, isLiveAccountReadVerified, liveAccountReadAgeMs, liveReadStaleLabel } from '../lib/liveReadFreshness';
import type { LiveAccount } from '../services/tradecopiaLiveService';

const NOW = Date.UTC(2026, 8, 18, 6, 0, 0);
const account = (extras: Partial<LiveAccount>): LiveAccount => ({ id: 1, name: 'A', positions: [], ...extras } as unknown as LiveAccount);
const readAt = (ageMs: number) => new Date(NOW - ageMs).toISOString();

describe('live read freshness: last known values stay visible', () => {
  it('a read younger than 45 s is verified and carries no label', () => {
    const a = account({ positionsAvailability: 'available', positionsUpdatedAt: readAt(10_000) });
    expect(isLiveAccountReadVerified(a, 'positions', NOW)).toBe(true);
    expect(liveAccountReadAgeMs(a, 'positions', NOW)).toBe(10_000);
    expect(liveReadStaleLabel(a, 'positions', NOW)).toBeNull();
  });
  it('between 45 s and 2 min the value is not verified but still shows without a label', () => {
    const a = account({ positionsAvailability: 'available', positionsUpdatedAt: readAt(70_000) });
    expect(isLiveAccountReadVerified(a, 'positions', NOW)).toBe(false);
    expect(liveReadStaleLabel(a, 'positions', NOW)).toBeNull();
  });
  it('after 2 min the last known value is labelled with its age', () => {
    const a = account({ positionsAvailability: 'empty', positionsUpdatedAt: readAt(3 * 60_000 + 5_000) });
    expect(liveReadStaleLabel(a, 'positions', NOW)).toBe('před 3 min');
    expect(liveReadStaleLabel(account({ ordersAvailability: 'available', ordersUpdatedAt: readAt(2 * 3_600_000 + 60_000) }), 'orders', NOW)).toBe('před 2 h 1 min');
  });
  it('an unavailable or denied read is labelled as such, never as a number', () => {
    expect(liveReadStaleLabel(account({ positionsAvailability: 'denied', positionsUpdatedAt: readAt(1_000) }), 'positions', NOW)).toBe('nedostupné');
    expect(liveReadStaleLabel(account({ positionsAvailability: 'available', positionsUpdatedAt: null }), 'positions', NOW)).toBe('nedostupné');
    expect(liveReadStaleLabel(account({ positionsAvailability: 'available', positionsUpdatedAt: readAt(-5_000) }), 'positions', NOW)).toBe('nedostupné');
  });
  it('legacy accounts without the read-state contract are treated as verified', () => {
    expect(liveReadStaleLabel(account({}), 'positions', NOW)).toBeNull();
    expect(liveAccountReadAgeMs(account({}), 'cash', NOW)).toBe(0);
  });
  it('formats ages compactly', () => {
    expect(formatReadAge(4_400)).toBe('4 s');
    expect(formatReadAge(59_400)).toBe('59 s');
    expect(formatReadAge(61_000)).toBe('1 min');
    expect(formatReadAge(3_600_000)).toBe('1 h 0 min');
  });
});

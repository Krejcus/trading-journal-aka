import { describe, expect, it } from 'vitest';
import { tradovateSharedBaselineRefresh } from '../lib/tradovateSharedBaselineRefresh';
const NOW = Date.UTC(2026, 10, 12, 7);
describe('renewing a shared baseline follows source age, not client mount time', () => {
  it('a new tab receiving nine-minute-old data renews in one minute, not ten more minutes', () => {
    const sourceAt = NOW - 9 * 60_000;
    const plan = tradovateSharedBaselineRefresh({ baselineAsOf: new Date(sourceAt).toISOString(), refreshPending: false }, NOW);
    expect(plan.lastFullSuccessAt).toBe(sourceAt);
    expect(plan.retryAt! - NOW).toBe(65_000);
  });
  it('different clients converge on the same renewal time for the same source', () => {
    const shared = { baselineAsOf: new Date(NOW).toISOString(), refreshPending: false };
    const first = tradovateSharedBaselineRefresh(shared, NOW);
    const second = tradovateSharedBaselineRefresh(shared, NOW + 8 * 60_000);
    expect(second.retryAt).toBe(first.retryAt);
    expect(second.lastFullSuccessAt).toBe(first.lastFullSuccessAt);
  });
  it('an already due source is retried promptly and never schedules a zero-delay loop', () => {
    const result = tradovateSharedBaselineRefresh({ baselineAsOf: new Date(NOW - 11 * 60_000).toISOString(), refreshPending: false }, NOW);
    expect(result.retryAt).toBe(NOW + 1_000);
  });
  it('malformed or future timestamps cannot defer renewal indefinitely', () => {
    for (const baselineAsOf of ['invalid', new Date(NOW + 3_600_000).toISOString()]) {
      const result = tradovateSharedBaselineRefresh({ baselineAsOf, refreshPending: false }, NOW);
      expect(result.retryAt).toBe(NOW + 600_000);
    }
    expect(tradovateSharedBaselineRefresh(undefined, NOW).retryAt).toBeNull();
  });
});

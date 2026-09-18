import { describe, expect, it } from 'vitest';
import { createSessionRenewalPolicy } from '../services/copierSessionRenewalPolicy';

describe('vynucená obnova tokenu po opakovaném sync timeoutu', () => {
  it('čeká na práh sync timeoutů v řadě a pak povolí jednu obnovu', () => {
    const policy = createSessionRenewalPolicy({ threshold: 2, cooldownMs: 5 * 60_000 });
    expect(policy.shouldForceRenewal(1, 1_000)).toBe(false);
    expect(policy.lastForcedAt()).toBeNull();
    expect(policy.shouldForceRenewal(2, 60_000)).toBe(true);
    expect(policy.lastForcedAt()).toBe(60_000);
  });

  it('drží cooldown, aby se obnovy neřetězily, a po jeho uplynutí povolí další', () => {
    const policy = createSessionRenewalPolicy({ threshold: 2, cooldownMs: 5 * 60_000 });
    expect(policy.shouldForceRenewal(2, 0)).toBe(true);
    expect(policy.shouldForceRenewal(3, 60_000)).toBe(false);
    expect(policy.shouldForceRenewal(6, 5 * 60_000 - 1)).toBe(false);
    expect(policy.shouldForceRenewal(7, 5 * 60_000)).toBe(true);
    expect(policy.lastForcedAt()).toBe(5 * 60_000);
  });

  it('ignoruje nesmyslné vstupy a drží minimální práh 1', () => {
    const policy = createSessionRenewalPolicy({ threshold: 0, cooldownMs: 0 });
    expect(policy.shouldForceRenewal(Number.NaN, 0)).toBe(false);
    expect(policy.shouldForceRenewal(0, 0)).toBe(false);
    expect(policy.shouldForceRenewal(1, 0)).toBe(true);
    expect(policy.shouldForceRenewal(2, 0)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { BusinessPayout } from '../types';
import { businessDataFingerprint, mergePayoutImages, stripPayoutImagesForCache } from '../utils/businessPayoutSync';

const payout = (overrides: Partial<BusinessPayout> = {}): BusinessPayout => ({
  id: '11111111-1111-4111-8111-111111111111',
  date: '2026-07-24',
  amount: 833.4,
  grossAmount: 926,
  profitSplitUsed: 90,
  accountId: 'account-a',
  status: 'Received',
  updated_at: '2026-07-24T10:00:00Z',
  ...overrides,
});

describe('business payout cache synchronizace', () => {
  it('pozná změnu accountId i při stejné částce', () => {
    const before = [payout({ accountId: undefined })];
    const after = [payout({ accountId: 'account-a', updated_at: '2026-07-24T10:01:00Z' })];

    expect(businessDataFingerprint(after)).not.toBe(businessDataFingerprint(before));
  });

  it('ignoruje base64 obrázek, ale ne ostatní metadata', () => {
    const withoutImage = [payout({ image: undefined })];
    const withImage = [payout({ image: 'data:image/png;base64,abc' })];

    expect(businessDataFingerprint(withImage)).toBe(businessDataFingerprint(withoutImage));
  });

  it('do localStorage cache uloží metadata, ale ne těžký proof obrázek', () => {
    const cached = stripPayoutImagesForCache([
      payout({ image: 'data:image/png;base64,very-large-proof', notes: 'verified' }),
    ]);

    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      accountId: 'account-a',
      amount: 833.4,
      notes: 'verified',
    });
    expect(cached[0]).not.toHaveProperty('image');
  });

  it('doplní screenshot do kanonických dat bez přepsání accountId z DB', () => {
    const fresh = [payout({ accountId: 'account-fixed', image: undefined })];
    const local = [payout({ accountId: 'stale-account', image: 'data:image/png;base64,proof' })];

    expect(mergePayoutImages(fresh, local)).toEqual([
      payout({ accountId: 'account-fixed', image: 'data:image/png;base64,proof' }),
    ]);
  });

  it('spáruje screenshot nového dočasného záznamu pouze jednou', () => {
    const fresh = [payout({ id: 'db-id' })];
    const local = [payout({ id: 'payout_123', image: 'data:image/png;base64,new-proof' })];

    expect(mergePayoutImages(fresh, local)[0].image).toBe('data:image/png;base64,new-proof');
  });
});

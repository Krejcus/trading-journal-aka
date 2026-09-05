import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
}));

vi.mock('../services/supabase', () => {
  database.from.mockReturnValue({ select: database.select });
  database.select.mockReturnValue({ eq: database.eq });
  return {
    supabase: {
      auth: {
        onAuthStateChange: vi.fn(),
        getSession: async () => ({ data: { session: { user: { id: 'payout-user' } } } }),
      },
      from: database.from,
    },
  };
});

import { storageService } from '../services/storageService';

describe('payout image prefetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.eq.mockReset();
  });

  it('rejects a failed read so callers cannot cache it as an empty success', async () => {
    database.eq.mockResolvedValue({ data: null, error: { message: 'temporary read failure' } });

    await expect(storageService.prefetchPayoutImages()).rejects.toThrow('Failed to fetch payout images');
    expect(database.from).toHaveBeenCalledWith('business_payouts');
    expect(database.select).toHaveBeenCalledWith('id, description');
    expect(database.eq).toHaveBeenCalledWith('user_id', 'payout-user');
  });

  it.each([
    { label: 'no rows', data: [] },
    { label: 'no data', data: null },
  ])('accepts a successful response with $label as an empty result', async ({ data }) => {
    database.eq.mockResolvedValue({ data, error: null });

    await expect(storageService.prefetchPayoutImages()).resolves.toEqual(new Map());
  });

  it('reads again after a failure and returns images from the successful retry', async () => {
    database.eq
      .mockResolvedValueOnce({ data: null, error: { message: 'temporary read failure' } })
      .mockResolvedValueOnce({
        data: [
          { id: 42, description: JSON.stringify({ image: 'data:image/png;base64,cHJvb2Y=' }) },
          { id: 43, description: JSON.stringify({ notes: 'No proof attached' }) },
        ],
        error: null,
      });

    await expect(storageService.prefetchPayoutImages()).rejects.toThrow('Failed to fetch payout images');
    await expect(storageService.prefetchPayoutImages()).resolves.toEqual(
      new Map([['42', 'data:image/png;base64,cHJvb2Y=']]),
    );
    expect(database.from).toHaveBeenCalledTimes(2);
    expect(database.eq).toHaveBeenNthCalledWith(2, 'user_id', 'payout-user');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { dashboardTables, loadDashboardFallback, type DashboardTable } from '../services/dashboardFallback';

describe('complete dashboard fallback', () => {
  it.each(['owner', 'friend', 'user'])('preserves the database role %s without granting access', async role => {
    const sourceProfile = { id: 'current-user', role, email: 'test@example.com' };
    const result = await loadDashboardFallback(async table => table === 'profiles'
      ? [Object.fromEntries(dashboardTables.profiles.split(',').map(field => [field, sourceProfile[field as keyof typeof sourceProfile]]))]
      : []);
    expect(result.user.role).toBe(role);
  });

  it('pages past the first five hundred trades and keeps the RPC mapping shape', async () => {
    const readPage = vi.fn(async (table: DashboardTable, offset: number) => {
      if (table === 'profiles') return [{ id: 'owner', preferences: { theme: 'dark' } }];
      if (table === 'trades') return Array.from({ length: offset === 0 ? 500 : 1 }, (_, index) => ({
        id: String(offset + index), quantity: 10, needsReview: true, setupType: 'test',
      }));
      return [];
    });
    const result = await loadDashboardFallback(readPage);
    expect(result.trades).toHaveLength(501);
    expect(result.trades[500].data).toMatchObject({ quantity: 10, needsReview: true, setupType: 'test' });
    expect(readPage).toHaveBeenCalledWith('trades', 500, 500);
    // Analytics blobs are deferred to get_trade_analytics_v1 (Lab / AI coach / detail).
    for (const field of ['counterfactual', 'entryContext', 'excursion', 'aiSuggestions', 'executionPath', 'entryMap', 'visionAnalysis']) {
      expect(dashboardTables.trades).not.toContain(`${field}:`);
    }
    expect(result.preferences).toEqual({ theme: 'dark' });
    expect(dashboardTables.trades).not.toContain('drawings');
  });

  it('rejects instead of claiming a partial or cached result is fresh', async () => {
    await expect(loadDashboardFallback(async table => {
      if (table === 'profiles') return [{ id: 'owner' }];
      if (table === 'accounts') throw new Error('network-error');
      return [];
    })).rejects.toThrow('network-error');
  });

  it('requires a confirmed owner profile', async () => {
    await expect(loadDashboardFallback(async () => [])).rejects.toThrow('dashboard-profile-unavailable');
  });

  it('does not silently truncate at an exact page boundary', async () => {
    const offsets: number[] = [];
    const result = await loadDashboardFallback(async (table, offset) => {
      if (table === 'profiles') return [{ id: 'owner' }];
      if (table === 'trades') {
        offsets.push(offset);
        return offset === 0 ? Array.from({ length: 500 }, (_, index) => ({ id: String(index) })) : [];
      }
      return [];
    });
    expect(offsets).toEqual([0, 500]);
    expect(result.trades).toHaveLength(500);
  });
});

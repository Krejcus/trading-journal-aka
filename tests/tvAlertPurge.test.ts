import { describe, expect, it, vi } from 'vitest';
import { purgeExpiredTvAlerts, shouldRunTvAlertPurge } from '../server/tvAlertPurge';

describe('TV alert hourly purge', () => {
  it('runs only on the UTC hour boundary', () => {
    expect(shouldRunTvAlertPurge(new Date('2026-08-22T20:00:10Z'))).toBe(true);
    expect(shouldRunTvAlertPurge(new Date('2026-08-22T20:01:00Z'))).toBe(false);
  });

  it('deletes only tv-alert snapshot metadata, never copier kinds', async () => {
    const kindFilters: unknown[] = [];
    const remove = vi.fn(async () => ({ error: null }));
    const db = {
      storage: { from: () => ({ remove }) },
      from(table: string) {
        if (table === 'copier_trade_snapshots') return {
          delete: () => ({
            eq: (column: string, value: unknown) => {
              kindFilters.push([column, value]);
              return { in: async () => ({ error: null }) };
            },
          }),
        };
        if (table === 'tv_alerts') return {
          select: () => ({ lt: () => ({ limit: async () => ({
            data: [{ id: 'alert-1', snapshot_path: 'user/alert-1/tv-alert-1.png' }], error: null,
          }) }) }),
          delete: () => ({ in: () => ({ lt: async () => ({ error: null }) }) }),
        };
        throw new Error(`unexpected table ${table}`);
      },
    };
    await expect(purgeExpiredTvAlerts({ db: db as never, now: Date.parse('2026-08-22T20:00:00Z') }))
      .resolves.toEqual({ alerts: 1, objects: 1 });
    expect(remove).toHaveBeenCalledWith(['user/alert-1/tv-alert-1.png']);
    expect(kindFilters).toEqual([['kind', 'tv-alert']]);
    expect(JSON.stringify(kindFilters)).not.toContain('entry');
    expect(JSON.stringify(kindFilters)).not.toContain('exit');
    expect(JSON.stringify(kindFilters)).not.toContain('sl-moved');
  });
});

import { describe, expect, it } from 'vitest';
import {
  loadPendingTvAlertSnapshotRequests,
  loadTvAlertWebhookSettings,
  pendingTvAlertSnapshotRequests,
  TvAlertRateLimiter,
  tvAlertNotification,
  validateTradingViewAlertPayload,
} from '../server/tvAlertNotifications';

describe('TradingView alert webhook validation', () => {
  it('accepts the documented template and normalizes scalar placeholders', () => {
    const input = validateTradingViewAlertPayload({ symbol: 'mnq1!', price: 123.5, tf: '5', name: 'OTE long' });
    expect(input).toEqual({ symbol: 'MNQ1!', price: '123.5', timeframe: '5', name: 'OTE long' });
    expect(tvAlertNotification(input)).toEqual({ title: 'TV Alert: OTE long', body: 'MNQ1! @ 123.5 (5m)' });
  });

  it('requires symbol and enforces bounded symbol/name', () => {
    expect(() => validateTradingViewAlertPayload({ name: 'missing' })).toThrow('invalid-tv-alert-payload');
    expect(() => validateTradingViewAlertPayload({ symbol: 'X'.repeat(33), name: 'x' })).toThrow('invalid-tv-alert-payload');
    expect(() => validateTradingViewAlertPayload({ symbol: 'MNQ', name: 'X'.repeat(121) })).toThrow('invalid-tv-alert-payload');
  });

  it('allows only 30 requests per token in a rolling minute', () => {
    const limiter = new TvAlertRateLimiter(30, 60_000);
    for (let index = 0; index < 30; index += 1) expect(limiter.consume('token', index)).toBe(true);
    expect(limiter.consume('token', 30)).toBe(false);
    expect(limiter.consume('other', 30)).toBe(true);
    expect(limiter.consume('token', 60_001)).toBe(true);
  });
});

describe('TV alert snapshot request freshness', () => {
  it('treats settings missing before the migration as enabled', async () => {
    const maybeSingle = async () => ({ data: {}, error: null });
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle }),
        }),
      }),
    };
    await expect(loadTvAlertWebhookSettings({ db: db as any, userId: 'user-1' })).resolves.toEqual({
      alertsEnabled: true,
      imagesEnabled: true,
    });
  });

  it('returns no snapshot requests when images are disabled', async () => {
    let queriedAlerts = false;
    const db = {
      from: (table: string) => table === 'tv_alert_webhooks'
        ? {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: { images_enabled: false }, error: null }) }),
            }),
          }
        : {
            select: () => {
              queriedAlerts = true;
              throw new Error('tv_alerts should not be queried');
            },
          },
    };
    await expect(loadPendingTvAlertSnapshotRequests({ db: db as any, userId: 'user-1' })).resolves.toEqual([]);
    expect(queriedAlerts).toBe(false);
  });

  it('returns only pending alerts strictly younger than 60 seconds', () => {
    const now = Date.parse('2026-08-22T20:00:00.000Z');
    expect(pendingTvAlertSnapshotRequests([
      { id: 'fresh', symbol: 'MNQ1!', timeframe: '5', created_at: new Date(now - 59_999).toISOString(), snapshot_path: null },
      { id: 'edge', symbol: 'NQ1!', timeframe: '1', created_at: new Date(now - 60_000).toISOString(), snapshot_path: null },
      { id: 'done', symbol: 'MNQ1!', timeframe: '15', created_at: new Date(now - 1_000).toISOString(), snapshot_path: 'u/done.png' },
      { id: 'future', symbol: 'MNQ1!', timeframe: null, created_at: new Date(now + 1).toISOString(), snapshot_path: null },
    ], now)).toEqual([{ id: 'fresh', symbol: 'MNQ1!', timeframe: '5' }]);
  });
});

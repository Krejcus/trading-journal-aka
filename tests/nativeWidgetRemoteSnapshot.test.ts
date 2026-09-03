import { describe, expect, it } from 'vitest';

import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';
import type { NativeLiveActivityBrokerSnapshot } from '../server/nativeLiveActivityBrokerSnapshot';
import type { NativeLiveActivityRuntimeRow } from '../server/nativeLiveActivityUpdater';
import { buildNativeWidgetRemoteSnapshot } from '../server/nativeWidgetRemoteSnapshot';

const runtime = (lastSeenAt: string): NativeLiveActivityRuntimeRow => ({
  device_id: 'device', user_id: 'user', connection_id: 'connection',
  last_seen_at: lastSeenAt, started_at: '2026-08-20T09:00:00.000Z',
  status: {
    group: { leaderAccountId: 10, followers: [{ accountId: 11 }] },
    controller: {
      connected: true, armed: false, shadowMode: false, killSwitch: false,
      dayLockUntil: 0, dailyStats: { realizedPnlUsd: 40, losingTrades: 1 },
    },
  },
});

const broker: NativeLiveActivityBrokerSnapshot = {
  accounts: [
    { accountId: 10, accountName: 'A10', balance: 50_040, realizedPnl: 40, openPnl: 0, totalPnl: 40, canTrade: true, changesLocked: false },
    { accountId: 11, accountName: 'A11', balance: 50_020, realizedPnl: 20, openPnl: 0, totalPnl: 20, canTrade: false, changesLocked: false },
  ],
  positions: [], pendingOrder: null, workingOrderCount: 0, realizedPnl: 60, openPnl: 0,
  totalPnl: 60, completeOpenPnl: true, capturedAt: Date.parse('2026-08-20T10:00:00Z'),
};

const profile = {
  externalAccountId: '10', accountName: 'A10', displayName: 'Leader',
} as TradovateAccountProfile;

describe('remote native widget snapshot', () => {
  it('uses broker state, durable closes and profile names without inventing null PnL', () => {
    const now = Date.parse('2026-08-20T10:00:30Z');
    const result = buildNativeWidgetRemoteSnapshot({
      runtime: runtime('2026-08-20T10:00:00Z'), broker, profiles: [profile], now,
      trades: [
        { trade_id: 'new', symbol: 'MNQ', side: 'Long', quantity: '2', realized_pnl_usd: '25.5', closed_at: '2026-08-20T09:59:00Z' },
        { trade_id: 'unknown', symbol: 'NQ', side: 'Short', quantity: 1, realized_pnl_usd: null, closed_at: '2026-08-20T09:58:00Z' },
        { trade_id: 'old', symbol: 'MNQ', side: 'Short', quantity: 1, realized_pnl_usd: -10, closed_at: '2026-08-20T09:57:00Z' },
      ],
    });
    expect(result.live.status).toBe('DISARMED');
    expect(result.live.accounts[0].name).toBe('Leader');
    expect(result.live.accounts[1]).toMatchObject({ locked: true, lockReason: 'Účet nemůže obchodovat' });
    expect(result.live.recentTrades.map(trade => trade.id)).toEqual(['new', 'old']);
    expect(result.live.equity).toHaveLength(3);
    expect(result.live.equity.at(-1)).toBe(50_040);
    expect(result.live.dailyRealizedPnl).toBe(40);
    expect(result.live.dailyRealizedPnlLabel).toBe('Leader · jen obchody přes kopírku · bez poplatků');
    expect(result.live.accountsRealizedPnl).toBe(60);
    expect(result.live.accountsRealizedPnlLabel).toBe('Účty (broker, vč. poplatků)');
  });

  it('reports a genuinely stale worker independently of widget refresh time', () => {
    const result = buildNativeWidgetRemoteSnapshot({
      runtime: runtime('2026-08-20T09:00:00Z'), broker, profiles: [], trades: [],
      now: Date.parse('2026-08-20T10:00:00Z'),
    });
    expect(result.live.status).toBe('WORKER OFFLINE');
    expect(result.updatedAt).toBe(Date.parse('2026-08-20T10:00:00Z'));
  });
});

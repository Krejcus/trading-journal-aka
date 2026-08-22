import { describe, expect, it } from 'vitest';
import { closedTradesFromStatus } from '../server/tradovateCopierCommandRelay';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';

const status = (recentClosedTrades: unknown[]): LocalCopierAgentStatus => ({
  version: 1,
  environment: 'demo',
  nonce: 'redacted',
  startedAt: '2026-08-20T10:00:00.000Z',
  group: { id: 'g', name: 'G', enabled: true, leaderAccountId: 10, followers: [{ accountId: 11, mode: 'on-fill', multiplier: 1, maxContracts: 10 }] },
  controller: {
    started: true, armed: false, killSwitch: false, shadowMode: false, connected: true,
    reconciliationRequired: false, divergentAccounts: [], workingOrderAccounts: [],
    stuckOutbox: false, stuckOperations: [], lastError: null, revision: 1, lastSequence: 1,
    dailyStats: {
      sessionEndAt: 9_999_999_999_999,
      realizedPnlUsd: 125,
      losingTrades: 0,
      unpricedSymbols: [],
      recentClosedTrades: recentClosedTrades as never,
    },
  },
});

describe('copier closed trade heartbeat ledger', () => {
  it('normalizes one broker-confirmed close without inventing missing PnL', () => {
    expect(closedTradesFromStatus(status([{
      id: 'fill-42', symbol: 'MNQZ6', side: 'Long', quantity: 2,
      episodeId: '11111111-1111-4111-8111-111111111111',
      realizedPnlUsd: 125, followerCount: 5,
      openedAt: 1_777_777_000_000, closedAt: 1_777_777_060_000,
      exitReason: 'tp', avgEntryPrice: 21_000.25, avgExitPrice: 21_040.5,
    }]))).toEqual([{
      tradeId: 'fill-42', episodeId: '11111111-1111-4111-8111-111111111111',
      symbol: 'MNQZ6', side: 'Long', quantity: 2,
      realizedPnlUsd: 125, followerCount: 5,
      openedAt: new Date(1_777_777_000_000).toISOString(),
      closedAt: new Date(1_777_777_060_000).toISOString(),
      exitReason: 'tp', entryPrice: 21_000.25, exitPrice: 21_040.5,
    }]);
    expect(closedTradesFromStatus(status([{
      id: 'fill-unpriced', symbol: 'UNKNOWN', side: 'Short', quantity: 1,
      realizedPnlUsd: null, followerCount: 1, closedAt: 1_777_777_060_000,
    }]))[0]).toMatchObject({ episodeId: null, realizedPnlUsd: null });
    expect(closedTradesFromStatus(status([{
      id: 'fill-invalid-extra', symbol: 'MNQ', side: 'Long', quantity: 1,
      realizedPnlUsd: 1, followerCount: 1, closedAt: 1_777_777_060_000,
      exitReason: 'unknown', avgEntryPrice: Number.NaN, avgExitPrice: Number.POSITIVE_INFINITY,
    }]))[0]).toMatchObject({ exitReason: null, entryPrice: null, exitPrice: null });
  });

  it('deduplicates by stable fill id and rejects malformed rows', () => {
    const valid = { id: 'same', symbol: 'MNQ', side: 'Long', quantity: 1, realizedPnlUsd: 10, followerCount: 2, closedAt: 1_777_777_060_000 };
    const result = closedTradesFromStatus(status([valid, { ...valid, realizedPnlUsd: 20 }, { id: '', symbol: 'MNQ', side: 'Long', quantity: 1, closedAt: 1 }]));
    expect(result).toHaveLength(1);
    expect(result[0].realizedPnlUsd).toBe(20);
  });
});

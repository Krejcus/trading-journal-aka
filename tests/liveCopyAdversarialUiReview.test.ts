import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LiveCopyTradeOverview } from '../components/LiveCopyTradeOverview';

vi.mock('../utils/useCompactViewport', () => ({ useCompactViewport: () => true }));

const account = (id: number, name: string) => ({
  id,
  entityId: null,
  name,
  firm: 'Tradeify',
  phase: 'Funded',
  accountSize: 50_000,
  balance: 50_000,
  equity: 50_000,
  realizedPnl: 0,
  weekRealizedPnl: 0,
  unrealizedPnl: 0,
  peakEquity: null,
  drawdownFloor: null,
  cushion: null,
  positions: [],
  updatedAt: '2026-09-28T08:00:00.000Z',
  mapRowId: null,
  mappedAccountId: null,
  mappedAccountName: null,
  mappingStatus: null,
});

const leaderId = 62_364_058;
const followerId = 62_364_057;
const otherLeaderId = 70_000_001;
const group = (id: string, name: string, leaderAccountId: number) => ({
  id,
  name,
  leaderAccountId,
  leaderName: 'Leader',
  followers: [{
    accountId: followerId,
    accountName: 'Follower DEMO',
    scale: 1,
    multiplier: 1,
    replicate: true,
    synced: true,
    mismatches: [],
  }],
  syncedCount: 1,
  warningCount: 0,
});

const snapshot = {
  run: null,
  accounts: [
    account(leaderId, 'Leader DEMO'),
    account(followerId, 'Follower DEMO'),
    account(otherLeaderId, 'Other Leader'),
  ],
  appAccounts: [],
  connections: [{
    id: 'connection-1',
    firm: 'Tradeify',
    connected: true,
    status: 'Connected',
    accountCount: 3,
    disconnectedAt: null,
    disconnectReason: null,
    updatedAt: '2026-09-28T08:00:00.000Z',
  }],
  groups: [
    group('group-main', 'Hlavní', leaderId),
    group('group-other', 'Druhá', otherLeaderId),
  ],
  alerts: [],
  totalBalance: 150_000,
  totalEquity: 150_000,
  totalRealizedPnl: 0,
  totalUnrealizedPnl: 0,
  worstCushion: null,
};

const renderStale = () => renderToStaticMarkup(React.createElement(LiveCopyTradeOverview as never, {
  snapshot,
  orders: [],
  executionGroupId: 'group-main',
  commandAdapter: { execute: vi.fn() },
  copierStatusPending: true,
  runtimeAvailable: false,
  copierArmed: false,
  followerParticipation: [{
    accountId: followerId,
    configuredEnabled: true,
    effectiveEnabled: true,
    canToggle: true,
    blockers: [],
  }],
  onSwitchAndArm: vi.fn(),
  onDisarm: vi.fn(),
} as never));

describe('adversariální review stale ovládání', () => {
  it('nepředá follower toggle ani násobek, dokud se stav ověřuje', () => {
    const markup = renderStale();
    expect(markup).not.toContain('aria-label="Vypnout kopírování na účet Follower DEMO"');
    expect(markup).not.toContain('aria-label="Zapnout kopírování na účet Follower DEMO"');
    expect(markup).not.toContain('aria-label="Násobek 1×, změnit"');
    // Poslední potvrzená poloha zůstane vidět (nic nenaskočí), ale jen ke čtení.
    expect(markup).toContain('aria-label="Kopírování na účet Follower DEMO: zapnuto (stav se ověřuje)"');
    expect(markup).toContain('Nelze přepnout: Stav kopírky se ověřuje');
  });

  it('označí jako neověřené všechny skupiny, nejen poslední execution skupinu', () => {
    const markup = renderStale();
    expect(markup).not.toContain('aria-label="Zapnout kopírovací skupinu"');
    expect(markup.match(/Neověřeno/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

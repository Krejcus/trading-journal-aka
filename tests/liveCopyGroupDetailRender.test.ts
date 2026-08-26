import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveCopyTradeOverview } from '../components/LiveCopyTradeOverview';
import type { LiveAccount, LiveOrder, LiveSnapshot } from '../services/tradecopiaLiveService';

const liveAccount = (id: number, name: string): LiveAccount => ({
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
  updatedAt: '2026-08-25T08:00:00.000Z',
  mapRowId: null,
  mappedAccountId: null,
  mappedAccountName: null,
  mappingStatus: null,
});

const leaderId = 62_364_058;
const followerId = 62_364_057;

const snapshot: LiveSnapshot = {
  run: null,
  accounts: [
    liveAccount(leaderId, 'Leader DEMO'),
    liveAccount(followerId, 'Follower DEMO'),
  ],
  appAccounts: [],
  connections: [{
    id: 'tradovate-oauth-1',
    firm: 'Tradeify',
    connected: true,
    status: 'Connected',
    accountCount: 2,
    disconnectedAt: null,
    disconnectReason: null,
    updatedAt: '2026-08-25T08:00:00.000Z',
  }],
  groups: [{
    id: 'group-main',
    name: 'Hlavni',
    leaderAccountId: leaderId,
    leaderName: 'Leader DEMO',
    followers: [{
      accountId: followerId,
      accountName: 'Follower DEMO',
      scale: 1,
      replicate: true,
      synced: true,
      mismatches: [],
    }],
    syncedCount: 1,
    warningCount: 0,
  }],
  alerts: [],
  totalBalance: 100_000,
  totalEquity: 100_000,
  totalRealizedPnl: 0,
  totalUnrealizedPnl: 0,
  worstCushion: null,
};

const workingLeaderLimit: LiveOrder = {
  id: 9001,
  accountId: leaderId,
  accountName: 'Leader DEMO',
  action: 'Buy',
  orderType: 'Limit',
  quantity: 3,
  price: 23_000,
  stopPrice: null,
  status: 'Working',
  symbol: 'MNQU6',
  placedAt: '2026-08-25T08:00:00.000Z',
  updatedAt: '2026-08-25T08:00:00.000Z',
  working: true,
};

const tableRows = (markup: string): string[] => markup.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
const tableCells = (row: string): string[] => row.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) ?? [];

describe('GroupDetail Positions integrace', () => {
  it('propustí working limit přes group accountIds do pending pillu v leader řádku', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot,
      orders: [
        workingLeaderLimit,
        { ...workingLeaderLimit, id: 9002, accountId: 999_999, accountName: 'Mimo skupinu', symbol: 'NQH27' },
      ],
    }));

    const leaderRow = tableRows(markup).find(row => row.includes('title="Leader účet"'));
    const positionsCell = leaderRow && tableCells(leaderRow)
      .find(cell => cell.includes('aria-label="Čekající vstup'));

    expect(leaderRow, 'leader account row se musí vykreslit').toBeDefined();
    expect(leaderRow).toContain('Leader DEMO');
    expect(positionsCell, 'pending pill musí být přímo v Positions buňce leadera').toBeDefined();
    expect(positionsCell).toContain('aria-label="Čekající vstup MNQ, 3 kontraktů"');
    expect(positionsCell).toContain('lucide-clock-3');
    expect(positionsCell).not.toContain('Čekající vstup NQ,');
  });

  it('překrývající profily vykreslí jako uložené a jen jeden jako execution aktivní', () => {
    const second = {
      ...snapshot.groups[0],
      id: 'group-second',
      name: 'Druhy profil',
    };
    const runtimeGroup = {
      id: 'group-main',
      name: 'Hlavni',
      enabled: true,
      leaderAccountId: leaderId,
      followers: [{ accountId: followerId, mode: 'on-submit' as const, multiplier: 1 }],
      localOnly: true,
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, groups: [snapshot.groups[0], second] },
      executionGroupId: 'group-main',
      runtimeGroup,
    }));

    expect(markup).toContain('Hlavni');
    expect(markup).toContain('Druhy profil');
    expect(markup.match(/Uložená/g)).toHaveLength(1);
  });

  it('vybraný, ale vypnutý execution profil nezobrazuje jako aktivní', () => {
    const second = {
      ...snapshot.groups[0],
      id: 'group-second',
      name: 'Druhy profil',
    };
    const runtimeGroup = {
      id: 'group-main',
      name: 'Hlavni',
      enabled: false,
      leaderAccountId: leaderId,
      followers: [{ accountId: followerId, mode: 'on-submit' as const, multiplier: 1 }],
      localOnly: true,
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, groups: [snapshot.groups[0], second] },
      executionGroupId: 'group-main',
      runtimeGroup,
    }));

    expect(markup.match(/Uložená/g)).toHaveLength(2);
    expect(markup).not.toContain('Execution aktivní');
  });

  it('zobrazí stale followera jako nedostupného a nepočítá ho mezi aktivní', () => {
    const staleFollowerId = 63_338_592;
    const staleGroup = {
      ...snapshot.groups[0],
      followers: [{
        ...snapshot.groups[0].followers[0],
        accountId: staleFollowerId,
        accountName: `Účet ${staleFollowerId}`,
      }],
    };
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot: { ...snapshot, groups: [staleGroup] },
    }));

    expect(markup).toContain('0/1 aktivních');
    expect(markup).toContain('1× nedostupný');
    expect(markup).toContain('Nedostupný účet');
    expect(markup).toContain('Účet není v aktuálním OAuth snapshotu. Oprav skupinu přes Edit group.');
  });
});

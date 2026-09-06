import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiveAccount, LiveOrder, LiveSnapshot } from '../services/tradecopiaLiveService';
import { DEFAULT_COPY_GROUP_SAFETY } from '../services/liveCopyTrading';

// Telefon: hook hlásí úzký viewport, takže LIVE vykreslí karty místo tabulky.
vi.mock('../utils/useCompactViewport', () => ({ useCompactViewport: () => true }));

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
    { ...liveAccount(leaderId, 'Leader DEMO'), realizedPnl: -150, unrealizedPnl: 40 },
    { ...liveAccount(followerId, 'Follower DEMO'), realizedPnl: -75 },
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
  totalRealizedPnl: -225,
  totalUnrealizedPnl: 40,
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

describe('LIVE kompaktní karty (telefon)', () => {
  it('nahradí 900px tabulku kartami se stejnými daty a akcemi', async () => {
    const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
      snapshot,
      orders: [workingLeaderLimit],
    }));

    expect(markup).toContain('data-testid="compact-group-list"');
    expect(markup).toContain('data-testid="compact-group-card"');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('Diagnostika dat a API');

    // Hlavička skupiny + přepínač copieru.
    expect(markup).toContain('Hlavni');
    expect(markup).toContain('1/1 aktivních');
    expect(markup).toContain('role="switch"');

    // Souhrn skupiny.
    expect(markup).toContain('Kapitál');
    expect(markup).toContain('$100,000');
    expect(markup).toContain('-$225.00');
    expect(markup).toContain('$40.00');

    // Účty s leaderem a followerem.
    expect(markup).toContain('Leader DEMO');
    expect(markup).toContain('Follower DEMO');
    expect(markup).toContain('title="Leader účet"');
    expect(markup).toContain('×1');

    // Příkazy a akce se zachovaným dotykovým cílem.
    expect(markup).toContain('Příkazy · 1 working');
    expect(markup).toContain('MNQU6');
    expect(markup).toContain('Zrušit');
    expect(markup).toContain('Flatten All');
    expect(markup).toContain('Upravit');
  });

  it('desktop bez úzkého viewportu dál vykresluje tabulku', async () => {
    vi.doMock('../utils/useCompactViewport', () => ({ useCompactViewport: () => false }));
    vi.resetModules();
    const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
    const markup = renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, { snapshot, orders: [] }));
    expect(markup).toContain('<table');
    expect(markup).not.toContain('data-testid="compact-group-list"');
    expect(markup).toContain('Diagnostika dat a API');
  });
});

describe('Pravidla dne na telefonu', () => {
  it('bez okna (SSR) zůstává karta rozbalená a nese data-collapsed pro mobilní výchozí sbalení', async () => {
    const { LiveDayRulesCard } = await import('../components/LiveDayRulesCard');
    const markup = renderToStaticMarkup(React.createElement(LiveDayRulesCard, { groupName: 'Hlavní', safety: DEFAULT_COPY_GROUP_SAFETY, riskConfigSupported: true }));
    expect(markup).toContain('data-collapsed="false"');
    expect(markup).toContain('aria-label="Sbalit pravidla dne"');
  });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveAccount, LiveSnapshot } from '../services/tradecopiaLiveService';

// Fáze 1 (docs/reviews/live-copier-loading-20261002.md): dokud worker
// neposlal žádný stav, chybějící způsobilost účtu NESMÍ znamenat „Aktivní“
// a místa pro přepínače followerů jsou vyhrazená od prvního vykreslení.

let compactViewport = false;
vi.mock('../utils/useCompactViewport', () => ({ useCompactViewport: () => compactViewport }));

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
  accounts: [liveAccount(leaderId, 'Leader DEMO'), liveAccount(followerId, 'Follower DEMO')],
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

const render = async (props: Record<string, unknown>) => {
  const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
  return renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, { snapshot, ...props }));
};

const tableRows = (markup: string): string[] => markup.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
const followerRow = (markup: string) => tableRows(markup).find(row => row.includes('Follower DEMO')) ?? '';

afterEach(() => { compactViewport = false; });

describe('LIVE desktop: neznámý stav workeru', () => {
  it('před první odpovědí workeru neukáže „Aktivní“, ale „Ověřuji“', async () => {
    const markup = await render({ workerStatusKnown: false, copierStatusPending: true });
    expect(markup).not.toContain('Stav účtu: Aktivní');
    expect(markup).toContain('Stav účtu: Ověřuji');
  });

  it('po odpovědi workeru bez výjimek ukáže „Aktivní“ jako dosud', async () => {
    const markup = await render({ workerStatusKnown: true, runtimeAvailable: true });
    expect(markup).toContain('Stav účtu: Aktivní');
    expect(markup).not.toContain('Stav účtu: Ověřuji');
  });

  it('potvrzený DLL zámek se ukáže i při ověřování, nepřekryje ho „Ověřuji“', async () => {
    const markup = await render({
      workerStatusKnown: true,
      copierStatusPending: true,
      accountEligibility: [{ accountId: followerId, state: 'dll-locked', reason: 'Denní limit vyčerpán' }],
    });
    expect(followerRow(markup)).toContain('Zamčeno denním limitem');
    expect(followerRow(markup)).not.toContain('Stav účtu: Ověřuji');
  });

  it('místo pro přepínač followera je vyhrazené ještě před odpovědí workeru', async () => {
    const before = await render({ workerStatusKnown: false, copierStatusPending: true });
    expect(followerRow(before)).toContain('aria-hidden="true" class="w-8 shrink-0"');
  });
});

describe('LIVE mobil: neznámý stav workeru', () => {
  it('tečka účtu není zelená a řádek štítků drží místo „ověřuji followery“', async () => {
    compactViewport = true;
    const markup = await render({ workerStatusKnown: false, copierStatusPending: true });
    expect(markup).toContain('data-testid="compact-group-card"');
    expect(markup).toContain('ověřuji followery…');
    expect(markup).toContain('h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400');
    expect(markup).not.toContain('h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500');
  });

  it('po odpovědi workeru se vrátí zelená tečka a štítek „ověřuji“ zmizí', async () => {
    compactViewport = true;
    const markup = await render({ workerStatusKnown: true, runtimeAvailable: true });
    expect(markup).not.toContain('ověřuji followery…');
    expect(markup).toContain('h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500');
  });
});

describe('počty followerů před odpovědí workeru', () => {
  const twoFollowers: LiveSnapshot = {
    ...snapshot,
    accounts: [...snapshot.accounts, liveAccount(62_364_059, 'Follower B')],
    groups: [{
      ...snapshot.groups[0],
      followers: [
        ...snapshot.groups[0].followers,
        { accountId: 62_364_059, accountName: 'Follower B', scale: 1, replicate: true, synced: true, mismatches: [] },
      ],
    }],
  };
  const dllOnFirst = [{ accountId: followerId, state: 'dll-locked' as const, reason: 'Denní limit vyčerpán' }];

  it.each([false, true])('neznámý follower se nezapočítá jako zařazený (mobil=%s)', async compact => {
    compactViewport = compact;
    const markup = await render({
      snapshot: twoFollowers, workerStatusKnown: false, copierStatusPending: true, accountEligibility: dllOnFirst,
    });
    expect(markup).toContain('ověřuji followery…');
    expect(markup).toContain('1× DLL');
    expect(markup).not.toContain('zařazených');
  });

  it('po odpovědi workeru se počet zařazených vrátí', async () => {
    const markup = await render({
      snapshot: twoFollowers, workerStatusKnown: true, runtimeAvailable: true, accountEligibility: dllOnFirst,
    });
    expect(markup).toContain('1/2 zařazených');
    expect(markup).not.toContain('ověřuji followery…');
  });
});

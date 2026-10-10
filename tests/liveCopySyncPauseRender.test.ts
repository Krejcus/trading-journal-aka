// Etapa 2, bod 5a (10. 10. 2026): follower „mimo synchron“ je vidět v řádku
// účtu i v liště skupiny — na telefonu i na desktopu.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiveAccount, LiveSnapshot } from '../services/tradecopiaLiveService';
import type { CopierControllerStatus } from '../services/copierRuntimeController';

const viewport = vi.hoisted(() => ({ compact: true }));
vi.mock('../utils/useCompactViewport', () => ({ useCompactViewport: () => viewport.compact }));

const liveAccount = (id: number, name: string): LiveAccount => ({
  id, entityId: null, name, firm: 'Tradeify', phase: 'Funded', accountSize: 50_000,
  balance: 50_000, equity: 50_000, realizedPnl: 0, weekRealizedPnl: 0, unrealizedPnl: 0,
  peakEquity: null, drawdownFloor: null, cushion: null, positions: [],
  updatedAt: '2026-10-10T08:00:00.000Z', mapRowId: null, mappedAccountId: null,
  mappedAccountName: null, mappingStatus: null,
});

const leaderId = 68_356_274;
const pausedId = 68_356_280;
const copyingId = 68_356_277;

const snapshot: LiveSnapshot = {
  run: null,
  accounts: [
    liveAccount(leaderId, 'Leader DEMO'),
    liveAccount(pausedId, 'Paused DEMO'),
    liveAccount(copyingId, 'Copying DEMO'),
  ],
  appAccounts: [],
  connections: [{
    id: 'tradovate-oauth-1', firm: 'Tradeify', connected: true, status: 'Connected', accountCount: 3,
    disconnectedAt: null, disconnectReason: null, updatedAt: '2026-10-10T08:00:00.000Z',
  }],
  groups: [{
    id: 'group-main', name: 'Hlavni', leaderAccountId: leaderId, leaderName: 'Leader DEMO',
    followers: [pausedId, copyingId].map(accountId => ({
      accountId, accountName: accountId === pausedId ? 'Paused DEMO' : 'Copying DEMO',
      scale: 1, replicate: true, synced: true, mismatches: [],
    })),
    syncedCount: 2, warningCount: 0,
  }],
  alerts: [],
  totalBalance: 150_000, totalEquity: 150_000, totalRealizedPnl: 0, totalUnrealizedPnl: 0, worstCushion: null,
};

const pause = (reasonCode: 'entry-rejected' | 'protective-filled-early') => ({
  accountId: pausedId, symbol: 'MNQZ6', reasonCode, reason: 'worker detail', pausedAt: Date.parse('2026-10-10T07:31:02.000Z'),
});

const render = async (props: Record<string, unknown>) => {
  const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
  return renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
    snapshot, orders: [], runtimeAvailable: true, executionGroupId: 'group-main', ...props,
  } as never));
};

describe('bod 5a — účet mimo synchron', () => {
  it('telefon: štítek v řádku, lišta skupiny a počet kopírujících', async () => {
    viewport.compact = true;
    const markup = await render({ accountSyncPauses: [pause('protective-filled-early')] });
    expect(markup).toContain('data-testid="compact-group-card"');
    expect(markup).toContain('data-testid="account-sync-pause-banner"');
    expect(markup).toContain('Jeden účet je mimo synchron');
    expect(markup).toContain('se vyplnil stop nebo target dřív než leaderovi');
    expect(markup).toContain('Ostatní kopírují dál.');
    expect(markup).toContain('MIMO SYNCHRON');
    expect(markup).toContain('Pauza do konce obchodu · vrátí se sám u dalšího obchodu');
    // Pozastavený follower se nepočítá mezi kopírující.
    expect(markup).toContain('1/2 zařazených');
    expect(markup.match(/data-sync-paused="true"/g)).toHaveLength(1);
  });

  it('desktop: tabulka ukáže stav i lištu', async () => {
    viewport.compact = false;
    const markup = await render({ accountSyncPauses: [pause('entry-rejected')] });
    viewport.compact = true;
    expect(markup).toContain('<table');
    expect(markup).toContain('data-testid="account-sync-pause-banner"');
    expect(markup).toContain('broker odmítl vstup');
    expect(markup).toContain('MIMO SYNCHRON');
    expect(markup).toContain('title="Broker odmítl vstup"');
    expect(markup).toContain('Pauza do konce obchodu · vrátí se sám u dalšího obchodu');
    expect(markup.match(/<tr[^>]*data-sync-paused="true"/g)).toHaveLength(1);
  });

  it('pozastavený účet s otevřenou pozicí je červeně — kopírka ji neřídí', async () => {
    viewport.compact = true;
    const withPosition: LiveSnapshot = {
      ...snapshot,
      accounts: snapshot.accounts.map(account => account.id === pausedId ? {
        ...account,
        positions: [{ accountId: pausedId, symbol: 'MNQZ6', netPosition: 1, netPrice: 30_500, realizedPnl: 0, unrealizedPnl: 0, updatedAt: '2026-10-10T08:00:00.000Z' }],
      } : account),
    };
    const markup = await render({ snapshot: withPosition, accountSyncPauses: [pause('entry-rejected')] });
    expect(markup).toContain('má otevřenou pozici, kopírka ji neřídí');
  });

  it('pauza patří jen execution skupině a ustoupí breach', async () => {
    viewport.compact = true;
    const otherGroup = await render({ executionGroupId: 'other-group', accountSyncPauses: [pause('entry-rejected')] });
    expect(otherGroup).not.toContain('MIMO SYNCHRON');
    expect(otherGroup).not.toContain('account-sync-pause-banner');

    const breached: CopierControllerStatus['accountEligibility'] = [{
      accountId: pausedId, state: 'breached', reason: 'Účet porušil drawdown', changedAt: 1,
    } as never];
    const markup = await render({ accountEligibility: breached, accountSyncPauses: [pause('entry-rejected')] });
    expect(markup).toContain('1× BREACHED');
    expect(markup).not.toContain('MIMO SYNCHRON');
    expect(markup).not.toContain('account-sync-pause-banner');
  });

  it('bez pauz se nic nezobrazí', async () => {
    viewport.compact = true;
    const markup = await render({ accountSyncPauses: [] });
    expect(markup).not.toContain('MIMO SYNCHRON');
    expect(markup).not.toContain('account-sync-pause-banner');
    expect(markup).not.toContain('data-sync-paused');
  });
});

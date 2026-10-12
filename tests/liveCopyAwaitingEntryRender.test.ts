// V6 (12. 10. 2026): follower, jehož kopie vstupu ještě čeká v knize, má
// v řádku „čeká na vstup“ místo varování „nesedí s leaderem“.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiveAccount, LiveSnapshot } from '../services/tradecopiaLiveService';

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

const waiting = { accountId: pausedId, symbol: 'MNQZ6', since: Date.parse('2026-10-12T08:00:24.000Z') };

const render = async (props: Record<string, unknown>) => {
  const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
  return renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
    snapshot, orders: [], runtimeAvailable: true, executionGroupId: 'group-main', copierArmed: true, ...props,
  } as never));
};

describe('V6 — follower čeká na vyplnění kopie vstupu', () => {
  it('telefon: poznámka v řádku čekajícího followera', async () => {
    viewport.compact = true;
    const markup = await render({ awaitingCopiedEntries: [waiting] });
    expect(markup).toContain('Čeká na vyplnění kopie vstupu');
    expect(markup.match(/Čeká na vyplnění kopie vstupu/g)).toHaveLength(1);
  });

  it('desktop: štítek ČEKÁ NA VSTUP s vysvětlením', async () => {
    viewport.compact = false;
    const markup = await render({ awaitingCopiedEntries: [waiting] });
    viewport.compact = true;
    expect(markup).toContain('<table');
    expect(markup).toContain('ČEKÁ NA VSTUP');
    expect(markup).toContain('účet tento obchod vynechá');
  });

  it('vypnutá kopírka ani jiná skupina čekání neukazují', async () => {
    viewport.compact = true;
    expect(await render({ copierArmed: false, awaitingCopiedEntries: [waiting] })).not.toContain('Čeká na vyplnění kopie vstupu');
    expect(await render({ executionGroupId: 'other-group', awaitingCopiedEntries: [waiting] })).not.toContain('Čeká na vyplnění kopie vstupu');
  });

  it('pauza mimo synchron má přednost', async () => {
    viewport.compact = true;
    const markup = await render({
      awaitingCopiedEntries: [waiting],
      accountSyncPauses: [{ accountId: pausedId, symbol: 'MNQZ6', reasonCode: 'entry-rejected', reason: 'x', pausedAt: 1 }],
    });
    expect(markup).toContain('MIMO SYNCHRON');
    expect(markup).not.toContain('Čeká na vyplnění kopie vstupu');
  });
});

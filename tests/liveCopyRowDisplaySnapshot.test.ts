// Nález Codex review 0a468e20: kontinuita streamu (jako graf) smí jen do vykreslení
// řádků přehledu. ARM předkontrola / „flat“ dál čte doložený `snapshot`.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiveAccount, LiveSnapshot } from '../services/tradecopiaLiveService';
import { armBlockUnverifiedAccounts, buildArmPositionBlock } from '../components/LiveCopyTradeOverview';

const viewport = vi.hoisted(() => ({ compact: true }));
vi.mock('../utils/useCompactViewport', () => ({ useCompactViewport: () => viewport.compact }));

const leaderId = 68_356_274;
const stale = new Date(Date.now() - 10 * 60_000).toISOString();
const fresh = new Date().toISOString();

const account = (positionsUpdatedAt: string, netPosition: number): LiveAccount => ({
  id: leaderId, entityId: null, name: 'Leader DEMO', firm: 'Tradeify', phase: 'Funded', accountSize: 50_000,
  balance: 50_000, equity: 50_000, realizedPnl: 0, weekRealizedPnl: 0, unrealizedPnl: 0,
  peakEquity: null, drawdownFloor: null, cushion: null,
  positions: netPosition ? [{ accountId: leaderId, symbol: 'MNQZ6', netPosition, netPrice: 21_000, realizedPnl: 0, unrealizedPnl: 0, updatedAt: positionsUpdatedAt }] : [],
  positionsAvailability: 'available', ordersAvailability: 'available',
  positionsUpdatedAt, ordersUpdatedAt: positionsUpdatedAt,
  updatedAt: positionsUpdatedAt, mapRowId: null, mappedAccountId: null, mappedAccountName: null, mappingStatus: null,
});

const snap = (a: LiveAccount): LiveSnapshot => ({
  run: null, accounts: [a], appAccounts: [],
  connections: [{ id: 'c1', firm: 'Tradeify', connected: true, status: 'Connected', accountCount: 1,
    disconnectedAt: null, disconnectReason: null, updatedAt: fresh }],
  groups: [{ id: 'g', name: 'Hlavni', leaderAccountId: leaderId, leaderName: 'Leader DEMO', followers: [], syncedCount: 0, warningCount: 0 }],
  alerts: [], totalBalance: 50_000, totalEquity: 50_000, totalRealizedPnl: 0, totalUnrealizedPnl: 0, worstCushion: null,
});

const proof = snap(account(stale, 0));
const display = snap(account(fresh, 2));

const render = async (props: Record<string, unknown>) => {
  const { LiveCopyTradeOverview } = await import('../components/LiveCopyTradeOverview');
  return renderToStaticMarkup(React.createElement(LiveCopyTradeOverview, {
    snapshot: proof, orders: [], runtimeAvailable: true, executionGroupId: 'g', copierArmed: false, ...props,
  } as never));
};

describe('přehled: kontinuita jen do řádků', () => {
  it('bez zobrazovací kontinuity řádek přizná neověřené pozice', async () => {
    viewport.compact = true;
    expect(await render({})).toContain('Pozice neověřeny');
  });

  it('se zobrazovací kontinuitou řádek ukáže pozici a nehlásí neověřeno', async () => {
    viewport.compact = true;
    const markup = await render({ rowDisplaySnapshot: display, rowDisplayOrders: [] });
    expect(markup).not.toContain('Pozice neověřeny');
    expect(markup).toContain('MNQ');
  });

  it('ARM blokace a „flat“ čtou jen doložený snapshot', () => {
    const group = { id: 'g', leaderAccountId: leaderId, followers: [] } as never;
    const proofById = new Map(proof.accounts.map(a => [a.id, a]));
    expect(armBlockUnverifiedAccounts(group, proofById)).toEqual([leaderId]);
    expect(buildArmPositionBlock(group, proofById, [], () => 'L')).toEqual([]);
  });
});

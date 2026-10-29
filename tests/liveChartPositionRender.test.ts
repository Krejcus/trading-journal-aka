import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildJournalLiveView } from '../lib/journalLivePosition';
import { liveChartPosition } from '../lib/liveChartPosition';
import { buildLiveTradeGroup } from '../lib/liveTradeGroupSource';
import { devLiveCopyFixtureSnapshot } from '../lib/devLiveCopyFixture';
import LiveOrderTicket from '../components/LiveOrderTicket';
import LiveGroupChip from '../components/LiveGroupChip';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

/**
 * Otevřená pozice skupiny celou cestou LIVE → Graf bez živého obchodu:
 * účty z brokera → pohled (stejný jako graf dne) → model grafu → vykreslený
 * panel objednávky a přehled účtů. Jen zobrazení.
 */
const now = Date.UTC(2026, 9, 29, 14, 0, 0);
const at = new Date(now - 2_000).toISOString();
const account = (id: number, quantity: number, entry: number, openPnl: number): LiveAccount => ({
  ...devLiveCopyFixtureSnapshot.accounts[0], id, name: `ACC${id}`,
  unrealizedPnl: openPnl, unrealizedPnlSource: 'broker', unrealizedPnlUpdatedAt: at,
  positionsAvailability: 'available', ordersAvailability: 'available', positionsUpdatedAt: at, ordersUpdatedAt: at,
  positions: [{ accountId: id, symbol: 'MNQZ6', netPosition: quantity, netPrice: entry, unrealizedPnl: openPnl, realizedPnl: 0, updatedAt: at }],
});
let nextId = 1;
const order = (accountId: number, patch: Partial<LiveOrder>): LiveOrder => ({
  id: nextId++, accountId, accountName: '', symbol: 'MNQZ6', action: 'Sell', orderType: 'Stop', quantity: 2,
  price: null, stopPrice: null, status: 'Working', working: true, placedAt: at, updatedAt: at, ...patch,
});
const group: CopyGroupConfig = {
  id: 'g', name: 'Skupina', enabled: true, leaderAccountId: 1,
  followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1, enabled: true } as CopyGroupConfig['followers'][number]],
};
const accounts = [account(1, 2, 21480, 40), account(2, 1, 21481, 18)];
const orders = [
  order(1, { orderType: 'Stop', stopPrice: 21470 }), order(1, { orderType: 'Limit', price: 21500 }),
  order(2, { orderType: 'Stop', stopPrice: 21472, quantity: 1 }), order(2, { orderType: 'Limit', price: 21495, quantity: 1 }),
];

describe('LIVE → Graf: otevřená pozice skupiny až do panelu', () => {
  const view = buildJournalLiveView({ accounts, orders, feeRates: new Map(), group, target: 'group', now });
  const position = liveChartPosition(view, 'group');

  it('model grafu: pozice skupiny, P&L z brokera, ochrana a čáry', () => {
    expect(position.issue).toBeNull();
    expect(position.summary).toMatchObject({ kind: 'position', side: 'long', quantity: 3, openPnl: 58, stop: 21470, target: 21500, protection: 'SL 2/2 · TP 2/2' });
    expect(position.lines.map(line => [line.id, line.price])).toEqual([['entry', position.summary!.entry], ['stop', 21470], ['target', 21500]]);
  });

  it('panel objednávky ukáže pozici, P&L z brokera a vypnuté BE / Zavřít', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveOrderTicket, {
      isDark: true,
      instrument: { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 },
      quote: { bid: 21485, ask: 21485.25 },
      draft: null, onDraft: () => {}, fromBox: false,
      units: 'pts', onUnits: () => {}, scope: 'account', onScope: () => {},
      group: null, target: { kind: 'group' }, onTarget: () => {},
      quoteInfo: { source: 'IBKR', capturedAt: now, stale: false },
      position,
      onNewDraft: () => {}, onClose: () => {},
    }));
    expect(markup).toContain('Long 3');
    expect(markup).toContain('+$58.00');
    expect(markup).toContain('z brokera');
    expect(markup).toContain('SL 2/2 · TP 2/2');
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>[^]*?SL na BE/);
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>[^]*?Zavřít pozici/);
  });

  it('přehled účtů ukáže pozici každého účtu z ověřeného čtení', () => {
    const tradeGroup = buildLiveTradeGroup({
      group, controller: { armed: true, transportResume: null, excludedForeignFollowers: [], followerParticipation: [] } as never,
      statusFresh: true, displayAccounts: accounts, positionAccounts: accounts, orders, nameOf: id => `Účet ${id}`, root: 'MNQ', now,
    })!;
    expect(tradeGroup.leader.position).toMatch(/^\+2 @ 21\s480,00$/);
    expect(tradeGroup.followers[0].position).toMatch(/^\+1 @ 21\s481,00$/);
    // Přehled je popover; vykreslí se po otevření — tady stačí, že čip se skupinou vznikne bez chyby.
    const chip = renderToStaticMarkup(React.createElement(LiveGroupChip, {
      isDark: true, group: tradeGroup, target: { kind: 'group' }, copierChip: null, onOpenDashboard: () => {},
    }));
    expect(chip).toContain('Účet 1 · leader → 1');
  });
});

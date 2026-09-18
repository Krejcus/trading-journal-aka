import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CopyTradePositionsCell } from '../components/LiveCopyTradeOverview';
import type { LiveOrder, LivePosition } from '../services/tradecopiaLiveService';

const position: LivePosition = { accountId: 200, symbol: 'MNQZ6', netPosition: -7, netPrice: 29_730.75, realizedPnl: 0, unrealizedPnl: -35, updatedAt: null };
const stop: LiveOrder = {
  id: 1, accountId: 200, accountName: 'F1', action: 'Buy', orderType: 'Stop', quantity: 7, price: null, stopPrice: 29_748.25,
  status: 'Working', symbol: 'MNQZ6', placedAt: null, updatedAt: null, working: true,
};
const render = (props: Partial<React.ComponentProps<typeof CopyTradePositionsCell>>) => renderToStaticMarkup(
  React.createElement(CopyTradePositionsCell, { accountId: 200, positions: [position], orders: [stop], ...props }),
);

describe('CopyTradePositionsCell keeps the last known position on screen', () => {
  it('shows the position even when the read is not verified and adds the age only when stale', () => {
    const fresh = render({ positionsVerified: false, staleLabel: null });
    expect(fresh).toContain('MNQ');
    expect(fresh).not.toContain('Pozice neověřené');
    expect(fresh).not.toContain('text-amber-600');
    expect(fresh).not.toContain('před');
    const stale = render({ positionsVerified: false, staleLabel: 'před 3 min' });
    expect(stale).toContain('MNQ');
    expect(stale).toContain('před 3 min');
    expect(stale).not.toContain('Pozice neověřené');
  });
  it('labels a flat account too, so an empty cell is never mistaken for a verified flat', () => {
    const html = render({ positions: [], orders: [], positionsVerified: false, staleLabel: 'nedostupné' });
    expect(html).toContain('—');
    expect(html).toContain('nedostupné');
  });
  it('verified reads render exactly as before', () => {
    const html = render({ positionsVerified: true, ordersVerified: true, staleLabel: 'před 9 min' });
    expect(html).toContain('MNQ');
    expect(html).not.toContain('před 9 min');
  });
});

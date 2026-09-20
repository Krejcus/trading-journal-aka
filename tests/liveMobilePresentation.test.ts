import { describe, expect, it } from 'vitest';
import { mobileGroupPosition, mobilePosition, mobileGroupOpenPnl } from '../lib/liveMobilePresentation';
import { devLiveCopyFixtureSnapshot } from '../lib/devLiveCopyFixture';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
const now = Date.now();
const at = new Date(now).toISOString();
const account = (quantity = 1, id = 1): LiveAccount => ({ ...devLiveCopyFixtureSnapshot.accounts[0], id, unrealizedPnl: 24 * quantity,
  unrealizedPnlSource: 'broker', unrealizedPnlUpdatedAt: at, positionsAvailability: 'available', ordersAvailability: 'available', positionsUpdatedAt: at, ordersUpdatedAt: at,
  positions: [{ accountId: id, symbol: 'MNQU6', netPosition: quantity, netPrice: 20950, unrealizedPnl: 0, realizedPnl: 0, updatedAt: at }] });
const orders = (id = 1, quantity = 1): LiveOrder[] => ['Stop', 'Limit'].map((type, i) => ({ id: id * 10 + i, accountId: id, accountName: 'Demo', symbol: 'MNQU6', action: quantity > 0 ? 'Sell' : 'Buy', orderType: type, quantity: Math.abs(quantity), price: i ? 20980 : null, stopPrice: i ? null : 20935, working: true, status: 'Working', placedAt: at, updatedAt: at }));
describe('mobile LIVE position presentation', () => {
  it('distinguishes distance from current mark and total P&L from entry', () => {
    const a = account(); const view = mobilePosition(a, a.positions[0], orders(), now);
    expect(view.mark).toBe(20962); expect(view.stop.distance).toBe(27); expect(view.stop.pnl).toBe(-30);
    expect(view.target.distance).toBe(18); expect(view.target.pnl).toBe(60);
  });
  it('sums leader plus followers and actual quantities, not multiplier assumptions', () => {
    const accounts = [account(1, 1), account(2, 2)];
    const view = mobileGroupPosition(accounts, [...orders(1), ...orders(2, 2)], now)!;
    expect(view.quantity).toBe(3); expect(view.stop.pnl).toBe(-90); expect(view.target.pnl).toBe(180); expect(view.openPnl).toBe(72);
  });
  it('handles shorts and a profitable stop', () => {
    const a = account(-2); const o = orders(1, -2); o[0].stopPrice = 20940;
    const view = mobilePosition(a, a.positions[0], o, now);
    expect(view.stop.pnl).toBe(40); expect(view.target.pnl).toBe(-120);
  });
  it('never projects full-position P&L from partial or excessive stop coverage', () => {
    const a = account(2);
    expect(mobilePosition(a, a.positions[0], orders(), now).stop.pnl).toBeNull();
    expect(mobilePosition(a, a.positions[0], orders(1, 3), now).stop.pnl).toBeNull();
  });
  it('sums split exits but does not invent a single stop price', () => {
    const a = account(2); const o = orders(); o.push({ ...o[0], id: 99, stopPrice: 20930 });
    const view = mobilePosition(a, a.positions[0], o, now);
    expect(view.stop.exact).toBe(true); expect(view.stop.price).toBeNull(); expect(view.stop.pnl).toBe(-70);
  });
  it('does not use another contract month, account, side, or cancelled order as protection', () => {
    const a = account();
    for (const patch of [{ symbol: 'MNQZ6' }, { accountId: 2 }, { action: 'Buy' }, { working: false }]) {
      expect(mobilePosition(a, a.positions[0], orders().map(o => ({ ...o, ...patch })), now).stop.pnl).toBeNull();
    }
  });
  it('suppresses mark for stale P&L or multiple positions and protection for unverified reads', () => {
    const a = account(); a.unrealizedPnlUpdatedAt = new Date(now - 60000).toISOString();
    expect(mobilePosition(a, a.positions[0], orders(), now).mark).toBeNull();
    a.positions.push({ ...a.positions[0], symbol: 'NQU6' });
    expect(mobilePosition(a, a.positions[0], orders(), now).openPnl).toBeNull();
    a.ordersAvailability = 'partial'; expect(mobilePosition(a, a.positions[0], orders(), now).stop.pnl).toBeNull();
    a.positionsAvailability = 'unavailable'; expect(mobileGroupPosition([a], orders(), now)).toBeNull();
  });
  it('rejects mixed contracts/directions and missing participants instead of showing partial totals', () => {
    expect(mobileGroupPosition([account(1, 1), account(-1, 2)], orders(), now)).toBeNull();
    expect(mobileGroupPosition([account(), undefined], orders(), now)).toBeNull();
    expect(mobileGroupOpenPnl([account(), undefined])).toBeNull();
    expect(mobileGroupOpenPnl([{ ...account(), unrealizedPnlSource: 'stale' }])).toBeNull();
    const a = account(); a.positions[0].symbol = 'UNKNOWN';
    expect(mobilePosition(a, a.positions[0], orders().map(o => ({ ...o, symbol: 'UNKNOWN' })), now).stop.pnl).toBeNull();
  });
});

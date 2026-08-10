import { describe, expect, it } from 'vitest';
import { deriveFastEvents } from '../scripts/tradecopia-sync/fast-event-core.mjs';

const accounts = [
  { id: 1, name: 'Leader 50K', balance: 50_000 },
  { id: 2, name: 'Follower A', balance: 50_000 },
  { id: 3, name: 'Follower B', balance: 50_000 },
  { id: 4, name: 'Follower C', balance: 50_000 },
];

const baseSnapshot = () => ({
  accounts,
  groups: [{ id: 'g1', name: 'MNQ skupina' }],
  groupLeaders: [{ group_id: 'g1', id: 1 }],
  groupFollowers: [
    { group_id: 'g1', id: 2, scale: 1, replicate: 1 },
    { group_id: 'g1', id: 3, scale: 1, replicate: 1 },
    { group_id: 'g1', id: 4, scale: 1, replicate: 1 },
  ],
  orders: [],
  positions: [],
  connections: [],
  autoLiquidations: [],
});

describe('TradeCopia rychlé agregované události', () => {
  it('sloučí jednu kopírovanou objednávku do jedné zprávy pro 3/3 účtů', () => {
    const previous = baseSnapshot();
    const current = {
      ...baseSnapshot(),
      orders: accounts.map(account => ({
        id: `order-${account.id}`,
        account_id: account.id,
        group_tag: 'copy-123',
        symbol: 'MNQ',
        action: 'Buy',
        quantity: 1,
        order_type: 'Market',
        status: 'working',
        placed_timestamp: '2026-08-10T10:00:00.000Z',
      })),
    };

    const events = deriveFastEvents(previous, current);
    expect(events.filter(event => event.type === 'order_submitted')).toHaveLength(1);
    expect(events.find(event => event.type === 'order_submitted')).toMatchObject({
      copiedAccountCount: 3,
      expectedAccountCount: 3,
      leaderName: 'Leader 50K',
      accountNames: ['Follower A', 'Follower B', 'Follower C'],
    });
  });

  it('oznámí neúplnou kopii jako jedinou událost 2/3', () => {
    const previous = baseSnapshot();
    const current = {
      ...baseSnapshot(),
      orders: accounts.slice(0, 3).map(account => ({
        id: `order-${account.id}`,
        account_id: account.id,
        group_tag: 'copy-456',
        symbol: 'MNQ',
        action: 'Sell',
        quantity: 2,
        order_type: 'Limit',
        status: 'accepted',
        placed_timestamp: '2026-08-10T10:01:00.000Z',
      })),
    };

    const events = deriveFastEvents(previous, current);
    expect(events.filter(event => event.type === 'copy_partial')).toHaveLength(1);
    expect(events.find(event => event.type === 'copy_partial')).toMatchObject({
      copiedAccountCount: 2,
      expectedAccountCount: 3,
      failedAccountCount: 1,
    });
  });

  it('sloučí otevření pozice do jedné události a uzavření doplní P&L skupiny', () => {
    const previous = baseSnapshot();
    const opened = {
      ...baseSnapshot(),
      positions: accounts.map(account => ({ id: 'MNQ', account_id: account.id, symbol: 'MNQ', net_pos: 1, net_price: 21_500, updated_at: '2026-08-10T10:02:00.000Z' })),
    };
    const openEvents = deriveFastEvents(previous, opened);
    expect(openEvents.filter(event => event.type === 'trade_opened')).toHaveLength(1);
    expect(openEvents.find(event => event.type === 'trade_opened')).toMatchObject({ copiedAccountCount: 3, expectedAccountCount: 3 });

    const closed = {
      ...opened,
      accounts: accounts.map(account => ({ ...account, balance: account.balance + 25 })),
      positions: opened.positions.map(position => ({ ...position, net_pos: 0, updated_at: '2026-08-10T10:03:00.000Z' })),
    };
    const closeEvents = deriveFastEvents(opened, closed);
    expect(closeEvents.filter(event => event.type === 'trade_closed')).toHaveLength(1);
    expect(closeEvents.find(event => event.type === 'trade_closed')).toMatchObject({ pnl: 75, copiedAccountCount: 3, expectedAccountCount: 3 });
  });
});

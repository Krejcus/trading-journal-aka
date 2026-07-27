import { describe, expect, it } from 'vitest';
import type { Account, BusinessPayout, Trade } from '../types';
import { calculateAccountDrawdown, inferDrawdownConfig, portfolioFloorForDate } from '../services/propDrawdown';

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-1', name: 'Tradeify 1', initialBalance: 50000, type: 'Funded', phase: 'Funded',
  status: 'Active', currency: 'USD', createdAt: 1, ...overrides,
});

const trade = (date: string, pnl: number): Trade => ({
  id: `${date}-${pnl}`, accountId: 'acc-1', signal: '', pnl, runUp: 0, drawdown: 0, date,
  direction: 'Long', timestamp: new Date(`${date}T15:00:00Z`).getTime(), duration: '1m', durationMinutes: 1,
  executionStatus: 'Valid',
});

describe('prop EOD drawdown', () => {
  it('infers Tradeify 50K funded lock at 50,100 after 52,100', () => {
    expect(inferDrawdownConfig(account())).toMatchObject({
      mode: 'eod_trailing', amount: 2000, lockTriggerBalance: 52100, lockedFloor: 50100,
    });
  });

  it('moves only at EOD, never down, and locks permanently', () => {
    const summary = calculateAccountDrawdown(account(), [
      trade('2026-07-01', 1500),
      trade('2026-07-02', -500),
      trade('2026-07-03', 1100),
      trade('2026-07-04', -300),
    ], [], []);
    expect(summary?.history.map(day => day.floorAfter)).toEqual([49500, 49500, 50100, 50100]);
    expect(summary?.locked).toBe(true);
    expect(summary?.currentBalance).toBe(51800);
    expect(summary?.remainingRoom).toBe(1700);
  });

  it('deducts gross payouts from balance but does not lower locked floor', () => {
    const payout: BusinessPayout = { id: 'p1', accountId: 'acc-1', date: '2026-07-04', amount: 900, grossAmount: 1000, status: 'Received' };
    const summary = calculateAccountDrawdown(account(), [trade('2026-07-01', 2100)], [payout], []);
    expect(summary?.locked).toBe(true);
    expect(summary?.currentFloor).toBe(50100);
    expect(summary?.currentBalance).toBe(51100);
    expect(summary?.remainingRoom).toBe(1000);
  });

  it('sums each account floor for the matching day in combined view', () => {
    const first = calculateAccountDrawdown(account(), [trade('2026-07-01', 1500)], [], []);
    const secondAccount = account({ id: 'acc-2', name: 'Lucid 1' });
    const secondTrade = { ...trade('2026-07-01', 1000), id: 'second', accountId: 'acc-2' };
    const second = calculateAccountDrawdown(secondAccount, [secondTrade], [], []);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const portfolio = portfolioFloorForDate([first!, second!], '2026-07-02');
    expect(portfolio.total).toBe(98500);
    expect(portfolio.breakdown).toEqual([
      expect.objectContaining({ accountId: 'acc-1', floor: 49500 }),
      expect.objectContaining({ accountId: 'acc-2', floor: 49000 }),
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { tradingDaysForPayout } from '../components/PayoutDetailModal';
import type { BusinessPayout, Trade } from '../types';

const trade = (accountId: string, date: string, id: string): Trade => ({
  id, accountId, signal: 'x', pnl: 10, runUp: 0, drawdown: 0,
  date, direction: 'Long', timestamp: Date.parse(`${date}T10:00:00Z`),
  duration: '', durationMinutes: 1,
} as Trade);

const payout = (id: string, accountId: string, date: string): BusinessPayout =>
  ({ id, accountId, date, amount: 100 });

describe('obchodní dny k výplatě', () => {
  const trades: Trade[] = [
    trade('acc-1', '2026-06-01', 't1'),
    trade('acc-1', '2026-06-01', 't2'), // stejný den → počítá se jednou
    trade('acc-1', '2026-06-03', 't3'),
    trade('acc-1', '2026-06-10', 't4'), // až po první výplatě
    trade('acc-2', '2026-06-02', 't5'), // jiný účet → nezapočítat
  ];
  const p1 = payout('p1', 'acc-1', '2026-06-05');
  const p2 = payout('p2', 'acc-1', '2026-06-15');
  const payouts = [p2, p1]; // pořadí jako v UI (nejnovější první)

  it('u první výplaty počítá od prvního obchodu a unikátní dny', () => {
    const run = tradingDaysForPayout(p1, payouts, trades);
    expect(run).toEqual({ days: 2, tradeCount: 3, from: '' });
  });

  it('po výplatě se počítadlo nuluje — další výplata počítá jen novější dny', () => {
    const run = tradingDaysForPayout(p2, payouts, trades);
    expect(run).toEqual({ days: 1, tradeCount: 1, from: '2026-06-05' });
  });

  it('zvládne ISO datum s časem i výplatu bez účtu', () => {
    const iso = payout('p3', 'acc-1', '2026-06-15T00:00:00');
    expect(tradingDaysForPayout(iso, [iso, p1], trades)?.days).toBe(1);
    expect(tradingDaysForPayout(payout('p4', '', '2026-06-15'), payouts, trades)).toBeNull();
  });

  it('zmeškaný obchod nezapočítá jako obchod ani obchodní den', () => {
    const missed = { ...trade('acc-1', '2026-06-04', 'missed'), executionStatus: 'Missed' as const };
    expect(tradingDaysForPayout(p1, payouts, [...trades, missed])).toEqual({
      days: 2,
      tradeCount: 3,
      from: '',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { calculateStats } from '../services/analysis';
import { adjustmentForAccount, adjustmentTotal, getFinancialAdjustments } from '../services/tradingIncidents';
import type { Account, DailyReview, Trade } from '../types';

const account = (id: string, name: string): Account => ({
  id, name, initialBalance: 50_000, type: 'Funded', phase: 'Funded',
  status: 'Active', currency: 'USD', createdAt: 1,
});

describe('incident bez tradů jako finanční P&L', () => {
  const reviews: DailyReview[] = [{
    id: 'review-1', date: '2026-07-23', mainTakeaway: '', mistakes: [], lessons: '', rating: 1,
    incidents: [{
      id: 'incident-1', timestamp: Date.parse('2026-07-23T19:00:00+02:00'), type: 'gambling',
      title: 'Gamble', whatHappened: 'Vstupy bez plánu.',
      allocations: [
        { id: 'a1', scopeType: 'account', scopeId: 'tradeify-1', label: 'Tradeify 1', lossAmount: 600 },
        { id: 'a2', scopeType: 'account', scopeId: 'lucid', label: 'Lucid Funded', lossAmount: 500 },
      ],
    }],
  }];

  it('odečte částku přesně z vybraných účtů', () => {
    const adjustments = getFinancialAdjustments(reviews);
    expect(adjustmentTotal(adjustments)).toBe(-1100);
    expect(adjustmentForAccount(adjustments, account('tradeify-1', 'Tradeify 1'))).toBe(-600);
    expect(adjustmentForAccount(adjustments, account('lucid', 'Lucid Funded'))).toBe(-500);
  });

  it('mění skutečný P&L, ale ne WR, RR, PF ani počet obchodů', () => {
    const trades = [
      { id: 'win', accountId: 'lucid', signal: 'x', pnl: 200, riskAmount: 100, runUp: 0, drawdown: 0, date: '2026-07-23', direction: 'Long', timestamp: 1, duration: '', durationMinutes: 1 },
      { id: 'loss', accountId: 'lucid', signal: 'x', pnl: -100, riskAmount: 100, runUp: 0, drawdown: 0, date: '2026-07-23', direction: 'Short', timestamp: 2, duration: '', durationMinutes: 1 },
    ] as Trade[];
    const baseline = calculateStats(trades, 50_000);
    const withIncident = calculateStats(trades, 50_000, -500);

    expect(withIncident.tradePnL).toBe(100);
    expect(withIncident.financialAdjustments).toBe(-500);
    expect(withIncident.totalPnL).toBe(-400);
    expect(withIncident.winRate).toBe(baseline.winRate);
    expect(withIncident.avgRR).toBe(baseline.avgRR);
    expect(withIncident.profitFactor).toBe(baseline.profitFactor);
    expect(withIncident.totalTrades).toBe(baseline.totalTrades);
  });

  it('promítne incident do equity křivky ve správný den (konec křivky = skutečný P&L)', () => {
    const trades = [
      { id: 'a', accountId: 'lucid', signal: 'x', pnl: 200, riskAmount: 100, runUp: 0, drawdown: 0, date: '2026-07-22', direction: 'Long', timestamp: Date.parse('2026-07-22T10:00:00Z'), duration: '', durationMinutes: 1 },
      { id: 'b', accountId: 'lucid', signal: 'x', pnl: 100, riskAmount: 100, runUp: 0, drawdown: 0, date: '2026-07-24', direction: 'Long', timestamp: Date.parse('2026-07-24T10:00:00Z'), duration: '', durationMinutes: 1 },
    ] as Trade[];
    const events = [{ date: '2026-07-23', timestamp: Date.parse('2026-07-23T19:00:00Z'), amount: -500 }];
    const stats = calculateStats(trades, 50_000, -500, events);

    // Start + 2 tready + 1 incident, vložený chronologicky mezi ně
    expect(stats.equityCurve).toHaveLength(4);
    expect(stats.equityCurve[2].date).toBe('2026-07-23');
    expect(stats.equityCurve[2].equity).toBe(49_700); // 50 000 + 200 − 500

    // Konec křivky odpovídá skutečnému P&L (dřív končila na tradePnL)
    const last = stats.equityCurve[stats.equityCurve.length - 1];
    expect(last.equity).toBe(50_000 + stats.totalPnL);

    // Disciplinovaná křivka incident ignoruje → mezera ukazuje cenu chyby
    expect(last.validEquity).toBe(50_000 + stats.tradePnL);

    // Drawdown incident zahrnuje (reálně ztracené peníze); vrací se kladně
    expect(stats.maxDrawdown).toBe(500);
  });
});

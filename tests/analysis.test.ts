import { describe, it, expect } from 'vitest';
import { calculateStats } from '../services/analysis';
import type { Trade } from '../types';

// Minimální validní Trade s rozumnými defaulty; přepíšeš jen co test potřebuje.
let seq = 0;
const mk = (p: Partial<Trade>): Trade => {
  const date = '2026-01-05T15:00:00.000Z';
  return {
    id: `t${seq++}`, accountId: 'acc', signal: 'sig', pnl: 0, runUp: 0, drawdown: 0,
    date, direction: 'Long', timestamp: Date.parse(date), duration: '5m', durationMinutes: 5,
    executionStatus: 'Valid', isValid: true, ...p,
  } as Trade;
};

describe('calculateStats — finanční matika', () => {
  it('totalPnL sečte validní obchody', () => {
    const s = calculateStats([mk({ pnl: 100 }), mk({ pnl: -40 }), mk({ pnl: 60 })], 10000);
    expect(s.totalPnL).toBe(120);
  });

  it('winRate vyloučí break-even (pnl≈0) z čitatele i jmenovatele', () => {
    // 1 win, 1 loss, 1 BE → winRate = 1/(1+1) = 50 %
    const s = calculateStats([mk({ pnl: 100 }), mk({ pnl: -50 }), mk({ pnl: 0 })], 10000);
    expect(s.winRate).toBe(50);
  });

  it('profitFactor = grossProfit / grossLoss', () => {
    const s = calculateStats([mk({ pnl: 200 }), mk({ pnl: -100 })], 10000);
    expect(s.profitFactor).toBeCloseTo(2, 5);
  });

  // REGRESE: dřív avgRR = (grossProfit/win) / (grossLoss/loss); při 0 ztrátách → dělení nulou → NaN
  it('avgRR není NaN když nejsou žádné ztrátové obchody', () => {
    const s = calculateStats([mk({ pnl: 100 }), mk({ pnl: 200 })], 10000);
    expect(Number.isNaN(s.avgRR)).toBe(false);
    expect(s.avgRR).toBe(0);
  });

  // REGRESE: yearlyGainPct = yearlyPnl / initialBalance; při initialBalance 0 → Infinity/NaN
  it('yearlyGainPct je konečné číslo i při initialBalance = 0', () => {
    const s = calculateStats([mk({ pnl: 100 }), mk({ pnl: 50 })], 0);
    for (const y of s.monthlyBreakdown) {
      expect(Number.isFinite(y.yearlyGainPct)).toBe(true);
    }
  });

  it('Missed obchody se nezapočítají do reálného P&L', () => {
    const s = calculateStats([mk({ pnl: 100 }), mk({ pnl: 999, executionStatus: 'Missed' })], 10000);
    expect(s.totalPnL).toBe(100);
  });
});

import { describe, expect, it } from 'vitest';
import { simulateBacktestMonteCarlo } from '../services/backtestMonteCarlo';

const ordered = (first: number, second: number, balance = 100) => {
  const pnls = [first, second, ...Array(8).fill(0)];
  let sample = 0;
  return simulateBacktestMonteCarlo(pnls, balance, {
    simulations: 10, pathCount: 1, random: () => ((sample++ % 10) + 0.5) / 10,
  })!;
};

describe('backtest bootstrap ruin', () => {
  it('does not call a drawdown from earned profit ruin', () => {
    const result = ordered(200, -150);
    expect(result.paths[0].map(pnl => pnl + 100)).toEqual([100, 300, 150, 150, 150, 150, 150, 150, 150, 150, 150]);
    expect(result.ddMed).toBe(150);
    expect(result.ruinPct).toBe(0);
    expect(result.pLoss).toBe(0);
  });
  it('counts a crossed zero even if equity subsequently recovers', () => {
    const result = ordered(-150, 200);
    expect(result.p50).toBe(50);
    expect(result.pLoss).toBe(0);
    expect(result.ruinPct).toBe(100);
  });
  it('counts reaching exactly zero and distinguishes a loss above zero', () => {
    expect(ordered(-100, 100).ruinPct).toBe(100);
    expect(ordered(-99, 0).ruinPct).toBe(0);
    expect(ordered(-99, 0).pLoss).toBe(100);
  });
  it('reports unknown ruin without a starting balance and needs a sufficient finite sample', () => {
    expect(ordered(-150, 200, 0).ruinPct).toBeNull();
    expect(simulateBacktestMonteCarlo([1, 2, NaN], 100)).toBeNull();
  });
});

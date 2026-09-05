import type { Trade } from '../types';

export interface MonteCarloInput {
  pnls: number[];
  initialBalance: number;
}

/** Stabilize only the simulation's inputs; the full trade objects remain live. */
export const reuseMonteCarloInput = (
  previous: MonteCarloInput | null,
  trades: ReadonlyArray<Pick<Trade, 'pnl' | 'executionStatus'>>,
  initialBalance: number,
): MonteCarloInput => {
  // Match the simulation's existing filtering and numeric fallback exactly.
  const pnls = trades.filter(trade => trade.executionStatus !== 'Missed').map(trade => trade.pnl || 0);
  const balance = initialBalance || 0;
  if (previous
    && Object.is(previous.initialBalance, balance)
    && previous.pnls.length === pnls.length
    && pnls.every((pnl, index) => Object.is(pnl, previous.pnls[index]))) return previous;
  return { pnls, initialBalance: balance };
};

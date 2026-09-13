import type { Trade } from '../types.js';

export function sharedResultStats(trades: readonly Pick<Trade, 'pnl' | 'executionStatus'>[]) {
  const rows = trades.filter(row => row.executionStatus !== 'Missed');
  const complete = rows.length > 0 && rows.every(row => typeof row.pnl === 'number' && Number.isFinite(row.pnl));
  const wins = rows.filter(row => row.pnl > 0).length;
  const losses = rows.filter(row => row.pnl < 0).length;
  const total = complete ? rows.reduce((sum, row) => sum + row.pnl, 0) : null;
  const grossProfit = rows.reduce((sum, row) => row.pnl > 0 ? sum + row.pnl : sum, 0);
  const grossLoss = rows.reduce((sum, row) => row.pnl < 0 ? sum - row.pnl : sum, 0);
  return { count: rows.length, complete, pnl: total !== null && Number.isFinite(total) ? total : null,
    winRate: complete && wins + losses > 0 ? wins / (wins + losses) * 100 : null,
    profitFactor: complete && grossLoss > 0 ? grossProfit / grossLoss : null };
}

export const formatSharedMetric = (value: number | null | undefined, decimals = 1, suffix = '') =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(decimals)}${suffix}` : '—';

import type { Trade } from '../types';
import type { BacktestRun } from './backtestTypes';
import { buildBacktestPositionEvidence, computeBacktestRobustness } from './backtestRobustness';

/** The replay ledger is complete even when the journal's loaded date range is not.
 * Reuse the existing position identity, net-P&L and realized-DD rules. Partial
 * exits count together and an exposure still open is not a completed trade. */
export function backtestSessionStats(run: Pick<BacktestRun, 'id' | 'accountId' | 'baseCurrency' | 'runtimeState'>) {
  const rows: Trade[] = run.runtimeState.closedTrades.map(trade => ({
    id: trade.id, accountId: run.accountId, backtestRunId: trade.runId,
    instrument: trade.instrument, direction: trade.direction, pnl: trade.pnl,
    timestamp: trade.exitTime * 1000, entryTime: trade.entryTime * 1000,
    signal: '', date: '', duration: '', durationMinutes: 0, runUp: 0, drawdown: 0,
  }));
  const report = computeBacktestRobustness(rows, {
    timeZone: 'UTC', dayStartMinute: 0,
    currencyByAccount: { [run.accountId]: run.baseCurrency },
    positionEvidence: buildBacktestPositionEvidence([run]),
  });
  const wins = report.positions.filter(position => position.netPnl > 0).length;
  const losses = report.positions.filter(position => position.netPnl < 0).length;
  const count = report.positions.length;
  return {
    count, wins, losses, breakeven: count - wins - losses,
    winRate: count ? wins / count * 100 : null,
    profitFactor: report.baseline?.profitFactor ?? null,
    profitFactorState: report.baseline?.profitFactorState ?? 'no-results',
    averagePnl: report.baseline?.expectancy ?? null,
    maxDrawdown: report.baseline?.maxDrawdown ?? null,
    excludedExits: report.excludedN,
  };
}

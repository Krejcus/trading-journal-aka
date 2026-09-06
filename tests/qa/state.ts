import type { BacktestRun } from '../../services/backtestTypes';
import type { Trade } from '../../types';
export const QA_START_MS = Date.parse('2026-08-03T14:00:00Z');
export const qaState = {
  marketDelayMs: 150,
  failMarketRequests: 0,
  failLocalSaves: 0,
  marketRequests: [] as Array<{ symbol: string; schema: string; start: string; end: string; result: string }>,
  localSaves: 0,
  cloudSaves: 0,
  savedRun: null as BacktestRun | null,
  cloudRun: null as BacktestRun | null,
  trades: [] as Trade[],
};
export const notifyQa = () => window.dispatchEvent(new Event('backtest-qa-change'));
(window as any).__BACKTEST_QA__ = qaState;

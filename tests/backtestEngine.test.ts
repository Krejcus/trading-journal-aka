import { describe, expect, it } from 'vitest';
import {
  createBacktestOrder,
  createBacktestRuntime,
  enqueueBacktestOrder,
  processBacktestCandle,
} from '../services/backtestEngine';
import { DEFAULT_BACKTEST_CONFIG } from '../services/backtestTypes';

const bar = (time: number, open: number, high: number, low: number, close: number) => ({ time, open, high, low, close, volume: 1 });

describe('backtestEngine', () => {
  it('normalizes all MNQ order levels to its 0.25 tick size', () => {
    const order = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1,
      limitPrice: 100.12, stopLoss: 98.88, takeProfit: 102.13, now: 1,
    });
    expect(order).toMatchObject({ limitPrice: 100, stopLoss: 99, takeProfit: 102.25 });
  });

  it('fills a market entry and closes an MNQ bracket at target', () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 2,
      stopLoss: 99, takeProfit: 102, now: 1,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 100.5, 99.75, 100), DEFAULT_BACKTEST_CONFIG);
    expect(runtime.positions[0]).toMatchObject({ side: 'long', quantity: 2, averagePrice: 100 });
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 100, 102.25, 99.5, 101), DEFAULT_BACKTEST_CONFIG);
    expect(runtime.positions).toHaveLength(0);
    expect(runtime.closedTrades[0].grossPnl).toBe(8);
    expect(runtime.closedTrades[0].reason).toBe('take-profit');
  });

  it('uses conservative stop-first ordering when one candle touches stop and target', () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1,
      stopLoss: 99, takeProfit: 101, now: 1,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 100, 100, 100), DEFAULT_BACKTEST_CONFIG);
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 100, 101.5, 98.5, 100), DEFAULT_BACKTEST_CONFIG);
    expect(runtime.closedTrades[0]).toMatchObject({ exitPrice: 99, reason: 'stop-loss', grossPnl: -2 });
  });

  it('fills limit and stop orders only when their prices are touched', () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1, limitPrice: 99, now: 1,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 101, 99.25, 100), DEFAULT_BACKTEST_CONFIG);
    expect(runtime.positions).toHaveLength(0);
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 100, 100.5, 98.75, 99.5), DEFAULT_BACKTEST_CONFIG);
    expect(runtime.positions[0].averagePrice).toBe(99);
  });

  it('accounts for both sides of commission and supports partial exits', () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 2, now: 1,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 100, 100, 100), DEFAULT_BACKTEST_CONFIG);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'sell', type: 'market', quantity: 1, reduceOnly: true, now: 2,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 101, 101, 101, 101), DEFAULT_BACKTEST_CONFIG);
    expect(runtime.positions[0]).toMatchObject({ side: 'long', quantity: 1 });
    expect(runtime.closedTrades[0]).toMatchObject({ grossPnl: 2, commission: 0.74, pnl: 1.26 });
    expect(runtime.realizedPnl).toBeCloseTo(0.89);
    expect(runtime.balance).toBeCloseTo(50_000.89);
  });

  it('fills a gapped stop at the worse opening price', () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1, stopLoss: 99, now: 1,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 100, 100, 100), DEFAULT_BACKTEST_CONFIG);
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 98, 98.5, 97.5, 98), DEFAULT_BACKTEST_CONFIG);
    expect(runtime.closedTrades[0]).toMatchObject({ exitPrice: 98, reason: 'stop-loss', grossPnl: -4 });
  });
});

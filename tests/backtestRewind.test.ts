import { describe, expect, it } from 'vitest';
import {
  createBacktestOrder,
  createBacktestRuntime,
  enqueueBacktestOrder,
  executeBacktestMarketOrder,
  processBacktestCandles,
} from '../services/backtestEngine';
import { applyBacktestRewind, planBacktestRewind } from '../services/backtestRewind';
import { DEFAULT_BACKTEST_CONFIG, type BacktestRuntimeState } from '../services/backtestTypes';

const RUN = 'run-rewind';
const T0 = 1784016000; // 14. 7. 2026 10:00 Praha — uvnitř session
const candle = (minute: number, open: number, high: number, low: number, close: number) => ({ time: T0 + minute * 60, open, high, low, close, volume: 1 });

const marketLong = (runtime: BacktestRuntimeState, minute: number, price: number, stopLoss: number, takeProfit: number) => {
  const order = createBacktestOrder({ runId: RUN, instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1, stopLoss, takeProfit, now: T0 + minute * 60 });
  const queued = enqueueBacktestOrder(runtime, order, Date.now());
  return executeBacktestMarketOrder(queued, order.id, { time: T0 + minute * 60, close: price }, DEFAULT_BACKTEST_CONFIG);
};

describe('návrat replaye před vzatý obchod', () => {
  // Obchod A: vstup 10:01, TP 10:03. Obchod B: vstup 10:10, SL 10:12.
  let runtime = createBacktestRuntime(50_000);
  runtime = marketLong(runtime, 1, 100, 90, 110);
  runtime = processBacktestCandles(runtime, RUN, 'MNQ', [candle(2, 100, 104, 99, 103), candle(3, 103, 111, 102, 110)], DEFAULT_BACKTEST_CONFIG);
  const afterA = runtime;
  runtime = marketLong(runtime, 10, 110, 100, 130);
  runtime = processBacktestCandles(runtime, RUN, 'MNQ', [candle(11, 110, 112, 104, 105), candle(12, 105, 106, 99, 100)], DEFAULT_BACKTEST_CONFIG);

  it('smaže jen obchody nehotové do cílového času a přepočítá zůstatek', () => {
    expect(runtime.closedTrades).toHaveLength(2);
    const plan = planBacktestRewind(runtime, T0 + 5 * 60);
    expect(plan.removedTrades.map(trade => trade.entryPrice)).toEqual([110]);
    const rewound = applyBacktestRewind(runtime, plan, 50_000);
    expect(rewound.closedTrades.map(trade => trade.id)).toEqual(afterA.closedTrades.map(trade => trade.id));
    expect(rewound.balance).toBeCloseTo(afterA.balance, 6);
    expect(rewound.realizedPnl).toBeCloseTo(afterA.realizedPnl, 6);
    expect(rewound.commissions).toBeCloseTo(afterA.commissions, 6);
    expect(rewound.fills).toHaveLength(afterA.fills.length);
    expect(rewound.positions).toEqual([]);
    expect(rewound.replay).toMatchObject({ cursorTime: T0 + 5 * 60, playing: false, phase: 'active' });
  });

  it('obchod otevřený přes cílový čas zmizí celý', () => {
    const plan = planBacktestRewind(runtime, T0 + 11 * 60);
    expect(plan.removedTrades.map(trade => trade.entryPrice)).toEqual([110]);
    expect(applyBacktestRewind(runtime, plan, 50_000).closedTrades).toHaveLength(1);
  });

  it('návrat za poslední obchod nic nemaže', () => {
    expect(planBacktestRewind(runtime, T0 + 20 * 60).empty).toBe(true);
  });

  it('otevřená pozice se při návratu smaže', () => {
    const open = marketLong(runtime, 15, 100, 90, 120);
    expect(open.positions).toHaveLength(1);
    const plan = planBacktestRewind(open, T0 + 20 * 60);
    expect(plan.empty).toBe(false);
    expect(plan.removedPositions).toHaveLength(1);
    const rewound = applyBacktestRewind(open, plan, 50_000);
    expect(rewound.positions).toEqual([]);
    expect(rewound.balance).toBeCloseTo(runtime.balance, 6);
  });
});

import { describe, expect, it } from 'vitest';
import {
  createBacktestOrder,
  createBacktestRuntime,
  enqueueBacktestOrder,
  processBacktestCandle,
  processBacktestCandles,
} from '../services/backtestEngine';
import { DEFAULT_BACKTEST_CONFIG, type BacktestRuntimeState } from '../services/backtestTypes';
import type { MarketCandle } from '../services/marketData';

const START = 1_700_000_000;

const bar = (index: number, open: number, high: number, low: number, close: number): MarketCandle =>
  ({ time: START + index * 60, open, high, low, close, volume: 100 });

/**
 * Deterministický pseudonáhodný scénář: vlnící se trh, do kterého se v daných
 * minutách zadávají vstupy s brackety. Pokrývá plnění, brackety, expirace
 * i dlouhé nečinné úseky — přesně to, co dávka přeskočí.
 */
const scenario = (): { candles: MarketCandle[]; orders: Array<{ atIndex: number; side: 'buy' | 'sell' }> } => {
  const candles: MarketCandle[] = [];
  let price = 100;
  let seed = 42;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  for (let index = 0; index < 600; index += 1) {
    const drift = (random() - 0.5) * 2;
    const open = price;
    const close = price + drift;
    candles.push(bar(index, open, Math.max(open, close) + random(), Math.min(open, close) - random(), close));
    price = close;
  }
  return {
    candles,
    orders: [
      { atIndex: 5, side: 'buy' },
      { atIndex: 90, side: 'sell' },
      { atIndex: 200, side: 'buy' },
      { atIndex: 420, side: 'sell' },
    ],
  };
};

/** Id a časy jsou generované (uuid); pro porovnání je normalizujeme. */
const comparable = (runtime: BacktestRuntimeState) => JSON.parse(JSON.stringify({
  ...runtime,
  orders: runtime.orders.map(({ id, ...rest }) => rest),
  fills: runtime.fills.map(({ id, orderId, ...rest }) => rest),
  closedTrades: runtime.closedTrades.map(({ id, ...rest }) => rest),
  orderEvents: (runtime.orderEvents ?? []).map(({ id, orderId, ...rest }) => rest),
}));

const runScenario = (
  advance: (runtime: BacktestRuntimeState, candles: MarketCandle[]) => BacktestRuntimeState,
): BacktestRuntimeState => {
  const { candles, orders } = scenario();
  let runtime = createBacktestRuntime(60_000);
  let cursor = 0;
  for (const order of orders) {
    runtime = advance(runtime, candles.slice(cursor, order.atIndex));
    cursor = order.atIndex;
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'r', instrument: 'MNQ', side: order.side, type: 'market', quantity: 1,
      stopLoss: order.side === 'buy' ? candles[order.atIndex].open - 3 : candles[order.atIndex].open + 3,
      takeProfit: order.side === 'buy' ? candles[order.atIndex].open + 5 : candles[order.atIndex].open - 5,
      now: candles[order.atIndex].time,
    }));
  }
  return advance(runtime, candles.slice(cursor));
};

describe('processBacktestCandles', () => {
  it('je ekvivalentní sekvenčnímu zpracování svíčku po svíčce', () => {
    const sequential = runScenario((runtime, candles) =>
      candles.reduce((state, candle) =>
        processBacktestCandle(state, 'r', 'MNQ', candle, DEFAULT_BACKTEST_CONFIG), runtime));
    const batched = runScenario((runtime, candles) =>
      processBacktestCandles(runtime, 'r', 'MNQ', candles, DEFAULT_BACKTEST_CONFIG));

    // Scénář musí být netriviální, jinak test nic nedokazuje.
    expect(sequential.closedTrades.length).toBeGreaterThan(0);
    expect(sequential.fills.length).toBeGreaterThan(0);
    expect(comparable(batched)).toEqual(comparable(sequential));
  });

  it('nečinný úsek vrací stav se sdílenými poli a čerstvým mark-to-market', () => {
    const runtime = createBacktestRuntime(60_000);
    const candles = Array.from({ length: 200 }, (_, index) => bar(index, 100, 101, 99, 100 + index * 0.01));
    const next = processBacktestCandles(runtime, 'r', 'MNQ', candles, DEFAULT_BACKTEST_CONFIG);
    // Bez pozice a objednávek se pole nekopírují — identita se zachová.
    expect(next.orders).toBe(runtime.orders);
    expect(next.fills).toBe(runtime.fills);
    expect(next.closedTrades).toBe(runtime.closedTrades);
    expect(next.equity).toBe(next.balance);
  });

  it('prázdná dávka vrací identický stav', () => {
    const runtime = createBacktestRuntime(60_000);
    expect(processBacktestCandles(runtime, 'r', 'MNQ', [], DEFAULT_BACKTEST_CONFIG)).toBe(runtime);
  });
});

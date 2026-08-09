import { describe, expect, it } from 'vitest';
import {
  cancelBacktestOrder,
  clearPendingBacktestOrderBracket,
  createBacktestOrder,
  createBacktestRuntime,
  enqueueBacktestOrder,
  processBacktestCandle,
  updatePendingBacktestOrder,
  updatePositionBracket,
} from '../services/backtestEngine';
import { DEFAULT_BACKTEST_CONFIG } from '../services/backtestTypes';
import { composeReplayAnalysisCandles, type MarketCandle } from '../services/marketData';

const bar = (time: number, open: number, high: number, low: number, close: number) => ({ time, open, high, low, close, volume: 1 });

describe('backtestEngine', () => {
  it('keeps execution and closed-trade economics bit-identical when older context is prepended', () => {
    const revealed: MarketCandle[] = [
      bar(1_000, 100, 100.5, 99.75, 100),
      bar(1_060, 100, 101, 99.5, 100.75),
      bar(1_120, 100.75, 102.25, 100.5, 102),
    ];
    const shortContext = [bar(880, 97, 98, 96, 97.5)];
    const longContext = [
      bar(760, 95, 96, 94, 95.5),
      bar(820, 95.5, 97.25, 95, 97),
      ...shortContext,
    ];

    const simulate = (historicalContext: MarketCandle[]) => {
      // The chart may analyse any amount of immutable pre-session context, but
      // the order engine must consume only the revealed 1m execution stream.
      const analysis = composeReplayAnalysisCandles({
        historicalMinute: historicalContext,
        revealedMinute: revealed,
        timeframe: '1m',
        replayStartSeconds: 1_000,
      });
      expect(analysis.slice(-revealed.length)).toEqual(revealed);

      let runtime = createBacktestRuntime(50_000);
      runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
        runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 2,
        stopLoss: 99, takeProfit: 102, now: 999,
      }));
      for (const candle of revealed) {
        runtime = processBacktestCandle(runtime, 'run', 'MNQ', candle, DEFAULT_BACKTEST_CONFIG);
      }
      return {
        balance: runtime.balance,
        equity: runtime.equity,
        realizedPnl: runtime.realizedPnl,
        unrealizedPnl: runtime.unrealizedPnl,
        commissions: runtime.commissions,
        orders: runtime.orders.map(({ id: _id, ...order }) => order),
        fills: runtime.fills.map(({ id: _id, orderId: _orderId, ...fill }) => fill),
        positions: runtime.positions.map(({ entryFillIds: _entryFillIds, ...position }) => position),
        closedTrades: runtime.closedTrades.map(({ id: _id, ...trade }) => trade),
      };
    };

    expect(simulate(longContext)).toEqual(simulate(shortContext));
  });

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

  it('moves pending entry and bracket levels on the MNQ tick grid', () => {
    let runtime = createBacktestRuntime(50_000);
    const order = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 2,
      limitPrice: 100, stopLoss: 98, takeProfit: 104, now: 1,
    });
    runtime = enqueueBacktestOrder(runtime, order);
    runtime = updatePendingBacktestOrder(runtime, order.id, 'entry', 99.62, 2);
    runtime = updatePendingBacktestOrder(runtime, order.id, 'stopLoss', 97.88, 3);
    runtime = updatePendingBacktestOrder(runtime, order.id, 'takeProfit', 105.12, 4);
    expect(runtime.orders[0]).toMatchObject({
      limitPrice: 99.5,
      stopLoss: 98,
      takeProfit: 105,
      updatedAt: 4,
    });
  });

  it('removes one position bracket without changing the other', () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1,
      stopLoss: 98, takeProfit: 104, now: 1,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 100, 100, 100), DEFAULT_BACKTEST_CONFIG);

    runtime = updatePositionBracket(runtime, 'MNQ', undefined, 104);

    expect(runtime.positions[0]).toMatchObject({ takeProfit: 104 });
    expect(runtime.positions[0].stopLoss).toBeUndefined();
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

describe('excursion a riziko uzavřeného obchodu', () => {
  const longWithStop = () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1,
      stopLoss: 98, takeProfit: 104, now: 1,
    }));
    return processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 100, 100, 100), DEFAULT_BACKTEST_CONFIG);
  };

  it('spočítá 1R z vstupního stop lossu', () => {
    let runtime = longWithStop();
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 100, 104, 99, 104), DEFAULT_BACKTEST_CONFIG);
    // |100 − 98| × $2/bod × 1 kontrakt
    expect(runtime.closedTrades[0].riskAmount).toBe(4);
    expect(runtime.closedTrades[0].initialStopLoss).toBe(98);
    expect(runtime.closedTrades[0].initialTakeProfit).toBe(104);
  });

  it('sleduje MFE i MAE přes svíčky, na kterých pozice žila', () => {
    let runtime = longWithStop();
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 100, 102, 99, 101), DEFAULT_BACKTEST_CONFIG);
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(3, 101, 104, 100.5, 104), DEFAULT_BACKTEST_CONFIG);
    const trade = runtime.closedTrades[0];
    expect(trade.mfePoints).toBe(4);
    expect(trade.maePoints).toBe(1);
    expect(trade.mfeR).toBe(2);
    expect(trade.maeR).toBe(0.5);
  });

  it('nezapočítá do MAE pohyb ze vstupní svíčky', () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1,
      stopLoss: 90, takeProfit: 104, now: 1,
    }));
    // Vstupní svíčka sahá hluboko dolů, ale fill padl na close — ten pohyb
    // proběhl ještě před vstupem.
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 100, 95, 100), DEFAULT_BACKTEST_CONFIG);
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 100, 104, 99, 104), DEFAULT_BACKTEST_CONFIG);
    expect(runtime.closedTrades[0].maePoints).toBe(1);
  });

  it('svíčka, která trefí stopku, se do MAE ještě promítne', () => {
    let runtime = longWithStop();
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 100, 100.5, 97, 98), DEFAULT_BACKTEST_CONFIG);
    expect(runtime.closedTrades[0]).toMatchObject({ reason: 'stop-loss', maePoints: 3, maeR: 1.5 });
  });

  it('bez stop lossu zůstane riziko i R metriky nedostupné', () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1, now: 1,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 100, 100, 100), DEFAULT_BACKTEST_CONFIG);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'sell', type: 'market', quantity: 1, reduceOnly: true, now: 2,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 101, 102, 100, 101), DEFAULT_BACKTEST_CONFIG);
    const trade = runtime.closedTrades[0];
    expect(trade.riskAmount).toBeUndefined();
    expect(trade.mfeR).toBeUndefined();
    // Extrémy v bodech se počítají dál — jen se nedají převést na R.
    expect(trade.mfePoints).toBe(2);
  });
});

describe('journal objednávek', () => {
  const kinds = (runtime: { orderEvents?: { kind: string }[] }) => (runtime.orderEvents ?? []).map(event => event.kind);

  it('zapíše vznik, posun i zrušení objednávky', () => {
    let runtime = createBacktestRuntime(50_000);
    const order = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1,
      limitPrice: 100, stopLoss: 98, now: 1,
    });
    runtime = enqueueBacktestOrder(runtime, order, 1_700_000_000_000);
    runtime = updatePendingBacktestOrder(runtime, order.id, 'stopLoss', 99, 2, 1_700_000_005_000);
    runtime = cancelBacktestOrder(runtime, order.id, 3, 1_700_000_009_000);
    expect(kinds(runtime)).toEqual(['created', 'stop-moved', 'cancelled']);
    expect(runtime.orderEvents?.[1]).toMatchObject({ price: 99, previousPrice: 98, marketTime: 2, recordedAt: 1_700_000_005_000 });
  });

  it('posun, který cenu nemění, se nezapisuje', () => {
    let runtime = createBacktestRuntime(50_000);
    const order = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1, now: 1,
    });
    runtime = enqueueBacktestOrder(runtime, order);
    // Tržní objednávka nemá vstupní cenu, kterou by šlo táhnout.
    runtime = updatePendingBacktestOrder(runtime, order.id, 'entry', 105, 2);
    expect(kinds(runtime)).toEqual(['created']);
  });

  it('smazání bracketu nese původní cenu', () => {
    let runtime = createBacktestRuntime(50_000);
    const order = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1,
      limitPrice: 100, takeProfit: 110, now: 1,
    });
    runtime = enqueueBacktestOrder(runtime, order);
    runtime = clearPendingBacktestOrderBracket(runtime, order.id, 'takeProfit', 2);
    expect(runtime.orderEvents?.at(-1)).toMatchObject({ kind: 'target-cleared', previousPrice: 110 });
  });

  it('posun bracketu na otevřené pozici se zapíše jen se známým časem svíčky', () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1,
      stopLoss: 98, takeProfit: 104, now: 1,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 100, 100, 100), DEFAULT_BACKTEST_CONFIG);
    const before = (runtime.orderEvents ?? []).length;
    expect(updatePositionBracket(runtime, 'MNQ', 99, 104).orderEvents).toHaveLength(before);
    runtime = updatePositionBracket(runtime, 'MNQ', 99, 104, 2, 1_700_000_000_000);
    expect(runtime.orderEvents?.at(-1)).toMatchObject({
      kind: 'position-stop-moved', price: 99, previousPrice: 98, orderId: 'position:MNQ',
    });
  });

  it('fill se zapíše i pro bracketový výstup', () => {
    let runtime = createBacktestRuntime(50_000);
    runtime = enqueueBacktestOrder(runtime, createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1,
      stopLoss: 98, takeProfit: 104, now: 1,
    }));
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(1, 100, 100, 100, 100), DEFAULT_BACKTEST_CONFIG);
    runtime = processBacktestCandle(runtime, 'run', 'MNQ', bar(2, 100, 104, 100, 104), DEFAULT_BACKTEST_CONFIG);
    expect(kinds(runtime)).toEqual(['created', 'filled', 'filled']);
  });
});

describe('clearPendingBacktestOrderBracket', () => {
  const pending = () => {
    const order = createBacktestOrder({
      runId: 'run', instrument: 'MNQ', side: 'buy', type: 'limit', quantity: 1,
      limitPrice: 100, stopLoss: 95, takeProfit: 110, now: 1,
    });
    return {
      runtime: { orders: [order], positions: [], fills: [], closedTrades: [] } as never,
      id: order.id,
    };
  };

  it('smaže jen zvolený bracket, objednávka zůstane', () => {
    const { runtime, id } = pending();
    const next = clearPendingBacktestOrderBracket(runtime, id, 'stopLoss', 2);
    const order = next.orders[0];
    expect(order.status).toBe('pending');
    expect(order.stopLoss).toBeUndefined();
    expect(order.takeProfit).toBe(110);
  });

  it('nesahá na cizí objednávku', () => {
    const { runtime } = pending();
    const next = clearPendingBacktestOrderBracket(runtime, 'jina', 'stopLoss', 2);
    expect(next.orders[0].stopLoss).toBe(95);
  });
});

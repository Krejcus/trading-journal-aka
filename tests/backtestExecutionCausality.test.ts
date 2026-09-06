import { describe, expect, it } from 'vitest';
import {
  createBacktestOrder, createBacktestRuntime, enqueueBacktestOrder,
  executeBacktestMarketOrder, processBacktestCandle, processBacktestCandles,
  updatePositionBracket,
} from '../services/backtestEngine';
import { DEFAULT_BACKTEST_CONFIG, type BacktestRunConfig, type BacktestRuntimeState } from '../services/backtestTypes';
import type { NewBacktestOrder } from '../services/backtestEngine';
import type { MarketCandle } from '../services/marketData';
import { managedPositionBoxes } from '../services/backtestManagedPosition';
import { tradeManagementStats } from '../services/backtestOrderJournal';

const TIME = Date.UTC(2026, 7, 10, 12) / 1_000;
const bar = (index: number, open: number, high: number, low: number, close: number): MarketCandle =>
  ({ time: TIME + index * 60, open, high, low, close, volume: 100 });
const order = (input: Partial<NewBacktestOrder>) => createBacktestOrder({
  runId: 'r', instrument: 'MNQ', side: 'buy', type: 'market', quantity: 1, now: TIME, ...input,
});
const step = (runtime: BacktestRuntimeState, candle: MarketCandle, config = DEFAULT_BACKTEST_CONFIG) =>
  processBacktestCandle(runtime, 'r', 'MNQ', candle, config);
const market = (runtime: BacktestRuntimeState, input: Partial<NewBacktestOrder>, candle = bar(0, 100, 100, 100, 100), config = DEFAULT_BACKTEST_CONFIG) => {
  const submitted = order({ ...input, type: 'market', now: candle.time });
  return executeBacktestMarketOrder(enqueueBacktestOrder(runtime, submitted), submitted.id, candle, config);
};
const economics = (runtime: BacktestRuntimeState) => JSON.parse(JSON.stringify(runtime, (key, value) =>
  ['id', 'orderId', 'positionId', 'closedPositionId', 'exitOrderId', 'entryFillIds'].includes(key) ? undefined : value));

describe('causal execution on an entry candle', () => {
  it.each([
    { label: 'long limit then certain SL', input: { side: 'buy', type: 'limit', limitPrice: 99, stopLoss: 98, takeProfit: 104 }, candle: bar(1, 100, 100, 96, 97), price: 98, reason: 'stop-loss' },
    { label: 'short limit then certain SL', input: { side: 'sell', type: 'limit', limitPrice: 101, stopLoss: 102, takeProfit: 96 }, candle: bar(1, 100, 104, 100, 103), price: 102, reason: 'stop-loss' },
    { label: 'long stop then certain TP', input: { side: 'buy', type: 'stop', stopPrice: 101, stopLoss: 98, takeProfit: 102 }, candle: bar(1, 100, 104, 100, 103), price: 102, reason: 'take-profit' },
    { label: 'short stop then certain TP', input: { side: 'sell', type: 'stop', stopPrice: 99, stopLoss: 102, takeProfit: 98 }, candle: bar(1, 100, 100, 96, 97), price: 98, reason: 'take-profit' },
  ] as const)('$label', ({ input, candle, price, reason }) => {
    const result = step(enqueueBacktestOrder(createBacktestRuntime(10_000), order(input)), candle);
    expect(result.positions).toHaveLength(0);
    expect(result.closedTrades).toHaveLength(1);
    expect(result.closedTrades[0]).toMatchObject({ exitTime: candle.time, exitPrice: price, reason });
    expect(result.closedTrades[0].outcomeAmbiguous).toBeUndefined();
    expect(result.commissions).toBeCloseTo(0.74);
  });

  it('never lets the certain stopped limit become a later winner', () => {
    const submitted = order({ type: 'limit', limitPrice: 99, stopLoss: 98, takeProfit: 104 });
    const runtime = processBacktestCandles(enqueueBacktestOrder(createBacktestRuntime(10_000), submitted), 'r', 'MNQ', [
      bar(1, 100, 100, 96, 97), bar(2, 100, 104, 100, 104),
    ], DEFAULT_BACKTEST_CONFIG);
    expect(runtime.closedTrades).toHaveLength(1);
    expect(runtime.closedTrades[0].pnl).toBeCloseTo(-2.74);
  });

  it.each([
    { side: 'buy', type: 'stop', stopPrice: 101, stopLoss: 99, takeProfit: 103 },
    { side: 'sell', type: 'stop', stopPrice: 99, stopLoss: 101, takeProfit: 97 },
  ] as const)('marks a possible entry-bar SL before/after TP for $side as ambiguous', input => {
    const result = step(enqueueBacktestOrder(createBacktestRuntime(10_000), order(input)), bar(1, 100, 104, 96, 100));
    expect(result.closedTrades[0]).toMatchObject({ reason: 'stop-loss', outcomeAmbiguous: true });
  });

  it('does not credit a target touch that may precede the limit entry; carries uncertainty forward', () => {
    let runtime = enqueueBacktestOrder(createBacktestRuntime(10_000), order({ type: 'limit', limitPrice: 99, stopLoss: 97, takeProfit: 102 }));
    runtime = step(runtime, bar(1, 100, 103, 98, 100));
    expect(runtime.closedTrades).toHaveLength(0);
    expect(runtime.positions[0]).toMatchObject({ outcomeAmbiguous: true });
    runtime = step(runtime, bar(2, 100, 102, 100, 102));
    expect(runtime.closedTrades[0]).toMatchObject({ reason: 'take-profit', outcomeAmbiguous: true });
  });

  it('uses the close to prove a target crossing after a limit entry', () => {
    const runtime = step(enqueueBacktestOrder(createBacktestRuntime(10_000), order({ type: 'limit', limitPrice: 99, stopLoss: 97, takeProfit: 102 })), bar(1, 100, 103, 98, 102.5));
    expect(runtime.closedTrades[0]).toMatchObject({ reason: 'take-profit', exitPrice: 102 });
    expect(runtime.closedTrades[0].outcomeAmbiguous).toBeUndefined();
  });

  it.each([
    { label: 'limit gap through stop', input: { type: 'limit', limitPrice: 99, stopLoss: 98, takeProfit: 104 }, candle: bar(1, 97, 100, 96, 98), price: 97, reason: 'stop-loss' },
    { label: 'stop gap through target', input: { type: 'stop', stopPrice: 101, stopLoss: 99, takeProfit: 103 }, candle: bar(1, 104, 105, 98, 100), price: 104, reason: 'take-profit' },
  ] as const)('$label is resolved at entry/open without later-bar ambiguity', ({ input, candle, price, reason }) => {
    const runtime = step(enqueueBacktestOrder(createBacktestRuntime(10_000), order(input)), candle);
    expect(runtime.closedTrades[0]).toMatchObject({ exitPrice: price, reason });
    expect(runtime.closedTrades[0].outcomeAmbiguous).toBeUndefined();
    expect(runtime.closedTrades[0].excursionAmbiguous).toBeUndefined();
  });

  it('will not trigger newly placed or moved resting orders on an already revealed candle', () => {
    const runtime = enqueueBacktestOrder(createBacktestRuntime(10_000), order({ type: 'limit', limitPrice: 99 }));
    expect(step(runtime, bar(0, 100, 102, 98, 100)).fills).toHaveLength(0);
  });
});

describe('resting orders that must precede an existing bracket', () => {
  it.each([[99.5, 99], [99, 99.5]])('fills two resting limits before their common stop independently of submission order (%s, %s)', (first, second) => {
    let runtime = createBacktestRuntime(10_000);
    runtime = enqueueBacktestOrder(runtime, order({ type: 'limit', limitPrice: first, stopLoss: 98 }));
    runtime = enqueueBacktestOrder(runtime, order({ type: 'limit', limitPrice: second, stopLoss: 98 }));
    runtime = step(runtime, bar(1, 100, 100, 97, 97));
    expect(runtime.positions).toHaveLength(0);
    expect(runtime.closedTrades).toHaveLength(1);
    expect(runtime.closedTrades[0]).toMatchObject({ quantity: 2, entryPrice: 99.25, exitPrice: 98, grossPnl: -5 });
    expect(runtime.closedTrades[0].outcomeAmbiguous).toBeUndefined();
  });

  it.each([
    { side: 'buy', stopLoss: 98, input: { side: 'buy', type: 'limit', limitPrice: 99 }, candle: bar(1, 100, 100, 97, 97), price: 98 },
    { side: 'sell', stopLoss: 102, input: { side: 'sell', type: 'limit', limitPrice: 101 }, candle: bar(1, 100, 103, 100, 103), price: 102 },
  ] as const)('fills a $side scale-in before stopping the combined quantity', ({ side, stopLoss, input, candle, price }) => {
    const original = market(createBacktestRuntime(10_000), { side, stopLoss });
    const runtime = step(enqueueBacktestOrder(original, order(input)), candle);
    expect(runtime.positions).toHaveLength(0);
    expect(runtime.closedTrades).toHaveLength(1);
    expect(runtime.closedTrades[0]).toMatchObject({ quantity: 2, exitPrice: price, grossPnl: -6, reason: 'stop-loss' });
    expect(runtime.closedTrades[0].outcomeAmbiguous).toBeUndefined();
    expect(runtime.commissions).toBeCloseTo(1.48);
  });

  it.each([
    { side: 'buy', stopLoss: 98, input: { side: 'sell', type: 'stop', stopPrice: 99 }, candle: bar(1, 100, 100, 97, 97) },
    { side: 'sell', stopLoss: 102, input: { side: 'buy', type: 'stop', stopPrice: 101 }, candle: bar(1, 100, 103, 100, 103) },
  ] as const)('reduces the $side exposure at the nearer pending exit before SL closes the remainder', ({ side, stopLoss, input, candle }) => {
    const original = market(createBacktestRuntime(10_000), { side, stopLoss, quantity: 2 });
    const runtime = step(enqueueBacktestOrder(original, order({ ...input, reduceOnly: true })), candle);
    expect(runtime.positions).toHaveLength(0);
    expect(runtime.closedTrades.map(trade => [trade.quantity, trade.grossPnl, trade.reason])).toEqual([
      [1, -2, 'manual'], [1, -4, 'stop-loss'],
    ]);
    expect(runtime.commissions).toBeCloseTo(1.48);
    expect(tradeManagementStats(runtime.orderEvents ?? [], runtime.closedTrades[1]).partialExits).toBe(1);
  });

  it.each([
    { side: 'buy', stopLoss: 98, input: { side: 'sell', type: 'stop', stopPrice: 99, stopLoss: 101, takeProfit: 97 }, candle: bar(1, 100, 100, 96, 97) },
    { side: 'sell', stopLoss: 102, input: { side: 'buy', type: 'stop', stopPrice: 101, stopLoss: 99, takeProfit: 103 }, candle: bar(1, 100, 104, 100, 103) },
  ] as const)('handles a $side reversal before the old stop without applying the old bracket to its new side', ({ side, stopLoss, input, candle }) => {
    const original = market(createBacktestRuntime(10_000), { side, stopLoss });
    const runtime = step(enqueueBacktestOrder(original, order({ ...input, quantity: 2 })), candle);
    expect(runtime.positions).toHaveLength(0);
    expect(runtime.closedTrades.map(trade => [trade.grossPnl, trade.reason])).toEqual([[-2, 'order'], [4, 'take-profit']]);
    expect(runtime.closedTrades[0].positionId).not.toBe(runtime.closedTrades[1].positionId);
    expect(runtime.closedTrades.every(trade => !trade.outcomeAmbiguous)).toBe(true);
    expect(runtime.balance).toBeCloseTo(10_000.52);
  });

  it('labels competing triggers on opposite sides instead of claiming an exact order', () => {
    const original = market(createBacktestRuntime(10_000), { stopLoss: 98 });
    const runtime = step(enqueueBacktestOrder(original, order({ type: 'stop', stopPrice: 101 })), bar(1, 100, 102, 97, 99));
    expect(runtime.closedTrades[0].outcomeAmbiguous).toBe(true);
    expect(runtime.positions[0].outcomeAmbiguous).toBe(true);
  });

  it('carries a conditional predecessor reversal outcome into its new side', () => {
    const original = market(createBacktestRuntime(10_000), { stopLoss: 98, takeProfit: 104 });
    const runtime = step(enqueueBacktestOrder(original, order({ side: 'sell', type: 'stop', stopPrice: 99,
      quantity: 2, stopLoss: 106, takeProfit: 97 })), bar(1, 100, 105, 96, 97));
    expect(runtime.closedTrades).toHaveLength(2);
    expect(runtime.closedTrades[1].reason).toBe('take-profit');
    expect(runtime.closedTrades.every(trade => trade.outcomeAmbiguous === true)).toBe(true);
  });

  it.each([
    { side: 'buy', exitSide: 'sell', price: 101, candle: bar(1, 100, 105, 100, 104) },
    { side: 'sell', exitSide: 'buy', price: 99, candle: bar(1, 100, 100, 95, 96) },
  ] as const)('bounds $side excursion at a resting manual limit exit without a touched bracket', ({ side, exitSide, price, candle }) => {
    const original = market(createBacktestRuntime(10_000), { side });
    const runtime = step(enqueueBacktestOrder(original, order({ side: exitSide, type: 'limit', limitPrice: price, reduceOnly: true })), candle);
    expect(runtime.positions).toHaveLength(0);
    expect(runtime.closedTrades[0]).toMatchObject({ reason: 'manual', exitPrice: price, mfePoints: 1, maePoints: 0 });
    expect(runtime.closedTrades[0].excursionAmbiguous).toBeUndefined();
  });
});

describe('quote-only market actions and reduction accounting', () => {
  it('leaves an unrelated fresh limit pending and never replays historical SL on close', () => {
    const candle = bar(0, 100, 102, 98, 100);
    const limit = order({ type: 'limit', limitPrice: 99 });
    let runtime = enqueueBacktestOrder(createBacktestRuntime(10_000), limit);
    runtime = market(runtime, { stopLoss: 99 }, candle);
    expect(runtime.orders.find(item => item.id === limit.id)?.status).toBe('pending');
    expect(runtime.positions[0]).toMatchObject({ quantity: 1, averagePrice: 100 });
    runtime = market(runtime, { side: 'sell', reduceOnly: true }, candle);
    expect(runtime.closedTrades[0]).toMatchObject({ reason: 'manual', exitPrice: 100 });
    expect(runtime.fills).toHaveLength(2);
    expect(runtime.balance).toBeCloseTo(9_999.26);
    expect(runtime.orders.find(item => item.id === limit.id)?.status).toBe('pending');
  });

  it.each(['buy', 'sell'] as const)('caps a %s position reduction and creates no ghost fee when already flat', side => {
    const exitSide = side === 'buy' ? 'sell' : 'buy';
    let runtime = market(createBacktestRuntime(10_000), { side });
    runtime = market(runtime, { side: exitSide, quantity: 5, reduceOnly: true });
    expect(runtime.fills[1]).toMatchObject({ quantity: 1, commission: 0.37 });
    expect(runtime.closedTrades[0]).toMatchObject({ quantity: 1, commission: 0.74 });
    const before = runtime.balance;
    runtime = market(runtime, { side: exitSide, quantity: 5, reduceOnly: true });
    expect(runtime.fills).toHaveLength(2);
    expect(runtime.balance).toBe(before);
    expect(runtime.orders.at(-1)?.status).toBe('cancelled');
  });

  it('rejects a same-side reduce-only fill and does not mutate earlier snapshots', () => {
    const before = market(createBacktestRuntime(10_000), { side: 'buy' });
    const snapshot = JSON.stringify(before);
    const after = market(before, { side: 'buy', reduceOnly: true });
    expect(after.fills).toHaveLength(1);
    expect(after.commissions).toBe(before.commissions);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('is idempotent for an already executed market order', () => {
    const submitted = order({});
    const before = executeBacktestMarketOrder(enqueueBacktestOrder(createBacktestRuntime(10_000), submitted), submitted.id, bar(0, 100, 100, 100, 100), DEFAULT_BACKTEST_CONFIG);
    expect(executeBacktestMarketOrder(before, submitted.id, bar(0, 100, 110, 90, 100), DEFAULT_BACKTEST_CONFIG)).toBe(before);
  });
});

describe('bounded excursions and target limit pricing', () => {
  it.each([
    { side: 'buy', stopLoss: 98, takeProfit: 104, candle: bar(1, 100, 120, 100, 119) },
    { side: 'sell', stopLoss: 102, takeProfit: 96, candle: bar(1, 100, 100, 80, 81) },
  ] as const)('excludes certain post-target extremes for $side and retains exact metrics', ({ side, stopLoss, takeProfit, candle }) => {
    const runtime = step(market(createBacktestRuntime(10_000), { side, stopLoss, takeProfit }), candle);
    expect(runtime.closedTrades[0]).toMatchObject({ mfePoints: 4, maePoints: 0, mfeR: 2, maeR: 0 });
    expect(runtime.closedTrades[0].excursionAmbiguous).toBeUndefined();
  });

  it('labels unknown pre-exit adverse excursion as a lower bound', () => {
    const runtime = step(market(createBacktestRuntime(10_000), { stopLoss: 98, takeProfit: 104 }), bar(1, 100, 120, 99, 119));
    expect(runtime.closedTrades[0]).toMatchObject({ mfePoints: 4, maePoints: 0, excursionAmbiguous: true });
  });

  it('includes the provable portion of an entry candle that remains open', () => {
    const runtime = step(enqueueBacktestOrder(createBacktestRuntime(10_000), order({ type: 'limit', limitPrice: 99, stopLoss: 98, takeProfit: 104 })), bar(1, 100, 101, 98.5, 100.5));
    expect(runtime.positions[0]).toMatchObject({ maxFavorablePrice: 100.5, maxAdversePrice: 98.5, excursionAmbiguous: true });
  });

  it.each(['buy', 'sell'] as const)('never fills the %s target worse than its limit under slippage', side => {
    const config: BacktestRunConfig = { ...DEFAULT_BACKTEST_CONFIG, slippageTicks: { MNQ: 1, NQ: 1 } };
    const target = side === 'buy' ? 104 : 96;
    const runtime = step(market(createBacktestRuntime(10_000), { side, takeProfit: target }, bar(0, 100, 100, 100, 100), config), bar(1, 100, 105, 95, 100), config);
    expect(runtime.closedTrades[0].exitPrice).toBe(target);
  });

  it.each([
    { side: 'buy', stopLoss: 98, takeProfit: 104, candle: bar(1, 106, 107, 97, 100), price: 106 },
    { side: 'sell', stopLoss: 102, takeProfit: 96, candle: bar(1, 94, 103, 93, 100), price: 94 },
  ] as const)('a $side target already marketable at open wins over a later SL', ({ side, stopLoss, takeProfit, candle, price }) => {
    const runtime = step(market(createBacktestRuntime(10_000), { side, stopLoss, takeProfit }), candle);
    expect(runtime.closedTrades[0]).toMatchObject({ reason: 'take-profit', exitPrice: price });
    expect(runtime.closedTrades[0].outcomeAmbiguous).toBeUndefined();
  });
});

describe('position lifecycle and management', () => {
  it('keeps all scale-in boxes alive through partial exits and freezes both on final exit', () => {
    let runtime = market(createBacktestRuntime(10_000), { quantity: 2 });
    runtime = market(runtime, { quantity: 1 }, bar(1, 101, 101, 101, 101));
    runtime.managedPositionPlans = runtime.orders.map(item => ({
      id: `plan-${item.id}`, orderId: item.id, instrument: 'MNQ', tool: 'LongPosition', startTime: item.createdAt,
      entryPrice: 100, targetPrice: 104, stopPrice: 98, style: { color: '#888888', width: 1, dashed: false, fill: null },
    }));
    expect(runtime.positions[0].entryFillIds).toHaveLength(2);
    const positionId = runtime.positions[0].positionId;
    expect(positionId).toBe(runtime.orders[0].id);
    expect(runtime.fills.map(fill => fill.positionId)).toEqual([positionId, positionId]);
    runtime = market(runtime, { side: 'sell', quantity: 1, reduceOnly: true }, bar(2, 102, 102, 102, 102));
    expect(managedPositionBoxes(runtime).map(box => box.state)).toEqual(['active', 'active']);
    runtime = market(runtime, { side: 'sell', quantity: 2, reduceOnly: true }, bar(3, 103, 103, 103, 103));
    expect(runtime.closedTrades.map(trade => trade.positionId)).toEqual([positionId, positionId]);
    expect(new Set(runtime.closedTrades.map(trade => trade.exitOrderId)).size).toBe(2);
    expect(new Set(runtime.closedTrades.map(trade => trade.id)).size).toBe(2);
    expect(managedPositionBoxes(runtime).map(box => [box.state, box.terminalTime])).toEqual([
      ['closed', TIME + 180], ['closed', TIME + 180],
    ]);
    const legacy: BacktestRuntimeState = {
      ...runtime,
      fills: runtime.fills.map(({ positionId: _positionId, closedPositionId: _closedPositionId, ...fill }) => fill),
      closedTrades: runtime.closedTrades.map(({ positionId: _positionId, exitOrderId: _exitOrderId, ...trade }) => trade),
    };
    expect(managedPositionBoxes(legacy).map(box => [box.state, box.terminalTime])).toEqual([
      ['closed', TIME + 180], ['closed', TIME + 180],
    ]);
    const reopened = market(runtime, { quantity: 1 }, bar(4, 104, 104, 104, 104));
    expect(reopened.positions[0].positionId).not.toBe(positionId);
    expect(managedPositionBoxes(reopened).every(box => box.state === 'closed')).toBe(true);
  });

  it('keeps reversal fees and old/new position identities separate without a false partial exit', () => {
    let runtime = market(createBacktestRuntime(10_000), { side: 'buy', quantity: 2 });
    const originalId = runtime.positions[0].positionId;
    runtime = market(runtime, { side: 'sell', quantity: 3 }, bar(1, 101, 101, 101, 101));
    const oldTrade = runtime.closedTrades[0];
    const reversedId = runtime.positions[0].positionId;
    expect(runtime.positions[0]).toMatchObject({ side: 'short', quantity: 1 });
    expect(runtime.positions[0].entryCommission).toBeCloseTo(0.37);
    expect(reversedId).not.toBe(originalId);
    expect(runtime.fills[1]).toMatchObject({ quantity: 3, closedPositionId: originalId, positionId: reversedId });
    expect(oldTrade).toMatchObject({ positionId: originalId, quantity: 2, grossPnl: 4, commission: 1.48 });
    expect(tradeManagementStats(runtime.orderEvents ?? [], oldTrade).partialExits).toBe(0);
    runtime = market(runtime, { side: 'buy', quantity: 1, reduceOnly: true }, bar(2, 100, 100, 100, 100));
    expect(runtime.closedTrades[1]).toMatchObject({ positionId: reversedId, quantity: 1, grossPnl: 2 });
    expect(runtime.closedTrades[1].commission).toBeCloseTo(0.74);
    expect(runtime.balance - 10_000).toBeCloseTo(runtime.closedTrades.reduce((sum, trade) => sum + trade.pnl, 0));
    expect(runtime.commissions).toBeCloseTo(2.22);
  });

  it('distinguishes same-minute scale-in, partial exit and final exit in the journal', () => {
    let runtime = market(createBacktestRuntime(10_000), { quantity: 2 });
    runtime = market(runtime, { quantity: 1 });
    runtime = market(runtime, { side: 'sell', quantity: 1, reduceOnly: true });
    runtime = updatePositionBracket(runtime, 'MNQ', 99, 104, TIME);
    runtime = market(runtime, { side: 'sell', quantity: 2, reduceOnly: true });
    const closed = runtime.closedTrades[1];
    const stats = tradeManagementStats(runtime.orderEvents ?? [], closed);
    expect(stats).toMatchObject({ partialExits: 1, stopMoves: 1, label: 'partial_runner' });
    // A later, same-minute independent position must not contaminate it.
    runtime = market(runtime, { quantity: 2 });
    runtime = market(runtime, { side: 'sell', quantity: 1, reduceOnly: true });
    expect(tradeManagementStats(runtime.orderEvents ?? [], closed)).toEqual(stats);
  });

  it('does not report a same-side scale-in as partial management in legacy journals', () => {
    let runtime = market(createBacktestRuntime(10_000), { quantity: 1 });
    runtime = market(runtime, { quantity: 1 }, bar(1, 101, 101, 101, 101));
    runtime = market(runtime, { side: 'sell', quantity: 2, reduceOnly: true }, bar(2, 102, 102, 102, 102));
    const legacy = (runtime.orderEvents ?? []).map(({ closedQuantity: _closedQuantity, positionQuantityAfter: _positionQuantityAfter, positionId: _positionId, closedPositionId: _closedPositionId, ...event }) => event);
    const { positionId: _positionId, exitOrderId: _exitOrderId, ...closed } = runtime.closedTrades[0];
    expect(tradeManagementStats(legacy, closed)).toMatchObject({ partialExits: 0, label: 'fixed' });
  });

  it('does not attribute an unrelated unfilled setup bracket to the active position', () => {
    let runtime = market(createBacktestRuntime(10_000), {});
    runtime = market(runtime, { side: 'sell', reduceOnly: true }, bar(1, 101, 101, 101, 101));
    const events = [...(runtime.orderEvents ?? [])];
    events.splice(2, 0, { id: 'unrelated-event', runId: 'r', instrument: 'MNQ', orderId: 'unfilled-order',
      marketTime: TIME + 30, kind: 'stop-moved', previousPrice: 98, price: 90, side: 'buy' });
    expect(tradeManagementStats(events, runtime.closedTrades[0])).toMatchObject({ stopMoves: 0, stopLoosened: 0, label: 'fixed' });
  });

  it('keeps prices on the tick grid and ignores invalid position bracket updates', () => {
    let runtime = market(createBacktestRuntime(10_000), { stopLoss: 98, takeProfit: 104 });
    runtime = updatePositionBracket(runtime, 'MNQ', 98.13, 104.12, TIME);
    expect(runtime.positions[0]).toMatchObject({ stopLoss: 98.25, takeProfit: 104 });
    runtime = updatePositionBracket(runtime, 'MNQ', NaN, -10, TIME);
    expect(runtime.positions[0]).toMatchObject({ stopLoss: 98.25, takeProfit: 104 });
  });
});

describe('batch invariants across causal fills', () => {
  it.each([1, 2, 3, 10])('retains economics and uncertainty with batch size %s', batchSize => {
    const initial = enqueueBacktestOrder(createBacktestRuntime(10_000), order({ type: 'limit', limitPrice: 99, stopLoss: 97, takeProfit: 104 }));
    const candles = [bar(1, 100, 105, 98, 100), bar(2, 100, 103, 99, 101), bar(3, 101, 106, 101, 105), bar(4, 105, 110, 100, 106)];
    const sequential = candles.reduce((runtime, candle) => step(runtime, candle), initial);
    let batched = initial;
    for (let index = 0; index < candles.length; index += batchSize) {
      batched = processBacktestCandles(batched, 'r', 'MNQ', candles.slice(index, index + batchSize), DEFAULT_BACKTEST_CONFIG);
    }
    expect(economics(batched)).toEqual(economics(sequential));
  });
});

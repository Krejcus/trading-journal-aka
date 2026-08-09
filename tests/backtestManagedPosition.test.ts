import { describe, expect, it } from 'vitest';
import {
  createManagedPositionPlan,
  managedPositionBoxes,
  managedPositionDrawing,
} from '../services/backtestManagedPosition';
import { createBacktestRuntime } from '../services/backtestEngine';
import { normalizePositionSettings, type PositionDrawing } from '../services/chartPositionDrawing';
import type { BacktestOrder } from '../services/backtestTypes';

const drawing: PositionDrawing = {
  id: 'manual-position',
  tool: 'LongPosition',
  points: [
    { time: 100, price: 100 },
    { time: 400, price: 110 },
    { time: 400, price: 95 },
  ],
  style: {
    color: '#787b86', width: 1, dashed: false, fill: null,
    position: normalizePositionSettings({ targetColor: '#00aa0080', stopColor: '#aa000080' }),
  },
};

const order: BacktestOrder = {
  id: 'order-1', runId: 'run-1', instrument: 'MNQ', side: 'buy', type: 'limit', status: 'pending',
  quantity: 2, remainingQuantity: 2, limitPrice: 100, stopLoss: 95, takeProfit: 110,
  createdAt: 120, updatedAt: 120,
};

describe('managed position box', () => {
  it('keeps the armed position box visible at its original width while entry is pending', () => {
    const runtime = createBacktestRuntime(50_000);
    runtime.orders = [{ ...order }];
    runtime.managedPositionPlans = [createManagedPositionPlan(drawing, order)];
    const [box] = managedPositionBoxes(runtime);
    expect(box).toMatchObject({ state: 'pending', startTime: 100, initialEndTime: 400 });
    expect(managedPositionDrawing(box, 900).points).toEqual([
      { time: 100, price: 100 },
      { time: 400, price: 110 },
      { time: 400, price: 95 },
    ]);
  });

  it('extends an active filled setup to the supplied replay edge', () => {
    const plan = createManagedPositionPlan(drawing, order);
    const box = { ...plan, startTime: 300, terminalTime: null, state: 'active' as const };
    expect(managedPositionDrawing(box, 900).points).toEqual([
      { time: 300, price: 100 },
      { time: 900, price: 110 },
      { time: 900, price: 95 },
    ]);
  });

  it('freezes at the fill exit candle after TP or SL closes the position', () => {
    const runtime = createBacktestRuntime(50_000);
    runtime.orders = [{ ...order, status: 'filled', remainingQuantity: 0, filledAt: 180 }];
    runtime.fills = [{
      id: 'entry-fill', runId: 'run-1', orderId: order.id, instrument: 'MNQ', side: 'buy',
      quantity: 2, price: 100, commission: 0.74, realizedPnl: 0, filledAt: 180, reason: 'order',
    }];
    runtime.closedTrades = [{
      id: 'trade-1', runId: 'run-1', instrument: 'MNQ', direction: 'Long', quantity: 2,
      entryPrice: 100, exitPrice: 110, entryTime: 180, exitTime: 360,
      grossPnl: 40, commission: 1.48, pnl: 38.52, reason: 'take-profit',
    }];
    runtime.managedPositionPlans = [createManagedPositionPlan(drawing, order)];
    const [box] = managedPositionBoxes(runtime);
    expect(box).toMatchObject({ state: 'closed', startTime: 180, terminalTime: 360 });
    expect(managedPositionDrawing(box, 1_200).points[0].time).toBe(180);
    expect(managedPositionDrawing(box, 1_200).points[1].time).toBe(360);
  });

  it('moves an active delayed limit setup to its actual entry fill candle', () => {
    const runtime = createBacktestRuntime(50_000);
    runtime.orders = [{ ...order, status: 'filled', remainingQuantity: 0, filledAt: 300 }];
    runtime.fills = [{
      id: 'entry-fill', runId: 'run-1', orderId: order.id, instrument: 'MNQ', side: 'buy',
      quantity: 2, price: 100, commission: 0.74, realizedPnl: 0, filledAt: 300, reason: 'order',
    }];
    runtime.managedPositionPlans = [createManagedPositionPlan(drawing, order)];

    expect(managedPositionBoxes(runtime)[0]).toMatchObject({
      state: 'active',
      startTime: 300,
      terminalTime: null,
    });
  });

  it('does not create a managed box for an unfilled cancelled setup', () => {
    const runtime = createBacktestRuntime(50_000);
    runtime.orders = [{ ...order, status: 'cancelled', cancelledAt: 240, updatedAt: 240 }];
    runtime.managedPositionPlans = [createManagedPositionPlan(drawing, order)];
    expect(managedPositionBoxes(runtime)).toEqual([]);
  });
});

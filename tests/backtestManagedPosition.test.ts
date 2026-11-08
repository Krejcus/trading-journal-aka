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
  it.each(['pending', 'active', 'closed'] as const)('hides axis prices for a %s box without altering the plan, geometry or later restoration', state => {
    const plan = createManagedPositionPlan(drawing, order);
    const box = { ...plan, terminalTime: state === 'closed' ? 600 : null, state };
    const original = structuredClone(box);
    const visible = managedPositionDrawing(box, 900, 60);
    const hidden = managedPositionDrawing(box, 900, 60, false);
    expect(hidden.style.position?.priceLabels).toBe(false);
    expect(hidden.points).toEqual(visible.points);
    expect(hidden.style.position?.targetColor).toBe(visible.style.position?.targetColor);
    expect(managedPositionDrawing(box, 900, 60, true)).toEqual(visible);
    expect(box).toEqual(original);
  });

  it('does not re-enable prices disabled in the original position drawing style', () => {
    const plan = createManagedPositionPlan(drawing, order);
    plan.style.position = { ...plan.style.position, priceLabels: false };
    const box = { ...plan, terminalTime: null, state: 'pending' as const };
    expect(managedPositionDrawing(box, 900, 60, true).style.position?.priceLabels).toBe(false);
  });

  it('shows a compact pending box beside the current candle without changing its saved plan', () => {
    const runtime = createBacktestRuntime(50_000);
    runtime.orders = [{ ...order }];
    runtime.managedPositionPlans = [createManagedPositionPlan(drawing, order)];
    const [box] = managedPositionBoxes(runtime);
    expect(box).toMatchObject({ state: 'pending', startTime: 100, initialEndTime: 400 });
    expect(managedPositionDrawing(box, 900, 60, true, { cursorTime: 600 }).points).toEqual([
      { time: 540, price: 100 },
      { time: 720, price: 110 },
      { time: 720, price: 95 },
    ]);
  });

  it('shows an unfilled limit as muted and restores its saved style only after fill', () => {
    const plan = createManagedPositionPlan(drawing, order);
    const original = structuredClone(plan);
    const pending = managedPositionDrawing({ ...plan, state: 'pending', terminalTime: null }, 900);
    const active = managedPositionDrawing({ ...plan, state: 'active', startTime: 300, terminalTime: null }, 900);
    expect(pending.style).toMatchObject({ executionState: 'pending', dashed: true, position: { lineColor: '#94a3b859', showOpenPnl: false } });
    expect(active.style).toMatchObject({ executionState: 'active', dashed: false, position: { targetColor: '#00aa0080' } });
    expect(active.points[0].time).toBe(300);
    expect(plan).toEqual(original);
  });

  it.each([60, 300, 900])('moves a pending box by one candle and keeps its width at three bars on %s-second panels', interval => {
    const plan = createManagedPositionPlan(drawing, order);
    const box = { ...plan, terminalTime: null, state: 'pending' as const };
    const before = managedPositionDrawing(box, 3000, interval, true, {cursorTime:1800});
    const after = managedPositionDrawing(box, 3000, interval, true, {cursorTime:1800+interval});
    expect(before.points[0].time).toBe(1800-interval);
    expect(before.points[1].time-before.points[0].time).toBe(3*interval);
    expect(after.points.map((p,i)=>p.time-before.points[i].time)).toEqual([interval,interval,interval]);
    expect(box.startTime).toBe(drawing.points[0].time);
  });
  it.each([60, 300, 900])('can keep the pending box one candle ahead on %s-second panels without moving the actual fill', interval => {
    const plan=createManagedPositionPlan(drawing,order);
    const pending={...plan,state:'pending' as const,terminalTime:null};
    const rendered=managedPositionDrawing(pending,3000,interval,true,{cursorTime:1800,anchor:'next'});
    expect(rendered.points.map(p=>p.time)).toEqual([1800+interval,1800+4*interval,1800+4*interval]);
    const moved=managedPositionDrawing(pending,3000,interval,true,{cursorTime:1800+interval,anchor:'next'});
    expect(moved.points.map((p,i)=>p.time-rendered.points[i].time)).toEqual([interval,interval,interval]);
    expect(plan.startTime).toBe(drawing.points[0].time);
    const active=managedPositionDrawing({...plan,state:'active',startTime:660,terminalTime:null},3000,interval,true,{cursorTime:1800,anchor:'next'});
    expect(active.points.map(p=>p.time)).toEqual([660,3000,3000]);
  });

  it('can anchor a waiting box at the current candle and ignores waiting preferences after a real fill', () => {
    const plan = createManagedPositionPlan(drawing, order);
    const pending = managedPositionDrawing({...plan,state:'pending',terminalTime:null},900,60,true,{cursorTime:600,anchor:'current',dimPercent:90});
    expect(pending.points.map(p=>p.time)).toEqual([600,780,780]);
    const filled={...plan,state:'active' as const,startTime:660,terminalTime:null};
    expect(managedPositionDrawing(filled,1200,60,true,{cursorTime:900,anchor:'current',dimPercent:90}))
      .toEqual(managedPositionDrawing(filled,1200,60,true,{cursorTime:600,anchor:'previous',dimPercent:0}));
  });
  it('changes the pending opacity without mutating order geometry, saved style or prices', () => {
    const plan=createManagedPositionPlan(drawing,order);
    const box={...plan,state:'pending' as const,terminalTime:null}; const original=structuredClone(box);
    const clear=managedPositionDrawing(box,900,60,true,{cursorTime:600,dimPercent:0});
    const faint=managedPositionDrawing(box,900,60,true,{cursorTime:600,dimPercent:90});
    expect(clear.points).toEqual(faint.points);
    expect(clear.style.color).toBe('#94a3b8ff'); expect(faint.style.color).toBe('#94a3b819');
    expect(clear.style.position?.targetColor).toBe('#94a3b880'); expect(faint.style.position?.targetColor).toBe('#94a3b80d');
    expect(box).toEqual(original);
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

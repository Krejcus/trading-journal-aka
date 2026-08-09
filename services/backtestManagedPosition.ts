import type { PositionDrawing } from './chartPositionDrawing';
import type {
  BacktestManagedPositionPlan,
  BacktestOrder,
  BacktestRuntimeState,
} from './backtestTypes';

export interface BacktestManagedPositionBox extends BacktestManagedPositionPlan {
  terminalTime: number | null;
  state: 'pending' | 'active' | 'closed' | 'cancelled';
}

const clone = <T,>(value: T): T => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value)) as T;

export const createManagedPositionPlan = (
  drawing: PositionDrawing,
  order: BacktestOrder,
): BacktestManagedPositionPlan => {
  const [entry, target, stop] = drawing.points;
  if (!entry || !target || !stop) throw new Error('Position box nemá kompletní Entry, TP a SL.');
  return {
    id: `managed-position-${order.id}`,
    orderId: order.id,
    instrument: order.instrument,
    tool: drawing.tool,
    startTime: entry.time,
    initialEndTime: Math.max(entry.time, target.time, stop.time),
    entryPrice: entry.price,
    targetPrice: target.price,
    stopPrice: stop.price,
    style: clone(drawing.style),
  };
};

export const managedPositionBoxes = (
  runtime: BacktestRuntimeState,
): BacktestManagedPositionBox[] => (runtime.managedPositionPlans ?? []).flatMap((plan): BacktestManagedPositionBox[] => {
  const order = runtime.orders.find(candidate => candidate.id === plan.orderId);
  if (!order) return [];
  const entryFill = runtime.fills.find(fill => fill.orderId === order.id && !order.reduceOnly);
  const cancelled = order.status === 'cancelled' || order.status === 'rejected';
  // A cancelled/rejected setup that never entered the market disappears.
  if (!entryFill && cancelled) return [];
  // Until fill, keep the armed position tool visible but fixed at its original
  // width. The fill event is what turns it into a replay-following box.
  if (!entryFill) {
    return [{
      ...plan,
      terminalTime: null,
      state: 'pending',
    }];
  }
  const direction = order.side === 'buy' ? 'Long' : 'Short';
  const closedTrade = runtime.closedTrades.find(trade => (
    trade.instrument === plan.instrument
    && trade.direction === direction
    && trade.entryTime === entryFill.filledAt
  ));
  return [{
    ...plan,
    startTime: entryFill.filledAt,
    terminalTime: closedTrade?.exitTime ?? null,
    state: closedTrade ? 'closed' : 'active',
  }];
});

export const managedPositionDrawing = (
  box: BacktestManagedPositionBox,
  rightTime: number,
  /**
   * Timeframe panelu, který kresbu vykresluje. Styl boxu si nese
   * `intervalSeconds` z okamžiku vzniku pozice, jenže tahle kresba se
   * přegenerovává pro každý panel zvlášť — a knihovna podle té hodnoty
   * extrapoluje šířku, když čas nepadne na existující bar. Bez přepsání se
   * pozice z 1m na 5m panelu roztáhne pětkrát.
   */
  intervalSeconds?: number,
): PositionDrawing => {
  const pendingEndTime = box.initialEndTime ?? box.startTime + 5 * 60;
  const endTime = box.terminalTime
    ?? (box.state === 'pending' ? pendingEndTime : rightTime);
  const style = clone(box.style);
  if (Number.isFinite(intervalSeconds as number) && (intervalSeconds as number) > 0) {
    style.position = { ...style.position, intervalSeconds };
  }
  return {
    id: `auto-${box.id}`,
    tool: box.tool,
    points: [
      { time: box.startTime, price: box.entryPrice },
      { time: endTime, price: box.targetPrice },
      { time: endTime, price: box.stopPrice },
    ],
    style,
  };
};

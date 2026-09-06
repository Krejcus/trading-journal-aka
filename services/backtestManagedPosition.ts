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

interface LegacyPositionLife {
  openedAt: number;
  terminalTime: number | null;
}

/** Recover old scale-in links from fill order, without rewriting saved data. */
const legacyPositionLives = (runtime: BacktestRuntimeState): Map<string, LegacyPositionLife> => {
  const lives = new Map<string, LegacyPositionLife>();
  const state = new Map<string, { quantity: number; life: LegacyPositionLife }>();
  const orders = new Map(runtime.orders.map(order => [order.id, order]));
  for (const fill of runtime.fills) {
    const previous = state.get(fill.instrument);
    const before = previous?.quantity ?? 0;
    const reducing = orders.get(fill.orderId ?? '')?.reduceOnly === true;
    const signed = fill.side === 'buy' ? fill.quantity : -fill.quantity;
    if (reducing && (!before || Math.sign(before) === Math.sign(signed))) continue;
    const quantity = reducing ? Math.sign(signed) * Math.min(Math.abs(before), Math.abs(signed)) : signed;
    const after = before + quantity;
    if (previous && before && Math.sign(before) !== Math.sign(after)) previous.life.terminalTime = fill.filledAt;
    if (!after) {
      state.delete(fill.instrument);
    } else if (!before || Math.sign(before) !== Math.sign(after)) {
      const life: LegacyPositionLife = { openedAt: fill.filledAt, terminalTime: null };
      state.set(fill.instrument, { quantity: after, life });
      lives.set(fill.id, life);
    } else if (previous) {
      state.set(fill.instrument, { quantity: after, life: previous.life });
      if (Math.sign(before) === Math.sign(quantity)) lives.set(fill.id, previous.life);
    }
  }
  return lives;
};

export const managedPositionBoxes = (
  runtime: BacktestRuntimeState,
): BacktestManagedPositionBox[] => {
  const legacyLives = runtime.fills.some(fill => !fill.positionId && !fill.closedPositionId)
    ? legacyPositionLives(runtime) : new Map<string, LegacyPositionLife>();
  return (runtime.managedPositionPlans ?? []).flatMap((plan): BacktestManagedPositionBox[] => {
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
  // An opposite-side order may only reduce a pre-existing position. It never
  // created the position represented by this drawing.
  if (!entryFill.positionId && entryFill.closedPositionId) return [];
  const legacyLife = legacyLives.get(entryFill.id);
  if (!entryFill.positionId && !legacyLife) return [];
  const direction = order.side === 'buy' ? 'Long' : 'Short';
  const active = runtime.positions.some(position => position.instrument === plan.instrument
    && position.side === (order.side === 'buy' ? 'long' : 'short')
    && (entryFill.positionId
      ? position.positionId === entryFill.positionId
      : (legacyLife?.terminalTime == null && position.openedAt === (legacyLife?.openedAt ?? entryFill.filledAt))
        || position.entryFillIds.includes(entryFill.id)));
  const closedTrades = runtime.closedTrades.filter(trade => (
    trade.instrument === plan.instrument
    && trade.direction === direction
    && (entryFill.positionId ? trade.positionId === entryFill.positionId : trade.entryTime === (legacyLife?.openedAt ?? entryFill.filledAt))
  ));
  // A partial realization is not terminal. All scale-in drawings share the
  // same position identity and freeze only when its final contract exits.
  const terminalTime = active ? null : legacyLife?.terminalTime
    ?? (closedTrades.length ? Math.max(...closedTrades.map(trade => trade.exitTime)) : null);
  return [{
    ...plan,
    startTime: entryFill.filledAt,
    terminalTime,
    state: terminalTime === null ? 'active' : 'closed',
  }];
  });
};

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

import type { MarketCandle } from './marketData';
import {
  type BacktestClosedTrade,
  type BacktestFill,
  type BacktestInstrument,
  type BacktestOrder,
  type BacktestOrderSide,
  type BacktestPosition,
  type BacktestRunConfig,
  type BacktestRuntimeState,
} from './backtestTypes';
import { DEFAULT_CHART_REPLAY_STATE } from './chartReplay';

const POINT_VALUE: Record<BacktestInstrument, number> = { MNQ: 2, NQ: 20 };
const TICK_SIZE: Record<BacktestInstrument, number> = { MNQ: 0.25, NQ: 0.25 };

const roundPrice = (price: number, instrument: BacktestInstrument) =>
  Math.round(price / TICK_SIZE[instrument]) * TICK_SIZE[instrument];

export const createBacktestRuntime = (initialCapital: number): BacktestRuntimeState => ({
  balance: initialCapital,
  equity: initialCapital,
  realizedPnl: 0,
  unrealizedPnl: 0,
  commissions: 0,
  orders: [],
  fills: [],
  positions: [],
  closedTrades: [],
  replay: { ...DEFAULT_CHART_REPLAY_STATE },
});

export interface NewBacktestOrder {
  runId: string;
  instrument: BacktestInstrument;
  side: BacktestOrderSide;
  type: BacktestOrder['type'];
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  reduceOnly?: boolean;
  now: number;
}

export const createBacktestOrder = (input: NewBacktestOrder): BacktestOrder => {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error('Množství musí být větší než nula.');
  if (input.type === 'limit' && !Number.isFinite(input.limitPrice)) throw new Error('Limitní objednávka vyžaduje cenu.');
  if (input.type === 'stop' && !Number.isFinite(input.stopPrice)) throw new Error('Stop objednávka vyžaduje cenu.');
  return {
    id: crypto.randomUUID(),
    runId: input.runId,
    instrument: input.instrument,
    side: input.side,
    type: input.type,
    status: 'pending',
    quantity: Math.floor(input.quantity),
    remainingQuantity: Math.floor(input.quantity),
    limitPrice: Number.isFinite(input.limitPrice) ? roundPrice(Number(input.limitPrice), input.instrument) : undefined,
    stopPrice: Number.isFinite(input.stopPrice) ? roundPrice(Number(input.stopPrice), input.instrument) : undefined,
    stopLoss: Number.isFinite(input.stopLoss) ? roundPrice(Number(input.stopLoss), input.instrument) : undefined,
    takeProfit: Number.isFinite(input.takeProfit) ? roundPrice(Number(input.takeProfit), input.instrument) : undefined,
    reduceOnly: input.reduceOnly,
    createdAt: input.now,
    updatedAt: input.now,
  };
};

const triggerPrice = (order: BacktestOrder, candle: MarketCandle): number | null => {
  if (order.type === 'market') return candle.close;
  if (order.type === 'limit') {
    if (order.side === 'buy' && candle.low <= Number(order.limitPrice)) return Math.min(candle.open, Number(order.limitPrice));
    if (order.side === 'sell' && candle.high >= Number(order.limitPrice)) return Math.max(candle.open, Number(order.limitPrice));
  }
  if (order.type === 'stop') {
    if (order.side === 'buy' && candle.high >= Number(order.stopPrice)) return Math.max(candle.open, Number(order.stopPrice));
    if (order.side === 'sell' && candle.low <= Number(order.stopPrice)) return Math.min(candle.open, Number(order.stopPrice));
  }
  return null;
};

const slippagePrice = (price: number, side: BacktestOrderSide, instrument: BacktestInstrument, config: BacktestRunConfig) => {
  const delta = (config.slippageTicks[instrument] || 0) * TICK_SIZE[instrument];
  return roundPrice(side === 'buy' ? price + delta : price - delta, instrument);
};

interface ApplyFillResult {
  positions: BacktestPosition[];
  fill: BacktestFill;
  closedTrades: BacktestClosedTrade[];
}

const applyFill = (
  runtime: BacktestRuntimeState,
  order: BacktestOrder,
  price: number,
  time: number,
  config: BacktestRunConfig,
  reason: BacktestFill['reason'],
): ApplyFillResult => {
  const quantity = order.remainingQuantity;
  const commission = config.commissionPerSide[order.instrument] * quantity;
  const current = runtime.positions.find(position => position.instrument === order.instrument);
  const direction = order.side === 'buy' ? 'long' : 'short';
  const positions = runtime.positions.filter(position => position.instrument !== order.instrument);
  let realizedPnl = 0;
  const closedTrades: BacktestClosedTrade[] = [];

  if (!current) {
    if (!order.reduceOnly) positions.push({
      instrument: order.instrument,
      side: direction,
      quantity,
      averagePrice: price,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      openedAt: time,
      entryFillIds: [],
      entryCommission: commission,
    });
  } else if (current.side === direction) {
    if (!order.reduceOnly) positions.push({
      ...current,
      quantity: current.quantity + quantity,
      averagePrice: ((current.averagePrice * current.quantity) + (price * quantity)) / (current.quantity + quantity),
      stopLoss: order.stopLoss ?? current.stopLoss,
      takeProfit: order.takeProfit ?? current.takeProfit,
      entryCommission: (current.entryCommission || 0) + commission,
    });
    else positions.push(current);
  } else {
    const closingQuantity = Math.min(current.quantity, quantity);
    const points = current.side === 'long' ? price - current.averagePrice : current.averagePrice - price;
    realizedPnl = points * POINT_VALUE[order.instrument] * closingQuantity;
    const allocatedEntryCommission = (current.entryCommission || 0) * (closingQuantity / current.quantity);
    const allocatedExitCommission = config.commissionPerSide[order.instrument] * closingQuantity;
    const tradeCommission = allocatedEntryCommission + allocatedExitCommission;
    closedTrades.push({
      id: crypto.randomUUID(),
      runId: order.runId,
      instrument: order.instrument,
      direction: current.side === 'long' ? 'Long' : 'Short',
      quantity: closingQuantity,
      entryPrice: current.averagePrice,
      exitPrice: price,
      entryTime: current.openedAt,
      exitTime: time,
      grossPnl: realizedPnl,
      commission: tradeCommission,
      pnl: realizedPnl - tradeCommission,
      reason,
    });
    if (current.quantity > closingQuantity) {
      positions.push({ ...current, quantity: current.quantity - closingQuantity, entryCommission: (current.entryCommission || 0) - allocatedEntryCommission });
    } else if (quantity > closingQuantity && !order.reduceOnly) {
      positions.push({
        instrument: order.instrument,
        side: direction,
        quantity: quantity - closingQuantity,
        averagePrice: price,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        openedAt: time,
        entryFillIds: [],
        entryCommission: Math.max(0, commission - allocatedExitCommission),
      });
    }
  }

  const fill: BacktestFill = {
    id: crypto.randomUUID(),
    runId: order.runId,
    orderId: order.id,
    instrument: order.instrument,
    side: order.side,
    quantity,
    price,
    commission,
    realizedPnl,
    filledAt: time,
    reason,
  };
  const opened = positions.find(position => position.instrument === order.instrument && position.openedAt === time);
  if (opened) opened.entryFillIds = [...opened.entryFillIds, fill.id];
  return { positions, fill, closedTrades };
};

const markToMarket = (runtime: BacktestRuntimeState, instrument: BacktestInstrument, close: number): BacktestRuntimeState => {
  const unrealizedPnl = runtime.positions.reduce((sum, position) => {
    if (position.instrument !== instrument) return sum;
    const points = position.side === 'long' ? close - position.averagePrice : position.averagePrice - close;
    return sum + points * POINT_VALUE[position.instrument] * position.quantity;
  }, 0);
  return { ...runtime, unrealizedPnl, equity: runtime.balance + unrealizedPnl };
};

const bracketOrder = (runId: string, position: BacktestPosition, side: BacktestOrderSide, price: number, now: number): BacktestOrder => ({
  id: crypto.randomUUID(), runId, instrument: position.instrument, side, type: 'market', status: 'pending',
  quantity: position.quantity, remainingQuantity: position.quantity, reduceOnly: true, createdAt: now, updatedAt: now,
  limitPrice: price,
});

/**
 * Processes one newly revealed candle. Bracket ambiguity is deliberately
 * conservative: if stop and target are both touched in the same candle, stop
 * loss wins because intrabar order is unknowable from OHLC data.
 */
export const processBacktestCandle = (
  runtime: BacktestRuntimeState,
  runId: string,
  instrument: BacktestInstrument,
  candle: MarketCandle,
  config: BacktestRunConfig,
): BacktestRuntimeState => {
  let next: BacktestRuntimeState = { ...runtime, orders: [...runtime.orders], fills: [...runtime.fills], positions: [...runtime.positions], closedTrades: [...runtime.closedTrades] };
  const position = next.positions.find(item => item.instrument === instrument);
  if (position) {
    const stopTouched = position.stopLoss !== undefined && (position.side === 'long' ? candle.low <= position.stopLoss : candle.high >= position.stopLoss);
    const targetTouched = position.takeProfit !== undefined && (position.side === 'long' ? candle.high >= position.takeProfit : candle.low <= position.takeProfit);
    if (stopTouched || targetTouched) {
      const reason: BacktestFill['reason'] = stopTouched ? 'stop-loss' : 'take-profit';
      const requestedLevel = stopTouched ? Number(position.stopLoss) : Number(position.takeProfit);
      const side: BacktestOrderSide = position.side === 'long' ? 'sell' : 'buy';
      const requested = stopTouched
        ? position.side === 'long' ? Math.min(candle.open, requestedLevel) : Math.max(candle.open, requestedLevel)
        : requestedLevel;
      const order = bracketOrder(runId, position, side, requested, candle.time);
      const price = slippagePrice(requested, side, instrument, config);
      const result = applyFill(next, order, price, candle.time, config, reason);
      next = {
        ...next,
        orders: [...next.orders, { ...order, status: 'filled', remainingQuantity: 0, filledAt: candle.time, updatedAt: candle.time }],
        positions: result.positions,
        fills: [...next.fills, result.fill],
        closedTrades: [...next.closedTrades, ...result.closedTrades],
        realizedPnl: next.realizedPnl + result.fill.realizedPnl - result.fill.commission,
        commissions: next.commissions + result.fill.commission,
        balance: next.balance + result.fill.realizedPnl - result.fill.commission,
      };
    }
  }

  const pending = next.orders.filter(order => order.status === 'pending' && order.instrument === instrument);
  for (const order of pending) {
    const requested = triggerPrice(order, candle);
    if (requested === null) continue;
    const slipped = slippagePrice(requested, order.side, instrument, config);
    const price = order.type === 'limit'
      ? order.side === 'buy' ? Math.min(slipped, Number(order.limitPrice)) : Math.max(slipped, Number(order.limitPrice))
      : slipped;
    const result = applyFill(next, order, price, candle.time, config, order.reduceOnly ? 'manual' : order.type === 'market' ? 'entry' : 'order');
    next = {
      ...next,
      orders: next.orders.map(item => item.id === order.id ? { ...item, status: 'filled', remainingQuantity: 0, filledAt: candle.time, updatedAt: candle.time } : item),
      positions: result.positions,
      fills: [...next.fills, result.fill],
      closedTrades: [...next.closedTrades, ...result.closedTrades],
      realizedPnl: next.realizedPnl + result.fill.realizedPnl - result.fill.commission,
      commissions: next.commissions + result.fill.commission,
      balance: next.balance + result.fill.realizedPnl - result.fill.commission,
    };
  }
  return markToMarket(next, instrument, candle.close);
};

export const enqueueBacktestOrder = (runtime: BacktestRuntimeState, order: BacktestOrder): BacktestRuntimeState => ({
  ...runtime,
  orders: [...runtime.orders, order],
});

export const cancelBacktestOrder = (runtime: BacktestRuntimeState, orderId: string, now: number): BacktestRuntimeState => ({
  ...runtime,
  orders: runtime.orders.map(order => order.id === orderId && order.status === 'pending'
    ? { ...order, status: 'cancelled', cancelledAt: now, updatedAt: now }
    : order),
});

export const updatePositionBracket = (
  runtime: BacktestRuntimeState,
  instrument: BacktestInstrument,
  stopLoss?: number,
  takeProfit?: number,
): BacktestRuntimeState => ({
  ...runtime,
  positions: runtime.positions.map(position => position.instrument === instrument
    ? { ...position, stopLoss, takeProfit }
    : position),
});

export const backtestPointValue = (instrument: BacktestInstrument) => POINT_VALUE[instrument];

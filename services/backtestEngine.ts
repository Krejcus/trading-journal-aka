import { backtestExitPrice } from './backtestExecutionModel';
import type { MarketCandle } from './marketData';
import {
  type BacktestClosedTrade,
  type BacktestFill,
  type BacktestInstrument,
  type BacktestOrder,
  type BacktestOrderEvent,
  type BacktestOrderEventKind,
  type BacktestOrderSide,
  type BacktestPosition,
  type BacktestRunConfig,
  type BacktestRuntimeState,
} from './backtestTypes';
import { DEFAULT_CHART_REPLAY_STATE } from './chartReplay';
import {
  backtestSessionCutoffSeconds,
  DEFAULT_BACKTEST_FLAT_BY_MINUTE,
  DEFAULT_BACKTEST_FLAT_TIME_ZONE,
} from './backtestSessionClose';

const POINT_VALUE: Record<BacktestInstrument, number> = { MNQ: 2, NQ: 20 };
const TICK_SIZE: Record<BacktestInstrument, number> = { MNQ: 0.25, NQ: 0.25 };

const roundPrice = (price: number, instrument: BacktestInstrument) =>
  Math.round(price / TICK_SIZE[instrument]) * TICK_SIZE[instrument];

export const createBacktestRuntime = (initialCapital: number): BacktestRuntimeState => ({
  maxRevealedTime: 0,
  balance: initialCapital,
  equity: initialCapital,
  realizedPnl: 0,
  unrealizedPnl: 0,
  commissions: 0,
  orders: [],
  fills: [],
  positions: [],
  closedTrades: [],
  managedPositionPlans: [],
  orderEvents: [],
  replay: { ...DEFAULT_CHART_REPLAY_STATE },
});

/** Umělé `orderId` pro události, které patří pozici, ne konkrétní objednávce. */
export const positionEventOwnerId = (instrument: BacktestInstrument) => `position:${instrument}`;

interface OrderEventInput {
  positionId?: string;
  closedPositionId?: string;
  orderId: string;
  kind: BacktestOrderEventKind;
  instrument: BacktestInstrument;
  marketTime: number;
  recordedAt?: number;
  side?: BacktestOrderSide;
  quantity?: number;
  price?: number;
  previousPrice?: number;
  closedQuantity?: number;
  positionQuantityAfter?: number;
}

/**
 * Strop journalu. Události se ukládají uvnitř `runtime_state` blobu, takže
 * neomezený růst by dřív nebo později rozbil uložení celé session. Ruční
 * přehrávání jich nasbírá řádově stovky; pět tisíc je hranice, za kterou už
 * jde o strojové generování, a tam se raději zahodí nejstarší záznamy, než aby
 * spadl checkpoint.
 */
export const BACKTEST_ORDER_EVENT_LIMIT = 5_000;

const appendOrderEvent = (
  runtime: BacktestRuntimeState,
  runId: string,
  input: OrderEventInput,
): BacktestRuntimeState => {
  const event: BacktestOrderEvent = {
    id: crypto.randomUUID(),
    runId,
    orderId: input.orderId,
    kind: input.kind,
    instrument: input.instrument,
    marketTime: input.marketTime,
    side: input.side,
    quantity: input.quantity,
  };
  // Nedefinovaná pole se vynechávají, ať journal nenafukuje uložený blob
  // stovkami `null` u událostí, které cenu ani wall clock nemají.
  if (input.recordedAt !== undefined) event.recordedAt = input.recordedAt;
  if (input.price !== undefined) event.price = input.price;
  if (input.previousPrice !== undefined) event.previousPrice = input.previousPrice;
  if (input.closedQuantity !== undefined) event.closedQuantity = input.closedQuantity;
  if (input.positionQuantityAfter !== undefined) event.positionQuantityAfter = input.positionQuantityAfter;
  if (input.positionId !== undefined) event.positionId = input.positionId;
  if (input.closedPositionId !== undefined) event.closedPositionId = input.closedPositionId;
  const events = [...(runtime.orderEvents ?? []), event];
  return {
    ...runtime,
    orderEvents: events.length > BACKTEST_ORDER_EVENT_LIMIT
      ? events.slice(events.length - BACKTEST_ORDER_EVENT_LIMIT)
      : events,
  };
};

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
  if (!Number.isFinite(input.quantity) || input.quantity < 1) throw new Error('Množství musí být alespoň jeden kontrakt.');
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

/**
 * Posune extrémy pozice o rozsah jedné svíčky.
 *
 * Volající předá celý bar jen pokud pozice žila po celý jeho rozsah; při
 * intrabar vstupu/výstupu použije pouze prokazatelně navštívené ceny.
 */
const withCandleExcursion = (position: BacktestPosition, candle: MarketCandle): BacktestPosition => {
  const favorable = position.maxFavorablePrice ?? position.averagePrice;
  const adverse = position.maxAdversePrice ?? position.averagePrice;
  const scale = POINT_VALUE[position.instrument] * position.quantity;
  const legacyProfit = Math.max(0, position.side === 'long' ? favorable - position.averagePrice : position.averagePrice - favorable) * scale;
  const legacyLoss = Math.max(0, position.side === 'long' ? position.averagePrice - adverse : adverse - position.averagePrice) * scale;
  return {
    ...position,
    cashExcursionLegacy: position.cashExcursionLegacy || position.maxUnrealizedProfit === undefined || position.maxUnrealizedLoss === undefined,
    maxUnrealizedProfit: Math.max(position.maxUnrealizedProfit ?? legacyProfit, 0,
      (position.side === 'long' ? candle.high - position.averagePrice : position.averagePrice - candle.low) * scale),
    maxUnrealizedLoss: Math.max(position.maxUnrealizedLoss ?? legacyLoss, 0,
      (position.side === 'long' ? position.averagePrice - candle.low : candle.high - position.averagePrice) * scale),
    maxFavorablePrice: position.side === 'long' ? Math.max(favorable, candle.high) : Math.min(favorable, candle.low),
    maxAdversePrice: position.side === 'long' ? Math.min(adverse, candle.low) : Math.max(adverse, candle.high),
  };
};

/** Riziko obchodu v dolarech podle vstupního stop lossu. `undefined` = bez SL. */
const riskAmountOf = (
  instrument: BacktestInstrument,
  entryPrice: number,
  initialStopLoss: number | undefined,
  quantity: number,
): number | undefined => {
  if (!Number.isFinite(initialStopLoss as number)) return undefined;
  const distance = Math.abs(entryPrice - Number(initialStopLoss));
  if (distance <= 0) return undefined;
  return distance * POINT_VALUE[instrument] * quantity;
};

interface ClosedExcursion {
  mfePoints: number;
  maePoints: number;
  mfeR?: number;
  maeR?: number;
}

/**
 * Extrémy obchodu v bodech a v R.
 *
 * Výstupní cena se do obou počítá vedle sledovaných extrémů: pozice zavřená
 * ještě na vstupní svíčce nemá žádnou zaznamenanou svíčku, ale její výstup je
 * sám o sobě platný pohyb.
 */
const closedExcursion = (
  position: BacktestPosition,
  exitPrice: number,
  riskDistance: number | undefined,
): ClosedExcursion => {
  const sampled = withPrices(position, [exitPrice]);
  const scale = POINT_VALUE[position.instrument] * position.quantity;
  const mfePoints = (sampled.maxUnrealizedProfit ?? 0) / scale;
  const maePoints = (sampled.maxUnrealizedLoss ?? 0) / scale;
  if (!Number.isFinite(riskDistance as number) || Number(riskDistance) <= 0) return { mfePoints, maePoints };
  return {
    mfePoints,
    maePoints,
    mfeR: mfePoints / Number(riskDistance),
    maeR: maePoints / Number(riskDistance),
  };
};

const applyFill = (
  runtime: BacktestRuntimeState,
  order: BacktestOrder,
  price: number,
  time: number,
  config: BacktestRunConfig,
  reason: BacktestFill['reason'],
  /** Svíčka trefila stopku i target — výsledek z minutových dat nerozhodneme. */
  outcomeAmbiguous = false,
): ApplyFillResult => {
  const quantity = order.remainingQuantity;
  const commission = config.commissionPerSide[order.instrument] * quantity;
  const existing = runtime.positions.find(position => position.instrument === order.instrument);
  const current = existing ? withPrices(existing, [price]) : undefined;
  const direction = order.side === 'buy' ? 'long' : 'short';
  const positions = runtime.positions.filter(position => position.instrument !== order.instrument);
  let realizedPnl = 0;
  const closedTrades: BacktestClosedTrade[] = [];

  if (!current) {
    if (!order.reduceOnly) positions.push({
      positionId: order.id,
      instrument: order.instrument,
      side: direction,
      quantity,
      averagePrice: price,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      initialStopLoss: order.stopLoss,
      initialTakeProfit: order.takeProfit,
      maxUnrealizedProfit: 0,
      maxUnrealizedLoss: 0,
      maxFavorablePrice: price,
      maxAdversePrice: price,
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
    const riskDistance = Number.isFinite(current.initialStopLoss as number)
      ? Math.abs(current.averagePrice - Number(current.initialStopLoss))
      : undefined;
    closedTrades.push({
      positionId: current.positionId,
      exitOrderId: order.id,
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
      stopLoss: current.stopLoss,
      takeProfit: current.takeProfit,
      initialStopLoss: current.initialStopLoss,
      initialTakeProfit: current.initialTakeProfit,
      riskAmount: riskAmountOf(order.instrument, current.averagePrice, current.initialStopLoss, closingQuantity),
      ...(outcomeAmbiguous || current.outcomeAmbiguous ? { outcomeAmbiguous: true } : {}),
      ...(current.excursionAmbiguous ? { excursionAmbiguous: true } : {}),
      ...closedExcursion(current, price, riskDistance),
      actualExcursionQuality: current.cashExcursionLegacy || current.maxUnrealizedProfit === undefined || current.maxUnrealizedLoss === undefined ? 'legacy-unknown' : 'cash-ledger',
      mfeAmount: (current.maxUnrealizedProfit ?? 0) * closingQuantity / current.quantity,
      maeAmount: (current.maxUnrealizedLoss ?? 0) * closingQuantity / current.quantity,
    });
    if (current.quantity > closingQuantity) {
      positions.push({ ...current, quantity: current.quantity - closingQuantity,
        maxUnrealizedProfit: (current.maxUnrealizedProfit ?? 0) * (1 - closingQuantity / current.quantity),
        maxUnrealizedLoss: (current.maxUnrealizedLoss ?? 0) * (1 - closingQuantity / current.quantity),
        entryCommission: (current.entryCommission || 0) - allocatedEntryCommission });
    } else if (quantity > closingQuantity && !order.reduceOnly) {
      positions.push({
        positionId: order.id,
        instrument: order.instrument,
        side: direction,
        quantity: quantity - closingQuantity,
        averagePrice: price,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        initialStopLoss: order.stopLoss,
        initialTakeProfit: order.takeProfit,
        maxUnrealizedProfit: 0,
        maxUnrealizedLoss: 0,
        maxFavorablePrice: price,
        maxAdversePrice: price,
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
  const opened = positions.find(position => position.instrument === order.instrument && position.side === direction);
  if (opened && !order.reduceOnly) {
    opened.entryFillIds = [...opened.entryFillIds, fill.id];
    fill.positionId = opened.positionId;
  }
  if (current && current.side !== direction) fill.closedPositionId = current.positionId;
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

const bracketOrder = (runId: string, position: BacktestPosition, side: BacktestOrderSide, now: number): BacktestOrder => ({
  id: crypto.randomUUID(), runId, instrument: position.instrument, side, type: 'market', status: 'pending',
  quantity: position.quantity, remainingQuantity: position.quantity, reduceOnly: true, createdAt: now, updatedAt: now,
});

/** Fill accounting has one owner; reductions cannot create phantom fills/fees. */
const settleOrder = (
  runtime: BacktestRuntimeState,
  order: BacktestOrder,
  price: number,
  time: number,
  config: BacktestRunConfig,
  reason: BacktestFill['reason'],
  outcomeAmbiguous = false,
): BacktestRuntimeState => {
  const current = runtime.positions.find(position => position.instrument === order.instrument);
  const direction = order.side === 'buy' ? 'long' : 'short';
  const quantity = order.reduceOnly
    ? current && current.side !== direction ? Math.min(order.remainingQuantity, current.quantity) : 0
    : order.remainingQuantity;
  if (quantity <= 0) return cancelBacktestOrder(runtime, order.id, time);
  const result = applyFill(runtime, { ...order, remainingQuantity: quantity }, price, time, config, reason, outcomeAmbiguous);
  const filledOrder: BacktestOrder = { ...order, status: 'filled', remainingQuantity: 0, filledAt: time, updatedAt: time };
  const next = {
    ...runtime,
    orders: runtime.orders.some(item => item.id === order.id)
      ? runtime.orders.map(item => item.id === order.id ? filledOrder : item)
      : [...runtime.orders, filledOrder],
    positions: result.positions,
    fills: [...runtime.fills, result.fill],
    closedTrades: [...runtime.closedTrades, ...result.closedTrades],
    realizedPnl: runtime.realizedPnl + result.fill.realizedPnl - result.fill.commission,
    commissions: runtime.commissions + result.fill.commission,
    balance: runtime.balance + result.fill.realizedPnl - result.fill.commission,
  };
  return appendOrderEvent(next, order.runId, {
    orderId: order.id, kind: 'filled', instrument: order.instrument, marketTime: time,
    side: order.side, quantity: result.fill.quantity, price,
    closedQuantity: result.closedTrades.reduce((sum, trade) => sum + trade.quantity, 0),
    positionQuantityAfter: result.positions.find(position => position.instrument === order.instrument)?.quantity ?? 0,
    positionId: result.fill.positionId,
    closedPositionId: result.fill.closedPositionId,
  });
};

/**
 * A user's market action happens at the displayed quote. It must never replay
 * that candle's earlier high/low, nor execute unrelated resting orders.
 * The caller creates and enqueues the order first, as for any other order.
 */
export const executeBacktestMarketOrder = (
  runtime: BacktestRuntimeState,
  orderId: string,
  quote: Pick<MarketCandle, 'time' | 'close'>,
  config: BacktestRunConfig,
): BacktestRuntimeState => {
  const order = runtime.orders.find(item => item.id === orderId && item.status === 'pending' && item.type === 'market');
  if (!order || !Number.isFinite(quote.close) || !Number.isFinite(quote.time)) return runtime;
  const cutoff = backtestSessionCutoffSeconds(order.createdAt,
    config.flatTimeZone ?? DEFAULT_BACKTEST_FLAT_TIME_ZONE,
    config.flatByMinute ?? DEFAULT_BACKTEST_FLAT_BY_MINUTE);
  if (!order.reduceOnly && quote.time >= cutoff) return cancelBacktestOrder(runtime, order.id, quote.time);
  const next = settleOrder(runtime, order, slippagePrice(quote.close, order.side, order.instrument, config),
    quote.time, config, order.reduceOnly ? 'manual' : 'entry');
  return markToMarket(next, order.instrument, quote.close);
};

interface EntryWithinCandle {
  type: 'limit' | 'stop';
  price: number;
  atOpen: boolean;
}

const replacePosition = (runtime: BacktestRuntimeState, position: BacktestPosition): BacktestRuntimeState => ({
  ...runtime,
  positions: runtime.positions.map(item => item.instrument === position.instrument ? position : item),
});

const withPrices = (position: BacktestPosition, prices: readonly number[]): BacktestPosition => {
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  return withCandleExcursion(position, { time: 0, open: prices[0], close: prices[prices.length - 1], high, low, volume: 0 });
};

const addExcursionUncertainty = (position: BacktestPosition, low: number, high: number): BacktestPosition => {
  const possible = withPrices(position, [low, high]);
  return (possible.maxUnrealizedProfit ?? 0) > (position.maxUnrealizedProfit ?? 0)
    || (possible.maxUnrealizedLoss ?? 0) > (position.maxUnrealizedLoss ?? 0)
    ? { ...position, excursionAmbiguous: true }
    : position;
};

/**
 * OHLC gives bounds and some certain crossings, not a tick path. An entry at
 * the open is active for the whole bar. For an intrabar limit entry, its
 * adverse extreme follows the crossing; for a stop entry, its favorable
 * extreme follows it. The close can additionally prove a subsequent crossing.
 * An uncertain adverse exit is taken conservatively and labelled. An uncertain
 * target alone is not credited; the unresolved outcome follows the position.
 */
const processPositionCandle = (
  runtime: BacktestRuntimeState,
  runId: string,
  instrument: BacktestInstrument,
  candle: MarketCandle,
  config: BacktestRunConfig,
  entry?: EntryWithinCandle,
): BacktestRuntimeState => {
  const current = runtime.positions.find(position => position.instrument === instrument);
  if (!current) return runtime;
  const long = current.side === 'long';
  const intrabarEntry = entry && !entry.atOpen;
  const startPrice = entry?.price ?? candle.open;
  const stop = current.stopLoss;
  const target = current.takeProfit;
  const stopAtStart = stop !== undefined && (long ? startPrice <= stop : startPrice >= stop);
  const targetAtStart = target !== undefined && (long ? startPrice >= target : startPrice <= target);
  const stopTouched = stop !== undefined && (long ? candle.low <= stop : candle.high >= stop);
  const targetTouched = target !== undefined && (long ? candle.high >= target : candle.low <= target);
  const stopCertain = !intrabarEntry || entry.type === 'limit'
    || (stop !== undefined && (long ? candle.close <= stop : candle.close >= stop));
  const targetCertain = !intrabarEntry || entry.type === 'stop'
    || (target !== undefined && (long ? candle.close >= target : candle.close <= target));
  const atStart = stopAtStart || targetAtStart;
  const exitStop = stopAtStart || (!targetAtStart && stopTouched);
  const exitTarget = !exitStop && (targetAtStart || (targetTouched && targetCertain));
  let position = withPrices(current, [startPrice]);

  if (exitStop || exitTarget) {
    const side: BacktestOrderSide = long ? 'sell' : 'buy';
    const reason: BacktestFill['reason'] = exitStop ? 'stop-loss' : 'take-profit';
    const level = Number(exitStop ? stop : target);
    // Stops slip adversely, including gaps. A target is a limit: a gap may
    // improve it, but slippage can never cross its limit price.
    const requested = atStart ? startPrice : level;
    const price = backtestExitPrice(requested, long, (config.slippageTicks[instrument] || 0) * TICK_SIZE[instrument],
      TICK_SIZE[instrument], exitStop ? undefined : level);
    position = withPrices(position, [price]);
    if (!atStart) {
      // Only start/exit crossings are proven before an intrabar exit. Bound
      // any unknown excursion by the bracket; no post-exit high/low leaks in.
      const possibleLow = Math.max(candle.low, long ? stop ?? -Infinity : target ?? -Infinity);
      const possibleHigh = Math.min(candle.high, long ? target ?? Infinity : stop ?? Infinity);
      position = addExcursionUncertainty(position, possibleLow, possibleHigh);
    }
    const ambiguous = !atStart && ((stopTouched && targetTouched) || (exitStop && !stopCertain));
    const next = replacePosition(runtime, position);
    return settleOrder(next, bracketOrder(runId, position, side, candle.time), price, candle.time, config, reason, ambiguous);
  }

  if (intrabarEntry) {
    // These extrema are necessarily visited after the corresponding entry
    // crossing, but the opposite extreme may have happened before entry.
    const certainExtreme = entry.type === 'limit'
      ? long ? candle.low : candle.high
      : long ? candle.high : candle.low;
    position = withPrices(position, [candle.close, certainExtreme]);
    position = addExcursionUncertainty(position, candle.low, candle.high);
    if (targetTouched) position = { ...position, outcomeAmbiguous: true };
  } else {
    position = withCandleExcursion(position, candle);
  }
  return replacePosition(runtime, position);
};

/**
 * Before a protective level can be reached from the open, every resting
 * trigger strictly between them must be crossed. Resolve those predecessors
 * in price order (including reductions/reversals), instead of closing the old
 * size first and incorrectly opening the scale-in afterward. Opposite-side
 * chronology remains unknown and is explicitly labelled, never simulated.
 */
const processProtectivePredecessors = (
  runtime: BacktestRuntimeState,
  candle: MarketCandle,
  instrument: BacktestInstrument,
  config: BacktestRunConfig,
  initialEntry?: EntryWithinCandle,
): { runtime: BacktestRuntimeState; entry?: EntryWithinCandle } => {
  let next = runtime;
  let cursorPrice = initialEntry?.price ?? candle.open;
  let lastEntry = initialEntry;
  const processed = new Set<string>();
  while (true) {
    const position = next.positions.find(item => item.instrument === instrument);
    if (!position) return { runtime: next, entry: lastEntry };
    const long = position.side === 'long';
    const stopTouched = position.stopLoss !== undefined && (long ? candle.low <= position.stopLoss : candle.high >= position.stopLoss);
    const targetTouched = position.takeProfit !== undefined && (long ? candle.high >= position.takeProfit : candle.low <= position.takeProfit);
    const stopAtCursor = position.stopLoss !== undefined && (long ? cursorPrice <= position.stopLoss : cursorPrice >= position.stopLoss);
    const targetAtCursor = position.takeProfit !== undefined && (long ? cursorPrice >= position.takeProfit : cursorPrice <= position.takeProfit);
    if (stopAtCursor || targetAtCursor) return { runtime: next, entry: lastEntry };
    const protectiveExit = stopTouched || targetTouched ? Number(stopTouched ? position.stopLoss : position.takeProfit) : null;
    const candidates = next.orders.flatMap(order => {
      if (order.instrument !== instrument || order.status !== 'pending' || order.type === 'market'
        || order.updatedAt >= candle.time || processed.has(order.id)) return [];
      const price = triggerPrice(order, candle);
      return price === null ? [] : [{ order, price }];
    });
    const eligible = candidates.filter(candidate => protectiveExit === null || (candidate.price !== protectiveExit
      && candidate.price >= Math.min(cursorPrice, protectiveExit) && candidate.price <= Math.max(cursorPrice, protectiveExit)))
      .sort((left, right) => Math.abs(left.price - cursorPrice) - Math.abs(right.price - cursorPrice));
    const candidate = eligible[0];
    const exit = protectiveExit ?? candidate?.price ?? cursorPrice;
    const uncertainEntryStop = lastEntry && !lastEntry.atOpen && lastEntry.type === 'stop' && stopTouched
      && (long ? candle.close > Number(position.stopLoss) : candle.close < Number(position.stopLoss));
    const uncertainChronology = Boolean(uncertainEntryStop) || (stopTouched && targetTouched) || candidates.some(item => (protectiveExit !== null && item.price === exit)
      || (item.price - cursorPrice) * (exit - cursorPrice) < 0);
    if (!candidate) return {
      runtime: uncertainChronology ? replacePosition(next, { ...position, outcomeAmbiguous: true }) : next,
      entry: lastEntry,
    };
    const { order, price: requested } = candidate;
    processed.add(order.id);
    const slipped = slippagePrice(requested, order.side, instrument, config);
    const price = order.type === 'limit'
      ? order.side === 'buy' ? Math.min(slipped, Number(order.limitPrice)) : Math.max(slipped, Number(order.limitPrice))
      : slipped;
    let exposed = withPrices(position, [cursorPrice, price]);
    const possibleLow = Math.max(candle.low, long ? position.stopLoss ?? -Infinity : position.takeProfit ?? -Infinity,
      requested < cursorPrice ? requested : -Infinity);
    const possibleHigh = Math.min(candle.high, long ? position.takeProfit ?? Infinity : position.stopLoss ?? Infinity,
      requested > cursorPrice ? requested : Infinity);
    if (requested !== cursorPrice) exposed = addExcursionUncertainty(exposed, possibleLow, possibleHigh);
    if (uncertainChronology) {
      exposed = { ...exposed, outcomeAmbiguous: true };
    }
    next = settleOrder(replacePosition(next, exposed), order, price, candle.time, config, order.reduceOnly ? 'manual' : 'order');
    let after = next.positions.find(item => item.instrument === instrument);
    if (after && exposed.outcomeAmbiguous) {
      after = { ...after, outcomeAmbiguous: true };
      next = replacePosition(next, after);
    }
    if (after) lastEntry = {
      type: (after.side === 'long' ? requested < candle.open : requested > candle.open) ? 'limit' : 'stop',
      price, atOpen: requested === candle.open,
    };
    if (after && after.side !== position.side) {
      return { runtime: next, entry: lastEntry };
    }
    cursorPrice = requested;
  }
};

/** Processes only a newly revealed candle; market UI actions use the quote API. */
export const processBacktestCandle = (
  runtime: BacktestRuntimeState,
  runId: string,
  instrument: BacktestInstrument,
  candle: MarketCandle,
  config: BacktestRunConfig,
): BacktestRuntimeState => {
  let next = runtime;
  const flatTimeZone = config.flatTimeZone ?? DEFAULT_BACKTEST_FLAT_TIME_ZONE;
  const flatByMinute = config.flatByMinute ?? DEFAULT_BACKTEST_FLAT_BY_MINUTE;
  for (const order of next.orders.filter(item => item.status === 'pending' && item.instrument === instrument
    && candle.time >= backtestSessionCutoffSeconds(item.createdAt, flatTimeZone, flatByMinute))) {
    next = cancelBacktestOrder(next, order.id, candle.time);
  }
  const position = next.positions.find(item => item.instrument === instrument);
  if (position && candle.time >= backtestSessionCutoffSeconds(position.openedAt, flatTimeZone, flatByMinute)) {
    const side: BacktestOrderSide = position.side === 'long' ? 'sell' : 'buy';
    next = settleOrder(next, bracketOrder(runId, position, side, candle.time),
      slippagePrice(candle.open, side, instrument, config), candle.time, config, 'session-close');
  } else if (position && candle.time > position.openedAt) {
    const predecessors = processProtectivePredecessors(next, candle, instrument, config);
    next = processPositionCandle(predecessors.runtime, runId, instrument, candle, config, predecessors.entry);
  }

  const pending = next.orders.filter(item => item.status === 'pending' && item.instrument === instrument)
    .map(order => ({ order, price: triggerPrice(order, candle) }));
  const firstDirection = pending.find(item => item.order.type !== 'market' && item.price !== null && item.price !== candle.open);
  const primaryDirection = Math.sign((firstDirection?.price ?? candle.open) - candle.open);
  const intrabarDirections = new Set(pending.filter(item => item.order.type !== 'market'
    && item.order.updatedAt < candle.time && item.price !== null && item.price !== candle.open)
    .map(item => Math.sign(Number(item.price) - candle.open)));
  const competingDirections = intrabarDirections.size > 1;
  pending.sort((left, right) => {
    if (left.order.type === 'market' || right.order.type === 'market') return Number(left.order.type === 'market') - Number(right.order.type === 'market');
    if (left.price === null || right.price === null) return Number(left.price === null) - Number(right.price === null);
    const leftDirection = Math.sign(left.price - candle.open);
    const rightDirection = Math.sign(right.price - candle.open);
    if (!leftDirection || !rightDirection || leftDirection === rightDirection) return Math.abs(left.price - candle.open) - Math.abs(right.price - candle.open);
    // Opposite directions cannot be ordered from OHLC. Retain the first
    // submitted direction as the fallback and label its outcomes below.
    return Number(leftDirection !== primaryDirection) - Number(rightDirection !== primaryDirection);
  });
  for (const { order } of pending) {
    // A causal predecessor pass may already have consumed another item from
    // this iteration snapshot. Never execute that order a second time.
    if (!next.orders.some(item => item.id === order.id && item.status === 'pending')) continue;
    // A newly placed/moved resting order cannot use a bar already revealed at
    // the time of that action. Market entries retain legacy close execution.
    if (order.type !== 'market' && candle.time <= order.updatedAt) continue;
    const requested = triggerPrice(order, candle);
    if (requested === null) continue;
    const slipped = slippagePrice(requested, order.side, instrument, config);
    const price = order.type === 'limit'
      ? order.side === 'buy' ? Math.min(slipped, Number(order.limitPrice)) : Math.max(slipped, Number(order.limitPrice))
      : slipped;
    const before = next.positions.find(item => item.instrument === instrument);
    const priorIntrabarFill = next.fills.length > runtime.fills.length;
    next = settleOrder(next, order, price, candle.time, config, order.reduceOnly ? 'manual' : order.type === 'market' ? 'entry' : 'order', competingDirections);
    let after = next.positions.find(item => item.instrument === instrument);
    if (order.type !== 'market' && (priorIntrabarFill || competingDirections) && after) {
      // This trigger may precede another fill already selected for the bar;
      // never present the retained conservative ordering as an exact outcome.
      after = { ...after, outcomeAmbiguous: true };
      next = replacePosition(next, after);
    }
    // New or reversed positions can own part of this candle; market entries
    // happen at its close and therefore cannot consume any of its earlier OHLC.
    if (order.type !== 'market' && after && (!before || before.side !== after.side)) {
      const level = Number(order.type === 'limit' ? order.limitPrice : order.stopPrice);
      const atOpen = order.type === 'limit'
        ? order.side === 'buy' ? candle.open <= level : candle.open >= level
        : order.side === 'buy' ? candle.open >= level : candle.open <= level;
      const predecessors = processProtectivePredecessors(next, candle, instrument, config, { type: order.type, price, atOpen });
      next = processPositionCandle(predecessors.runtime, runId, instrument, candle, config, predecessors.entry);
    }
  }
  return markToMarket(next, instrument, candle.close);
};

/**
 * Dávkové zpracování odhalených svíček — jeden tick přehrávání jich při
 * dotahování skluzu předá až sto najednou.
 *
 * Klíčové pozorování: svíčka, při které neexistuje pozice ani čekající
 * objednávka na instrumentu, nemůže změnit nic než mark-to-market. Expirace
 * čekajících vstupů je podmnožina čekajících objednávek, cutoff i bracket
 * vyžadují pozici, plnění vyžaduje čekající objednávku. Takové svíčky se tedy
 * přeskočí úplně a mark-to-market se udělá jednou, z poslední z nich — mezi
 * nečinnými svíčkami ho stejně každá další přepisuje. Aktivní svíčky jdou
 * beze změny přes `processBacktestCandle`, ať existuje jediná implementace
 * pravidel. Ekvivalenci se sekvenčním zpracováním drží property test.
 */
export const processBacktestCandles = (
  runtime: BacktestRuntimeState,
  runId: string,
  instrument: BacktestInstrument,
  candles: readonly MarketCandle[],
  config: BacktestRunConfig,
): BacktestRuntimeState => {
  let next = runtime;
  let idleMark: MarketCandle | null = null;
  for (const candle of candles) {
    const idle = !next.positions.some(position => position.instrument === instrument)
      && !next.orders.some(order => order.status === 'pending' && order.instrument === instrument);
    if (idle) {
      idleMark = candle;
      continue;
    }
    idleMark = null;
    next = processBacktestCandle(next, runId, instrument, candle, config);
  }
  return idleMark ? markToMarket(next, instrument, idleMark.close) : next;
};

export const enqueueBacktestOrder = (
  runtime: BacktestRuntimeState,
  order: BacktestOrder,
  recordedAt?: number,
): BacktestRuntimeState => appendOrderEvent(
  { ...runtime, orders: [...runtime.orders, order] },
  order.runId,
  {
    orderId: order.id, kind: 'created', instrument: order.instrument, marketTime: order.createdAt,
    recordedAt, side: order.side, quantity: order.quantity,
    price: order.type === 'limit' ? order.limitPrice : order.type === 'stop' ? order.stopPrice : undefined,
  },
);

export const cancelBacktestOrder = (
  runtime: BacktestRuntimeState,
  orderId: string,
  now: number,
  recordedAt?: number,
): BacktestRuntimeState => {
  const target = runtime.orders.find(order => order.id === orderId && order.status === 'pending');
  const next: BacktestRuntimeState = {
    ...runtime,
    orders: runtime.orders.map(order => order.id === orderId && order.status === 'pending'
      ? { ...order, status: 'cancelled', cancelledAt: now, updatedAt: now }
      : order),
  };
  if (!target) return next;
  return appendOrderEvent(next, target.runId, {
    orderId, kind: 'cancelled', instrument: target.instrument, marketTime: now,
    recordedAt, side: target.side, quantity: target.remainingQuantity,
  });
};

export type PendingOrderPriceField = 'entry' | 'stopLoss' | 'takeProfit';

const PENDING_EVENT_KIND: Record<PendingOrderPriceField, BacktestOrderEventKind> = {
  entry: 'entry-moved',
  stopLoss: 'stop-moved',
  takeProfit: 'target-moved',
};

const pendingOrderPrice = (order: BacktestOrder, field: PendingOrderPriceField): number | undefined =>
  field === 'entry'
    ? order.type === 'limit' ? order.limitPrice : order.type === 'stop' ? order.stopPrice : undefined
    : order[field];

export const updatePendingBacktestOrder = (
  runtime: BacktestRuntimeState,
  orderId: string,
  field: PendingOrderPriceField,
  price: number,
  now: number,
  recordedAt?: number,
): BacktestRuntimeState => {
  const target = runtime.orders.find(order => order.id === orderId && order.status === 'pending');
  const next: BacktestRuntimeState = {
    ...runtime,
    orders: runtime.orders.map(order => {
      if (order.id !== orderId || order.status !== 'pending' || !Number.isFinite(price)) return order;
      const nextPrice = roundPrice(price, order.instrument);
      if (field === 'entry') {
        return order.type === 'limit'
          ? { ...order, limitPrice: nextPrice, updatedAt: now }
          : order.type === 'stop'
            ? { ...order, stopPrice: nextPrice, updatedAt: now }
            : order;
      }
      return { ...order, [field]: nextPrice, updatedAt: now };
    }),
  };
  if (!target || !Number.isFinite(price)) return next;
  const previousPrice = pendingOrderPrice(target, field);
  const nextPrice = pendingOrderPrice(next.orders.find(order => order.id === orderId) as BacktestOrder, field);
  // Tržní objednávka nemá co posouvat — `updatePendingBacktestOrder` ji vrátí
  // beze změny a journal by jinak zapsal fiktivní posun.
  if (nextPrice === previousPrice) return next;
  return appendOrderEvent(next, target.runId, {
    orderId, kind: PENDING_EVENT_KIND[field], instrument: target.instrument, marketTime: now,
    recordedAt, side: target.side, price: nextPrice, previousPrice,
  });
};

/**
 * Odebere SL nebo TP u čekající objednávky.
 *
 * `updatePendingBacktestOrder` umí jen zapsat cenu — nekonečno ani NaN neprojde
 * přes kontrolu `Number.isFinite`, takže smazání potřebuje vlastní cestu.
 */
export const clearPendingBacktestOrderBracket = (
  runtime: BacktestRuntimeState,
  orderId: string,
  field: 'stopLoss' | 'takeProfit',
  now: number,
  recordedAt?: number,
): BacktestRuntimeState => {
  const target = runtime.orders.find(order => order.id === orderId && order.status === 'pending');
  const next: BacktestRuntimeState = {
    ...runtime,
    orders: runtime.orders.map(order => {
      if (order.id !== orderId || order.status !== 'pending') return order;
      const updated = { ...order, updatedAt: now };
      delete updated[field];
      return updated;
    }),
  };
  if (!target || target[field] === undefined) return next;
  return appendOrderEvent(next, target.runId, {
    orderId, kind: field === 'stopLoss' ? 'stop-cleared' : 'target-cleared',
    instrument: target.instrument, marketTime: now, recordedAt,
    side: target.side, previousPrice: target[field],
  });
};

export const updatePositionBracket = (
  runtime: BacktestRuntimeState,
  instrument: BacktestInstrument,
  stopLoss?: number,
  takeProfit?: number,
  marketTime?: number,
  recordedAt?: number,
): BacktestRuntimeState => {
  const target = runtime.positions.find(position => position.instrument === instrument);
  const normalized = (value: number | undefined, previous: number | undefined) => value === undefined
    ? undefined : Number.isFinite(value) && value > 0 ? roundPrice(value, instrument) : previous;
  stopLoss = normalized(stopLoss, target?.stopLoss);
  takeProfit = normalized(takeProfit, target?.takeProfit);
  let next: BacktestRuntimeState = {
    ...runtime,
    positions: runtime.positions.map(position => position.instrument === instrument
      ? { ...position, stopLoss, takeProfit }
      : position),
  };
  // Bez známého času svíčky by se událost nedala zařadit do replay časové osy,
  // takže se raději nezapíše vůbec, než aby v journalu ležela s časem 0.
  if (!target || !Number.isFinite(marketTime as number)) return next;
  const runId = runtime.closedTrades[0]?.runId ?? runtime.orders[0]?.runId ?? '';
  const owner = positionEventOwnerId(instrument);
  const side: BacktestOrderSide = target.side === 'long' ? 'buy' : 'sell';
  const moves: Array<[keyof Pick<BacktestPosition, 'stopLoss' | 'takeProfit'>, number | undefined]> = [
    ['stopLoss', stopLoss],
    ['takeProfit', takeProfit],
  ];
  moves.forEach(([field, value]) => {
    const previous = target[field];
    if (previous === value) return;
    const kind: BacktestOrderEventKind = value === undefined
      ? field === 'stopLoss' ? 'position-stop-cleared' : 'position-target-cleared'
      : field === 'stopLoss' ? 'position-stop-moved' : 'position-target-moved';
    next = appendOrderEvent(next, runId, {
      orderId: owner, kind, instrument, marketTime: Number(marketTime), recordedAt,
      positionId: target.positionId,
      side, quantity: target.quantity, price: value, previousPrice: previous,
    });
  });
  return next;
};

export const backtestPointValue = (instrument: BacktestInstrument) => POINT_VALUE[instrument];

export const backtestTickSize = (instrument: BacktestInstrument) => TICK_SIZE[instrument];

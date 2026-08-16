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
  orderId: string;
  kind: BacktestOrderEventKind;
  instrument: BacktestInstrument;
  marketTime: number;
  recordedAt?: number;
  side?: BacktestOrderSide;
  quantity?: number;
  price?: number;
  previousPrice?: number;
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

/**
 * Posune extrémy pozice o rozsah jedné svíčky.
 *
 * Vstupní svíčka se záměrně vynechává (volající ji filtruje přes `openedAt`):
 * fill padl někam dovnitř baru a jeho high/low z větší části patří pohybu,
 * který se stal ještě před vstupem. Připočítat ho by MFE i MAE nafouklo.
 */
const withCandleExcursion = (position: BacktestPosition, candle: MarketCandle): BacktestPosition => {
  const favorable = position.maxFavorablePrice ?? position.averagePrice;
  const adverse = position.maxAdversePrice ?? position.averagePrice;
  return {
    ...position,
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
  const favorable = position.maxFavorablePrice ?? position.averagePrice;
  const adverse = position.maxAdversePrice ?? position.averagePrice;
  const long = position.side === 'long';
  const mfePoints = Math.max(
    0,
    long ? favorable - position.averagePrice : position.averagePrice - favorable,
    long ? exitPrice - position.averagePrice : position.averagePrice - exitPrice,
  );
  const maePoints = Math.max(
    0,
    long ? position.averagePrice - adverse : adverse - position.averagePrice,
    long ? position.averagePrice - exitPrice : exitPrice - position.averagePrice,
  );
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
      initialStopLoss: order.stopLoss,
      initialTakeProfit: order.takeProfit,
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
      ...(outcomeAmbiguous ? { outcomeAmbiguous: true } : {}),
      ...closedExcursion(current, price, riskDistance),
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
        initialStopLoss: order.stopLoss,
        initialTakeProfit: order.takeProfit,
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
  const flatTimeZone = config.flatTimeZone ?? DEFAULT_BACKTEST_FLAT_TIME_ZONE;
  const flatByMinute = config.flatByMinute ?? DEFAULT_BACKTEST_FLAT_BY_MINUTE;

  // Žádný čekající vstup nesmí přežít denní prop-firm cutoff. Rušíme ho před
  // vyhodnocením high/low cutoff svíčky, takže se na ní nemůže zpětně vyplnit.
  const expired = next.orders.filter(order => order.status === 'pending'
    && order.instrument === instrument
    && candle.time >= backtestSessionCutoffSeconds(order.createdAt, flatTimeZone, flatByMinute));
  for (const order of expired) {
    next = {
      ...next,
      orders: next.orders.map(item => item.id === order.id
        ? { ...item, status: 'cancelled', cancelledAt: candle.time, updatedAt: candle.time }
        : item),
    };
    next = appendOrderEvent(next, runId, {
      orderId: order.id, kind: 'cancelled', instrument, marketTime: candle.time,
      side: order.side, quantity: order.remainingQuantity,
    });
  }

  // Pozici zavíráme na open první dostupné 1m svíčky v/po cutoffu. Její
  // high/low už nesmí vstoupit do MFE/MAE ani rozhodnout bracket.
  const positionAtCutoff = next.positions.find(item => item.instrument === instrument
    && candle.time >= backtestSessionCutoffSeconds(item.openedAt, flatTimeZone, flatByMinute));
  if (positionAtCutoff) {
    const side: BacktestOrderSide = positionAtCutoff.side === 'long' ? 'sell' : 'buy';
    const order = bracketOrder(runId, positionAtCutoff, side, candle.open, candle.time);
    const price = slippagePrice(candle.open, side, instrument, config);
    const result = applyFill(next, order, price, candle.time, config, 'session-close');
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
    next = appendOrderEvent(next, runId, {
      orderId: order.id, kind: 'filled', instrument, marketTime: candle.time,
      side, quantity: order.quantity, price,
    });
  }

  // Extrémy se musí posunout dřív, než bracket pozici zavře — jinak by se
  // svíčka, která trefila stopku, do MAE vůbec nedostala.
  next.positions = next.positions.map(item => item.instrument === instrument && candle.time > item.openedAt
    ? withCandleExcursion(item, candle)
    : item);
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
      const result = applyFill(next, order, price, candle.time, config, reason, stopTouched && targetTouched);
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
      next = appendOrderEvent(next, runId, {
        orderId: order.id, kind: 'filled', instrument, marketTime: candle.time,
        side, quantity: order.quantity, price,
      });
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
    next = appendOrderEvent(next, runId, {
      orderId: order.id, kind: 'filled', instrument, marketTime: candle.time,
      side: order.side, quantity: order.quantity, price,
    });
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
      side, quantity: target.quantity, price: value, previousPrice: previous,
    });
  });
  return next;
};

export const backtestPointValue = (instrument: BacktestInstrument) => POINT_VALUE[instrument];

export const backtestTickSize = (instrument: BacktestInstrument) => TICK_SIZE[instrument];

import type { BacktestClosedTrade, BacktestPosition, BacktestRuntimeState } from './backtestTypes';

/**
 * Návrat replaye nůžkami před už vzatý obchod. Backtest není reálný účet:
 * místo zákazu se obchody, které by v novém čase ještě neproběhly, smažou.
 *
 * Zůstává jen to, co bylo hotové nejpozději v cílovém čase (svíčka v tom čase
 * je odkrytá): uzavřené obchody s výstupem do cíle, jejich plnění a příkazy.
 * Pryč je každý obchod s výstupem po cíli (i když vstup byl dřív — v cíli by
 * byl otevřený), otevřená pozice, příkazy založené po cíli a příkazy vyplněné
 * po cíli. Zůstatek se přepočítá z plnění, která zůstala.
 *
 * `maxRevealedTime` se nemění: co uživatel v datech už viděl, viděl.
 */

export interface BacktestRewindPlan {
  targetTime: number;
  removedTrades: BacktestClosedTrade[];
  removedPositions: BacktestPosition[];
  removedOrderIds: string[];
  /** Nic se nemaže — návrat je čistý posun kurzoru. */
  empty: boolean;
}

const positionKey = (position: { positionId?: string; instrument: string; openedAt?: number }) => position.positionId ?? `${position.instrument}:${position.openedAt ?? ''}`;

export function planBacktestRewind(runtime: BacktestRuntimeState, targetTime: number): BacktestRewindPlan {
  const removedTrades = runtime.closedTrades.filter(trade => trade.exitTime > targetTime);
  const removedPositions = runtime.positions.slice();
  const removedPositionIds = new Set([
    ...removedTrades.map(trade => trade.positionId).filter((id): id is string => Boolean(id)),
    ...removedPositions.map(positionKey),
  ]);
  const removedOrderIds = runtime.orders
    .filter(order => order.createdAt > targetTime || (order.filledAt !== undefined && order.filledAt > targetTime)
      || runtime.fills.some(fill => fill.orderId === order.id && fill.filledAt > targetTime)
      || runtime.fills.some(fill => fill.orderId === order.id && ((fill.positionId && removedPositionIds.has(fill.positionId))
        || (fill.closedPositionId && removedPositionIds.has(fill.closedPositionId)))))
    .map(order => order.id);
  return {
    targetTime,
    removedTrades,
    removedPositions,
    removedOrderIds,
    empty: removedTrades.length === 0 && removedPositions.length === 0 && removedOrderIds.length === 0,
  };
}

export function applyBacktestRewind(runtime: BacktestRuntimeState, plan: BacktestRewindPlan, initialCapital: number): BacktestRuntimeState {
  const target = plan.targetTime;
  const removedTradeIds = new Set(plan.removedTrades.map(trade => trade.id));
  const removedPositionIds = new Set([
    ...plan.removedTrades.map(trade => trade.positionId).filter((id): id is string => Boolean(id)),
    ...plan.removedPositions.map(positionKey),
  ]);
  const removedOrders = new Set(plan.removedOrderIds);
  const fills = runtime.fills.filter(fill => fill.filledAt <= target
    && !(fill.orderId && removedOrders.has(fill.orderId))
    && !(fill.positionId && removedPositionIds.has(fill.positionId))
    && !(fill.closedPositionId && removedPositionIds.has(fill.closedPositionId)));
  const orders = runtime.orders.filter(order => !removedOrders.has(order.id));
  const keptOrderIds = new Set(orders.map(order => order.id));
  // Stejně jako engine: realizované P&L je čisté (po komisích).
  const commissions = fills.reduce((sum, fill) => sum + fill.commission, 0);
  const realizedPnl = fills.reduce((sum, fill) => sum + fill.realizedPnl - fill.commission, 0);
  const balance = initialCapital + realizedPnl;
  return {
    ...runtime,
    balance,
    equity: balance,
    realizedPnl,
    unrealizedPnl: 0,
    commissions,
    orders,
    fills,
    positions: [],
    closedTrades: runtime.closedTrades.filter(trade => !removedTradeIds.has(trade.id)),
    managedPositionPlans: runtime.managedPositionPlans?.filter(plan => keptOrderIds.has(plan.orderId)),
    orderEvents: runtime.orderEvents?.filter(event => event.marketTime <= target && keptOrderIds.has(event.orderId)),
    replay: { ...runtime.replay, cursorTime: target, startTime: target, playing: false, phase: 'active' },
  };
}

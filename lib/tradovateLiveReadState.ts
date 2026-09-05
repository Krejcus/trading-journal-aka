import type { TradovateAccountDataAccount, TradovateAccountDataResult, TradovateSourceCoverage } from './tradovateAccountDataTypes.js';

const unavailable: TradovateSourceCoverage = { availability: 'unavailable', count: 0, httpStatus: null };

export const hasCompleteTradovateRead = (coverage: TradovateSourceCoverage | undefined): boolean =>
  coverage?.availability === 'available' || coverage?.availability === 'empty';

export const tradovateAccountReadState = (
  account: TradovateAccountDataAccount,
  data: TradovateAccountDataResult,
): NonNullable<TradovateAccountDataAccount['readState']> => account.readState ?? {
  positions: data.coverage?.positions ?? unavailable,
  orders: data.coverage?.orders ?? unavailable,
  positionsAsOf: hasCompleteTradovateRead(data.coverage?.positions) ? data.capturedAt : null,
  ordersAsOf: hasCompleteTradovateRead(data.coverage?.orders) ? data.capturedAt : null,
  cashAsOf: hasCompleteTradovateRead(account.balance.coverage) ? data.capturedAt : null,
  requestedAt: data.requestedAt ?? data.capturedAt,
};

export const isOlderTradovateRead = (incoming: string | null | undefined, current: string | null | undefined): boolean =>
  Number.isFinite(Date.parse(current ?? ''))
    && (!Number.isFinite(Date.parse(incoming ?? '')) || Date.parse(incoming!) < Date.parse(current!));

/** Merge enrichment without replacing newer live evidence, or turning a
 * failed read into a confirmed zero. Failed sources retain last-known values
 * together with unavailable coverage and the original evidence time. */
export function mergeTradovateAccountRead(
  previous: TradovateAccountDataAccount,
  incoming: TradovateAccountDataAccount,
  previousData: TradovateAccountDataResult,
  incomingData: TradovateAccountDataResult,
): TradovateAccountDataAccount {
  const before = tradovateAccountReadState(previous, previousData);
  const after = tradovateAccountReadState(incoming, incomingData);
  const older = isOlderTradovateRead(after.requestedAt, before.requestedAt);
  const keepPositions = older || !hasCompleteTradovateRead(after.positions);
  const keepOrders = older || !hasCompleteTradovateRead(after.orders);
  const cashFailed = !hasCompleteTradovateRead(incoming.balance.coverage);
  const cashOlder = isOlderTradovateRead(after.cashAsOf ?? after.requestedAt, before.cashAsOf);
  const keepCash = cashFailed || cashOlder;
  const keepPnl = cashFailed || isOlderTradovateRead(incoming.balance.openPnlAsOf ?? after.cashAsOf, previous.balance.openPnlAsOf ?? before.cashAsOf);
  return {
    ...incoming,
    positions: keepPositions ? previous.positions : incoming.positions,
    netPositionCount: keepPositions ? previous.netPositionCount : incoming.netPositionCount,
    orders: keepOrders ? previous.orders : incoming.orders,
    workingOrderCount: keepOrders ? previous.workingOrderCount : incoming.workingOrderCount,
    activity: {
      ...incoming.activity,
      ...(keepPositions ? { positionCount: previous.activity.positionCount, netPositionCount: previous.activity.netPositionCount } : {}),
      ...(keepOrders ? { orderCount: previous.activity.orderCount, workingOrderCount: previous.activity.workingOrderCount } : {}),
    },
    readState: {
      ...after,
      ...(older ? { requestedAt: before.requestedAt, positions: before.positions, orders: before.orders } : {}),
      positionsAsOf: keepPositions ? before.positionsAsOf : after.positionsAsOf,
      ordersAsOf: keepOrders ? before.ordersAsOf : after.ordersAsOf,
      cashAsOf: keepCash ? before.cashAsOf : after.cashAsOf,
    },
    balance: {
      ...(keepCash ? previous.balance : incoming.balance),
      ...(cashFailed && !cashOlder ? { coverage: incoming.balance.coverage } : {}),
      ...(keepPnl ? {
        openPnL: previous.balance.openPnL,
        netLiq: previous.balance.netLiq,
        openPnlSource: cashFailed && !cashOlder ? 'stale' as const : previous.balance.openPnlSource,
        openPnlAsOf: previous.balance.openPnlAsOf ?? before.cashAsOf,
      } : {}),
    },
  };
}

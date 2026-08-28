import type { TradovateAccountDataResult, TradovateAccountPosition } from './tradovateAccountDataTypes.js';
import type {
  TradovateLivePnlAnchorTick,
  TradovateLivePnlTick,
} from './tradovateLivePnlTypes.js';
import { isTradovateWorkingStatus } from './tradovateOrderReadModel.js';

export interface TradovateContractMark {
  contractId: number;
  price: number;
  valuePerPoint: number;
  observedAt: string;
}

export type TradovateContractMarkMap = Record<string, TradovateContractMark>;

export interface TradovateLivePnlAnchorCandidate {
  accountId: number;
  contractId: number;
}

const ROOT_VALUE_PER_POINT: Record<string, number> = {
  MNQ: 2,
  NQ: 20,
};

export const tradovateContractRoot = (symbol: string | null): string | null => {
  if (!symbol) return null;
  const normalized = symbol.trim().toUpperCase();
  const match = normalized.match(/^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/);
  return match?.[1] ?? null;
};

export const tradovateValuePerPoint = (symbol: string | null): number | null => {
  const root = tradovateContractRoot(symbol);
  return root ? ROOT_VALUE_PER_POINT[root] ?? null : null;
};

/**
 * Account-wide openPnL lze převést na cenu kontraktu pouze pro účet s právě
 * jednou otevřenou pozicí. Jeden kandidát na kontrakt stačí; stejný mark pak
 * přepočítá další účty držící tentýž NQ/MNQ kontrakt.
 */
export const tradovateLivePnlAnchorCandidates = (
  data: TradovateAccountDataResult,
): TradovateLivePnlAnchorCandidate[] => {
  const byContract = new Map<number, TradovateLivePnlAnchorCandidate>();
  for (const account of data.accounts) {
    const open = account.positions.filter(position => position.netPosition !== 0);
    if (open.length !== 1 || open[0].averagePrice == null) continue;
    if (tradovateValuePerPoint(open[0].symbol) == null) continue;
    if (!byContract.has(open[0].contractId)) {
      byContract.set(open[0].contractId, { accountId: account.id, contractId: open[0].contractId });
    }
  }
  return [...byContract.values()].sort((left, right) => left.contractId - right.contractId);
};

export function applyTradovateLivePnlAnchorTick(
  data: TradovateAccountDataResult,
  tick: TradovateLivePnlAnchorTick,
  previousMarks: TradovateContractMarkMap = {},
): { data: TradovateAccountDataResult; marks: TradovateContractMarkMap } {
  if (!tick.anchor) return { data, marks: previousMarks };
  const exactAccount = data.accounts.find(account => account.id === tick.anchor!.accountId);
  const exactOpen = exactAccount?.positions.filter(position => position.netPosition !== 0) ?? [];
  const exactPosition = exactOpen.length === 1 && exactOpen[0].contractId === tick.anchor.contractId
    ? exactOpen[0]
    : null;
  const valuePerPoint = tradovateValuePerPoint(exactPosition?.symbol ?? null);
  if (!exactPosition || exactPosition.averagePrice == null || valuePerPoint == null) {
    return { data, marks: previousMarks };
  }

  const marks = {
    ...previousMarks,
    [String(tick.anchor.contractId)]: {
      contractId: tick.anchor.contractId,
      price: exactPosition.averagePrice
        + tick.anchor.openPnl / (exactPosition.netPosition * valuePerPoint),
      valuePerPoint,
      observedAt: tick.capturedAt,
    },
  };
  const accounts = data.accounts.map(account => {
    const openPositions = account.positions.filter(position => position.netPosition !== 0);
    const exact = account.id === tick.anchor!.accountId ? tick.anchor : null;
    const estimatedParts = openPositions.map(position => {
      const mark = marks[String(position.contractId)];
      if (!mark || position.averagePrice == null) return null;
      return (mark.price - position.averagePrice) * position.netPosition * mark.valuePerPoint;
    });
    const canEstimate = estimatedParts.every((value): value is number => value != null);
    const openPnl = exact?.openPnl
      ?? (openPositions.length === 0 ? 0 : canEstimate ? estimatedParts.reduce((sum, value) => sum + value, 0) : null);
    if (openPnl == null) return account;
    const totalCashValue = exact?.totalCashValue ?? account.balance.totalCashValue;
    return {
      ...account,
      balance: {
        ...account.balance,
        ...(exact?.totalCashValue != null ? { totalCashValue: exact.totalCashValue } : {}),
        openPnL: openPnl,
        ...(exact?.netLiq != null
          ? { netLiq: exact.netLiq }
          : totalCashValue != null ? { netLiq: totalCashValue + openPnl } : {}),
        openPnlSource: exact ? 'broker' as const : 'estimated' as const,
        openPnlAsOf: tick.capturedAt,
      },
    };
  });
  return {
    data: { ...data, capturedAt: tick.capturedAt, accounts },
    marks,
  };
}

/**
 * The lightweight tick intentionally does not request a cash snapshot when all
 * accounts are flat. Detect the first open -> flat transition so the caller can
 * run one authoritative preflight and refresh realized P&L, balance and orders.
 */
export const tradovateLiveTickClosedLastPosition = (
  data: TradovateAccountDataResult,
  tick: TradovateLivePnlTick,
): boolean => data.accounts.some(account => account.netPositionCount > 0)
  && !tick.positions.some(position => position.netPosition !== 0);

const mergePosition = (
  previous: TradovateAccountPosition | undefined,
  tick: TradovateLivePnlTick['positions'][number],
  symbol: string | null,
): TradovateAccountPosition => ({
  id: tick.id,
  contractId: tick.contractId,
  symbol: previous?.symbol ?? symbol,
  timestamp: tick.timestamp,
  tradeDate: previous?.tradeDate ?? null,
  netPosition: tick.netPosition,
  bought: previous?.bought ?? null,
  boughtValue: previous?.boughtValue ?? null,
  sold: previous?.sold ?? null,
  soldValue: previous?.soldValue ?? null,
  previousPosition: previous?.previousPosition ?? null,
  averagePrice: tick.averagePrice,
  previousPrice: previous?.previousPrice ?? null,
});

export function applyTradovateLivePnlTick(
  data: TradovateAccountDataResult,
  tick: TradovateLivePnlTick,
  previousMarks: TradovateContractMarkMap = {},
): { data: TradovateAccountDataResult; marks: TradovateContractMarkMap } {
  const contractSymbols = new Map(data.contracts.map(contract => [contract.id, contract.name]));
  const positionsByAccount = new Map<number, TradovateLivePnlTick['positions']>();
  for (const position of tick.positions) {
    const rows = positionsByAccount.get(position.accountId) ?? [];
    rows.push(position);
    positionsByAccount.set(position.accountId, rows);
  }
  const ordersByAccount = new Map<number, TradovateLivePnlTick['orders']>();
  for (const order of tick.orders) {
    const rows = ordersByAccount.get(order.accountId) ?? [];
    rows.push(order);
    ordersByAccount.set(order.accountId, rows);
  }

  const marks = { ...previousMarks };
  if (tick.anchor) {
    const anchorPosition = tick.positions.find(position =>
      position.accountId === tick.anchor!.accountId
      && position.contractId === tick.anchor!.contractId
      && position.netPosition !== 0);
    const symbol = contractSymbols.get(tick.anchor.contractId) ?? null;
    const valuePerPoint = tradovateValuePerPoint(symbol);
    if (anchorPosition?.averagePrice != null && valuePerPoint != null) {
      marks[String(tick.anchor.contractId)] = {
        contractId: tick.anchor.contractId,
        price: anchorPosition.averagePrice
          + tick.anchor.openPnl / (anchorPosition.netPosition * valuePerPoint),
        valuePerPoint,
        observedAt: tick.capturedAt,
      };
    }
  }

  const accounts = data.accounts.map(account => {
    const tickPositions = positionsByAccount.get(account.id) ?? [];
    const previousByContract = new Map(account.positions.map(position => [position.contractId, position]));
    const positions = tickPositions.map(position => mergePosition(
      previousByContract.get(position.contractId),
      position,
      contractSymbols.get(position.contractId) ?? null,
    ));
    const orders = (ordersByAccount.get(account.id) ?? []).map(order => ({
      id: order.id,
      contractId: order.contractId,
      symbol: order.contractId == null ? null : contractSymbols.get(order.contractId) ?? null,
      timestamp: order.timestamp,
      action: order.action,
      orderType: order.orderType,
      quantity: order.quantity,
      price: order.price,
      stopPrice: order.stopPrice,
      status: order.status,
      admin: order.admin,
      ocoId: order.ocoId,
      parentId: order.parentId,
      linkedId: order.linkedId,
    })).sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? ''));
    const workingOrderCount = orders.filter(order => isTradovateWorkingStatus(order.status)).length;
    const openPositions = positions.filter(position => position.netPosition !== 0);
    const exact = tick.anchor?.accountId === account.id ? tick.anchor : null;
    const estimatedParts = openPositions.map(position => {
      const mark = marks[String(position.contractId)];
      if (!mark || position.averagePrice == null) return null;
      return (mark.price - position.averagePrice) * position.netPosition * mark.valuePerPoint;
    });
    const canEstimate = estimatedParts.every((value): value is number => value != null);
    const openPnl = exact?.openPnl
      ?? (openPositions.length === 0 ? 0 : canEstimate ? estimatedParts.reduce((sum, value) => sum + value, 0) : account.balance.openPnL);
    const source = exact
      ? 'broker' as const
      : openPositions.length === 0 || canEstimate ? 'estimated' as const : 'stale' as const;
    const totalCashValue = exact?.totalCashValue ?? account.balance.totalCashValue;
    return {
      ...account,
      netPositionCount: openPositions.length,
      workingOrderCount,
      positions,
      orders,
      activity: {
        ...account.activity,
        workingOrderCount,
        orderCount: orders.length,
      },
      balance: {
        ...account.balance,
        ...(exact?.totalCashValue != null ? { totalCashValue: exact.totalCashValue } : {}),
        ...(openPnl != null ? { openPnL: openPnl } : {}),
        ...(exact?.netLiq != null
          ? { netLiq: exact.netLiq }
          : openPnl != null && totalCashValue != null ? { netLiq: totalCashValue + openPnl } : {}),
        openPnlSource: source,
        openPnlAsOf: tick.capturedAt,
      },
    };
  });

  return {
    data: {
      ...data,
      capturedAt: tick.capturedAt,
      accounts,
      coverage: {
        ...data.coverage,
        orders: { availability: tick.orders.length > 0 ? 'available' : 'empty', count: tick.orders.length, httpStatus: 200 },
      },
    },
    marks,
  };
}

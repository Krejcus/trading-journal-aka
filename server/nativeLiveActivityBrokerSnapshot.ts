import { pointValueUsd } from '../services/futuresContractSpecs.js';

interface PositionEntity {
  accountId?: number;
  contractId?: number;
  netPos?: number;
  netPrice?: number;
}

interface OrderEntity {
  id?: number;
  accountId?: number;
  contractId?: number;
  action?: string;
  ordStatus?: string;
}

interface OrderVersionEntity {
  id?: number;
  orderId?: number;
  orderQty?: number;
  orderType?: string;
  price?: number;
  stopPrice?: number;
}

interface CashBalanceEntity {
  accountId?: number;
  timestamp?: string;
  amount?: number;
  realizedPnL?: number;
}

interface CashBalanceSnapshot {
  errorText?: string;
  openPnL?: number;
  totalCashValue?: number;
  netLiq?: number;
}

interface ContractEntity {
  id?: number;
  name?: string;
}

interface AccountEntity {
  id?: number;
  name?: string;
  canTrade?: boolean;
}

interface UserAccountAutoLiqEntity {
  accountId?: number;
  changesLocked?: boolean;
}

export interface NativeLiveActivityBrokerAccount {
  accountId: number;
  accountName: string;
  balance: number;
  realizedPnl: number;
  openPnl: number;
  totalPnl: number;
  canTrade: boolean;
  changesLocked: boolean;
}

export interface NativeLiveActivityBrokerPosition {
  accountId: number;
  symbol: string | null;
  side: 'Long' | 'Short';
  quantity: number;
  entryPrice: number | null;
  currentPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
}

export interface NativeLiveActivityBrokerPendingOrder {
  symbol: string;
  side: 'Buy' | 'Sell';
  quantity: number;
  price: number;
}

export interface NativeLiveActivityBrokerSnapshot {
  accounts: NativeLiveActivityBrokerAccount[];
  positions: NativeLiveActivityBrokerPosition[];
  pendingOrder: NativeLiveActivityBrokerPendingOrder | null;
  workingOrderCount: number;
  realizedPnl: number;
  openPnl: number;
  totalPnl: number;
  /** False means the display must label the amount as realized-only. */
  completeOpenPnl: boolean;
  /** False means account/list failed and lock transitions must not be inferred. */
  accountStatusComplete?: boolean;
  /** False means userAccountAutoLiq/list failed and unlocks must not be inferred. */
  accountLockStatusComplete?: boolean;
  capturedAt: number;
}

const terminalOrderStatuses = new Set(['filled', 'canceled', 'cancelled', 'rejected', 'expired', 'completed']);
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const working = (order: OrderEntity): boolean =>
  !terminalOrderStatuses.has((order.ordStatus ?? '').toLowerCase());

async function requestJson<T>(options: {
  baseUrl: string;
  accessToken: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  fetchImpl: typeof fetch;
}): Promise<T> {
  const response = await options.fetchImpl(`${options.baseUrl}${options.path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${options.accessToken}`,
      ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body == null ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok || payload == null) throw new Error(`tradovate-live-activity-http-${response.status}`);
  return payload;
}

/**
 * Minimal broker read model for a remote Live Activity. It does not persist
 * financial values. Base lists are one request each; cash snapshots are only
 * requested for accounts that currently have exposure.
 */
export async function loadNativeLiveActivityBrokerSnapshot(options: {
  baseUrl: string;
  accessToken: string;
  accountIds: readonly number[];
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<NativeLiveActivityBrokerSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const allowedAccounts = new Set(options.accountIds.filter(Number.isSafeInteger));
  const optionalList = async <T>(path: string): Promise<{ values: T[]; complete: boolean }> => {
    try {
      const value = await requestJson<T[]>({ ...options, path, fetchImpl });
      return { values: Array.isArray(value) ? value : [], complete: Array.isArray(value) };
    } catch {
      return { values: [], complete: false };
    }
  };
  const [rawPositions, rawOrders, rawBalances, rawAccounts, rawAutoLiq, rawOrderVersions] = await Promise.all([
    requestJson<PositionEntity[]>({ ...options, path: '/position/list', fetchImpl }),
    requestJson<OrderEntity[]>({ ...options, path: '/order/list', fetchImpl }),
    requestJson<CashBalanceEntity[]>({ ...options, path: '/cashBalance/list', fetchImpl }),
    optionalList<AccountEntity>('/account/list'),
    optionalList<UserAccountAutoLiqEntity>('/userAccountAutoLiq/list'),
    optionalList<OrderVersionEntity>('/orderVersion/list'),
  ]);
  if (!Array.isArray(rawPositions) || !Array.isArray(rawOrders) || !Array.isArray(rawBalances)) {
    throw new Error('tradovate-live-activity-invalid-list');
  }

  const open = rawPositions.flatMap(position => {
    const accountId = finite(position.accountId);
    const contractId = finite(position.contractId);
    const netPosition = finite(position.netPos);
    if (accountId == null || contractId == null || netPosition == null || netPosition === 0
      || !allowedAccounts.has(accountId)) return [];
    return [{ accountId, contractId, netPosition, entryPrice: finite(position.netPrice) }];
  });
  const leaderAccountId = options.accountIds.find(Number.isSafeInteger) ?? null;
  const workingOrders = rawOrders.filter(order => {
    const accountId = finite(order.accountId);
    return accountId != null && allowedAccounts.has(accountId) && working(order);
  });
  const leaderWorkingOrders = workingOrders.filter(order => finite(order.accountId) === leaderAccountId);
  const contractIds = [...new Set([
    ...open.map(position => position.contractId),
    ...leaderWorkingOrders.flatMap(order => finite(order.contractId) ?? []),
  ])];
  let symbols = new Map<number, string>();
  if (contractIds.length > 0) {
    try {
      const contracts = await requestJson<ContractEntity[]>({
        ...options,
        path: `/contract/items?ids=${contractIds.map(id => encodeURIComponent(String(id))).join(',')}`,
        fetchImpl,
      });
      if (Array.isArray(contracts)) {
        symbols = new Map(contracts.flatMap(contract => {
          const id = finite(contract.id);
          return id == null || typeof contract.name !== 'string' ? [] : [[id, contract.name] as const];
        }));
      }
    } catch {
      // A missing symbol must not suppress otherwise authoritative P&L/position state.
    }
  }

  const latestBalance = new Map<number, CashBalanceEntity>();
  for (const balance of rawBalances) {
    const accountId = finite(balance.accountId);
    if (accountId == null || !allowedAccounts.has(accountId)) continue;
    const current = latestBalance.get(accountId);
    if (!current || Date.parse(balance.timestamp ?? '') > Date.parse(current.timestamp ?? '')) {
      latestBalance.set(accountId, balance);
    }
  }
  const realizedPnl = [...latestBalance.values()]
    .reduce((sum, balance) => sum + (finite(balance.realizedPnL) ?? 0), 0);

  const openAccountIds = [...new Set(open.map(position => position.accountId))];
  const openPnlResults = await Promise.all(openAccountIds.map(async accountId => {
    try {
      const snapshot = await requestJson<CashBalanceSnapshot>({
        ...options,
        path: '/cashBalance/getcashbalancesnapshot',
        method: 'POST',
        body: { accountId },
        fetchImpl,
      });
      const value = snapshot.errorText ? null : finite(snapshot.openPnL);
      return {
        accountId,
        value,
        balance: finite(snapshot.netLiq) ?? finite(snapshot.totalCashValue),
      };
    } catch {
      return { accountId, value: null, balance: null };
    }
  }));
  const completeOpenPnl = openPnlResults.every(result => result.value != null);
  const openPnl = openPnlResults.reduce((sum, result) => sum + (result.value ?? 0), 0);
  const openByAccount = new Map(openPnlResults.map(result => [result.accountId, result]));
  const accountById = new Map(rawAccounts.values.flatMap(account => {
    const id = finite(account.id);
    return id == null || !allowedAccounts.has(id) ? [] : [[id, account] as const];
  }));
  const autoLiqByAccount = new Map(rawAutoLiq.values.flatMap(row => {
    const id = finite(row.accountId);
    return id == null || !allowedAccounts.has(id) ? [] : [[id, row] as const];
  }));
  const accounts = [...allowedAccounts].map(accountId => {
    const balance = latestBalance.get(accountId);
    const realized = finite(balance?.realizedPnL) ?? 0;
    const openResult = openByAccount.get(accountId);
    const account = accountById.get(accountId);
    return {
      accountId,
      accountName: typeof account?.name === 'string' && account.name.trim() ? account.name.trim() : `Tradovate ${accountId}`,
      balance: openResult?.balance ?? finite(balance?.amount) ?? 0,
      realizedPnl: realized,
      openPnl: openResult?.value ?? 0,
      totalPnl: realized + (openResult?.value ?? 0),
      canTrade: account?.canTrade !== false,
      changesLocked: autoLiqByAccount.get(accountId)?.changesLocked === true,
    };
  });

  const latestVersionByOrderId = new Map<number, OrderVersionEntity>();
  if (rawOrderVersions.complete) {
    for (const version of rawOrderVersions.values) {
      const orderId = finite(version.orderId);
      const versionId = finite(version.id);
      if (orderId == null) continue;
      const current = latestVersionByOrderId.get(orderId);
      if (!current || (versionId ?? 0) >= (finite(current.id) ?? 0)) {
        latestVersionByOrderId.set(orderId, version);
      }
    }
  }

  const leaderOpen = open.filter(position => position.accountId === leaderAccountId);
  const dominantPool = leaderOpen.length > 0 ? leaderOpen : open;
  const quantityByContract = new Map<number, number>();
  for (const position of dominantPool) {
    quantityByContract.set(position.contractId,
      (quantityByContract.get(position.contractId) ?? 0) + Math.abs(position.netPosition));
  }
  const dominantContractId = [...quantityByContract.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  const dominantPositions = dominantContractId == null
    ? []
    : open.filter(position => position.contractId === dominantContractId);
  const dominantQuantity = dominantPositions.reduce((sum, position) => sum + Math.abs(position.netPosition), 0);
  const dominantDirection = dominantPositions[0]?.netPosition && dominantPositions[0].netPosition > 0 ? 1 : -1;
  const sameDirection = dominantPositions.every(position => Math.sign(position.netPosition) === dominantDirection);
  const allExposureIsDominant = dominantPositions.length === open.length;
  const dominantEntryNumerator = dominantPositions.reduce((sum, position) =>
    sum + (position.entryPrice == null ? 0 : position.entryPrice * Math.abs(position.netPosition)), 0);
  const hasCompleteEntry = dominantPositions.length > 0
    && dominantPositions.every(position => position.entryPrice != null);
  const dominantEntryPrice = hasCompleteEntry && dominantQuantity > 0
    ? dominantEntryNumerator / dominantQuantity
    : null;
  const dominantSymbol = dominantContractId == null ? null : symbols.get(dominantContractId) ?? null;

  let stopPrice: number | null = null;
  let targetPrice: number | null = null;
  if (rawOrderVersions.complete && dominantContractId != null && dominantEntryPrice != null && sameDirection) {
    const protectiveAction = dominantDirection > 0 ? 'sell' : 'buy';
    const candidates = leaderWorkingOrders.flatMap(order => {
      const orderId = finite(order.id);
      if (orderId == null || finite(order.contractId) !== dominantContractId
        || (order.action ?? '').toLowerCase() !== protectiveAction) return [];
      const version = latestVersionByOrderId.get(orderId);
      return version ? [version] : [];
    });
    const stops = candidates.flatMap(version => {
      const kind = (version.orderType ?? '').toLowerCase();
      const price = finite(version.stopPrice);
      const correctSide = price != null
        && (dominantDirection > 0 ? price <= dominantEntryPrice : price >= dominantEntryPrice);
      return (kind === 'stop' || kind === 'stoplimit') && correctSide ? [price] : [];
    });
    const targets = candidates.flatMap(version => {
      const price = finite(version.price);
      const correctSide = price != null
        && (dominantDirection > 0 ? price >= dominantEntryPrice : price <= dominantEntryPrice);
      return (version.orderType ?? '').toLowerCase() === 'limit' && correctSide ? [price] : [];
    });
    stopPrice = stops.sort((a, b) => Math.abs(a - dominantEntryPrice) - Math.abs(b - dominantEntryPrice))[0] ?? null;
    targetPrice = targets.sort((a, b) => Math.abs(a - dominantEntryPrice) - Math.abs(b - dominantEntryPrice))[0] ?? null;
  }

  let currentPrice: number | null = null;
  if (completeOpenPnl && allExposureIsDominant && sameDirection && dominantEntryPrice != null
    && dominantSymbol != null && dominantQuantity > 0) {
    const pointValue = pointValueUsd(dominantSymbol);
    if (pointValue != null) {
      currentPrice = dominantEntryPrice + openPnl / (dominantQuantity * pointValue * dominantDirection);
    }
  }

  let pendingOrder: NativeLiveActivityBrokerPendingOrder | null = null;
  if (open.length === 0 && rawOrderVersions.complete) {
    const candidate = leaderWorkingOrders.flatMap(order => {
      const orderId = finite(order.id);
      const contractId = finite(order.contractId);
      const action = (order.action ?? '').toLowerCase();
      if (orderId == null || contractId == null || (action !== 'buy' && action !== 'sell')) return [];
      const version = latestVersionByOrderId.get(orderId);
      const kind = (version?.orderType ?? '').toLowerCase();
      const price = kind === 'limit' ? finite(version?.price)
        : (kind === 'stop' || kind === 'stoplimit') ? finite(version?.stopPrice) : null;
      const quantity = finite(version?.orderQty);
      const symbol = symbols.get(contractId);
      return price == null || quantity == null || quantity <= 0 || !symbol ? [] : [{
        orderId,
        pending: { symbol, side: action === 'buy' ? 'Buy' as const : 'Sell' as const, quantity, price },
      }];
    }).sort((a, b) => a.orderId - b.orderId)[0];
    pendingOrder = candidate?.pending ?? null;
  }

  return {
    accounts,
    positions: open.map(position => ({
      accountId: position.accountId,
      symbol: symbols.get(position.contractId) ?? null,
      side: position.netPosition > 0 ? 'Long' : 'Short',
      quantity: Math.abs(position.netPosition),
      entryPrice: position.entryPrice,
      currentPrice: position.contractId === dominantContractId ? currentPrice : null,
      stopPrice: position.contractId === dominantContractId ? stopPrice : null,
      targetPrice: position.contractId === dominantContractId ? targetPrice : null,
    })),
    pendingOrder,
    workingOrderCount: workingOrders.length,
    realizedPnl,
    openPnl,
    totalPnl: realizedPnl + openPnl,
    completeOpenPnl,
    accountStatusComplete: rawAccounts.complete,
    accountLockStatusComplete: rawAutoLiq.complete,
    capturedAt: options.now ?? Date.now(),
  };
}

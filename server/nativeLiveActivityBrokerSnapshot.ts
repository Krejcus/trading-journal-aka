interface PositionEntity {
  accountId?: number;
  contractId?: number;
  netPos?: number;
  netPrice?: number;
}

interface OrderEntity {
  accountId?: number;
  ordStatus?: string;
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
}

export interface NativeLiveActivityBrokerSnapshot {
  accounts: NativeLiveActivityBrokerAccount[];
  positions: NativeLiveActivityBrokerPosition[];
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
  const [rawPositions, rawOrders, rawBalances, rawAccounts, rawAutoLiq] = await Promise.all([
    requestJson<PositionEntity[]>({ ...options, path: '/position/list', fetchImpl }),
    requestJson<OrderEntity[]>({ ...options, path: '/order/list', fetchImpl }),
    requestJson<CashBalanceEntity[]>({ ...options, path: '/cashBalance/list', fetchImpl }),
    optionalList<AccountEntity>('/account/list'),
    optionalList<UserAccountAutoLiqEntity>('/userAccountAutoLiq/list'),
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
    return [{ accountId, contractId, netPosition }];
  });
  const contractIds = [...new Set(open.map(position => position.contractId))];
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

  return {
    accounts,
    positions: open.map(position => ({
      accountId: position.accountId,
      symbol: symbols.get(position.contractId) ?? null,
      side: position.netPosition > 0 ? 'Long' : 'Short',
      quantity: Math.abs(position.netPosition),
    })),
    workingOrderCount: rawOrders.filter(order => {
      const accountId = finite(order.accountId);
      return accountId != null
        && allowedAccounts.has(accountId)
        && !terminalOrderStatuses.has((order.ordStatus ?? '').toLowerCase());
    }).length,
    realizedPnl,
    openPnl,
    totalPnl: realizedPnl + openPnl,
    completeOpenPnl,
    accountStatusComplete: rawAccounts.complete,
    accountLockStatusComplete: rawAutoLiq.complete,
    capturedAt: options.now ?? Date.now(),
  };
}

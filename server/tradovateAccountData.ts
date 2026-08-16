export type TradovateDataAvailability = 'available' | 'empty' | 'denied' | 'unavailable';

export interface TradovateSourceCoverage {
  availability: TradovateDataAvailability;
  count: number;
  httpStatus: number | null;
}

export interface TradovateAccountDataAccount {
  id: number;
  name: string;
  active: boolean;
  canTrade: boolean;
  netPositionCount: number;
  workingOrderCount: number;
  balance: {
    coverage: TradovateSourceCoverage;
    totalCashValue: number | null;
    netLiq: number | null;
    netLiqSOD: number | null;
    openPnL: number | null;
    realizedPnL: number | null;
    weekRealizedPnL: number | null;
    initialMargin: number | null;
    maintenanceMargin: number | null;
    autoLiqLevel: number | null;
  };
  activity: {
    positionCount: number;
    netPositionCount: number;
    workingOrderCount: number;
    orderCount: number;
    fillCount: number;
    fillPairCount: number;
    knownFees: number;
    firstFillAt: string | null;
    lastFillAt: string | null;
  };
  history: {
    coverage: TradovateSourceCoverage;
    entryCount: number;
    firstEntryAt: string | null;
    lastEntryAt: string | null;
    realizedBalanceDrawdown: number | null;
  };
  risk: {
    statusCoverage: TradovateSourceCoverage;
    limitsCoverage: TradovateSourceCoverage;
    adminAction: string | null;
    maxNetLiq: number | null;
    minNetLiq: number | null;
    dailyLossAutoLiq: number | null;
    weeklyLossAutoLiq: number | null;
    trailingMaxDrawdown: number | null;
    trailingMaxDrawdownLimit: number | null;
    trailingMaxDrawdownMode: string | null;
    changesLocked: boolean | null;
  };
}

export interface TradovateAccountDataResult {
  capturedAt: string;
  accounts: TradovateAccountDataAccount[];
  coverage: {
    accounts: TradovateSourceCoverage;
    positions: TradovateSourceCoverage;
    orders: TradovateSourceCoverage;
    fills: TradovateSourceCoverage;
    fillPairs: TradovateSourceCoverage;
    fillFees: TradovateSourceCoverage;
  };
}

interface AccountEntity { id: number; name?: string; active?: boolean; readonly?: boolean }
interface PositionEntity { id?: number; accountId: number; netPos: number }
interface OrderEntity { id?: number; accountId: number; ordStatus?: string }
interface FillEntity { id?: number; orderId: number; timestamp?: string }
interface FillPairEntity { buyFillId: number; sellFillId: number }
interface FillFeeEntity {
  id?: number;
  clearingFee?: number;
  exchangeFee?: number;
  nfaFee?: number;
  brokerageFee?: number;
  ipFee?: number;
  commission?: number;
  orderRoutingFee?: number;
}
interface CashBalanceLogEntity { timestamp?: string; amount?: number }
interface CashBalanceSnapshot {
  errorText?: string;
  totalCashValue?: number;
  netLiq?: number;
  netLiqSOD?: number;
  openPnL?: number;
  realizedPnL?: number;
  weekRealizedPnL?: number;
  initialMargin?: number;
  maintenanceMargin?: number;
  autoLiqLevel?: number;
}
interface AccountRiskStatus {
  adminAction?: string;
  maxNetLiq?: number;
  minNetLiq?: number;
}
interface UserAccountAutoLiq {
  changesLocked?: boolean;
  dailyLossAutoLiq?: number;
  weeklyLossAutoLiq?: number;
  trailingMaxDrawdown?: number;
  trailingMaxDrawdownLimit?: number;
  trailingMaxDrawdownMode?: string;
}

interface Probe<T> {
  ok: boolean;
  value: T | null;
  status: number | null;
}

const terminalOrderStatuses = new Set(['Filled', 'Canceled', 'Cancelled', 'Rejected', 'Expired', 'Completed']);

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const coverage = (probe: Probe<unknown>, count: number): TradovateSourceCoverage => ({
  availability: probe.ok ? (count > 0 ? 'available' : 'empty') : probe.status === 401 || probe.status === 403 ? 'denied' : 'unavailable',
  count,
  httpStatus: probe.status,
});

const getTimestampRange = (values: Array<string | undefined>) => {
  const timestamps = values
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return { first: timestamps[0] ?? null, last: timestamps[timestamps.length - 1] ?? null };
};

export const calculateRealizedBalanceDrawdown = (logs: CashBalanceLogEntity[]): number | null => {
  const ordered = logs
    .filter((log): log is CashBalanceLogEntity & { timestamp: string; amount: number } =>
      typeof log.timestamp === 'string' && Number.isFinite(Date.parse(log.timestamp)) && finite(log.amount) != null)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (ordered.length === 0) return null;
  let peak = ordered[0].amount;
  let drawdown = 0;
  for (const log of ordered) {
    peak = Math.max(peak, log.amount);
    drawdown = Math.max(drawdown, peak - log.amount);
  }
  return drawdown;
};

const sumKnownFees = (fees: FillFeeEntity[]): number => fees.reduce((total, fee) => total + [
  fee.clearingFee,
  fee.exchangeFee,
  fee.nfaFee,
  fee.brokerageFee,
  fee.ipFee,
  fee.commission,
  fee.orderRoutingFee,
].reduce<number>((sum, value) => sum + (finite(value) ?? 0), 0), 0);

const request = async <T>(options: {
  baseUrl: string;
  path: string;
  accessToken: string;
  fetchImpl: typeof fetch;
  method?: 'GET' | 'POST';
  body?: unknown;
}): Promise<Probe<T>> => {
  try {
    const response = await options.fetchImpl(`${options.baseUrl}${options.path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${options.accessToken}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, value: null, status: response.status };
    return { ok: true, value: await response.json() as T, status: response.status };
  } catch {
    return { ok: false, value: null, status: null };
  }
};

const requireList = <T>(probe: Probe<T[]>): T[] => probe.ok && Array.isArray(probe.value) ? probe.value : [];

export async function loadTradovateAccountData(options: {
  baseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<TradovateAccountDataResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const call = <T>(path: string) => request<T>({ ...options, path, fetchImpl });
  const [accountsProbe, positionsProbe, ordersProbe, fillsProbe, fillPairsProbe, fillFeesProbe] = await Promise.all([
    call<AccountEntity[]>('/account/list'),
    call<PositionEntity[]>('/position/list'),
    call<OrderEntity[]>('/order/list'),
    call<FillEntity[]>('/fill/list'),
    call<FillPairEntity[]>('/fillPair/list'),
    call<FillFeeEntity[]>('/fillFee/list'),
  ]);

  const accounts = requireList(accountsProbe);
  if (!accountsProbe.ok || !Array.isArray(accountsProbe.value)) {
    throw new Error(`Tradovate /account/list failed (${accountsProbe.status ?? 'network'})`);
  }
  const positions = requireList(positionsProbe);
  const orders = requireList(ordersProbe);
  const fills = requireList(fillsProbe);
  const fillPairs = requireList(fillPairsProbe);
  const fillFees = requireList(fillFeesProbe);

  const accountData = await Promise.all(accounts.map(async account => {
    const accountId = account.id;
    const encodedId = encodeURIComponent(String(accountId));
    const [snapshotProbe, historyProbe, riskStatusProbe, riskLimitsProbe] = await Promise.all([
      request<CashBalanceSnapshot>({
        ...options,
        path: '/cashBalance/getcashbalancesnapshot',
        fetchImpl,
        method: 'POST',
        body: { accountId },
      }),
      call<CashBalanceLogEntity[]>(`/cashBalanceLog/deps?masterid=${encodedId}`),
      call<AccountRiskStatus[]>(`/accountRiskStatus/deps?masterid=${encodedId}`),
      call<UserAccountAutoLiq[]>(`/userAccountAutoLiq/deps?masterid=${encodedId}`),
    ]);

    const snapshot = snapshotProbe.ok && snapshotProbe.value && !snapshotProbe.value.errorText
      ? snapshotProbe.value
      : null;
    const accountPositions = positions.filter(position => position.accountId === accountId);
    const accountOrders = orders.filter(order => order.accountId === accountId);
    const orderIds = new Set(accountOrders.map(order => order.id).filter((id): id is number => typeof id === 'number'));
    const accountFills = fills.filter(fill => orderIds.has(fill.orderId));
    const fillIds = new Set(accountFills.map(fill => fill.id).filter((id): id is number => typeof id === 'number'));
    const accountFillPairs = fillPairs.filter(pair => fillIds.has(pair.buyFillId) || fillIds.has(pair.sellFillId));
    const accountFillFees = fillFees.filter(fee => typeof fee.id === 'number' && fillIds.has(fee.id));
    const history = requireList(historyProbe);
    const riskStatus = requireList(riskStatusProbe)[0] ?? null;
    const riskLimits = requireList(riskLimitsProbe)[0] ?? null;
    const fillRange = getTimestampRange(accountFills.map(fill => fill.timestamp));
    const historyRange = getTimestampRange(history.map(entry => entry.timestamp));

    return {
      id: accountId,
      name: account.name ?? String(accountId),
      active: account.active !== false,
      canTrade: account.readonly !== true,
      netPositionCount: accountPositions.filter(position => position.netPos !== 0).length,
      workingOrderCount: accountOrders.filter(order => !terminalOrderStatuses.has(order.ordStatus ?? '')).length,
      balance: {
        coverage: coverage(snapshotProbe, snapshot ? 1 : 0),
        totalCashValue: finite(snapshot?.totalCashValue),
        netLiq: finite(snapshot?.netLiq),
        netLiqSOD: finite(snapshot?.netLiqSOD),
        openPnL: finite(snapshot?.openPnL),
        realizedPnL: finite(snapshot?.realizedPnL),
        weekRealizedPnL: finite(snapshot?.weekRealizedPnL),
        initialMargin: finite(snapshot?.initialMargin),
        maintenanceMargin: finite(snapshot?.maintenanceMargin),
        autoLiqLevel: finite(snapshot?.autoLiqLevel),
      },
      activity: {
        positionCount: accountPositions.length,
        netPositionCount: accountPositions.filter(position => position.netPos !== 0).length,
        workingOrderCount: accountOrders.filter(order => !terminalOrderStatuses.has(order.ordStatus ?? '')).length,
        orderCount: accountOrders.length,
        fillCount: accountFills.length,
        fillPairCount: accountFillPairs.length,
        knownFees: sumKnownFees(accountFillFees),
        firstFillAt: fillRange.first,
        lastFillAt: fillRange.last,
      },
      history: {
        coverage: coverage(historyProbe, history.length),
        entryCount: history.length,
        firstEntryAt: historyRange.first,
        lastEntryAt: historyRange.last,
        realizedBalanceDrawdown: calculateRealizedBalanceDrawdown(history),
      },
      risk: {
        statusCoverage: coverage(riskStatusProbe, requireList(riskStatusProbe).length),
        limitsCoverage: coverage(riskLimitsProbe, requireList(riskLimitsProbe).length),
        adminAction: riskStatus?.adminAction ?? null,
        maxNetLiq: finite(riskStatus?.maxNetLiq),
        minNetLiq: finite(riskStatus?.minNetLiq),
        dailyLossAutoLiq: finite(riskLimits?.dailyLossAutoLiq),
        weeklyLossAutoLiq: finite(riskLimits?.weeklyLossAutoLiq),
        trailingMaxDrawdown: finite(riskLimits?.trailingMaxDrawdown),
        trailingMaxDrawdownLimit: finite(riskLimits?.trailingMaxDrawdownLimit),
        trailingMaxDrawdownMode: riskLimits?.trailingMaxDrawdownMode ?? null,
        changesLocked: typeof riskLimits?.changesLocked === 'boolean' ? riskLimits.changesLocked : null,
      },
    } satisfies TradovateAccountDataAccount;
  }));

  return {
    capturedAt: new Date(options.now ?? Date.now()).toISOString(),
    accounts: accountData,
    coverage: {
      accounts: coverage(accountsProbe, accounts.length),
      positions: coverage(positionsProbe, positions.length),
      orders: coverage(ordersProbe, orders.length),
      fills: coverage(fillsProbe, fills.length),
      fillPairs: coverage(fillPairsProbe, fillPairs.length),
      fillFees: coverage(fillFeesProbe, fillFees.length),
    },
  };
}

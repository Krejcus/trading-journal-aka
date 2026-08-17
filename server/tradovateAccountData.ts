import type {
  TradovateAccountDataAccount,
  TradovateAccountDataResult,
  TradovateAccountFill,
  TradovateAccountFillPair,
  TradovateAccountOrder,
  TradovateAccountPosition,
  TradovateCashLedgerEntry,
  TradovateContractSummary,
  TradovateDailyAccountSummary,
  TradovateFeeBreakdown,
  TradovateSourceCoverage,
} from '../lib/tradovateAccountDataTypes.js';

export type {
  TradovateAccountDataAccount,
  TradovateAccountDataResult,
  TradovateSourceCoverage,
} from '../lib/tradovateAccountDataTypes.js';

interface AccountEntity {
  id: number;
  name?: string;
  timestamp?: string;
  active?: boolean;
  readonly?: boolean;
}
interface TradeDateEntity { year?: number; month?: number; day?: number }
interface PositionEntity {
  id?: number;
  accountId: number;
  contractId: number;
  timestamp?: string;
  tradeDate?: TradeDateEntity;
  netPos: number;
  bought?: number;
  boughtValue?: number;
  sold?: number;
  soldValue?: number;
  prevPos?: number;
  netPrice?: number;
  prevPrice?: number;
}
interface OrderEntity {
  id?: number;
  accountId: number;
  timestamp?: string;
  action?: 'Buy' | 'Sell';
  orderType?: string;
  orderQty?: number;
  price?: number;
  stopPrice?: number;
  ordStatus?: string;
  admin?: boolean;
  contractId?: number;
  ocoId?: number;
  parentId?: number;
  linkedId?: number;
}
interface FillEntity {
  id?: number;
  orderId: number;
  contractId: number;
  timestamp?: string;
  tradeDate?: TradeDateEntity;
  action?: 'Buy' | 'Sell';
  qty?: number;
  price?: number;
  active?: boolean;
  finallyPaired?: number;
}
interface FillPairEntity {
  id?: number;
  positionId?: number;
  buyFillId: number;
  sellFillId: number;
  qty?: number;
  buyPrice?: number;
  sellPrice?: number;
  active?: boolean;
}
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
interface CashBalanceLogEntity {
  id?: number;
  accountId?: number;
  timestamp?: string;
  tradeDate?: TradeDateEntity;
  currencyId?: number;
  amount?: number;
  cashChangeType?: string;
  delta?: number;
  realizedPnL?: number;
  weekRealizedPnL?: number;
  fillPairId?: number;
  fillId?: number;
  comment?: string;
}
interface CashBalanceEntity {
  id?: number;
  accountId: number;
  timestamp?: string;
  tradeDate?: TradeDateEntity;
  currencyId?: number;
  amount?: number;
  amountSOD?: number;
  realizedPnL?: number;
  weekRealizedPnL?: number;
}
interface ContractEntity {
  id?: number;
  name?: string;
  contractMaturityId?: number;
  timestamp?: string;
}
interface CashBalanceSnapshot {
  errorText?: string;
  totalCashValue?: number;
  totalCashValueSOD?: number;
  totalPnL?: number;
  netLiq?: number;
  netLiqSOD?: number;
  openPnL?: number;
  realizedPnL?: number;
  weekRealizedPnL?: number;
  cashUSD?: number;
  cashSODUSD?: number;
  currencyCashAvailWithdrawalUSD?: number;
  initialMargin?: number;
  maintenanceMargin?: number;
  fullInitialMargin?: number;
  fullInitialMarginSOD?: number;
  autoLiqLevel?: number;
  withdrawalRejectReason?: string;
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
  partial?: boolean;
}

const terminalOrderStatuses = new Set(['Filled', 'Canceled', 'Cancelled', 'Rejected', 'Expired', 'Completed']);

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// Prop/evaluation providers may use a very large value as a disabled limit.
// Never present that sentinel as the user's actual challenge threshold.
const activeRiskThreshold = (value: unknown): number | null => {
  const parsed = finite(value);
  return parsed != null && Math.abs(parsed) < 100_000_000 ? parsed : null;
};

const coverage = (probe: Probe<unknown>, count: number): TradovateSourceCoverage => ({
  availability: probe.ok
    ? probe.partial ? 'partial' : count > 0 ? 'available' : 'empty'
    : probe.status === 401 || probe.status === 403 ? 'denied' : 'unavailable',
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

const timestampOrNull = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

const tradeDateKey = (value: TradeDateEntity | undefined, timestamp?: string): string | null => {
  const year = finite(value?.year);
  const month = finite(value?.month);
  const day = finite(value?.day);
  if (year != null && month != null && day != null) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const parsedTimestamp = timestampOrNull(timestamp);
  return parsedTimestamp ? new Date(parsedTimestamp).toISOString().slice(0, 10) : null;
};

const feeBreakdown = (fee: FillFeeEntity | undefined): TradovateFeeBreakdown | null => {
  if (!fee) return null;
  const breakdown = {
    clearing: finite(fee.clearingFee) ?? 0,
    exchange: finite(fee.exchangeFee) ?? 0,
    nfa: finite(fee.nfaFee) ?? 0,
    brokerage: finite(fee.brokerageFee) ?? 0,
    ip: finite(fee.ipFee) ?? 0,
    commission: finite(fee.commission) ?? 0,
    orderRouting: finite(fee.orderRoutingFee) ?? 0,
  };
  return { ...breakdown, total: Object.values(breakdown).reduce((sum, value) => sum + value, 0) };
};

const normalizeLedgerEntry = (entry: CashBalanceLogEntity): TradovateCashLedgerEntry => ({
  id: finite(entry.id),
  timestamp: timestampOrNull(entry.timestamp),
  tradeDate: tradeDateKey(entry.tradeDate, entry.timestamp),
  currencyId: finite(entry.currencyId),
  amount: finite(entry.amount),
  delta: finite(entry.delta),
  cashChangeType: typeof entry.cashChangeType === 'string' ? entry.cashChangeType : null,
  realizedPnl: finite(entry.realizedPnL),
  weekRealizedPnl: finite(entry.weekRealizedPnL),
  fillPairId: finite(entry.fillPairId),
  fillId: finite(entry.fillId),
  comment: typeof entry.comment === 'string' ? entry.comment : null,
});

const cashFeeChangeTypes = new Set([
  'BrokerageFee',
  'ClearingFee',
  'Commission',
  'ExchangeFee',
  'IPFee',
  'LiquidationFee',
  'LiquidationFee2',
  'NfaFee',
  'OrderRoutingFee',
  'RithmicFee',
  'ThirdPartyFee',
]);

export const buildDailyAccountSummaries = (
  logs: CashBalanceLogEntity[],
  fills: FillEntity[],
  feesByFillId: Map<number, FillFeeEntity>,
  feesAvailable = true,
  cashBalances: CashBalanceEntity[] = [],
): TradovateDailyAccountSummary[] => {
  const ledgerByDate = new Map<string, TradovateCashLedgerEntry[]>();
  for (const log of logs.map(normalizeLedgerEntry)) {
    if (!log.tradeDate) continue;
    const entries = ledgerByDate.get(log.tradeDate) ?? [];
    entries.push(log);
    ledgerByDate.set(log.tradeDate, entries);
  }

  const fillsByDate = new Map<string, FillEntity[]>();
  for (const fill of fills) {
    const date = tradeDateKey(fill.tradeDate, fill.timestamp);
    if (!date) continue;
    const entries = fillsByDate.get(date) ?? [];
    entries.push(fill);
    fillsByDate.set(date, entries);
  }

  const balancesByDate = new Map<string, CashBalanceEntity[]>();
  for (const balance of cashBalances) {
    const date = tradeDateKey(balance.tradeDate, balance.timestamp);
    if (!date) continue;
    const entries = balancesByDate.get(date) ?? [];
    entries.push(balance);
    balancesByDate.set(date, entries);
  }

  const dates = new Set([...ledgerByDate.keys(), ...fillsByDate.keys(), ...balancesByDate.keys()]);
  return [...dates].sort((a, b) => b.localeCompare(a)).map(tradeDate => {
    const ledger = [...(ledgerByDate.get(tradeDate) ?? [])].sort((a, b) =>
      Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''));
    const dailyFills = fillsByDate.get(tradeDate) ?? [];
    const last = ledger[ledger.length - 1] ?? null;
    const balance = [...(balancesByDate.get(tradeDate) ?? [])]
      .sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''))
      .at(-1) ?? null;
    const balanceAmount = finite(balance?.amount);
    const balanceAmountSod = finite(balance?.amountSOD);
    const fillIds = new Set(dailyFills.map(fill => fill.id).filter((id): id is number => typeof id === 'number'));
    const pairIds = new Set(ledger
      .filter(entry => entry.cashChangeType === 'TradePaired' && entry.fillPairId != null)
      .map(entry => entry.fillPairId as number));
    return {
      tradeDate,
      reportedRealizedPnl: finite(balance?.realizedPnL) ?? last?.realizedPnl ?? null,
      reportedWeekRealizedPnl: finite(balance?.weekRealizedPnL) ?? last?.weekRealizedPnl ?? null,
      endingBalance: balanceAmount ?? last?.amount ?? null,
      cashDelta: ledger.length > 0
        ? ledger.reduce((sum, entry) => sum + (entry.delta ?? 0), 0)
        : balanceAmount != null && balanceAmountSod != null ? balanceAmount - balanceAmountSod : 0,
      grossTradePnl: ledger.reduce((sum, entry) => sum + (entry.cashChangeType === 'TradePaired' ? entry.delta ?? 0 : 0), 0),
      feeDelta: ledger.reduce((sum, entry) => sum + (entry.cashChangeType && cashFeeChangeTypes.has(entry.cashChangeType) ? entry.delta ?? 0 : 0), 0),
      knownFillFees: feesAvailable
        ? [...fillIds].reduce((sum, fillId) => sum + (feeBreakdown(feesByFillId.get(fillId))?.total ?? 0), 0)
        : null,
      fillCount: dailyFills.length,
      pairedTradeCount: pairIds.size,
      ledgerEntryCount: ledger.length,
    };
  });
};

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

export interface TradovateAccountIdentity {
  id: number;
  name: string;
  createdAt: string | null;
}

/**
 * Lightweight, read-only account identity lookup. Account.timestamp is the
 * broker-side creation timestamp documented on the Tradovate Account entity.
 */
export async function loadTradovateAccountIdentity(options: {
  baseUrl: string;
  accessToken: string;
  accountId: number;
  fetchImpl?: typeof fetch;
}): Promise<TradovateAccountIdentity | null> {
  const probe = await request<AccountEntity>({
    ...options,
    path: `/account/item?id=${encodeURIComponent(String(options.accountId))}`,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  if (!probe.ok || !probe.value || probe.value.id !== options.accountId) return null;
  return {
    id: probe.value.id,
    name: probe.value.name ?? String(probe.value.id),
    createdAt: timestampOrNull(probe.value.timestamp),
  };
}

const requireList = <T>(probe: Probe<T[]>): T[] => probe.ok && Array.isArray(probe.value) ? probe.value : [];

const mergeListProbes = <T>(probes: Probe<T[]>[]): Probe<T[]> => {
  if (probes.length === 0) return { ok: true, value: [], status: 200 };
  const successful = probes.filter(probe => probe.ok && Array.isArray(probe.value));
  if (successful.length === 0) return probes[0];
  return {
    ok: true,
    value: successful.flatMap(probe => probe.value ?? []),
    status: successful.length === probes.length ? 200 : null,
    partial: successful.length !== probes.length,
  };
};

const normalizeContract = (contract: ContractEntity): TradovateContractSummary | null => {
  const id = finite(contract.id);
  if (id == null) return null;
  return {
    id,
    name: typeof contract.name === 'string' ? contract.name : null,
    contractMaturityId: finite(contract.contractMaturityId),
    timestamp: timestampOrNull(contract.timestamp),
  };
};

const normalizePosition = (
  position: PositionEntity,
  symbols: Map<number, string>,
): TradovateAccountPosition => ({
  id: finite(position.id),
  contractId: position.contractId,
  symbol: symbols.get(position.contractId) ?? null,
  timestamp: timestampOrNull(position.timestamp),
  tradeDate: tradeDateKey(position.tradeDate, position.timestamp),
  netPosition: position.netPos,
  bought: finite(position.bought),
  boughtValue: finite(position.boughtValue),
  sold: finite(position.sold),
  soldValue: finite(position.soldValue),
  previousPosition: finite(position.prevPos),
  averagePrice: finite(position.netPrice),
  previousPrice: finite(position.prevPrice),
});

const normalizeOrder = (
  order: OrderEntity & { id: number },
  symbols: Map<number, string>,
): TradovateAccountOrder => ({
  id: order.id,
  contractId: finite(order.contractId),
  symbol: typeof order.contractId === 'number' ? symbols.get(order.contractId) ?? null : null,
  timestamp: timestampOrNull(order.timestamp),
  action: order.action === 'Buy' || order.action === 'Sell' ? order.action : null,
  orderType: typeof order.orderType === 'string' ? order.orderType : null,
  quantity: finite(order.orderQty),
  price: finite(order.price),
  stopPrice: finite(order.stopPrice),
  status: typeof order.ordStatus === 'string' ? order.ordStatus : null,
  admin: typeof order.admin === 'boolean' ? order.admin : null,
  ocoId: finite(order.ocoId),
  parentId: finite(order.parentId),
  linkedId: finite(order.linkedId),
});

const normalizeFill = (
  fill: FillEntity & { id: number },
  symbols: Map<number, string>,
  feesByFillId: Map<number, FillFeeEntity>,
): TradovateAccountFill => ({
  id: fill.id,
  orderId: fill.orderId,
  contractId: fill.contractId,
  symbol: symbols.get(fill.contractId) ?? null,
  timestamp: timestampOrNull(fill.timestamp),
  tradeDate: tradeDateKey(fill.tradeDate, fill.timestamp),
  action: fill.action === 'Buy' || fill.action === 'Sell' ? fill.action : null,
  quantity: finite(fill.qty),
  price: finite(fill.price),
  active: typeof fill.active === 'boolean' ? fill.active : null,
  finallyPaired: finite(fill.finallyPaired),
  fees: feeBreakdown(feesByFillId.get(fill.id)),
});

const normalizeFillPair = (options: {
  pair: FillPairEntity & { id: number };
  fillsById: Map<number, FillEntity>;
  feesByFillId: Map<number, FillFeeEntity>;
  symbols: Map<number, string>;
  history: CashBalanceLogEntity[];
  feesAvailable: boolean;
}): TradovateAccountFillPair => {
  const { pair, fillsById, feesByFillId, symbols, history, feesAvailable } = options;
  const buy = fillsById.get(pair.buyFillId);
  const sell = fillsById.get(pair.sellFillId);
  const buyTimestamp = timestampOrNull(buy?.timestamp);
  const sellTimestamp = timestampOrNull(sell?.timestamp);
  const orderedTimestamps = [buyTimestamp, sellTimestamp]
    .filter((value): value is string => value != null)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const contractId = finite(buy?.contractId) ?? finite(sell?.contractId);
  const pairLedger = history.filter(entry => entry.fillPairId === pair.id && entry.cashChangeType === 'TradePaired');
  const grossPnl = pairLedger.some(entry => finite(entry.delta) != null)
    ? pairLedger.reduce((sum, entry) => sum + (finite(entry.delta) ?? 0), 0)
    : null;
  const knownFees = feesAvailable
    ? (feeBreakdown(feesByFillId.get(pair.buyFillId))?.total ?? 0)
      + (feeBreakdown(feesByFillId.get(pair.sellFillId))?.total ?? 0)
    : null;
  const closingFill = buyTimestamp && sellTimestamp
    ? Date.parse(buyTimestamp) <= Date.parse(sellTimestamp) ? sell : buy
    : sellTimestamp ? sell : buy;
  return {
    id: pair.id,
    positionId: finite(pair.positionId),
    buyFillId: pair.buyFillId,
    sellFillId: pair.sellFillId,
    contractId,
    symbol: contractId != null ? symbols.get(contractId) ?? null : null,
    openedAt: orderedTimestamps[0] ?? null,
    closedAt: orderedTimestamps[orderedTimestamps.length - 1] ?? null,
    tradeDate: tradeDateKey(closingFill?.tradeDate, closingFill?.timestamp)
      ?? tradeDateKey(pairLedger[pairLedger.length - 1]?.tradeDate, pairLedger[pairLedger.length - 1]?.timestamp),
    side: buyTimestamp && sellTimestamp
      ? Date.parse(buyTimestamp) <= Date.parse(sellTimestamp) ? 'Long' : 'Short'
      : null,
    quantity: finite(pair.qty),
    buyPrice: finite(pair.buyPrice),
    sellPrice: finite(pair.sellPrice),
    grossPnl,
    knownFees,
    netPnl: grossPnl != null && knownFees != null ? grossPnl - knownFees : null,
    active: typeof pair.active === 'boolean' ? pair.active : null,
  };
};

export async function loadTradovateAccountData(options: {
  baseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<TradovateAccountDataResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const call = <T>(path: string) => request<T>({ ...options, path, fetchImpl });
  const [accountsProbe, positionsProbe, ordersProbe, fillsProbe, fillPairsProbe, fillFeesProbe, cashBalancesProbe] = await Promise.all([
    call<AccountEntity[]>('/account/list'),
    call<PositionEntity[]>('/position/list'),
    call<OrderEntity[]>('/order/list'),
    call<FillEntity[]>('/fill/list'),
    call<FillPairEntity[]>('/fillPair/list'),
    call<FillFeeEntity[]>('/fillFee/list'),
    call<CashBalanceEntity[]>('/cashBalance/list'),
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
  const cashBalances = requireList(cashBalancesProbe);
  const contractIds = [...new Set([
    ...positions.map(position => position.contractId),
    ...orders.map(order => order.contractId),
    ...fills.map(fill => fill.contractId),
  ].filter((id): id is number => typeof id === 'number' && Number.isFinite(id)))];
  const contractChunks = Array.from({ length: Math.ceil(contractIds.length / 100) }, (_, index) =>
    contractIds.slice(index * 100, (index + 1) * 100));
  const contractsProbe = mergeListProbes(await Promise.all(contractChunks.map(ids =>
    call<ContractEntity[]>(`/contract/items?ids=${ids.map(id => encodeURIComponent(String(id))).join(',')}`))));
  const contracts = requireList(contractsProbe).map(normalizeContract).filter((contract): contract is TradovateContractSummary => contract != null);
  const symbols = new Map(contracts
    .filter((contract): contract is TradovateContractSummary & { name: string } => contract.name != null)
    .map(contract => [contract.id, contract.name]));
  const fillsById = new Map(fills
    .filter((fill): fill is FillEntity & { id: number } => typeof fill.id === 'number')
    .map(fill => [fill.id, fill]));
  const fillPairsById = new Map(fillPairs
    .filter((pair): pair is FillPairEntity & { id: number } => typeof pair.id === 'number')
    .map(pair => [pair.id, pair]));
  const feesByFillId = new Map(fillFees
    .filter((fee): fee is FillFeeEntity & { id: number } => typeof fee.id === 'number')
    .map(fee => [fee.id, fee]));

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
    const history = requireList(historyProbe);
    const orderIds = new Set(accountOrders.map(order => order.id).filter((id): id is number => typeof id === 'number'));
    const linkedPairIds = new Set(history.map(entry => entry.fillPairId).filter((id): id is number => typeof id === 'number'));
    const linkedFillIds = new Set(history.map(entry => entry.fillId).filter((id): id is number => typeof id === 'number'));
    for (const pairId of linkedPairIds) {
      const pair = fillPairsById.get(pairId);
      if (!pair) continue;
      linkedFillIds.add(pair.buyFillId);
      linkedFillIds.add(pair.sellFillId);
    }
    const accountFills = fills.filter(fill => orderIds.has(fill.orderId) || (typeof fill.id === 'number' && linkedFillIds.has(fill.id)));
    const fillIds = new Set(accountFills.map(fill => fill.id).filter((id): id is number => typeof id === 'number'));
    const accountFillPairs = fillPairs.filter(pair =>
      (typeof pair.id === 'number' && linkedPairIds.has(pair.id)) || fillIds.has(pair.buyFillId) || fillIds.has(pair.sellFillId));
    const accountFillFees = fillFees.filter(fee => typeof fee.id === 'number' && fillIds.has(fee.id));
    const accountCashBalances = cashBalances.filter(balance => balance.accountId === accountId);
    const riskStatus = requireList(riskStatusProbe)[0] ?? null;
    const riskLimits = requireList(riskLimitsProbe)[0] ?? null;
    const fillRange = getTimestampRange(accountFills.map(fill => fill.timestamp));
    const historyRange = getTimestampRange(history.map(entry => entry.timestamp));

    return {
      id: accountId,
      name: account.name ?? String(accountId),
      createdAt: timestampOrNull(account.timestamp),
      active: account.active !== false,
      canTrade: account.readonly !== true,
      netPositionCount: accountPositions.filter(position => position.netPos !== 0).length,
      workingOrderCount: accountOrders.filter(order => !terminalOrderStatuses.has(order.ordStatus ?? '')).length,
      balance: {
        coverage: coverage(snapshotProbe, snapshot ? 1 : 0),
        totalCashValue: finite(snapshot?.totalCashValue),
        totalCashValueSOD: finite(snapshot?.totalCashValueSOD),
        totalPnL: finite(snapshot?.totalPnL),
        netLiq: finite(snapshot?.netLiq),
        netLiqSOD: finite(snapshot?.netLiqSOD),
        openPnL: finite(snapshot?.openPnL),
        realizedPnL: finite(snapshot?.realizedPnL),
        weekRealizedPnL: finite(snapshot?.weekRealizedPnL),
        cashUSD: finite(snapshot?.cashUSD),
        cashSODUSD: finite(snapshot?.cashSODUSD),
        currencyCashAvailWithdrawalUSD: finite(snapshot?.currencyCashAvailWithdrawalUSD),
        initialMargin: finite(snapshot?.initialMargin),
        maintenanceMargin: finite(snapshot?.maintenanceMargin),
        fullInitialMargin: finite(snapshot?.fullInitialMargin),
        fullInitialMarginSOD: finite(snapshot?.fullInitialMarginSOD),
        autoLiqLevel: finite(snapshot?.autoLiqLevel),
        withdrawalRejectReason: typeof snapshot?.withdrawalRejectReason === 'string' ? snapshot.withdrawalRejectReason : null,
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
        maxNetLiq: activeRiskThreshold(riskStatus?.maxNetLiq),
        minNetLiq: activeRiskThreshold(riskStatus?.minNetLiq),
        dailyLossAutoLiq: activeRiskThreshold(riskLimits?.dailyLossAutoLiq),
        weeklyLossAutoLiq: activeRiskThreshold(riskLimits?.weeklyLossAutoLiq),
        trailingMaxDrawdown: activeRiskThreshold(riskLimits?.trailingMaxDrawdown),
        trailingMaxDrawdownLimit: activeRiskThreshold(riskLimits?.trailingMaxDrawdownLimit),
        trailingMaxDrawdownMode: riskLimits?.trailingMaxDrawdownMode ?? null,
        changesLocked: typeof riskLimits?.changesLocked === 'boolean' ? riskLimits.changesLocked : null,
      },
      positions: accountPositions
        .map(position => normalizePosition(position, symbols))
        .sort((a, b) => (a.symbol ?? String(a.contractId)).localeCompare(b.symbol ?? String(b.contractId))),
      orders: accountOrders
        .filter((order): order is OrderEntity & { id: number } => typeof order.id === 'number')
        .map(order => normalizeOrder(order, symbols))
        .sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? '')),
      fills: accountFills
        .filter((fill): fill is FillEntity & { id: number } => typeof fill.id === 'number')
        .map(fill => normalizeFill(fill, symbols, feesByFillId))
        .sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? '')),
      fillPairs: accountFillPairs
        .filter((pair): pair is FillPairEntity & { id: number } => typeof pair.id === 'number')
        .map(pair => normalizeFillPair({
          pair,
          fillsById,
          feesByFillId,
          symbols,
          history,
          feesAvailable: fillFeesProbe.ok,
        }))
        .sort((a, b) => Date.parse(b.closedAt ?? '') - Date.parse(a.closedAt ?? '')),
      daily: buildDailyAccountSummaries(
        history,
        accountFills,
        feesByFillId,
        fillFeesProbe.ok,
        accountCashBalances,
      ),
      ledger: history
        .map(normalizeLedgerEntry)
        .sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? '')),
    } satisfies TradovateAccountDataAccount;
  }));

  return {
    capturedAt: new Date(options.now ?? Date.now()).toISOString(),
    accounts: accountData,
    contracts,
    coverage: {
      accounts: coverage(accountsProbe, accounts.length),
      positions: coverage(positionsProbe, positions.length),
      orders: coverage(ordersProbe, orders.length),
      fills: coverage(fillsProbe, fills.length),
      fillPairs: coverage(fillPairsProbe, fillPairs.length),
      fillFees: coverage(fillFeesProbe, fillFees.length),
      contracts: coverage(contractsProbe, contracts.length),
    },
  };
}

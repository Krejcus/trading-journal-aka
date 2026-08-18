export type TradovateDataAvailability = 'available' | 'partial' | 'empty' | 'denied' | 'unavailable';

export interface TradovateSourceCoverage {
  availability: TradovateDataAvailability;
  count: number;
  httpStatus: number | null;
}

export interface TradovateFeeBreakdown {
  clearing: number;
  exchange: number;
  nfa: number;
  brokerage: number;
  ip: number;
  commission: number;
  orderRouting: number;
  total: number;
}

export interface TradovateAccountPosition {
  id: number | null;
  contractId: number;
  symbol: string | null;
  timestamp: string | null;
  tradeDate: string | null;
  netPosition: number;
  bought: number | null;
  boughtValue: number | null;
  sold: number | null;
  soldValue: number | null;
  previousPosition: number | null;
  averagePrice: number | null;
  previousPrice: number | null;
}

export interface TradovateAccountOrder {
  id: number;
  contractId: number | null;
  symbol: string | null;
  timestamp: string | null;
  action: 'Buy' | 'Sell' | null;
  orderType: string | null;
  quantity: number | null;
  price: number | null;
  stopPrice: number | null;
  status: string | null;
  admin: boolean | null;
  ocoId: number | null;
  parentId: number | null;
  linkedId: number | null;
}

export interface TradovateAccountFill {
  id: number;
  orderId: number;
  contractId: number;
  symbol: string | null;
  timestamp: string | null;
  tradeDate: string | null;
  action: 'Buy' | 'Sell' | null;
  quantity: number | null;
  price: number | null;
  active: boolean | null;
  finallyPaired: number | null;
  fees: TradovateFeeBreakdown | null;
}

export interface TradovateAccountFillPair {
  id: number;
  positionId: number | null;
  buyFillId: number;
  sellFillId: number;
  contractId: number | null;
  symbol: string | null;
  openedAt: string | null;
  closedAt: string | null;
  tradeDate: string | null;
  side: 'Long' | 'Short' | null;
  quantity: number | null;
  buyPrice: number | null;
  sellPrice: number | null;
  grossPnl: number | null;
  knownFees: number | null;
  netPnl: number | null;
  active: boolean | null;
}

export interface TradovateCashLedgerEntry {
  id: number | null;
  timestamp: string | null;
  tradeDate: string | null;
  currencyId: number | null;
  amount: number | null;
  delta: number | null;
  cashChangeType: string | null;
  realizedPnl: number | null;
  weekRealizedPnl: number | null;
  fillPairId: number | null;
  fillId: number | null;
  comment: string | null;
}

export interface TradovateDailyAccountSummary {
  tradeDate: string;
  reportedRealizedPnl: number | null;
  reportedWeekRealizedPnl: number | null;
  endingBalance: number | null;
  cashDelta: number;
  grossTradePnl: number;
  feeDelta: number;
  knownFillFees: number | null;
  fillCount: number;
  pairedTradeCount: number;
  ledgerEntryCount: number;
}

export interface TradovateContractSummary {
  id: number;
  name: string | null;
  contractMaturityId: number | null;
  timestamp: string | null;
}

export interface TradovateAccountDataAccount {
  id: number;
  name: string;
  /** Exact broker-side Account.timestamp when Tradovate exposes it. */
  createdAt: string | null;
  active: boolean;
  canTrade: boolean;
  netPositionCount: number;
  workingOrderCount: number;
  balance: {
    coverage: TradovateSourceCoverage;
    totalCashValue: number | null;
    totalCashValueSOD: number | null;
    totalPnL: number | null;
    netLiq: number | null;
    netLiqSOD: number | null;
    openPnL: number | null;
    /** Broker is exact, estimated is derived from an exact anchor mark. */
    openPnlSource?: 'broker' | 'estimated' | 'stale';
    openPnlAsOf?: string | null;
    realizedPnL: number | null;
    weekRealizedPnL: number | null;
    cashUSD: number | null;
    cashSODUSD: number | null;
    currencyCashAvailWithdrawalUSD: number | null;
    initialMargin: number | null;
    maintenanceMargin: number | null;
    fullInitialMargin: number | null;
    fullInitialMarginSOD: number | null;
    autoLiqLevel: number | null;
    withdrawalRejectReason: string | null;
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
  positions: TradovateAccountPosition[];
  orders: TradovateAccountOrder[];
  fills: TradovateAccountFill[];
  fillPairs: TradovateAccountFillPair[];
  daily: TradovateDailyAccountSummary[];
  ledger: TradovateCashLedgerEntry[];
  historicalBackfill?: {
    status: 'pending' | 'running' | 'complete' | 'error';
    tradeCount: number;
    pendingRangeCount: number;
    requestedStart: string;
    requestedEnd: string;
    syncedThrough: string | null;
    lastError: string | null;
  };
}

export interface TradovateAccountDataResult {
  capturedAt: string;
  accounts: TradovateAccountDataAccount[];
  contracts: TradovateContractSummary[];
  coverage: {
    accounts: TradovateSourceCoverage;
    positions: TradovateSourceCoverage;
    orders: TradovateSourceCoverage;
    fills: TradovateSourceCoverage;
    fillPairs: TradovateSourceCoverage;
    fillFees: TradovateSourceCoverage;
    contracts: TradovateSourceCoverage;
  };
}

export type TradovateHistoricalSyncStatus =
  | 'available'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'invalid-response'
  | 'unavailable';

export interface TradovateHistoricalSyncCapability {
  status: TradovateHistoricalSyncStatus;
  httpStatus: number | null;
  checkedAt: string;
  reportBaseUrl: string;
  definitionCount: number;
  reports: Array<{
    name: string;
    parameters: Array<{ name: string; paramType: string | null; optional: boolean | null }>;
  }>;
  supportsPerformance: boolean;
  supportsOrders: boolean;
  supportsCashHistory: boolean;
  supportsAccountBalanceHistory: boolean;
  responseShape: {
    kind: 'array' | 'object' | 'null' | 'primitive';
    topLevelKeys: string[];
    arrayKeys: string[];
  };
}

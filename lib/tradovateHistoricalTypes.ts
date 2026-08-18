export interface TradovateHistoryRange {
  startDate: string;
  endDate: string;
}

export type TradovateHistorySyncStatus = 'pending' | 'running' | 'complete' | 'error';
export type TradovateHistoryStartBasis = 'account_created_at' | 'rolling_12_months';

export interface TradovateHistoricalTrade {
  sourceKey: string;
  symbol: string | null;
  buyFillId: number | null;
  sellFillId: number | null;
  quantity: number | null;
  buyPrice: number | null;
  sellPrice: number | null;
  grossPnl: number | null;
  boughtAt: string | null;
  soldAt: string | null;
  tradeDate: string | null;
  rawRow: Record<string, string>;
}

export interface TradovateHistorySyncResult {
  syncId: string;
  accountId: number;
  accountName: string;
  accountCreatedAt: string | null;
  historyStartBasis: TradovateHistoryStartBasis;
  status: TradovateHistorySyncStatus;
  requestedStart: string;
  requestedEnd: string;
  pendingRangeCount: number;
  rowsSeen: number;
  rowsImported: number;
  syncedThrough: string | null;
  lastError: string | null;
  completedAt: string | null;
}

export interface TradovateHistorySnapshot {
  sync: TradovateHistorySyncResult | null;
  trades: TradovateHistoricalTrade[];
}

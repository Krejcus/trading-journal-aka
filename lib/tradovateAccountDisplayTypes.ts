/** Display-only values. These never certify execution/risk freshness. */
export interface TradovateAccountDisplaySnapshot {
  accountId: number;
  connectionId: string;
  environment: 'demo' | 'live';
  requestedAt: string;
  confirmedAt: string;
  fields: Partial<Record<'dailyRealizedPnL' | 'totalCashValue' | 'totalCashValueSOD' | 'realizedPnL' | 'netLiq' | 'openPnL', number>>;
}

export interface TradovateAccountDisplayFeedState {
  /** Stream health is separate from the age of an unchanged cash value. */
  streamConnected?: boolean;
  connectionId: string;
  environment: 'demo' | 'live';
  snapshots: TradovateAccountDisplaySnapshot[];
  pendingAccountIds: number[];
  lastErrorAt: string | null;
  retryAt: string | null;
}

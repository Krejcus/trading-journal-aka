export interface TradovateLivePnlPosition {
  id: number | null;
  accountId: number;
  contractId: number;
  netPosition: number;
  averagePrice: number | null;
  timestamp: string | null;
}

export interface TradovateLivePnlAnchor {
  accountId: number;
  contractId: number;
  openPnl: number;
  netLiq: number | null;
  totalCashValue: number | null;
}

export interface TradovateLivePnlTick {
  connectionId: string;
  environment: 'demo' | 'live';
  capturedAt: string;
  positions: TradovateLivePnlPosition[];
  anchor: TradovateLivePnlAnchor | null;
  activeContractCount: number;
  nextContractCursor: number;
}

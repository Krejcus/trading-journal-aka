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

export interface TradovateLiveOrder {
  id: number;
  accountId: number;
  contractId: number | null;
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

export interface TradovateLivePnlTick {
  connectionId: string;
  environment: 'demo' | 'live';
  capturedAt: string;
  positions: TradovateLivePnlPosition[];
  /** Cheap /order/list snapshot used by the live Orders tab. */
  orders: TradovateLiveOrder[];
  anchor: TradovateLivePnlAnchor | null;
  activeContractCount: number;
  nextContractCursor: number;
}

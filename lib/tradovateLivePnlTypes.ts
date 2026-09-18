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
  /** Confirmed account cash fields; never estimated from another account. */
  realizedPnL?: number | null;
  totalCashValueSOD?: number | null;
}

/**
 * Levný mezitick mezi autoritativními position/order snapshoty. Obsahuje
 * pouze brokerem vypočtené account P&L; klient ho smí použít k odvození marku
 * jen tehdy, když stále vidí právě jednu odpovídající otevřenou pozici.
 */
export interface TradovateLivePnlAnchorTick {
  /** Tradovate REST volání serveru pro tento anchor (0 = sdílený výsledek). */
  brokerCalls?: number;
  connectionId: string;
  environment: 'demo' | 'live';
  capturedAt: string;
  requestedAt?: string;
  anchor: TradovateLivePnlAnchor | null;
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
  requestedAt?: string;
  /** Cash failure does not invalidate successful position/order reads. */
  anchorError?: string | null;
  anchorErrorStatus?: number | null;
  anchorAsOf?: string;
  positions: TradovateLivePnlPosition[];
  /** Cheap /order/list snapshot used by the live Orders tab. */
  orders: TradovateLiveOrder[];
  anchor: TradovateLivePnlAnchor | null;
  activeContractCount: number;
  nextContractCursor: number;
  /** Kolik Tradovate REST volání server pro tento tick udělal (0 = sdílený výsledek z cache). */
  brokerCalls?: number;
}

/**
 * Broker-agnostické rozhraní pro exekuci.
 *
 * Copier ani risk gate nesmí vědět, že pod tím je Tradovate. Až dorazí
 * OAuth, přibude transport v `services/tradovateBroker.ts` — a nic jiného
 * se měnit nebude. Do té doby jede všechno proti `createMockBroker()`.
 *
 * DŮLEŽITÉ: port záměrně NESLIBUJE idempotenci odeslání. Tradovate ji
 * nemá — `customTag50` je jen volitelný textový tag, podle kterého broker
 * druhou objednávku neodmítne. Proto je tu `findOrdersByTag()`: po
 * nejasném konci se osud objednávky musí dohledat, ne uhodnout.
 *
 * Záměrně tu NENÍ nic o market datech. Copier se obejde bez kotací
 * (pracuje z order/fill/position událostí) a realtime P&L čeká na
 * vyřešenou CME licenci.
 */

export type BrokerEnvironment = 'demo' | 'live';

export type OrderSide = 'Buy' | 'Sell';

export type OrderType = 'Market' | 'Limit' | 'Stop' | 'StopLimit';

export type OrderStatus = 'working' | 'filled' | 'canceled' | 'rejected';

export interface BrokerOrderRequest {
  /**
   * Tag, který se posílá brokerovi a podle kterého se objednávka dohledá.
   * Musí být deterministicky odvozený z leader události — po restartu se
   * počítá znovu a musí vyjít stejný.
   *
   * Pozor: NENÍ to idempotency klíč. Broker podle něj duplicitu neodmítne.
   */
  tag: string;
  accountId: number;
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  limitPrice?: number;
  stopPrice?: number;
}

export interface BrokerOrder {
  tag: string;
  brokerOrderId: string;
  accountId: number;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  filledQuantity: number;
  limitPrice?: number;
  stopPrice?: number;
  status: OrderStatus;
  /** Stabilní revize zdrojové broker entity pro deduplikaci lifecycle eventů. */
  sourceVersion?: string;
  /** Vyplněné jen u `rejected` — text od brokera, do auditu. */
  rejectReason?: string;
  updatedAt: number;
}

export interface BrokerFill {
  fillId: string;
  tag: string;
  brokerOrderId: string;
  accountId: number;
  symbol: string;
  side: OrderSide;
  /** Množství TOHOTO plnění, ne kumulativní součet. */
  quantity: number;
  price: number;
  filledAt: number;
}

export interface BrokerPosition {
  accountId: number;
  symbol: string;
  /** Kladné = long, záporné = short, nula = plochý. */
  netQuantity: number;
}

export interface BrokerAccountCapability {
  accountId: number;
  active: boolean;
  /** false znamená, že OAuth/account dovolí čtení, ale ne zadání příkazu. */
  canTrade: boolean;
}

export type BrokerEvent =
  | { type: 'order'; order: BrokerOrder }
  | { type: 'fill'; fill: BrokerFill }
  | { type: 'position'; position: BrokerPosition }
  | { type: 'heartbeat'; at: number }
  | { type: 'error'; error: Error; at: number }
  | { type: 'connection'; connected: boolean; at: number };

/**
 * Odpověď na `placeOrder`.
 *
 * Odpovídá tomu, co reálně vrací Tradovate `PlaceOrderResult`: buď
 * identifikátor objednávky, nebo důvod selhání. Žádné `duplicate` —
 * broker o našich předchozích pokusech nic neví.
 */
export interface BrokerOrderAck {
  brokerOrderId: string;
  accepted: boolean;
  /** Explicitní business výsledek. false znamená nejednoznačnou odpověď. */
  definitive: boolean;
  rejectReason?: string;
}

export interface BrokerOrderLookup {
  orders: BrokerOrder[];
  /** Jen autoritativní prázdný výsledek dovoluje nový pokus. */
  completeness: 'authoritative' | 'eventual';
  observedAt: number;
}

export interface BrokerOrderStateLookup {
  order: BrokerOrder | null;
  completeness: 'authoritative' | 'eventual';
  observedAt: number;
}

export interface BrokerPort {
  readonly environment: BrokerEnvironment;
  placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderAck>;
  cancelOrder(accountId: number, brokerOrderId: string): Promise<void>;
  modifyOrder(
    accountId: number,
    brokerOrderId: string,
    changes: { quantity: number; orderType: OrderType; limitPrice?: number; stopPrice?: number },
  ): Promise<void>;
  /** Autoritativní OAuth/account preflight před reconciliation a ARM. */
  listAccountCapabilities(accountIds: readonly number[]): Promise<BrokerAccountCapability[]>;
  listPositions(accountId: number): Promise<BrokerPosition[]>;
  /** Autoritativní seznam objednávek účtu pro pre-arm kontrolu. */
  listOrders(accountId: number): Promise<BrokerOrder[]>;
  /**
   * Dohledání objednávek podle tagu. Volá se po timeoutu, aby se zjistilo,
   * jestli objednávka k brokerovi přece jen dorazila.
   */
  findOrdersByTag(accountId: number, tag: string): Promise<BrokerOrderLookup>;
  findOrderById(accountId: number, brokerOrderId: string): Promise<BrokerOrderStateLookup>;
  /** Vrací odhlašovací funkci. */
  subscribe(listener: (event: BrokerEvent) => void): () => void;
}

/** Opačná strana — pro zavírání pozic a reversal. */
export function oppositeSide(side: OrderSide): OrderSide {
  return side === 'Buy' ? 'Sell' : 'Buy';
}

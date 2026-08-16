import type {
  BrokerEnvironment,
  BrokerOrder,
  BrokerOrderAck,
  BrokerOrderRequest,
  OrderStatus,
} from './brokerPort';

/**
 * Překlad mezi naším portem a tvary Tradovate API.
 *
 * Čisté funkce bez transportu — tohle je jediná část Tradovate adaptéru,
 * kterou jde napsat a otestovat před OAuth.
 *
 * Pozor na dvě různé věci, které se snadno slijí do jedné:
 *  - `PlaceOrderResult` je odpověď na příkaz. Obsahuje `orderId` nebo
 *    důvod selhání, nic víc — žádný stav, žádné plnění.
 *  - `Order` je entita, která dorazí až přes `user/syncrequest` nebo
 *    execution reporty. Teprve ta má `ordStatus` a kumulativní množství.
 *
 * Proto adaptér nebude jen HTTP obálka: mezi příkazem, objednávkou,
 * execution reporty a filly musí držet korelaci podle tagu.
 *
 * VAROVÁNÍ: tvary payloadů jsou postavené podle veřejného popisu API a
 * NEJSOU ověřené proti živému endpointu. První věc po zprovoznění
 * přístupu je projít je proti skutečné odpovědi.
 */

export const TRADOVATE_HOSTS: Record<BrokerEnvironment, { rest: string; websocket: string }> = {
  demo: { rest: 'https://demo.tradovateapi.com/v1', websocket: 'wss://demo.tradovateapi.com/v1/websocket' },
  live: { rest: 'https://live.tradovateapi.com/v1', websocket: 'wss://live.tradovateapi.com/v1/websocket' },
};

/**
 * Tradovate vyžaduje heartbeat zhruba po 2,5 sekundy, jinak spojení zavře.
 * Posíláme o něco dřív, ať se to nevejde do síťového zpoždění.
 */
export const TRADOVATE_HEARTBEAT_MS = 2_000;

export interface TradovatePlaceOrderPayload {
  accountId: number;
  accountSpec: string;
  action: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit' | 'Stop' | 'StopLimit';
  symbol: string;
  orderQty: number;
  price?: number;
  stopPrice?: number;
  /**
   * Náš dohledávací tag. Tradovate ho bere jako volitelný text a NEPOUŽÍVÁ
   * ho k odmítnutí duplicit — slouží nám jen k tomu, abychom objednávku
   * po timeoutu našli.
   */
  customTag50: string;
  /**
   * Musí být true — objednávku odesílá software, ne člověk klikající v UI.
   * Tvrdit opak by bylo nepravdivé prohlášení vůči brokerovi.
   */
  isAutomated: true;
}

export function toPlaceOrderPayload(
  request: BrokerOrderRequest,
  accountSpec: string,
): TradovatePlaceOrderPayload {
  return {
    accountId: request.accountId,
    accountSpec,
    action: request.side,
    symbol: request.symbol,
    orderQty: request.quantity,
    orderType: request.orderType,
    ...(request.limitPrice != null ? { price: request.limitPrice } : {}),
    ...(request.stopPrice != null ? { stopPrice: request.stopPrice } : {}),
    customTag50: request.tag,
    isAutomated: true,
  };
}

/** Odpověď na `POST /order/placeorder`. */
export interface TradovatePlaceOrderResult {
  orderId?: number;
  failureReason?: string;
  failureText?: string;
}

/**
 * Překlad odpovědi na příkaz.
 *
 * Chybějící `orderId` bez uvedeného důvodu je nejednoznačný výsledek —
 * hlásíme ho jako odmítnutí s explicitním textem, ať se to v auditu
 * nespletí s potvrzením.
 */
export function fromPlaceOrderResult(result: TradovatePlaceOrderResult): BrokerOrderAck {
  if (result.orderId != null) {
    return { brokerOrderId: String(result.orderId), accepted: true, definitive: true };
  }
  const failureText = result.failureText?.trim();
  const failureReason = result.failureReason && result.failureReason !== 'Success'
    ? result.failureReason
    : undefined;
  const reason = failureText || failureReason;
  return {
    brokerOrderId: '',
    accepted: false,
    definitive: reason != null,
    rejectReason: reason ?? 'nejednoznačná odpověď bez orderId a failure reason',
  };
}

/**
 * Tradovate stavy objednávky → náš zjednodušený model.
 *
 * Neznámý stav mapujeme na `working`, ne na `filled`. Kdyby přišlo něco
 * neočekávaného, je bezpečnější tvrdit „ještě běží" než „hotovo".
 */
export function toOrderStatus(tradovateStatus: string): OrderStatus {
  switch (tradovateStatus) {
    case 'Filled':
    case 'Completed':
      return 'filled';
    case 'Canceled':
    case 'Cancelled':
    case 'Expired':
      return 'canceled';
    case 'Rejected':
      return 'rejected';
    default:
      return 'working';
  }
}

/** Entita `Order` ze synchronizace nebo execution reportu. */
export interface TradovateOrderEntity {
  id: number;
  accountId: number;
  contractId: number;
  action: 'Buy' | 'Sell';
  ordStatus: string;
  orderQty: number;
  orderType: 'Market' | 'Limit' | 'Stop' | 'StopLimit';
  /** Kumulativní plněné množství, ne přírůstek. */
  cumQty?: number;
  price?: number;
  stopPrice?: number;
  customTag50?: string;
  rejectReason?: string;
  timestamp?: string;
}

export function fromOrderEntity(
  entity: TradovateOrderEntity,
  symbol: string,
  fallbackTag = '',
): BrokerOrder {
  const status = toOrderStatus(entity.ordStatus);
  return {
    tag: entity.customTag50 ?? fallbackTag,
    brokerOrderId: String(entity.id),
    accountId: entity.accountId,
    symbol,
    side: entity.action,
    orderType: entity.orderType,
    quantity: entity.orderQty,
    filledQuantity: entity.cumQty ?? 0,
    ...(entity.price != null ? { limitPrice: entity.price } : {}),
    ...(entity.stopPrice != null ? { stopPrice: entity.stopPrice } : {}),
    status,
    ...(status === 'rejected' && entity.rejectReason ? { rejectReason: entity.rejectReason } : {}),
    updatedAt: entity.timestamp ? Date.parse(entity.timestamp) : 0,
  };
}

/**
 * Přírůstek plnění mezi dvěma stavy objednávky.
 *
 * Tradovate posílá `cumQty` kumulativně, ale náš `BrokerFill.quantity` je
 * přírůstek. Bez tohohle převodu by se při druhém partial fillu započítalo
 * množství dvakrát a pozice by se rozešly.
 */
export function fillIncrement(previousCumQty: number, currentCumQty: number): number {
  return Math.max(0, currentCumQty - previousCumQty);
}

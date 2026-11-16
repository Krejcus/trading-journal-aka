/**
 * Klient R | Protocol API nad jednotlivými planty: přihlášení, účty, příkazy,
 * brackety, snímky stavu, ceny a P&L. Jen tenká typovaná vrstva — žádná
 * obchodní logika, žádné opakování, žádné automatické obnovení spojení.
 */
import { rithmicEnum, rithmicEnumName, rithmicStrings, type RithmicFields, type RithmicMessage } from './rithmicCodec';
import {
  RITHMIC_INFRA,
  RithmicPlant,
  RithmicRequestError,
  type RithmicCloseInfo,
  type RithmicCredentials,
  type RithmicResponse,
  type RithmicSocketFactory,
} from './rithmicPlant';

export type RithmicPlantName = 'order' | 'ticker' | 'pnl';
export type RithmicSide = 'BUY' | 'SELL';
export type RithmicPriceType = 'LIMIT' | 'MARKET' | 'STOP_LIMIT' | 'STOP_MARKET';
export type RithmicDuration = 'DAY' | 'GTC' | 'IOC' | 'FOK';

export interface RithmicAccount {
  fcmId: string;
  ibId: string;
  accountId: string;
  accountName: string;
}

export interface RithmicOrderRequest {
  accountId: string;
  /** Naše korelační značka (obdoba clOrdId); Rithmic ji vrací v notifikacích jako user_tag. */
  userTag: string;
  symbol: string;
  exchange: string;
  side: RithmicSide;
  quantity: number;
  priceType: RithmicPriceType;
  price?: number;
  triggerPrice?: number;
  duration?: RithmicDuration;
}

export interface RithmicBracketRequest extends RithmicOrderRequest {
  /** Vzdálenost od ceny vyplnění v tickách; nohy drží server Rithmicu. */
  stopTicks?: number;
  targetTicks?: number;
}

export interface RithmicOrderAck {
  basketId: string;
  userTag: string;
  sentAt: number;
  ackAt: number;
}

/** Stav příkazu z notifikace burzy (352) nebo Rithmicu (351); hodnoty jak je poslal server. */
export interface RithmicOrderUpdate {
  source: 'exchange' | 'rithmic';
  notifyType: string;
  isSnapshot: boolean;
  accountId: string;
  basketId: string;
  originalBasketId: string;
  linkedBasketIds: string;
  userTag: string;
  symbol: string;
  exchange: string;
  side: RithmicSide | null;
  priceType: string;
  bracketType: string;
  status: string;
  completionReason: string;
  quantity: number | null;
  price: number | null;
  triggerPrice: number | null;
  fillPrice: number | null;
  fillSize: number | null;
  fillId: string;
  avgFillPrice: number | null;
  totalFillSize: number | null;
  totalUnfilledSize: number | null;
  text: string;
  /** Čas z brány Rithmicu (ms od epochy), null když ho zpráva nenese. */
  gatewayAt: number | null;
  receivedAt: number;
  raw: RithmicFields;
}

export interface RithmicBracketUpdate {
  accountId: string;
  basketId: string;
  stopTicks: number | null;
  stopQuantity: number | null;
  stopQuantityReleased: number | null;
  targetTicks: number | null;
  targetQuantity: number | null;
  targetQuantityReleased: number | null;
  receivedAt: number;
}

export interface RithmicTick {
  kind: 'trade' | 'bbo';
  symbol: string;
  exchange: string;
  isSnapshot: boolean;
  tradePrice: number | null;
  tradeSize: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  gatewayAt: number | null;
  exchangeAt: number | null;
  receivedAt: number;
}

export interface RithmicInstrumentPosition {
  accountId: string;
  symbol: string;
  exchange: string;
  isSnapshot: boolean;
  netQuantity: number;
  avgOpenFillPrice: number | null;
  openPnl: number | null;
  closedPnl: number | null;
  receivedAt: number;
}

export interface RithmicAccountPnl {
  accountId: string;
  isSnapshot: boolean;
  accountBalance: number | null;
  openPnl: number | null;
  closedPnl: number | null;
  dayPnl: number | null;
  netQuantity: number | null;
  receivedAt: number;
}

export interface RithmicClientEvents {
  onOrderUpdate?: (update: RithmicOrderUpdate) => void;
  onBracketUpdate?: (update: RithmicBracketUpdate) => void;
  onTick?: (tick: RithmicTick) => void;
  onInstrumentPosition?: (position: RithmicInstrumentPosition) => void;
  onAccountPnl?: (pnl: RithmicAccountPnl) => void;
  onPlantClosed?: (plant: RithmicPlantName, info: RithmicCloseInfo) => void;
  onUnknownTemplate?: (plant: RithmicPlantName, templateId: number) => void;
}

export interface RithmicClientConfig {
  url: string;
  credentials: RithmicCredentials;
  socketFactory: RithmicSocketFactory;
  events?: RithmicClientEvents;
  now?: () => number;
  requestTimeoutMs?: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const stamp = (sec: unknown, usecs: unknown): number | null => {
  const s = num(sec);
  if (s === null || s <= 0) return null;
  return s * 1000 + (num(usecs) ?? 0) / 1000;
};

const INFRA_BY_PLANT = {
  order: RITHMIC_INFRA.ORDER_PLANT,
  ticker: RITHMIC_INFRA.TICKER_PLANT,
  pnl: RITHMIC_INFRA.PNL_PLANT,
} as const;

function orderUpdate(source: 'exchange' | 'rithmic', message: RithmicMessage, receivedAt: number): RithmicOrderUpdate {
  const f = message.fields;
  const type = source === 'exchange' ? 'ExchangeOrderNotification' : 'RithmicOrderNotification';
  const side = f.transaction_type === undefined ? null : rithmicEnumName(type, 'TransactionType', f.transaction_type);
  return {
    source,
    notifyType: rithmicEnumName(type, 'NotifyType', f.notify_type),
    isSnapshot: f.is_snapshot === true,
    accountId: str(f.account_id),
    basketId: str(f.basket_id),
    originalBasketId: str(f.original_basket_id),
    linkedBasketIds: str(f.linked_basket_ids),
    userTag: str(f.user_tag),
    symbol: str(f.symbol),
    exchange: str(f.exchange),
    side: side === 'BUY' || side === 'SELL' ? side : null,
    priceType: f.price_type === undefined ? '' : rithmicEnumName(type, 'PriceType', f.price_type),
    bracketType: f.bracket_type === undefined ? '' : rithmicEnumName(type, 'BracketType', f.bracket_type),
    status: str(f.status),
    completionReason: str(f.completion_reason),
    quantity: num(f.quantity),
    price: num(f.price),
    triggerPrice: num(f.trigger_price),
    fillPrice: num(f.fill_price),
    fillSize: num(f.fill_size),
    fillId: str(f.fill_id),
    avgFillPrice: num(f.avg_fill_price),
    totalFillSize: num(f.total_fill_size),
    totalUnfilledSize: num(f.total_unfilled_size),
    text: str(f.text) || str(f.report_text),
    gatewayAt: stamp(f.ssboe, f.usecs),
    receivedAt,
    raw: f,
  };
}

export class RithmicClient {
  private readonly config: RithmicClientConfig;
  private readonly plants = new Map<RithmicPlantName, RithmicPlant>();
  private tradeRoutes: Array<{ exchange: string; tradeRoute: string; isDefault: boolean }> = [];
  accounts: RithmicAccount[] = [];
  userType: number | undefined;
  /** Surová odpověď RequestLoginInfo (mj. limity souběžných přihlášení). */
  loginInfo: RithmicFields | null = null;

  constructor(config: RithmicClientConfig) {
    this.config = config;
  }

  isConnected(plant: RithmicPlantName): boolean {
    return this.plants.get(plant)?.connected === true;
  }

  private plant(name: RithmicPlantName): RithmicPlant {
    const plant = this.plants.get(name);
    if (!plant) throw new RithmicRequestError(`Rithmic: plant ${name} není připojený`, 'not-sent', 0);
    return plant;
  }

  /** Připojí vybrané planty. Order plant navíc načte identitu, účty a trade routes a přihlásí odběr změn. */
  async connect(plants: RithmicPlantName[] = ['order', 'ticker', 'pnl']): Promise<void> {
    for (const name of plants) {
      if (this.plants.has(name)) continue;
      const plant = new RithmicPlant({
        url: this.config.url,
        infraType: INFRA_BY_PLANT[name],
        credentials: this.config.credentials,
        socketFactory: this.config.socketFactory,
        now: this.config.now,
        requestTimeoutMs: this.config.requestTimeoutMs,
        onPush: (message, receivedAt) => this.handlePush(name, message, receivedAt),
        onClose: (info) => {
          this.plants.delete(name);
          this.config.events?.onPlantClosed?.(name, info);
        },
        onUnknownTemplate: (templateId) => this.config.events?.onUnknownTemplate?.(name, templateId),
      });
      this.plants.set(name, plant);
      try {
        await plant.connect();
        if (name === 'order') await this.initOrderPlant(plant);
      } catch (error) {
        this.plants.delete(name);
        plant.close();
        throw error;
      }
    }
  }

  private async initOrderPlant(plant: RithmicPlant): Promise<void> {
    const info = (await plant.request(300)).terminal;
    if (info) {
      this.loginInfo = info.fields;
      plant.identity = {
        fcmId: str(info.fields.fcm_id) || plant.identity.fcmId,
        ibId: str(info.fields.ib_id) || plant.identity.ibId,
        userType: typeof info.fields.user_type === 'number' ? info.fields.user_type : undefined,
      };
      this.userType = plant.identity.userType;
    }
    const accounts = await plant.request(302, { user_type: this.userType });
    this.accounts = [...accounts.rows, ...(accounts.terminal ? [accounts.terminal] : [])]
      .filter((m) => str(m.fields.account_id) !== '')
      .map((m) => ({
        fcmId: str(m.fields.fcm_id),
        ibId: str(m.fields.ib_id),
        accountId: str(m.fields.account_id),
        accountName: str(m.fields.account_name),
      }));
    const routes = await plant.request(310, { subscribe_for_updates: true });
    this.tradeRoutes = [...routes.rows, ...(routes.terminal ? [routes.terminal] : [])]
      .filter((m) => str(m.fields.trade_route) !== '')
      .map((m) => ({
        exchange: str(m.fields.exchange),
        tradeRoute: str(m.fields.trade_route),
        isDefault: m.fields.is_default === true,
      }));
    for (const account of this.accounts) {
      await plant.request(308, { account_id: account.accountId });
      await plant.request(336, { account_id: account.accountId });
    }
  }

  close(): void {
    for (const plant of [...this.plants.values()]) plant.close();
    this.plants.clear();
  }

  private tradeRoute(exchange: string): string {
    const matches = this.tradeRoutes.filter((r) => r.exchange === exchange);
    const route = matches.find((r) => r.isDefault) ?? matches[0];
    if (!route) throw new RithmicRequestError(`Rithmic: pro burzu ${exchange} není trade route`, 'not-sent', 312);
    return route.tradeRoute;
  }

  private orderFields(message: 'RequestNewOrder' | 'RequestBracketOrder', request: RithmicOrderRequest): RithmicFields {
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new RithmicRequestError('Rithmic: množství musí být kladné celé číslo', 'not-sent', 312);
    }
    if (!request.userTag) throw new RithmicRequestError('Rithmic: příkaz bez korelační značky', 'not-sent', 312);
    const needsPrice = request.priceType === 'LIMIT' || request.priceType === 'STOP_LIMIT';
    const needsTrigger = request.priceType === 'STOP_LIMIT' || request.priceType === 'STOP_MARKET';
    if (needsPrice && !(typeof request.price === 'number' && Number.isFinite(request.price))) {
      throw new RithmicRequestError('Rithmic: chybí limitní cena', 'not-sent', 312);
    }
    if (needsTrigger && !(typeof request.triggerPrice === 'number' && Number.isFinite(request.triggerPrice))) {
      throw new RithmicRequestError('Rithmic: chybí spouštěcí cena', 'not-sent', 312);
    }
    return {
      user_tag: request.userTag,
      account_id: request.accountId,
      symbol: request.symbol,
      exchange: request.exchange,
      quantity: request.quantity,
      price: needsPrice ? request.price : undefined,
      trigger_price: needsTrigger ? request.triggerPrice : undefined,
      transaction_type: rithmicEnum(message, 'TransactionType', request.side),
      duration: rithmicEnum(message, 'Duration', request.duration ?? 'DAY'),
      price_type: rithmicEnum(message, 'PriceType', request.priceType),
      trade_route: this.tradeRoute(request.exchange),
      manual_or_auto: rithmicEnum(message, 'OrderPlacement', 'MANUAL'),
    };
  }

  private ack(response: RithmicResponse, userTag: string, templateId: number): RithmicOrderAck {
    const basketId = str(response.terminal?.fields.basket_id);
    if (!basketId) {
      // Server přijal, ale nevrátil ID: stav příkazu neznáme, musí se dohledat.
      throw new RithmicRequestError('Rithmic: potvrzení bez basket_id', 'unknown', templateId);
    }
    return { basketId, userTag, sentAt: response.sentAt, ackAt: response.completedAt };
  }

  async placeOrder(request: RithmicOrderRequest): Promise<RithmicOrderAck> {
    const fields = this.orderFields('RequestNewOrder', request);
    return this.ack(await this.plant('order').request(312, fields), request.userTag, 312);
  }

  /** Vstup se serverovým SL/TP. Nohy vznikají až po vyplnění vstupu (ověřit na serveru). */
  async placeBracketOrder(request: RithmicBracketRequest): Promise<RithmicOrderAck> {
    const hasStop = typeof request.stopTicks === 'number';
    const hasTarget = typeof request.targetTicks === 'number';
    if (!hasStop && !hasTarget) throw new RithmicRequestError('Rithmic: bracket bez SL i TP', 'not-sent', 330);
    for (const ticks of [request.stopTicks, request.targetTicks]) {
      if (ticks !== undefined && !(Number.isInteger(ticks) && ticks > 0)) {
        throw new RithmicRequestError('Rithmic: vzdálenost SL/TP musí být kladný počet ticků', 'not-sent', 330);
      }
    }
    const bracketType = hasStop && hasTarget ? 'TARGET_AND_STOP_STATIC' : hasStop ? 'STOP_ONLY_STATIC' : 'TARGET_ONLY_STATIC';
    const fields: RithmicFields = {
      ...this.orderFields('RequestBracketOrder', request),
      bracket_type: rithmicEnum('RequestBracketOrder', 'BracketType', bracketType),
      stop_ticks: hasStop ? request.stopTicks : undefined,
      stop_quantity: hasStop ? request.quantity : undefined,
      target_ticks: hasTarget ? request.targetTicks : undefined,
      target_quantity: hasTarget ? request.quantity : undefined,
    };
    return this.ack(await this.plant('order').request(330, fields), request.userTag, 330);
  }

  /** Změna pracujícího příkazu. Rithmic chce celý nový stav (množství, typ, cenu). */
  async modifyOrder(order: {
    accountId: string;
    basketId: string;
    symbol: string;
    exchange: string;
    quantity: number;
    priceType: RithmicPriceType;
    price?: number;
    triggerPrice?: number;
  }): Promise<RithmicResponse> {
    return this.plant('order').request(314, {
      account_id: order.accountId,
      basket_id: order.basketId,
      symbol: order.symbol,
      exchange: order.exchange,
      quantity: order.quantity,
      price_type: rithmicEnum('RequestModifyOrder', 'PriceType', order.priceType),
      price: order.price,
      trigger_price: order.triggerPrice,
      manual_or_auto: rithmicEnum('RequestModifyOrder', 'OrderPlacement', 'MANUAL'),
    });
  }

  async cancelOrder(accountId: string, basketId: string): Promise<RithmicResponse> {
    return this.plant('order').request(316, {
      account_id: accountId,
      basket_id: basketId,
      manual_or_auto: rithmicEnum('RequestCancelOrder', 'OrderPlacement', 'MANUAL'),
    });
  }

  async cancelAllOrders(accountId: string): Promise<RithmicResponse> {
    return this.plant('order').request(346, {
      account_id: accountId,
      manual_or_auto: rithmicEnum('RequestCancelAllOrders', 'OrderPlacement', 'MANUAL'),
    });
  }

  /** Zavře pozici v instrumentu tržním příkazem na straně serveru. */
  async exitPosition(accountId: string, symbol: string, exchange: string): Promise<RithmicResponse> {
    return this.plant('order').request(3504, {
      account_id: accountId,
      symbol,
      exchange,
      manual_or_auto: rithmicEnum('RequestExitPosition', 'OrderPlacement', 'MANUAL'),
    });
  }

  /** Snímek příkazů účtu (pracující i dnešní dokončené — rozsah ověřit na serveru). */
  async showOrders(accountId: string): Promise<RithmicOrderUpdate[]> {
    const response = await this.plant('order').request(
      320,
      { account_id: accountId },
      {
        collect: (m) =>
          m.templateId === 352 && m.fields.is_snapshot === true && str(m.fields.account_id) === accountId,
      },
    );
    return response.rows.filter((m) => m.templateId === 352).map((m) => orderUpdate('exchange', m, response.completedAt));
  }

  /** Souhrn historie příkazů za obchodní den (YYYYMMDD) — pro dohledání i dokončených příkazů. */
  async showOrderHistorySummary(accountId: string, date: string): Promise<RithmicOrderUpdate[]> {
    const response = await this.plant('order').request(
      324,
      { account_id: accountId, date },
      {
        collect: (m) =>
          m.templateId === 352 && m.fields.is_snapshot === true && str(m.fields.account_id) === accountId,
      },
    );
    return response.rows.filter((m) => m.templateId === 352).map((m) => orderUpdate('exchange', m, response.completedAt));
  }

  async showBrackets(accountId: string): Promise<Array<{ basketId: string; targetTicks: number | null; targetQuantity: number | null; targetQuantityReleased: number | null }>> {
    const response = await this.plant('order').request(338, { account_id: accountId });
    return [...response.rows, ...(response.terminal ? [response.terminal] : [])]
      .filter((m) => str(m.fields.basket_id) !== '')
      .map((m) => ({
        basketId: str(m.fields.basket_id),
        targetTicks: num(m.fields.target_ticks),
        targetQuantity: num(m.fields.target_quantity),
        targetQuantityReleased: num(m.fields.target_quantity_released),
      }));
  }

  async showBracketStops(accountId: string): Promise<Array<{ basketId: string; stopTicks: number | null; stopQuantity: number | null; stopQuantityReleased: number | null }>> {
    const response = await this.plant('order').request(340, { account_id: accountId });
    return [...response.rows, ...(response.terminal ? [response.terminal] : [])]
      .filter((m) => str(m.fields.basket_id) !== '')
      .map((m) => ({
        basketId: str(m.fields.basket_id),
        stopTicks: num(m.fields.stop_ticks),
        stopQuantity: num(m.fields.stop_quantity),
        stopQuantityReleased: num(m.fields.stop_quantity_released),
      }));
  }

  /** Posun SL bracketu před vznikem nohy: `level` je dosavadní vzdálenost, `stopTicks` nová. */
  async updateStopBracketLevel(accountId: string, basketId: string, level: number, stopTicks: number): Promise<RithmicResponse> {
    return this.plant('order').request(334, { account_id: accountId, basket_id: basketId, level, stop_ticks: stopTicks });
  }

  async updateTargetBracketLevel(accountId: string, basketId: string, level: number, targetTicks: number): Promise<RithmicResponse> {
    return this.plant('order').request(332, { account_id: accountId, basket_id: basketId, level, target_ticks: targetTicks });
  }

  async frontMonthContract(symbol: string, exchange: string): Promise<string | null> {
    const response = await this.plant('ticker').request(113, { symbol, exchange });
    return str(response.terminal?.fields.trading_symbol) || null;
  }

  async searchSymbols(searchText: string, exchange: string): Promise<Array<{ symbol: string; productCode: string; expirationDate: string; instrumentType: string }>> {
    const response = await this.plant('ticker').request(109, {
      search_text: searchText,
      exchange,
      pattern: rithmicEnum('RequestSearchSymbols', 'Pattern', 'CONTAINS'),
    });
    return [...response.rows, ...(response.terminal ? [response.terminal] : [])]
      .filter((m) => str(m.fields.symbol) !== '')
      .map((m) => ({
        symbol: str(m.fields.symbol),
        productCode: str(m.fields.product_code),
        expirationDate: str(m.fields.expiration_date),
        instrumentType: str(m.fields.instrument_type),
      }));
  }

  async referenceData(symbol: string, exchange: string): Promise<{ tickSize: number | null; pointValue: number | null; raw: RithmicFields } | null> {
    const response = await this.plant('ticker').request(14, { symbol, exchange });
    if (!response.terminal) return null;
    const f = response.terminal.fields;
    return { tickSize: num(f.min_qprice_change), pointValue: num(f.single_point_value), raw: f };
  }

  /** Odběr posledních obchodů (1) a nejlepší nabídky/poptávky (2). */
  async subscribeMarketData(symbol: string, exchange: string, bits = 3): Promise<void> {
    await this.plant('ticker').request(100, {
      symbol,
      exchange,
      request: rithmicEnum('RequestMarketDataUpdate', 'Request', 'SUBSCRIBE'),
      update_bits: bits,
    });
  }

  async subscribePnl(accountId: string): Promise<void> {
    await this.plant('pnl').request(400, {
      account_id: accountId,
      request: rithmicEnum('RequestPnLPositionUpdates', 'Request', 'SUBSCRIBE'),
    });
  }

  /** Vyžádá snímek pozic a P&L; výsledky přijdou událostmi s isSnapshot = true. */
  async requestPnlSnapshot(accountId: string): Promise<void> {
    await this.plant('pnl').request(402, { account_id: accountId });
  }

  private handlePush(plant: RithmicPlantName, message: RithmicMessage, receivedAt: number): void {
    const events = this.config.events;
    if (!events) return;
    const f = message.fields;
    switch (message.templateId) {
      case 351:
        events.onOrderUpdate?.(orderUpdate('rithmic', message, receivedAt));
        return;
      case 352:
        events.onOrderUpdate?.(orderUpdate('exchange', message, receivedAt));
        return;
      case 353:
        events.onBracketUpdate?.({
          accountId: str(f.account_id),
          basketId: str(f.basket_id),
          stopTicks: num(f.stop_ticks),
          stopQuantity: num(f.stop_quantity),
          stopQuantityReleased: num(f.stop_quantity_released),
          targetTicks: num(f.target_ticks),
          targetQuantity: num(f.target_quantity),
          targetQuantityReleased: num(f.target_quantity_released),
          receivedAt,
        });
        return;
      case 150:
      case 151:
        events.onTick?.({
          kind: message.templateId === 150 ? 'trade' : 'bbo',
          symbol: str(f.symbol),
          exchange: str(f.exchange),
          isSnapshot: f.is_snapshot === true,
          tradePrice: num(f.trade_price),
          tradeSize: num(f.trade_size),
          bidPrice: num(f.bid_price),
          askPrice: num(f.ask_price),
          gatewayAt: stamp(f.ssboe, f.usecs),
          exchangeAt: stamp(f.source_ssboe, f.source_usecs),
          receivedAt,
        });
        return;
      case 450:
        events.onInstrumentPosition?.({
          accountId: str(f.account_id),
          symbol: str(f.symbol),
          exchange: str(f.exchange),
          isSnapshot: f.is_snapshot === true,
          netQuantity: num(f.net_quantity) ?? 0,
          avgOpenFillPrice: num(f.avg_open_fill_price),
          openPnl: num(f.open_position_pnl) ?? num(f.day_open_pnl),
          closedPnl: num(f.closed_position_pnl) ?? num(f.day_closed_pnl),
          receivedAt,
        });
        return;
      case 451:
        events.onAccountPnl?.({
          accountId: str(f.account_id),
          isSnapshot: f.is_snapshot === true,
          accountBalance: num(f.account_balance),
          openPnl: num(f.open_position_pnl),
          closedPnl: num(f.closed_position_pnl),
          dayPnl: num(f.day_pnl),
          netQuantity: num(f.net_quantity),
          receivedAt,
        });
        return;
      default:
        return;
    }
  }
}

export { RithmicRequestError, rithmicStrings };

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

export type RithmicPlantName = 'order' | 'ticker' | 'pnl' | 'history';

/** Jedna svíčka z historie Rithmicu. `time` = začátek svíčky v sekundách (minutové svíčky), jen čtení. */
export interface RithmicHistoryBar { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number; period: string; marker: number }
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
  /** Druh posledního hlášení u řádku snímku: změřeno „cancel" u zrušeného příkazu. */
  reportType: string;
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
  /** null = server hodnotu neposlal nebo je neplatná. NENÍ to nula. */
  netQuantity: number | null;
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
  /** Zpráva, kterou klient zahodil, protože jí nejde věřit (cizí identita účtu apod.). */
  onAttention?: (message: string) => void;
  /** Důkaz živého spojení daného plantu. */
  onAlive?: (plant: RithmicPlantName, receivedAt: number) => void;
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
  history: RITHMIC_INFRA.HISTORY_PLANT,
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
    reportType: str(f.report_type),
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
      if (name === 'pnl' && !this.plants.has('order')) {
        // Identitu účtů dává order plant; bez ní by se každá pozice a P&L zahodily.
        throw new RithmicRequestError('Rithmic: pnl plant jde připojit až po order plantu', 'not-sent', 0);
      }
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
        onAlive: (receivedAt) => this.config.events?.onAlive?.(name, receivedAt),
        onHandlerError: (message, error) =>
          this.config.events?.onAttention?.(
            `zpracování zprávy ${message.templateId} na plantu ${name} selhalo: ${error instanceof Error ? error.message : String(error)}`,
          ),
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
    const listed: RithmicAccount[] = [...accounts.rows, ...(accounts.terminal ? [accounts.terminal] : [])]
      .filter((m) => str(m.fields.account_id) !== '')
      .map((m) => ({
        fcmId: str(m.fields.fcm_id),
        ibId: str(m.fields.ib_id),
        accountId: str(m.fields.account_id),
        accountName: str(m.fields.account_name),
      }));
    const seen = new Set<string>();
    for (const account of listed) {
      // Text účtu používáme jako klíč zápisů i událostí; dvě identity se stejným textem nejde bezpečně rozlišit.
      if (seen.has(account.accountId)) throw new Error(`Rithmic: přihlášení má dva účty se stejným číslem ${account.accountId}`);
      if (!account.fcmId || !account.ibId) throw new Error(`Rithmic: účet ${account.accountId} nemá FCM/IB`);
      seen.add(account.accountId);
    }
    // Až po kontrole: neplatný seznam nesmí zůstat v paměti a propouštět události.
    this.accounts = listed;
    const routes = await plant.request(310, { subscribe_for_updates: true });
    this.tradeRoutes = [...routes.rows, ...(routes.terminal ? [routes.terminal] : [])]
      .filter((m) => str(m.fields.trade_route) !== '')
      .map((m) => ({
        exchange: str(m.fields.exchange),
        tradeRoute: str(m.fields.trade_route),
        isDefault: m.fields.is_default === true,
      }));
    for (const account of this.accounts) {
      await plant.request(308, this.accountFields(account.accountId));
      await plant.request(336, this.accountFields(account.accountId));
    }
  }

  close(): void {
    for (const plant of [...this.plants.values()]) plant.close();
    this.plants.clear();
  }

  /** Má přihlášení trade route pro burzu? Bez ní nejde na burze obchodovat. */
  hasTradeRoute(exchange: string): boolean {
    return this.tradeRoutes.some((r) => r.exchange === exchange);
  }

  /** Úplná identita účtu pro zprávu; neznámý účet = požadavek se neodešle. */
  private accountFields(accountId: string): RithmicFields {
    const account = this.accounts.find((a) => a.accountId === accountId);
    if (!account) throw new RithmicRequestError(`Rithmic: účet ${accountId} není v přihlášení`, 'not-sent', 0);
    return { account_id: account.accountId, fcm_id: account.fcmId, ib_id: account.ibId };
  }

  /** Událost musí nést účet z přihlášení a, pokud nese FCM/IB, tak shodné. */
  private trustedAccount(f: RithmicFields, what: string): boolean {
    const account = this.accounts.find((a) => a.accountId === str(f.account_id));
    const fcm = str(f.fcm_id);
    const ib = str(f.ib_id);
    if (account && (!fcm || fcm === account.fcmId) && (!ib || ib === account.ibId)) return true;
    this.config.events?.onAttention?.(`${what} pro cizí nebo neznámou identitu účtu ${str(f.account_id) || '(prázdný)'}`);
    return false;
  }

  /** Snímky příkazů sdílejí zachytávání zpráv 352, proto vždy jen jeden naráz. */
  private snapshotQueue: Promise<unknown> = Promise.resolve();
  private serialSnapshot<T>(run: () => Promise<T>): Promise<T> {
    const next = this.snapshotQueue.then(run, run);
    this.snapshotQueue = next.catch(() => undefined);
    return next;
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
      ...this.accountFields(request.accountId),
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
    // Rithmic posílá basket_id v datovém řádku odpovědi a konečná odpověď ho nést nemusí
    // (změřeno 16. 11. 2026 na Rithmic Test). Řádky jsou spárované podle user_msg.
    const basketId =
      str(response.terminal?.fields.basket_id) ||
      str(response.rows.find((m) => m.templateId === templateId + 1 && str(m.fields.basket_id) !== '')?.fields.basket_id);
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
      ...this.accountFields(order.accountId),
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
      ...this.accountFields(accountId),
      basket_id: basketId,
      manual_or_auto: rithmicEnum('RequestCancelOrder', 'OrderPlacement', 'MANUAL'),
    });
  }

  async cancelAllOrders(accountId: string): Promise<RithmicResponse> {
    return this.plant('order').request(346, {
      ...this.accountFields(accountId),
      manual_or_auto: rithmicEnum('RequestCancelAllOrders', 'OrderPlacement', 'MANUAL'),
    });
  }

  /** Zavře pozici v instrumentu tržním příkazem na straně serveru. */
  async exitPosition(accountId: string, symbol: string, exchange: string): Promise<RithmicResponse> {
    return this.plant('order').request(3504, {
      ...this.accountFields(accountId),
      symbol,
      exchange,
      manual_or_auto: rithmicEnum('RequestExitPosition', 'OrderPlacement', 'MANUAL'),
    });
  }

  /**
   * Snímek příkazů účtu. Změřeno 16. 11. 2026 na Rithmic Test: vrací pracující I dnešní
   * dokončené příkazy (zrušené, vyplněné, odmítnuté). Historie 324 pro dnešní den vrací prázdno.
   */
  async showOrders(accountId: string): Promise<RithmicOrderUpdate[]> {
    return this.orderSnapshot(320, accountId, {});
  }

  /** Souhrn historie příkazů za obchodní den (YYYYMMDD) — pro dohledání i dokončených příkazů. */
  async showOrderHistorySummary(accountId: string, date: string): Promise<RithmicOrderUpdate[]> {
    return this.orderSnapshot(324, accountId, { date });
  }

  private orderSnapshot(templateId: 320 | 324, accountId: string, extra: RithmicFields): Promise<RithmicOrderUpdate[]> {
    const identity = this.accountFields(accountId);
    return this.serialSnapshot(async () => {
      const response = await this.plant('order').request(
        templateId,
        { ...identity, ...extra },
        {
          // Změřeno 16. 11. 2026: příkaz, který nedošel na burzu (odmítnutí RMS), je ve snímku
          // jen jako 351; ostatní jako 352. Sbíráme oba, jinak by odmítnutý příkaz chyběl.
          collect: (m) =>
            (m.templateId === 352 || m.templateId === 351) &&
            m.fields.is_snapshot === true &&
            str(m.fields.account_id) === accountId,
        },
      );
      const rows = response.rows.filter(
        (m) => (m.templateId === 352 || m.templateId === 351) && this.trustedAccount(m.fields, 'řádek snímku příkazů'),
      );
      const onExchange = new Set(rows.filter((m) => m.templateId === 352).map((m) => str(m.fields.basket_id)));
      return rows
        .filter((m) => m.templateId === 352 || !onExchange.has(str(m.fields.basket_id)))
        .map((m) => orderUpdate(m.templateId === 352 ? 'exchange' : 'rithmic', m, response.completedAt));
    });
  }

  /**
   * Historie svíček (history plant, šablona 202 → 203). Jen čtení. `fromSec`/`toSec` jsou sekundy od epochy.
   * Změřeno 17. 11. 2026 na systému LucidTrading (scripts/rithmic/measureHistory.ts): u minutových svíček je
   * `marker` KONEC svíčky v sekundách a vrací se jen DOKONČENÉ minuty (rozpracovaná ne); denní přestávka trhu
   * je v datech jako mezera. Hloubka: aspoň 90 dní zpět u běžícího kontraktu, týden 1m ≈ 6 900 svíček za 0,5 s.
   */
  async timeBarReplay(request: { symbol: string; exchange: string; barType: 'MINUTE_BAR' | 'DAILY_BAR'; period: number; fromSec: number; toSec: number; maxCount?: number }): Promise<RithmicHistoryBar[]> {
    const response = await this.plant('history').request(202, {
      symbol: request.symbol,
      exchange: request.exchange,
      bar_type: rithmicEnum('RequestTimeBarReplay', 'BarType', request.barType),
      bar_type_period: request.period,
      start_index: Math.floor(request.fromSec),
      finish_index: Math.floor(request.toSec),
      ...(request.maxCount !== undefined ? { user_max_count: request.maxCount } : {}),
      direction: rithmicEnum('RequestTimeBarReplay', 'Direction', 'FIRST'),
      time_order: rithmicEnum('RequestTimeBarReplay', 'TimeOrder', 'FORWARDS'),
    });
    const seconds = request.barType === 'MINUTE_BAR' ? request.period * 60 : 0;
    const bars = response.rows
      // Jen řádky s platným časem a kladnou cenou; cokoli jiného by v grafu udělalo nesmyslnou svíčku.
      .filter((m) => (num(m.fields.open_price) ?? 0) > 0 && (num(m.fields.marker) ?? 0) > seconds)
      .map((m) => {
        const marker = num(m.fields.marker)!;
        return {
          time: marker - seconds, open: num(m.fields.open_price)!, high: num(m.fields.high_price) ?? num(m.fields.open_price)!,
          low: num(m.fields.low_price) ?? num(m.fields.open_price)!, close: num(m.fields.close_price) ?? num(m.fields.open_price)!,
          volume: num(m.fields.volume) ?? 0, trades: num(m.fields.num_trades) ?? 0, period: str(m.fields.period), marker,
        };
      });
    // Vzestupně a od každého času jen poslední řádek (dvě svíčky se stejným časem graf nesnese).
    const byTime = new Map<number, RithmicHistoryBar>();
    for (const bar of bars) byTime.set(bar.time, bar);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  async showBrackets(accountId: string): Promise<Array<{ basketId: string; targetTicks: number | null; targetQuantity: number | null; targetQuantityReleased: number | null }>> {
    const response = await this.plant('order').request(338, this.accountFields(accountId));
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
    const response = await this.plant('order').request(340, this.accountFields(accountId));
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
    return this.plant('order').request(334, { ...this.accountFields(accountId), basket_id: basketId, level, stop_ticks: stopTicks });
  }

  async updateTargetBracketLevel(accountId: string, basketId: string, level: number, targetTicks: number): Promise<RithmicResponse> {
    return this.plant('order').request(332, { ...this.accountFields(accountId), basket_id: basketId, level, target_ticks: targetTicks });
  }

  /**
   * Čerstvý seznam účtů ze serveru. Uloženou identitu účtů NEPŘEPISUJE (běžící čtení
   * a kontrola událostí na ní stojí); volající porovná a při rozdílu se odpojí.
   */
  async fetchAccounts(): Promise<RithmicAccount[]> {
    const response = await this.plant('order').request(302, { user_type: this.userType });
    return [...response.rows, ...(response.terminal ? [response.terminal] : [])]
      .filter((m) => str(m.fields.account_id) !== '')
      .map((m) => ({
        fcmId: str(m.fields.fcm_id),
        ibId: str(m.fields.ib_id),
        accountId: str(m.fields.account_id),
        accountName: str(m.fields.account_name),
      }));
  }

  /** Surové RMS nastavení účtů (limity, stav, auto-likvidace). */
  async accountRmsInfo(): Promise<RithmicFields[]> {
    const response = await this.plant('order').request(304, { user_type: this.userType });
    return [...response.rows, ...(response.terminal ? [response.terminal] : [])].map((m) => m.fields);
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
      ...this.accountFields(accountId),
      request: rithmicEnum('RequestPnLPositionUpdates', 'Request', 'SUBSCRIBE'),
    });
  }

  /** Vyžádá snímek pozic a P&L; výsledky přijdou událostmi s isSnapshot = true. */
  async requestPnlSnapshot(accountId: string): Promise<void> {
    await this.plant('pnl').request(402, this.accountFields(accountId));
  }

  private handlePush(plant: RithmicPlantName, message: RithmicMessage, receivedAt: number): void {
    const events = this.config.events;
    if (!events) return;
    const f = message.fields;
    switch (message.templateId) {
      case 351:
        if (!this.trustedAccount(f, 'notifikace příkazu')) return;
        events.onOrderUpdate?.(orderUpdate('rithmic', message, receivedAt));
        return;
      case 352:
        if (!this.trustedAccount(f, 'notifikace příkazu')) return;
        events.onOrderUpdate?.(orderUpdate('exchange', message, receivedAt));
        return;
      case 353:
        if (!this.trustedAccount(f, 'změna bracketu')) return;
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
        if (!this.trustedAccount(f, 'pozice')) return;
        events.onInstrumentPosition?.({
          accountId: str(f.account_id),
          symbol: str(f.symbol),
          exchange: str(f.exchange),
          isSnapshot: f.is_snapshot === true,
          netQuantity: num(f.net_quantity),
          avgOpenFillPrice: num(f.avg_open_fill_price),
          openPnl: num(f.open_position_pnl) ?? num(f.day_open_pnl),
          closedPnl: num(f.closed_position_pnl) ?? num(f.day_closed_pnl),
          receivedAt,
        });
        return;
      case 451:
        if (!this.trustedAccount(f, 'P&L účtu')) return;
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

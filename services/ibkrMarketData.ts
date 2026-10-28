import {
  BarSizeSetting,
  type Contract,
  type ContractDetails,
  EventName,
  IBApi,
  MarketDataType,
  TickByTickDataType,
  WhatToShow,
} from '@stoqey/ib';

/**
 * Jediná cesta appky k IB Gateway (Interactive Brokers). Jen čtení:
 *
 * - připojení výhradně na 127.0.0.1 a porty Gateway/TWS (Gateway má navíc
 *   zapnuté „Read-Only API“, takže ani spojení samo příkaz neprovede);
 * - `createReadOnlyIbClient` vrací zmrazené úzké rozhraní jen s čtecími
 *   voláními — žádné příkazy, účty, pozice ani exekuce (hlídá
 *   `tests/ibkrMarketData.test.ts`);
 * - čísla účtů z hlášek Gateway maže.
 *
 * Používá sonda `scripts/market-data/ibkrTickProbe.ts` a zdroj ceny vlákna
 * kanálu ceny (`services/ibkrPriceSource.ts`). Jen zobrazení (INV-UI-04):
 * nic odsud nesmí do kopírky, risku ani úložišť.
 */

export const IB_GATEWAY_HOST = '127.0.0.1';
/** 4001/4002 = IB Gateway live/paper, 7496/7497 = TWS live/paper. */
export const IB_ALLOWED_PORTS = [4001, 4002, 7496, 7497] as const;
/** IBKR: stejný instrument jde přes tick-by-tick požádat nejvýš jednou za 15 s. */
export const TICK_BY_TICK_REQUEST_GAP_MS = 15_000;

const VOLUME_TICK_TYPE = 8;
const BID_TICK_TYPE = 1;
const ASK_TICK_TYPE = 2;

export interface IbTrade {
  /** Čas obchodu od IBKR, epoch sekundy (IBKR dává jen celé sekundy). */
  time: number;
  price: number;
  size: number;
  /** Epoch ms, kdy obchod dorazil. */
  receivedAt: number;
  pastLimit: boolean;
  unreported: boolean;
}

export interface IbMinuteBar {
  /** Začátek minuty, epoch sekundy. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  count: number | null;
}

export interface ReadOnlyIbHandlers {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (code: number, reqId: number, message: string) => void;
  onInfo?: (code: number, message: string) => void;
  onMarketDataType?: (reqId: number, type: number) => void;
  onContractDetails?: (reqId: number, details: ContractDetails) => void;
  onContractDetailsEnd?: (reqId: number) => void;
  onTick?: (reqId: number, tick: IbTrade) => void;
  onVolume?: (reqId: number, volume: number, receivedAt: number) => void;
  /** Nejlepší bid/ask z `reqMktData` (tick type 1/2). */
  onQuote?: (reqId: number, side: 'bid' | 'ask', price: number) => void;
  onBar?: (reqId: number, bar: IbMinuteBar) => void;
  onBarsEnd?: (reqId: number) => void;
}

/** Úzké rozhraní nad `IBApi`: nic, co by umělo poslat příkaz nebo číst účet. */
export interface ReadOnlyIbClient {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  requestRealtimeData(): void;
  requestContractDetails(reqId: number, contract: Contract): void;
  subscribeTrades(reqId: number, contract: Contract): void;
  cancelTrades(reqId: number): void;
  subscribeVolume(reqId: number, contract: Contract): void;
  cancelVolume(reqId: number): void;
  requestMinuteBars(reqId: number, contract: Contract, durationStr: string): void;
}

const ACCOUNT_ID_PATTERN = /\b(?:DU|DF|U|F|I)\d{5,9}\b/g;

/** Z textu (hlášky Gateway) vymaže čísla účtů IBKR. */
export const redactAccountIds = (text: string): string => text.replace(ACCOUNT_ID_PATTERN, '[account]');

export function assertGatewayEndpoint(host: string, port: number): void {
  if (host !== IB_GATEWAY_HOST) throw new Error(`IBKR klient se smí připojit jen na ${IB_GATEWAY_HOST}`);
  if (!(IB_ALLOWED_PORTS as readonly number[]).includes(port)) {
    throw new Error(`port ${port} není port IB Gateway/TWS (${IB_ALLOWED_PORTS.join(', ')})`);
  }
}

export function createReadOnlyIbClient(
  options: { port: number; clientId: number },
  handlers: ReadOnlyIbHandlers,
): ReadOnlyIbClient {
  assertGatewayEndpoint(IB_GATEWAY_HOST, options.port);
  // Všechny volby předané výslovně → knihovna nesáhne na vlastní konfiguraci
  // (ta by jinak načetla `.env` z aktuální složky).
  const api = new IBApi({ host: IB_GATEWAY_HOST, port: options.port, clientId: options.clientId, maxReqPerSec: 40 });

  api.on(EventName.connected, () => handlers.onConnected?.());
  api.on(EventName.disconnected, () => handlers.onDisconnected?.());
  api.on(EventName.error, (error, code, reqId) => {
    handlers.onError?.(Number(code), reqId, redactAccountIds(error?.message ?? ''));
  });
  api.on(EventName.info, (message, code) => handlers.onInfo?.(Number(code), redactAccountIds(String(message ?? ''))));
  api.on(EventName.marketDataType, (reqId, type) => handlers.onMarketDataType?.(reqId, type));
  api.on(EventName.contractDetails, (reqId, details) => handlers.onContractDetails?.(reqId, details));
  api.on(EventName.contractDetailsEnd, reqId => handlers.onContractDetailsEnd?.(reqId));
  api.on(EventName.tickByTickAllLast, (reqId, _tickType, time, price, size, attribs) => {
    handlers.onTick?.(reqId, {
      time: Number(time),
      price,
      size: Number(size),
      receivedAt: Date.now(),
      pastLimit: !!attribs?.pastLimit,
      unreported: !!attribs?.unreported,
    });
  });
  api.on(EventName.tickSize, (reqId, field, value) => {
    if (field === VOLUME_TICK_TYPE && value != null && Number.isFinite(Number(value))) {
      handlers.onVolume?.(reqId, Number(value), Date.now());
    }
  });
  api.on(EventName.tickPrice, (reqId, field, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    if (field === BID_TICK_TYPE) handlers.onQuote?.(reqId, 'bid', value);
    else if (field === ASK_TICK_TYPE) handlers.onQuote?.(reqId, 'ask', value);
  });
  api.on(EventName.historicalData, (reqId, time, open, high, low, close, volume, count) => {
    if (String(time).startsWith('finished')) {
      handlers.onBarsEnd?.(reqId);
      return;
    }
    handlers.onBar?.(reqId, {
      time: Number(time),
      open,
      high,
      low,
      close,
      volume: Number(volume),
      count: count == null ? null : Number(count),
    });
  });

  return Object.freeze({
    connect: () => void api.connect(),
    disconnect: () => void api.disconnect(),
    isConnected: () => api.isConnected,
    requestRealtimeData: () => void api.reqMarketDataType(MarketDataType.REALTIME),
    requestContractDetails: (reqId: number, contract: Contract) => void api.reqContractDetails(reqId, contract),
    subscribeTrades: (reqId: number, contract: Contract) =>
      void api.reqTickByTickData(reqId, contract, TickByTickDataType.AllLast, 0, false),
    cancelTrades: (reqId: number) => void api.cancelTickByTickData(reqId),
    // Kotace (bid/ask, denní objem a typ dat); bez snapshotu, bez regulatorního snapshotu.
    subscribeVolume: (reqId: number, contract: Contract) => void api.reqMktData(reqId, contract, '', false, false),
    cancelVolume: (reqId: number) => void api.cancelMktData(reqId),
    // formatDate 2 = epoch sekundy; useRTH 0 = celá session (ne jen 15:30–22:00).
    requestMinuteBars: (reqId: number, contract: Contract, durationStr: string) =>
      void api.reqHistoricalData(reqId, contract, '', durationStr, BarSizeSetting.MINUTES_ONE, WhatToShow.TRADES, 0, 2, false),
  });
}

/** „20261218“ nebo „20261218 08:30 US/Central“ → epoch ms (půlnoc UTC). */
export function parseIbDate(value: string | undefined): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value ?? '');
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export interface FrontContractCandidate {
  conId: number;
  localSymbol: string;
  lastTradeDate: string;
  multiplier: number | null;
}

export const toFrontCandidate = (details: ContractDetails): FrontContractCandidate | null => {
  const contract = details.contract;
  const lastTradeDate = details.realExpirationDate ?? contract?.lastTradeDateOrContractMonth;
  if (!contract?.conId || !contract.localSymbol || !lastTradeDate) return null;
  return {
    conId: contract.conId,
    localSymbol: contract.localSymbol,
    lastTradeDate,
    multiplier: contract.multiplier == null ? null : Number(contract.multiplier),
  };
};

/**
 * Přední kontrakt: nejbližší expirace, která je víc než `rollDays` dní daleko
 * (indexové futures se rolují ~8 dní před expirací). `localSymbol` přebíjí.
 */
export function pickFrontContract(
  candidates: readonly FrontContractCandidate[],
  nowMs: number,
  rollDays: number,
  localSymbol?: string | null,
): FrontContractCandidate | null {
  if (localSymbol) return candidates.find(candidate => candidate.localSymbol === localSymbol) ?? null;
  const dated = candidates
    .map(candidate => ({ candidate, expiry: parseIbDate(candidate.lastTradeDate) }))
    .filter((entry): entry is { candidate: FrontContractCandidate; expiry: number } => entry.expiry != null && entry.expiry >= nowMs)
    .sort((a, b) => a.expiry - b.expiry);
  const pastRoll = dated.find(entry => entry.expiry - nowMs > rollDays * 86_400_000);
  return (pastRoll ?? dated[0])?.candidate ?? null;
}

/** Další tick-by-tick žádost o stejný instrument smí odejít nejdřív za 15 s. */
export const nextTradesRequestAt = (lastRequestAt: number | null): number =>
  lastRequestAt == null ? 0 : lastRequestAt + TICK_BY_TICK_REQUEST_GAP_MS;

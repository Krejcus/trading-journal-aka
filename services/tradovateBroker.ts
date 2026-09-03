import type {
  BrokerEnvironment,
  BrokerEvent,
  BrokerFill,
  BrokerAccountCapability,
  BrokerOrder,
  BrokerOrderAck,
  BrokerOrderRequest,
  BrokerOcoRequest,
  BrokerOsoRequest,
  BrokerPort,
  BrokerPosition,
  OrderSide,
  OrderType,
} from './brokerPort';
import { isOpenOrderStatus } from './brokerPort';
import {
  TRADOVATE_HEARTBEAT_MS,
  TRADOVATE_HOSTS,
  fromLiquidatePositionResult,
  fromOrderEntity,
  fromPlaceOcoResult,
  fromPlaceOsoResult,
  fromPlaceOrderResult,
  toPlaceOcoPayload,
  toPlaceOsoPayload,
  toPlaceOrderPayload,
  type TradovateOrderEntity,
  type TradovatePlaceOrderResult,
  type TradovatePlaceOcoResult,
  type TradovatePlaceOsoResult,
} from './tradovateMapping';

interface TradovateContractEntity { id: number; name: string }
interface TradovateAccountEntity { id: number; name?: string; active: boolean; readonly?: boolean }
interface TradovatePositionEntity { accountId: number; contractId: number; netPos: number }
interface TradovateRawOrderEntity {
  id: number;
  accountId: number;
  contractId: number;
  action: OrderSide;
  ordStatus: string;
  ocoId?: number;
  parentId?: number;
  linkedId?: number;
  timestamp?: string;
}
interface TradovateOrderVersionEntity {
  id: number;
  orderId: number;
  orderQty: number;
  orderType: string;
  price?: number;
  stopPrice?: number;
}
interface TradovateCommandEntity {
  id: number;
  orderId?: number;
  commandType?: 'New' | 'Cancel' | 'Modify';
  clOrdId?: string;
  customTag50?: string;
}
interface TradovateCommandReportEntity {
  id: number;
  commandId: number;
  commandStatus?: string;
  rejectReason?: string;
  text?: string;
  ordStatus?: string;
}
interface TradovateExecutionReportEntity {
  id: number;
  commandId?: number;
  orderId: number;
  accountId: number;
  contractId: number;
  timestamp?: string;
  ordStatus: string;
  action: OrderSide;
  ocoId?: number;
  parentId?: number;
  linkedId?: number;
  rejectReason?: string;
  text?: string;
}
interface TradovateFillEntity {
  id: number;
  orderId: number;
  accountId?: number;
  contractId: number;
  action?: OrderSide;
  qty: number;
  price: number;
  timestamp?: string;
}
interface TradovateCommandResult { commandId?: number; failureReason?: string; failureText?: string }

export interface WebSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface TradovateBrokerConfig {
  environment: BrokerEnvironment;
  accessToken?: string;
  getAccessToken?: () => Promise<string>;
  /** Legacy fallback for single-account connections. */
  accountSpec?: string;
  /** Exact Tradovate Account.name keyed by Account.id for multi-account connections. */
  accountSpecsByAccountId?: Readonly<Record<number, string>>;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
  clock?: () => number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitterRatio?: number;
  random?: () => number;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
  disconnectedLogIntervalMs?: number;
  onReconnectDiagnostic?: (message: string) => void;
  syncTimeoutMs?: number;
  socketIdleTimeoutMs?: number;
  /**
   * Lidský štítek OAuth spojení do chybových hlášek. U multi-connection
   * runtime bez něj nejde z logu poznat, KTERÉ spojení vypadlo (živý případ:
   * „odpojil se Lucid?" nešlo z `transport error` vůbec vyčíst).
   */
  connectionLabel?: string;
  /** Nejdéle jak smí plánovaná obměna socketu trvat, než se přizná výpadek. */
  renewalDeadlineMs?: number;
  /** Jak dlouho po command ACK čekat na autoritativní Order update ze sync streamu. */
  commandConfirmationTimeoutMs?: number;
}

export class TradovateTransportError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TradovateTransportError';
  }
}

export class TradovateRateLimitError extends TradovateTransportError {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
    readonly captchaRequired: boolean,
    readonly penaltyTicket?: string,
    status?: number,
  ) {
    super(message, status);
    this.name = 'TradovateRateLimitError';
  }
}

const numberId = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid Tradovate id: ${value}`);
  return parsed;
};

const supportedOrderType = (value: string): OrderType => {
  if (value === 'Market' || value === 'Limit' || value === 'Stop' || value === 'StopLimit') return value;
  throw new TradovateTransportError(`Unsupported Tradovate order type: ${value}`);
};

export interface TradovateBrokerPort extends BrokerPort {
  /**
   * Obnoví autoritativní adresář účtů viditelných tímto OAuth spojením.
   * Kromě oprávnění aktualizuje i Account.name používané při order side
   * effectu, takže nově přidaný prop účet nevyžaduje restart workeru.
   */
  refreshAccountDirectory(): Promise<TradovateVisibleAccount[]>;
  /**
   * Plánovaná plynulá obměna WebSocketu (cyklus Tradovate access tokenu).
   * Zavře socket BEZ disconnect eventu a hned se připojí s čerstvým tokenem;
   * resync doplní stav z autoritativního snapshotu (order sourceVersion a
   * fillId dedup kryjí překryvy). Když se obnova nestihne do deadline,
   * výpadek se přizná normální cestou. Vrací false, když obměna nejde
   * spustit (socket není v plném provozu nebo už běží).
   */
  renewSocket(): boolean;
}

export interface TradovateVisibleAccount extends BrokerAccountCapability {
  /** Exact Tradovate Account.name; null znamená, že účet nelze bezpečně použít pro execution. */
  accountSpec: string | null;
}

export function createTradovateBroker(config: TradovateBrokerConfig): TradovateBrokerPort {
  const hosts = TRADOVATE_HOSTS[config.environment];
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const clock = config.clock ?? Date.now;
  const intervals = config.setIntervalImpl ?? setInterval;
  const clearIntervals = config.clearIntervalImpl ?? clearInterval;
  const timeouts = config.setTimeoutImpl ?? setTimeout;
  const clearTimeouts = config.clearTimeoutImpl ?? clearTimeout;
  const listeners = new Set<(event: BrokerEvent) => void>();
  const accountSpecsByAccountId = new Map<number, string>(
    Object.entries(config.accountSpecsByAccountId ?? {}).flatMap(([rawId, rawName]) => {
      const accountId = Number(rawId);
      const accountSpec = rawName?.trim();
      return Number.isSafeInteger(accountId) && accountId > 0 && accountSpec
        ? [[accountId, accountSpec] as const]
        : [];
    }),
  );
  const contracts = new Map<number, string>();
  const rawOrders = new Map<number, TradovateRawOrderEntity>();
  const orderVersions = new Map<number, TradovateOrderVersionEntity>();
  const orderTags = new Map<number, string>();
  const commands = new Map<number, TradovateCommandEntity>();
  const pendingCommandReports = new Map<number, TradovateCommandReportEntity[]>();
  const orderRejectReasons = new Map<number, string>();
  const fillTotals = new Map<number, number>();
  const emittedFillIds = new Set<number>();
  const deliveredFillIds = new Set<number>();
  const pendingFills = new Map<number, TradovateFillEntity[]>();
  const orders = new Map<string, BrokerOrder>();
  const orderWaiters = new Map<number, Set<(order: BrokerOrder) => void>>();
  let socket: WebSocketLike | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let reconnectAt = 0;
  let connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  let closeWatchdog: ReturnType<typeof setTimeout> | null = null;
  let closeDeadlineAt = 0;
  let disconnectedLog: ReturnType<typeof setInterval> | null = null;
  let syncTimeout: ReturnType<typeof setTimeout> | null = null;
  let syncRetry: ReturnType<typeof setTimeout> | null = null;
  let socketMessageTail: Promise<void> = Promise.resolve();
  let lastSocketMessageAt = 0;
  let lastHeartbeatSentAt = 0;
  /**
   * Circuit breaker rate limitu. Po HTTP 429 Tradovate počítá hodinové okno
   * ZNOVU od každého dalšího pokusu — jediný „testovací“ retry prodlouží
   * blokaci o další hodinu. Po dobu penalizace se proto každý request
   * odmítá lokálně (fail-fast), bez dotyku API. `p-ticket` s `p-time`
   * blokuje jen na svůj interval.
   */
  let rateLimitedUntil = 0;
  let rateLimitedReason = '';
  const armRateLimitBreaker = (error: TradovateRateLimitError) => {
    if (error.retryAfterMs == null || error.retryAfterMs <= 0) return;
    const until = clock() + error.retryAfterMs;
    if (until > rateLimitedUntil) {
      rateLimitedUntil = until;
      rateLimitedReason = error.message;
    }
  };
  const assertNotRateLimited = () => {
    const remaining = rateLimitedUntil - clock();
    if (remaining <= 0) return;
    throw new TradovateRateLimitError(
      `Tradovate rate limit breaker aktivní ještě ${Math.ceil(remaining / 1_000)} s (${rateLimitedReason})`,
      remaining,
      false,
    );
  };
  type SocketState = 'idle' | 'connecting' | 'authorizing' | 'syncing' | 'connected' | 'closing' | 'waiting';
  let socketState: SocketState = 'idle';
  let reconnectFailures = 0;
  let lastReconnectReason = 'subscribe';
  let disconnectedSince = 0;
  let requestId = 2;
  let syncReady = false;
  /**
   * Plánovaná obměna socketu (cyklus access tokenu). Dokud běží, disconnect
   * eventy se zadržují — controller nesmí kvůli údržbě ztratit ARM. Když se
   * nový socket nestihne synchronizovat do deadline, zadržené chyby se
   * přiznají a výpadek se ohlásí normální cestou.
   */
  let renewalInProgress = false;
  let renewalDeadline: ReturnType<typeof setTimeout> | null = null;
  let renewalHeldEvents: BrokerEvent[] = [];
  const withConnectionLabel = (message: string): string =>
    config.connectionLabel ? `${message} [${config.connectionLabel}]` : message;
  const diagnosticLabel = config.connectionLabel?.trim() || 'connection:unlabeled';
  const diagnostic = (message: string) => config.onReconnectDiagnostic?.(
    `connection=${diagnosticLabel} ${message}`,
  );
  const contextualError = (
    reason: unknown,
    phase: 'token-lease' | 'rest' | 'websocket' | 'reconciliation',
  ): Error => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const prefix = `connection=${diagnosticLabel} phase=${phase}`;
    if (!error.message.includes('connection=') || !error.message.includes('phase=')) {
      error.message = `${prefix} ${error.message}`;
    }
    return error;
  };
  const finishRenewal = () => {
    if (renewalDeadline) clearTimeouts(renewalDeadline);
    renewalDeadline = null;
    renewalInProgress = false;
    renewalHeldEvents = [];
  };
  /** Zadrží chybu během plánované obměny; jinak ji rovnou emituje. */
  const emitOrHoldError = (error: Error) => {
    if (renewalInProgress) {
      renewalHeldEvents.push({ type: 'error', error, at: clock() });
      return;
    }
    emit({ type: 'error', error, at: clock() });
  };
  const commandCorrelationTag = (command: TradovateCommandEntity): string | undefined =>
    command.clOrdId?.trim() || command.customTag50?.trim() || undefined;
  const syncRequestBody = {
    splitResponses: true,
    entityTypes: ['contract', 'order', 'fill', 'position', 'command', 'executionReport', 'commandReport'],
  };

  const emit = (event: BrokerEvent) => {
    for (const listener of listeners) listener(event);
  };

  const token = async () => {
    try {
      const value = config.getAccessToken ? await config.getAccessToken() : config.accessToken;
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TradovateTransportError('Tradovate access token is missing');
      }
      return value.trim();
    } catch (reason) {
      throw contextualError(reason, 'token-lease');
    }
  };

  const accountSpecFor = (accountId: number): string => {
    const value = accountSpecsByAccountId.get(accountId) ?? config.accountSpec;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TradovateTransportError(`Tradovate accountSpec is missing for account ${accountId}`);
    }
    return value.trim();
  };

  const requestRaw = async <T>(path: string, init: RequestInit = {}, allowNotFound = false): Promise<T | null> => {
    if (!fetchImpl) throw new TradovateTransportError('fetch is unavailable');
    assertNotRateLimited();
    const accessToken = await token();
    const response = await fetchImpl(`${hosts.rest}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (allowNotFound && response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 423 || response.status === 429) {
        const error = new TradovateRateLimitError(
          `Tradovate ${path} rate limited (${response.status})`,
          response.status === 429 ? 60 * 60 * 1_000 : null,
          response.status === 429,
          undefined,
          response.status,
        );
        armRateLimitBreaker(error);
        throw error;
      }
      throw new TradovateTransportError(
        `Tradovate ${path} failed (${response.status}): ${text.slice(0, 500)}`,
        response.status,
      );
    }
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as T & {
        'p-ticket'?: string;
        'p-time'?: number;
        'p-captcha'?: boolean;
        'p-message'?: string;
      };
      if (parsed && typeof parsed === 'object' && parsed['p-ticket']) {
        const error = new TradovateRateLimitError(
          parsed['p-message'] ?? `Tradovate ${path} returned a penalty ticket`,
          Number.isFinite(parsed['p-time']) ? (parsed['p-time'] as number) * 1_000 : null,
          parsed['p-captcha'] === true,
          parsed['p-ticket'],
        );
        armRateLimitBreaker(error);
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error instanceof TradovateRateLimitError) throw error;
      throw new TradovateTransportError(`Tradovate ${path} returned malformed JSON`);
    }
  };

  const request = async <T>(path: string, init: RequestInit = {}, allowNotFound = false): Promise<T | null> => {
    try {
      return await requestRaw<T>(path, init, allowNotFound);
    } catch (reason) {
      throw contextualError(reason, 'rest');
    }
  };

  const post = <T>(path: string, body: unknown) => request<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const assertCommandAccepted = (result: TradovateCommandResult | null, operation: string): number => {
    if (!result) throw new TradovateTransportError(`${operation} returned an empty response`);
    if (result.failureReason && result.failureReason !== 'Success') {
      throw new TradovateTransportError(`${operation} rejected: ${result.failureText ?? result.failureReason}`);
    }
    if (result.commandId == null) {
      throw new TradovateTransportError(`${operation} returned an ambiguous response`);
    }
    return result.commandId;
  };

  const commandRejection = async (commandId: number): Promise<string | null> => {
    const reports = await request<TradovateCommandReportEntity[]>(
      `/commandReport/deps?masterid=${commandId}`,
    );
    const rejected = (reports ?? []).find(report =>
      report.ordStatus === 'Rejected'
      || report.commandStatus === 'ExecutionRejected'
      || report.commandStatus === 'RiskRejected');
    if (!rejected) return null;
    return rejected.text?.trim() || rejected.rejectReason || 'Tradovate command rejected';
  };

  const hydrateContracts = async (ids: readonly number[]) => {
    const missing = [...new Set(ids)].filter(id => !contracts.has(id));
    if (missing.length === 0) return;
    const encodedIds = missing.map(id => encodeURIComponent(String(id))).join(',');
    const result = await request<TradovateContractEntity[]>(`/contract/items?ids=${encodedIds}`);
    for (const item of result ?? []) contracts.set(item.id, item.name);
    const unresolved = missing.filter(id => !contracts.has(id));
    if (unresolved.length > 0) {
      throw new TradovateTransportError(`Missing contract metadata for ids: ${unresolved.join(',')}`);
    }
  };

  const rememberVersion = (version: TradovateOrderVersionEntity) => {
    const current = orderVersions.get(version.orderId);
    if (!current || version.id >= current.id) orderVersions.set(version.orderId, version);
  };

  const hydrateOrderVersion = async (orderId: number) => {
    if (orderVersions.has(orderId)) return;
    const versions = await request<TradovateOrderVersionEntity[]>(
      `/orderVersion/deps?masterid=${orderId}`,
    );
    for (const version of versions ?? []) rememberVersion(version);
  };

  const rememberFill = (fill: TradovateFillEntity): boolean => {
    if (emittedFillIds.has(fill.id)) return false;
    emittedFillIds.add(fill.id);
    fillTotals.set(fill.orderId, (fillTotals.get(fill.orderId) ?? 0) + fill.qty);
    return true;
  };

  const composeOrder = async (orderId: number): Promise<BrokerOrder | null> => {
    const raw = rawOrders.get(orderId);
    const version = orderVersions.get(orderId);
    if (!raw || !version) return null;
    await hydrateContracts([raw.contractId]);
    const entity: TradovateOrderEntity = {
      ...raw,
      ordStatus: orderRejectReasons.has(orderId) ? 'Rejected' : raw.ordStatus,
      orderQty: version.orderQty,
      orderType: supportedOrderType(version.orderType),
      cumQty: fillTotals.get(orderId) ?? 0,
      price: version.price,
      stopPrice: version.stopPrice,
      ocoId: raw.ocoId,
      parentId: raw.parentId,
      linkedId: raw.linkedId,
      customTag50: orderTags.get(orderId),
      rejectReason: orderRejectReasons.get(orderId),
    };
    const order = fromOrderEntity(entity, contracts.get(raw.contractId) as string);
    order.sourceVersion = `${version.id}:${raw.ordStatus}`;
    orders.set(order.brokerOrderId, order);
    for (const waiter of orderWaiters.get(orderId) ?? []) waiter(order);
    return order;
  };

  const waitForOrder = async (
    orderId: number,
    predicate: (order: BrokerOrder) => boolean,
  ): Promise<BrokerOrder | null> => {
    const current = orders.get(String(orderId));
    if (current && predicate(current)) return current;
    // Bez dokončeného syncu nemáme autoritativní stream. REST lookup v runneru
    // zůstává jediným bezpečným potvrzením a tady proto nečekáme.
    if (!syncReady) return null;
    return new Promise(resolveWait => {
      const listeners = orderWaiters.get(orderId) ?? new Set<(order: BrokerOrder) => void>();
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const finish = (order: BrokerOrder | null) => {
        listeners.delete(onOrder);
        if (listeners.size === 0) orderWaiters.delete(orderId);
        if (timeoutHandle) clearTimeouts(timeoutHandle);
        resolveWait(order);
      };
      const onOrder = (order: BrokerOrder) => {
        if (predicate(order)) finish(order);
      };
      listeners.add(onOrder);
      orderWaiters.set(orderId, listeners);
      timeoutHandle = timeouts(
        () => finish(null),
        config.commandConfirmationTimeoutMs ?? 5_000,
      );
    });
  };

  const emitMappedFill = async (fill: TradovateFillEntity): Promise<boolean> => {
    if (deliveredFillIds.has(fill.id)) return true;
    const linked = orders.get(String(fill.orderId));
    const accountId = fill.accountId ?? linked?.accountId ?? rawOrders.get(fill.orderId)?.accountId;
    if (accountId == null) {
      const waiting = pendingFills.get(fill.orderId) ?? [];
      if (!waiting.some(item => item.id === fill.id)) pendingFills.set(fill.orderId, [...waiting, fill]);
      return false;
    }
    await hydrateContracts([fill.contractId]);
    deliveredFillIds.add(fill.id);
    const mapped: BrokerFill = {
      fillId: String(fill.id),
      tag: orderTags.get(fill.orderId) ?? linked?.tag ?? '',
      brokerOrderId: String(fill.orderId),
      accountId,
      symbol: contracts.get(fill.contractId) as string,
      side: fill.action ?? linked?.side ?? rawOrders.get(fill.orderId)?.action ?? 'Buy',
      quantity: fill.qty,
      price: fill.price,
      filledAt: fill.timestamp ? Date.parse(fill.timestamp) : clock(),
    };
    emit({ type: 'fill', fill: mapped });
    return true;
  };

  const flushPendingFills = async (orderId: number) => {
    const waiting = pendingFills.get(orderId) ?? [];
    if (waiting.length === 0) return;
    pendingFills.delete(orderId);
    for (const fill of waiting) await emitMappedFill(fill);
  };

  /**
   * In-flight dedup globálních čtení: reconciliation/flatten volají
   * listPositions/listOrders pro KAŽDÝ účet spojení, ale Tradovate vrací
   * seznamy globálně. Bez sdílení dělal ARM pro 5 účtů ~25 identických REST
   * dotazů (a throttling je natahoval na sekundy). Sdílí se jen souběžné
   * volání — žádná TTL cache, žádné riziko starých dat.
   */
  let positionListInFlight: Promise<TradovatePositionEntity[]> | null = null;
  const listPositionEntities = () => {
    if (!positionListInFlight) {
      positionListInFlight = request<TradovatePositionEntity[]>('/position/list')
        .finally(() => { positionListInFlight = null; });
    }
    return positionListInFlight;
  };
  let accountListInFlight: Promise<TradovateAccountEntity[]> | null = null;
  const listAccountEntities = () => {
    if (!accountListInFlight) {
      accountListInFlight = request<TradovateAccountEntity[]>('/account/list')
        .finally(() => { accountListInFlight = null; });
    }
    return accountListInFlight;
  };
  let orderGraphInFlight: Promise<TradovateRawOrderEntity[]> | null = null;

  const loadOrderGraph = async (selectedOrderId?: number) => {
    if (selectedOrderId == null) {
      if (!orderGraphInFlight) {
        orderGraphInFlight = loadOrderGraphUncached()
          .finally(() => { orderGraphInFlight = null; });
      }
      return orderGraphInFlight;
    }
    return loadOrderGraphUncached(selectedOrderId);
  };

  const loadOrderGraphUncached = async (selectedOrderId?: number) => {
    const suffix = selectedOrderId == null ? '/list' : `/deps?masterid=${selectedOrderId}`;
    const [rawResult, versionResult, commandResult, fillResult] = await Promise.all([
      selectedOrderId == null
        ? request<TradovateRawOrderEntity[]>('/order/list')
        : request<TradovateRawOrderEntity>(`/order/item?id=${selectedOrderId}`, {}, true),
      request<TradovateOrderVersionEntity[]>(`/orderVersion${suffix}`),
      request<TradovateCommandEntity[]>('/command/list'),
      request<TradovateFillEntity[]>(`/fill${suffix}`),
    ]);
    const rawList = Array.isArray(rawResult) ? rawResult : rawResult ? [rawResult] : [];
    for (const raw of rawList) rawOrders.set(raw.id, raw);
    for (const version of versionResult ?? []) rememberVersion(version);
    for (const command of commandResult ?? []) {
      commands.set(command.id, command);
      const correlationTag = commandCorrelationTag(command);
      if (command.orderId != null && command.commandType === 'New' && correlationTag) {
        orderTags.set(command.orderId, correlationTag);
      }
    }
    for (const fill of fillResult ?? []) rememberFill(fill);
    return rawList;
  };

  const sendSocketRequest = (endpoint: string, body: unknown, id = requestId++) => {
    if (!socket || socket.readyState !== 1) throw new TradovateTransportError('WebSocket is not open');
    socket.send(`${endpoint}\n${id}\n\n${JSON.stringify(body)}`);
  };

  const applyCommandReport = async (report: TradovateCommandReportEntity): Promise<boolean> => {
    const command = commands.get(report.commandId);
    if (command?.orderId == null) {
      const waiting = pendingCommandReports.get(report.commandId) ?? [];
      if (!waiting.some(item => item.id === report.id)) {
        pendingCommandReports.set(report.commandId, [...waiting, report]);
      }
      return false;
    }
    const rejected = report.ordStatus === 'Rejected'
      || report.commandStatus === 'ExecutionRejected'
      || report.commandStatus === 'RiskRejected';
    if (rejected) {
      const reason = report.text?.trim() || report.rejectReason || 'Tradovate command rejected';
      orderRejectReasons.set(command.orderId, reason);
      const raw = rawOrders.get(command.orderId);
      if (raw) rawOrders.set(command.orderId, { ...raw, ordStatus: 'Rejected' });
      const order = await composeOrder(command.orderId);
      if (order) emit({ type: 'order', order });
    }
    return true;
  };

  const flushCommandReports = async (commandId: number) => {
    const waiting = pendingCommandReports.get(commandId) ?? [];
    if (waiting.length === 0) return;
    pendingCommandReports.delete(commandId);
    for (const report of waiting) await applyCommandReport(report);
  };

  const handleProps = async (payload: unknown) => {
    const items = Array.isArray(payload) ? payload : [payload];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as { entityType?: string; entity?: unknown };
      const entityType = item.entityType?.toLowerCase();
      if (!item.entity || typeof item.entity !== 'object') continue;
      if (entityType === 'contract') {
        const contract = item.entity as TradovateContractEntity;
        if (contract.id != null && contract.name) contracts.set(contract.id, contract.name);
      } else if (entityType === 'command') {
        const command = item.entity as TradovateCommandEntity;
        commands.set(command.id, command);
        const correlationTag = commandCorrelationTag(command);
        if (command.orderId != null && command.commandType === 'New' && correlationTag) {
          orderTags.set(command.orderId, correlationTag);
          const order = await composeOrder(command.orderId);
          if (order) emit({ type: 'order', order });
        }
        await flushCommandReports(command.id);
      } else if (entityType === 'commandreport') {
        await applyCommandReport(item.entity as TradovateCommandReportEntity);
      } else if (entityType === 'executionreport') {
        const report = item.entity as TradovateExecutionReportEntity;
        rawOrders.set(report.orderId, {
          id: report.orderId,
          accountId: report.accountId,
          contractId: report.contractId,
          action: report.action,
          ordStatus: report.ordStatus,
          ocoId: report.ocoId,
          parentId: report.parentId,
          linkedId: report.linkedId,
          timestamp: report.timestamp,
        });
        if (report.ordStatus === 'Rejected') {
          orderRejectReasons.set(
            report.orderId,
            report.text?.trim() || report.rejectReason || 'Tradovate execution rejected',
          );
        }
        await hydrateOrderVersion(report.orderId);
        const order = await composeOrder(report.orderId);
        if (order) emit({ type: 'order', order });
      } else if (entityType === 'orderversion') {
        const version = item.entity as TradovateOrderVersionEntity;
        rememberVersion(version);
        const order = await composeOrder(version.orderId);
        if (order) emit({ type: 'order', order });
        await flushPendingFills(version.orderId);
      } else if (entityType === 'order') {
        const orderEntity = item.entity as TradovateRawOrderEntity;
        rawOrders.set(orderEntity.id, orderEntity);
        await hydrateOrderVersion(orderEntity.id);
        const order = await composeOrder(orderEntity.id);
        if (order) emit({ type: 'order', order });
        await flushPendingFills(orderEntity.id);
      } else if (entityType === 'position') {
        const position = item.entity as TradovatePositionEntity;
        await hydrateContracts([position.contractId]);
        emit({ type: 'position', position: {
          accountId: position.accountId,
          symbol: contracts.get(position.contractId) as string,
          netQuantity: position.netPos,
        } });
      } else if (entityType === 'fill') {
        const fill = item.entity as TradovateFillEntity;
        if (!rememberFill(fill)) continue;
        await emitMappedFill(fill);
        const updated = await composeOrder(fill.orderId);
        if (updated) emit({ type: 'order', order: updated });
      }
    }
  };

  const handleMessageObject = async (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const value = message as { e?: string; d?: unknown; i?: number; s?: number };
    if (value.s === 423 || value.s === 429) {
      const error = new TradovateRateLimitError(
        `Tradovate WebSocket rate limited (${value.s})`,
        value.s === 429 ? 60 * 60 * 1_000 : null,
        value.s === 429,
        undefined,
        value.s,
      );
      armRateLimitBreaker(error);
      throw error;
    }
    if (value.d && typeof value.d === 'object' && !Array.isArray(value.d)) {
      const penalty = value.d as {
        'p-ticket'?: string; 'p-time'?: number; 'p-captcha'?: boolean; 'p-message'?: string;
      };
      if (penalty['p-ticket']) {
        if (value.i === 1 && penalty['p-captcha'] !== true) {
          if (syncTimeout) clearTimeouts(syncTimeout);
          syncTimeout = null;
          if (!syncRetry) {
            const delay = Number.isFinite(penalty['p-time'])
              ? Math.max(0, penalty['p-time'] as number) * 1_000
              : 1_000;
            syncRetry = timeouts(() => {
              syncRetry = null;
              try {
                sendSocketRequest('user/syncrequest', {
                  ...syncRequestBody,
                  'p-ticket': penalty['p-ticket'],
                }, 1);
                syncTimeout = timeouts(() => {
                  const candidate = socket;
                  if (candidate) closeSocket(candidate, 'sync-retry-timeout');
                }, config.syncTimeoutMs ?? 5_000);
              } catch (reason) {
                emitOrHoldError(contextualError(reason, 'websocket'));
                const candidate = socket;
                if (candidate) closeSocket(candidate, 'sync-retry-error');
                else scheduleReconnect('sync-retry-error');
              }
            }, delay);
          }
          return;
        }
        throw new TradovateRateLimitError(
          penalty['p-message'] ?? 'Tradovate WebSocket returned a penalty ticket',
          Number.isFinite(penalty['p-time']) ? (penalty['p-time'] as number) * 1_000 : null,
          penalty['p-captcha'] === true,
          penalty['p-ticket'],
        );
      }
    }
    if (value.e === 'props') {
      await handleProps(value.d);
      return;
    }
    if (value.i === 0) {
      if (value.s !== 200) throw new TradovateTransportError('WebSocket authorization failed');
      socketState = 'syncing';
      sendSocketRequest('user/syncrequest', syncRequestBody, 1);
      return;
    }
    if (value.i === 1) {
      if (value.s !== 200) throw new TradovateTransportError('WebSocket synchronization failed');
      if (Array.isArray(value.d)) await handleProps(value.d);
      if (!syncReady) {
        const baseline = await loadOrderGraph();
        for (const raw of baseline) {
          const order = await composeOrder(raw.id);
          if (order) emit({ type: 'order', order });
        }
        if (syncTimeout) clearTimeouts(syncTimeout);
        syncTimeout = null;
        if (syncRetry) clearTimeouts(syncRetry);
        syncRetry = null;
        syncReady = true;
        socketState = 'connected';
        reconnectFailures = 0;
        stopDisconnectedLog();
        // Dokončená plánovaná obměna: controller výpadek nikdy neviděl,
        // redundantní `connected: true` je neškodné a srovná heartbeat.
        const wasRenewal = renewalInProgress;
        if (renewalInProgress) finishRenewal();
        emit({ type: 'connection', connected: true, at: clock(), ...(wasRenewal ? { resynced: true } : {}) });
      }
      return;
    }
    if (Array.isArray(value.d)) {
      for (const item of value.d) await handleMessageObject(item);
    }
  };

  const handleSocketData = async (raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0) return;
    lastSocketMessageAt = clock();
    emit({ type: 'heartbeat', at: lastSocketMessageAt });
    if (raw === 'o') {
      socketState = 'authorizing';
      socket?.send(`authorize\n0\n\n${await token()}`);
      return;
    }
    if (raw[0] === 'h') {
      socket?.send('[]');
      return;
    }
    if (raw[0] !== 'a') return;
    const messages = JSON.parse(raw.slice(1)) as unknown[];
    for (const message of messages) await handleMessageObject(message);
  };

  const clearSocketTimers = () => {
    if (connectWatchdog) clearTimeouts(connectWatchdog);
    connectWatchdog = null;
    if (closeWatchdog) clearTimeouts(closeWatchdog);
    closeWatchdog = null;
    closeDeadlineAt = 0;
    if (syncTimeout) clearTimeouts(syncTimeout);
    syncTimeout = null;
    if (syncRetry) clearTimeouts(syncRetry);
    syncRetry = null;
    if (heartbeat) clearIntervals(heartbeat);
    heartbeat = null;
  };

  const stopDisconnectedLog = () => {
    if (disconnectedLog) clearIntervals(disconnectedLog);
    disconnectedLog = null;
    disconnectedSince = 0;
  };

  const startDisconnectedLog = () => {
    if (!disconnectedSince) disconnectedSince = clock();
    if (disconnectedLog || listeners.size === 0) return;
    const intervalMs = Math.min(60_000, Math.max(1_000, config.disconnectedLogIntervalMs ?? 60_000));
    disconnectedLog = intervals(() => {
      if (listeners.size === 0 || socketState === 'connected') return;
      const now = clock();
      diagnostic([
        'WS DISCONNECTED',
        `state=${socketState}`,
        `attempt=${reconnectFailures + 1}`,
        `lastReason=${lastReconnectReason}`,
        `nextAttemptIn=${Math.max(0, Math.ceil((reconnectAt - now) / 1_000))}s`,
        `disconnectedFor=${Math.max(0, Math.floor((now - disconnectedSince) / 1_000))}s`,
      ].join(' '));
    }, intervalMs);
  };

  const reconnectDelay = (minimumDelayMs: number): number => {
    const base = Math.max(1, config.reconnectDelayMs ?? 1_000);
    const cap = Math.max(base, config.reconnectMaxDelayMs ?? 60_000);
    const exponential = Math.min(cap, base * (2 ** Math.min(reconnectFailures - 1, 30)));
    const ratio = Math.min(1, Math.max(0, config.reconnectJitterRatio ?? 0.2));
    const random = Math.min(1, Math.max(0, (config.random ?? Math.random)()));
    const jittered = Math.round(exponential * (1 - ratio + (2 * ratio * random)));
    return Math.max(minimumDelayMs, Math.min(cap, Math.max(1, jittered)));
  };

  const scheduleReconnect = (reason: string, minimumDelayMs = 0) => {
    lastReconnectReason = reason;
    startDisconnectedLog();
    if (listeners.size === 0) return;
    if (reconnect) {
      const minimumAt = clock() + minimumDelayMs;
      if (minimumAt <= reconnectAt) return;
      clearTimeouts(reconnect);
      reconnect = null;
      reconnectAt = 0;
    } else {
      reconnectFailures += 1;
    }
    const delay = reconnectDelay(minimumDelayMs);
    reconnectAt = clock() + delay;
    if (!socket || socketState === 'waiting' || socketState === 'idle') socketState = 'waiting';
    diagnostic(
      `WS RECONNECT attempt=${reconnectFailures + 1} reason=${reason} nextAttemptIn=${(delay / 1_000).toFixed(3)}s`,
    );
    const run = () => {
      reconnect = null;
      reconnectAt = 0;
      if (listeners.size === 0) return;
      if (socket) {
        const waitForClose = Math.max(1, closeDeadlineAt - clock());
        reconnectAt = clock() + waitForClose;
        reconnect = timeouts(run, waitForClose);
        return;
      }
      ensureSocket(lastReconnectReason);
    };
    reconnect = timeouts(run, delay);
  };

  const releaseSocket = (candidate: WebSocketLike) => {
    if (socket !== candidate) return false;
    candidate.onopen = null;
    candidate.onmessage = null;
    candidate.onerror = null;
    candidate.onclose = null;
    socket = null;
    socketState = 'idle';
    syncReady = false;
    clearSocketTimers();
    return true;
  };

  const closeSocket = (candidate: WebSocketLike, reason: string, minimumDelayMs = 0) => {
    if (socket !== candidate) return;
    socketState = 'closing';
    if (connectWatchdog) clearTimeouts(connectWatchdog);
    connectWatchdog = null;
    if (syncTimeout) clearTimeouts(syncTimeout);
    syncTimeout = null;
    if (syncRetry) clearTimeouts(syncRetry);
    syncRetry = null;
    if (heartbeat) clearIntervals(heartbeat);
    heartbeat = null;
    scheduleReconnect(reason, minimumDelayMs);
    try {
      candidate.close();
    } catch (closeReason) {
      emitOrHoldError(contextualError(closeReason, 'websocket'));
      if (releaseSocket(candidate)) scheduleReconnect(`${reason}:close-throw`, minimumDelayMs);
      return;
    }
    if (socket !== candidate) return;
    const closeTimeoutMs = Math.max(1, config.closeTimeoutMs ?? 5_000);
    closeDeadlineAt = clock() + closeTimeoutMs;
    closeWatchdog = timeouts(() => {
      closeWatchdog = null;
      closeDeadlineAt = 0;
      if (socket !== candidate) return;
      diagnostic(`WS CLOSE WATCHDOG state=${socketState} reason=${reason}`);
      releaseSocket(candidate);
      scheduleReconnect(`${reason}:close-watchdog`, minimumDelayMs);
    }, closeTimeoutMs);
  };

  function ensureSocket(reason = 'subscribe') {
    if (socket || listeners.size === 0) return;
    const factory = config.webSocketFactory ?? ((url: string) => {
      if (typeof WebSocket === 'undefined') throw new TradovateTransportError('WebSocket is unavailable');
      return new WebSocket(url) as unknown as WebSocketLike;
    });
    socketState = 'connecting';
    diagnostic(`WS CONNECT attempt=${reconnectFailures + 1} reason=${reason}`);
    let candidate: WebSocketLike;
    try {
      candidate = factory(hosts.websocket);
    } catch (factoryReason) {
      emitOrHoldError(contextualError(factoryReason, 'websocket'));
      if (!renewalInProgress) emit({ type: 'connection', connected: false, at: clock() });
      socketState = 'idle';
      scheduleReconnect('factory-throw');
      return;
    }
    socket = candidate;
    syncReady = false;
    socketMessageTail = Promise.resolve();
    connectWatchdog = timeouts(() => {
      connectWatchdog = null;
      if (socket !== candidate || candidate.readyState === 1) return;
      emitOrHoldError(contextualError(
        new TradovateTransportError('Tradovate WebSocket connect timeout'),
        'websocket',
      ));
      if (!renewalInProgress) emit({ type: 'connection', connected: false, at: clock() });
      closeSocket(candidate, 'connect-watchdog');
    }, Math.max(1, config.connectTimeoutMs ?? 10_000));
    candidate.onopen = () => {
      if (socket !== candidate) return;
      if (connectWatchdog) clearTimeouts(connectWatchdog);
      connectWatchdog = null;
      socketState = 'authorizing';
      lastSocketMessageAt = clock();
      lastHeartbeatSentAt = 0;
      syncTimeout = timeouts(() => {
        if (socket !== candidate) return;
        emitOrHoldError(contextualError(
          new TradovateTransportError('Tradovate WebSocket sync timeout'),
          'websocket',
        ));
        closeSocket(candidate, 'sync-timeout');
      }, config.syncTimeoutMs ?? 5_000);
    };
    candidate.onmessage = event => {
      if (socket !== candidate) return;
      socketMessageTail = socketMessageTail
        .then(() => handleSocketData(event.data))
        .catch(reason => {
          if (socket !== candidate) return;
          const error = contextualError(reason, 'websocket');
          let minimumDelayMs = 0;
          if (error instanceof TradovateRateLimitError) {
            minimumDelayMs = error.captchaRequired
              ? 60 * 60 * 1_000
              : Math.max(error.retryAfterMs ?? 0, config.reconnectDelayMs ?? 1_000);
          }
          emitOrHoldError(error);
          closeSocket(candidate, 'socket-message-error', minimumDelayMs);
        });
    };
    candidate.onerror = () => {
      if (socket !== candidate) return;
      emitOrHoldError(contextualError(
        new TradovateTransportError(withConnectionLabel('Tradovate WebSocket transport error')),
        'websocket',
      ));
      if (!renewalInProgress) emit({ type: 'connection', connected: false, at: clock() });
      closeSocket(candidate, 'socket-error');
    };
    candidate.onclose = () => {
      if (socket !== candidate) return;
      if (!renewalInProgress) emit({ type: 'connection', connected: false, at: clock() });
      releaseSocket(candidate);
      scheduleReconnect(renewalInProgress ? 'planned-renewal' : 'socket-close');
    };
    heartbeat = intervals(() => {
      if (socket !== candidate || candidate.readyState !== 1) return;
      const now = clock();
      if (now - lastSocketMessageAt >= (config.socketIdleTimeoutMs ?? 15_000)) {
        emit({
          type: 'error',
          error: contextualError(
            new TradovateTransportError(withConnectionLabel('Tradovate WebSocket heartbeat timeout')),
            'websocket',
          ),
          at: now,
        });
        closeSocket(candidate, 'heartbeat-timeout');
        return;
      }
      if (
        now - lastSocketMessageAt >= TRADOVATE_HEARTBEAT_MS
        && now - lastHeartbeatSentAt >= TRADOVATE_HEARTBEAT_MS
      ) {
        try {
          candidate.send('[]');
          lastHeartbeatSentAt = now;
        } catch (reason) {
          emitOrHoldError(contextualError(reason, 'websocket'));
          if (!renewalInProgress) emit({ type: 'connection', connected: false, at: clock() });
          closeSocket(candidate, 'heartbeat-send-error');
        }
      }
    }, 500);
  }

  return {
    environment: config.environment,
    async refreshAccountDirectory(): Promise<TradovateVisibleAccount[]> {
      const entities = await listAccountEntities();
      return (entities ?? []).filter(item => Number.isSafeInteger(item.id) && item.id > 0).map(item => {
        const freshName = item.name?.trim();
        if (freshName) accountSpecsByAccountId.set(item.id, freshName);
        return {
          accountId: item.id,
          accountSpec: accountSpecsByAccountId.get(item.id) ?? null,
          active: item.active === true,
          canTrade: item.active === true && item.readonly !== true,
        };
      });
    },
    async placeOrder(requestBody: BrokerOrderRequest): Promise<BrokerOrderAck> {
      const result = await post<TradovatePlaceOrderResult>(
        '/order/placeorder',
        toPlaceOrderPayload(requestBody, accountSpecFor(requestBody.accountId)),
      );
      return fromPlaceOrderResult(result ?? {});
    },
    async liquidatePosition(requestBody) {
      // ContractId vybíráme z čerstvé brokerové Position entity, ne ze stale
      // lokální quantity. Pokud je účet už flat, jde o úspěšný stavový no-op
      // a žádný opačný Market se nesmí vytvořit.
      const entities = await listPositionEntities();
      const accountPositions = (entities ?? []).filter(item => (
        item.accountId === requestBody.accountId && item.netPos !== 0
      ));
      await hydrateContracts(accountPositions.map(item => item.contractId));
      const position = accountPositions.find(item => contracts.get(item.contractId) === requestBody.symbol);
      if (!position) {
        return { status: 'already-flat' as const };
      }
      try {
        const result = await post<TradovatePlaceOrderResult>('/order/liquidateposition', {
          accountId: requestBody.accountId,
          contractId: position.contractId,
          admin: false,
          isAutomated: true,
        });
        return fromLiquidatePositionResult(result);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (
          reason instanceof TradovateTransportError
          && reason.status != null
          && reason.status >= 400
          && reason.status < 500
        ) {
          return { status: 'rejected' as const, reason: message };
        }
        return {
          status: 'indeterminate' as const,
          reason: message,
        };
      }
    },
    async placeOco(requestBody: BrokerOcoRequest) {
      const result = await post<TradovatePlaceOcoResult>(
        '/order/placeoco',
        toPlaceOcoPayload(requestBody, accountSpecFor(requestBody.accountId)),
      );
      return fromPlaceOcoResult(result ?? {});
    },
    async placeOso(requestBody: BrokerOsoRequest) {
      const result = await post<TradovatePlaceOsoResult>(
        '/order/placeoso',
        toPlaceOsoPayload(requestBody, accountSpecFor(requestBody.accountId)),
      );
      return fromPlaceOsoResult(result ?? {});
    },
    async cancelOrder(_accountId, brokerOrderId) {
      const orderId = numberId(brokerOrderId);
      const result = await post<TradovateCommandResult>('/order/cancelorder', {
        orderId,
        isAutomated: true,
      });
      const commandId = assertCommandAccepted(result, 'cancelOrder');
      const confirmed = await waitForOrder(orderId, order =>
        order.status === 'canceled' || order.status === 'filled' || order.status === 'rejected');
      if (syncReady && !confirmed) {
        const rejection = await commandRejection(commandId);
        if (rejection) throw new TradovateTransportError(`cancelOrder command ${commandId} rejected: ${rejection}`);
        throw new TradovateTransportError(`cancelOrder command ${commandId} was not confirmed by the order stream`);
      }
    },
    async modifyOrder(_accountId, brokerOrderId, changes) {
      const orderId = numberId(brokerOrderId);
      const result = await post<TradovateCommandResult>('/order/modifyorder', {
        orderId,
        orderQty: changes.quantity,
        orderType: changes.orderType,
        ...(changes.limitPrice != null ? { price: changes.limitPrice } : {}),
        ...(changes.stopPrice != null ? { stopPrice: changes.stopPrice } : {}),
        isAutomated: true,
      });
      const commandId = assertCommandAccepted(result, 'modifyOrder');
      const confirmed = await waitForOrder(orderId, order =>
        isOpenOrderStatus(order.status)
        && order.quantity === changes.quantity
        && order.orderType === changes.orderType
        && order.limitPrice === changes.limitPrice
        && order.stopPrice === changes.stopPrice);
      if (syncReady && !confirmed) {
        const rejection = await commandRejection(commandId);
        if (rejection) throw new TradovateTransportError(`modifyOrder command ${commandId} rejected: ${rejection}`);
        throw new TradovateTransportError(`modifyOrder command ${commandId} was not confirmed by the order stream`);
      }
    },
    async listAccountCapabilities(accountIds): Promise<BrokerAccountCapability[]> {
      const entities = await listAccountEntities();
      const selected = new Set(accountIds);
      return (entities ?? []).filter(item => selected.has(item.id)).map(item => ({
        accountId: item.id,
        active: item.active === true,
        canTrade: item.active === true && item.readonly !== true,
      }));
    },
    async listPositions(accountId): Promise<BrokerPosition[]> {
      const entities = await listPositionEntities();
      const selected = (entities ?? []).filter(item => item.accountId === accountId);
      await hydrateContracts(selected.map(item => item.contractId));
      return selected.map(item => ({
        accountId: item.accountId,
        symbol: contracts.get(item.contractId) as string,
        netQuantity: item.netPos,
      }));
    },
    async listOrders(accountId): Promise<BrokerOrder[]> {
      const rawList = await loadOrderGraph();
      const selected = rawList.filter(item => item.accountId === accountId);
      return (await Promise.all(selected.map(item => composeOrder(item.id))))
        .filter((order): order is BrokerOrder => order != null);
    },
    async findOrdersByTag(accountId, tag) {
      const rawList = await loadOrderGraph();
      const matched = rawList.filter(item => item.accountId === accountId && orderTags.get(item.id) === tag);
      const mapped = (await Promise.all(matched.map(item => composeOrder(item.id))))
        .filter((order): order is BrokerOrder => order != null);
      // Tradovate archivuje order data po konci seance. Nález je použitelný,
      // ale prázdný current-session list nikdy není důkaz, že starší timeout
      // nebyl přijat — proto nesmí automaticky povolit resend.
      return { orders: mapped, completeness: 'eventual', observedAt: clock() };
    },
    async findOrderById(accountId, brokerOrderId) {
      const orderId = numberId(brokerOrderId);
      // Po vypršení čekání na sync stream nesmíme vrátit starý cache
      // snapshot jako autoritativní. To je zvlášť důležité u nativního OSO,
      // kde Tradovate nemusí doručit nový OrderVersion ve stejném okně jako
      // command ACK. Vždy proto obnovíme Order + nejnovější OrderVersion z
      // REST grafu; prázdný nebo neúplný výsledek zůstává fail-closed.
      const rawList = await loadOrderGraph(orderId);
      const raw = rawList[0];
      if (!raw || raw.accountId !== accountId) {
        return { order: null, completeness: 'authoritative', observedAt: clock() };
      }
      const order = await composeOrder(orderId);
      if (!order) throw new TradovateTransportError(`Missing OrderVersion for order ${orderId}`);
      return { order, completeness: 'authoritative', observedAt: clock() };
    },
    renewSocket() {
      if (!socket || !syncReady || renewalInProgress || listeners.size === 0) return false;
      renewalInProgress = true;
      renewalHeldEvents = [];
      renewalDeadline = timeouts(() => {
        // Obnova se nestihla — přiznej zadržené chyby a výpadek poctivě.
        renewalDeadline = null;
        renewalInProgress = false;
        const held = renewalHeldEvents;
        renewalHeldEvents = [];
        for (const heldEvent of held) emit(heldEvent);
        emit({
          type: 'error',
          error: contextualError(
            new TradovateTransportError(withConnectionLabel('Tradovate WebSocket renewal timeout')),
            'websocket',
          ),
          at: clock(),
        });
        // Flag už je shozený, takže disconnect ohlásí onclose; bez živého
        // socketu (mezera mezi close a reconnectem) ho ohlásíme sami.
        const candidate = socket;
        if (candidate && candidate.readyState !== 3) closeSocket(candidate, 'renewal-deadline');
        else {
          emit({ type: 'connection', connected: false, at: clock() });
          scheduleReconnect('renewal-deadline');
        }
      }, config.renewalDeadlineMs ?? 15_000);
      closeSocket(socket, 'planned-renewal');
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      ensureSocket();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          if (reconnect) clearTimeouts(reconnect);
          reconnect = null;
          reconnectAt = 0;
          reconnectFailures = 0;
          stopDisconnectedLog();
          if (renewalInProgress) finishRenewal();
          orderWaiters.clear();
          const candidate = socket;
          if (candidate) {
            releaseSocket(candidate);
            try {
              candidate.close();
            } catch {
              // Poslední listener už neexistuje; žádný reconnect se neplánuje.
            }
          } else {
            clearSocketTimers();
          }
          socketState = 'idle';
        }
      };
    },
  };
}

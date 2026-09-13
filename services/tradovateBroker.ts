import { createJournalBackfillPlan, validateJournalBackfillScope } from '../lib/journalBackfillPlan';
import { positionSnapshotObservations } from '../lib/journalPositionSnapshot';
import { createJournalAccountingBackfill, JOURNAL_ACCOUNTING_MAX_BYTES, readJournalResponseText, waitJournalReceipt } from '../lib/journalAccountingBackfill';
import { visitJournalSocketEvidence, JOURNAL_SOCKET_ENTITY_TYPES } from '../lib/journalSocketEvidence';
import { journalObservation, type JournalObservation } from '../lib/tradovateJournalEvidence';
import type {
  BrokerEnvironment,
  BrokerEvent,
  BrokerFill,
  BrokerAccountCapability,
  BrokerAccountRiskSnapshot,
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
interface TradovateCashBalanceEntity {
  accountId?: number;
  /** Některé transportní vrstvy mohou propustit bohatší cash snapshot. */
  netLiq?: number;
  realizedPnL?: number;
}
interface TradovateAccountRiskStatusEntity {
  accountId?: number;
  maxNetLiq?: number;
  minNetLiq?: number;
}
interface TradovateUserAccountAutoLiqEntity {
  accountId?: number;
  dailyLossAutoLiq?: number;
  trailingMaxDrawdown?: number;
}
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

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// Prop/evaluation providers use very large sentinels for a disabled limit.
// Keep this aligned with server/tradovateAccountData.ts.
const activeRiskThreshold = (value: unknown): number | null => {
  const parsed = finiteNumber(value);
  return parsed != null && Math.abs(parsed) < 100_000_000 ? parsed : null;
};

const firstAccountDependent = <T extends { accountId?: number }>(
  value: T[] | null,
  accountId: number,
): T | null => {
  if (!Array.isArray(value)) return null;
  const exact = value.find(item => item != null && item.accountId === accountId);
  return exact ?? value.find(item => item != null && item.accountId == null) ?? null;
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
  /** Passive observer; does not start/retain execution. Optional false/async false
   * reports failed persistence; accounting backfill awaits async receipts. */
  subscribeEvidence(listener: (event: JournalObservation) => unknown): () => void;
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
  const evidenceListeners = new Set<(event: JournalObservation) => unknown>();
  const journalAccounting = createJournalAccountingBackfill();
  const journalBackfillPlan = createJournalBackfillPlan();
  let journalRoster: number[] = [];
  const observe = (type: string, entity: unknown, source: JournalObservation['source'], eventType = 'Observed', receivedAt = clock()) => {
    if (evidenceListeners.size === 0) return Promise.resolve(false);
    const evidence = journalObservation(type, entity, source, eventType, receivedAt);
    if (!evidence) return Promise.resolve(false);
    journalAccounting.remember(evidence);
    Object.freeze(evidence.entity);
    Object.freeze(evidence);
    const receipts: Promise<boolean>[] = [];
    for (const listener of evidenceListeners) {
      // Analytics errors never enter the controller's fail-closed event queue.
      try { receipts.push(Promise.resolve(listener(evidence)).then(value => value !== false, () => false)); }
      catch { receipts.push(Promise.resolve(false)); }
    }
    // Delivery stays synchronous for stream events. Only background backfill
    // awaits durable recorder receipts; execution never waits on disk writes.
    return Promise.all(receipts).then(results => {
      const accepted = results.every(Boolean);
      if (!accepted) journalAccounting.reset();
      return accepted;
    });
  };
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
  let journalSnapshotBusy = false;
  let journalSnapshotAbort: AbortController | null = null;
  let journalSnapshotTimer: ReturnType<typeof setInterval> | null = null;
  const syncRequestBody = {
    splitResponses: true,
    entityTypes: [...JOURNAL_SOCKET_ENTITY_TYPES],
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

  const requestRaw = async <T>(path: string, init: RequestInit = {}, allowNotFound = false, maxResponseBytes?: number): Promise<T | null> => {
    if (!fetchImpl) throw new TradovateTransportError('fetch is unavailable');
    assertNotRateLimited();
    const accessToken = await token();
    init.signal?.throwIfAborted();
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
    if (response.status === 423 || response.status === 429) {
      const error = new TradovateRateLimitError(
        `Tradovate ${path} rate limited (${response.status})`,
        response.status === 429 ? 60 * 60 * 1_000 : null,
        response.status === 429,
        undefined,
        response.status,
      );
      armRateLimitBreaker(error);
      void response.body?.cancel().catch(() => {});
      throw error;
    }
    const text = maxResponseBytes == null ? await response.text() : await readJournalResponseText(response, maxResponseBytes);
    if (!response.ok) {
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
      const result = await requestRaw<T>(path, init, allowNotFound);
      if (!init.method || init.method === 'GET') {
        const type = path.split('/')[1];
        for (const row of Array.isArray(result) ? result : result ? [result] : []) observe(type, row, 'snapshot');
      }
      return result;
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

  const captureJournalPositions = async () => {
    const candidate = socket;
    if (journalSnapshotBusy || !candidate || !syncReady || socketState !== 'connected' || !evidenceListeners.size) return;
    journalSnapshotBusy = true;
    const startedAt = clock();
    const snapshotId = crypto.randomUUID();
    const abort = new AbortController();
    journalSnapshotAbort = abort;
    const timeout = timeouts(() => abort.abort(), 20_000);
    const current = () => socket === candidate && socketState === 'connected' && syncReady && evidenceListeners.size > 0 && !abort.signal.aborted;
    try {
      try {
        // Dedicated fresh GETs: joining an older in-flight request would invalidate
        // this witness's startedAt. Analytics never updates execution caches.
        const roster = await requestRaw<unknown>('/account/list', { signal: abort.signal });
        if (!current()) return;
        if (Array.isArray(roster) && roster.length <= 10000 && roster.every(row => row && Number.isSafeInteger(row.id) && row.id > 0)) journalRoster = [...new Set(roster.map(row => row.id))];
        const positions = await requestRaw<unknown>('/position/list', { signal: abort.signal });
        if (!current()) return;
        const completedAt = clock();
        for (const event of positionSnapshotObservations(snapshotId, roster, positions, startedAt, completedAt)) {
          observe(event.entityType, event.entity, event.source, event.eventType, completedAt);
        }
      } catch (error) {
        if (socket === candidate && evidenceListeners.size) observe('positionsnapshot', {
          id: `${snapshotId}:failed`, snapshotId, kind: 'failed', startedAt, completedAt: clock(), reason: 'snapshot-unavailable',
        }, 'snapshot');
        if (error instanceof TradovateRateLimitError) return;
      }
      // One bounded pass across available source lists, then exact known-parent
      // batches for oversized sources. No per-account socket or execution cache.
      for (const type of journalBackfillPlan.cycle()) {
        if (!current()) return;
        const read = journalBackfillPlan.next(type, parent => parent === 'account'
          ? [...journalRoster, ...journalAccounting.references(parent)] : journalAccounting.references(parent));
        const readStartedAt = clock();
        const revision = journalAccounting.begin();
        try {
          if (!read.path) throw new Error('journal-backfill-no-known-parents');
          const rows = await requestRaw<unknown>(read.path, { signal: abort.signal }, false, JOURNAL_ACCOUNTING_MAX_BYTES);
          if (!current()) return;
          validateJournalBackfillScope(read, rows);
          const result = journalAccounting.select(read.type, rows, revision, clock());
          let recorded = 0; let contended = result.contended;
          for (const event of result.observations) {
            if (!current()) return;
            // The stream can also change while earlier rows wait for disk.
            const fresh = journalAccounting.select(read.type, [event.entity], revision, event.receivedAt);
            contended += fresh.contended;
            if (!fresh.observations.length) continue;
            const accepted = await waitJournalReceipt(observe(event.entityType, event.entity, event.source, event.eventType, event.receivedAt), abort.signal);
            if (!accepted) throw new Error('journal-backfill-recorder-unavailable');
            recorded++;
          }
          if (!current()) return;
          observe('journalbackfill', { id: `${snapshotId}:${read.type}`, entityType: read.type, kind: 'observed',
            startedAt: readStartedAt, completedAt: clock(), scope: read.scope, requested: read.ids?.length ?? null, remaining: read.remaining ?? null, scanned: result.scanned,
            recorded, contended }, 'snapshot');
        } catch (error) {
          if (error instanceof Error && error.message === 'journal-backfill-response-too-large') journalBackfillPlan.useScoped(read.type);
          // A timed-out receipt is not a durable ACK. Retry its facts next pass.
          if (abort.signal.aborted) journalAccounting.reset();
          if (socket !== candidate || socketState !== 'connected' || !evidenceListeners.size) return;
          observe('journalbackfill', { id: `${snapshotId}:${read.type}`, entityType: read.type, kind: 'unavailable',
            startedAt: readStartedAt, completedAt: clock(), scope: read.scope, requested: read.ids?.length ?? null, remaining: read.remaining ?? null, reason: abort.signal.aborted ? 'history-read-timeout'
              : error instanceof Error && ['journal-backfill-invalid-list', 'journal-backfill-response-too-large', 'journal-backfill-recorder-unavailable', 'journal-backfill-no-known-parents'].includes(error.message)
                ? error.message : 'history-read-unavailable' }, 'snapshot');
          if (abort.signal.aborted || error instanceof TradovateRateLimitError) break;
        }
      }
    } finally {
      clearTimeouts(timeout);
      journalSnapshotBusy = false;
      if (journalSnapshotAbort === abort) journalSnapshotAbort = null;
      if (socket !== candidate && syncReady && evidenceListeners.size) void captureJournalPositions();
    }
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
      const item = raw as { entityType?: string; entity?: unknown; eventType?: string };
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
      } else if (entityType === 'order') {
        const orderEntity = item.entity as TradovateRawOrderEntity;
        // A new Order and its initial shape can arrive together before REST knows
        // the order. Preserve that correlation without letting standalone requested
        // versions replace an already populated execution order. Journal protection
        // confirmation remains separate and requires its own execution evidence.
        if (!rawOrders.has(orderEntity.id) && !orderVersions.has(orderEntity.id)) {
          for (const candidate of items) {
            if (!candidate || typeof candidate !== 'object') continue;
            const sibling = candidate as { entityType?: string; entity?: TradovateOrderVersionEntity };
            if (sibling.entityType?.toLowerCase() === 'orderversion'
              && sibling.entity?.orderId === orderEntity.id) rememberVersion(sibling.entity);
          }
        }
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

  const handleMessageObject = async (message: unknown, isCurrent: () => boolean) => {
    if (!isCurrent()) return;
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
        if (!isCurrent()) return;
        for (const raw of baseline) {
          const order = await composeOrder(raw.id);
          if (order) emit({ type: 'order', order });
        }
        if (!isCurrent()) return;
        if (syncTimeout) clearTimeouts(syncTimeout);
        syncTimeout = null;
        if (syncRetry) clearTimeouts(syncRetry);
        syncRetry = null;
        syncReady = true;
        socketState = 'connected';
        observe('connection', { state: 'synced' }, 'transport');
        reconnectFailures = 0;
        stopDisconnectedLog();
        // Dokončená plánovaná obměna: controller výpadek nikdy neviděl,
        // redundantní `connected: true` je neškodné a srovná heartbeat.
        const wasRenewal = renewalInProgress;
        if (renewalInProgress) finishRenewal();
        emit({ type: 'connection', connected: true, at: clock(), ...(wasRenewal ? { resynced: true } : {}) });
        void captureJournalPositions();
      }
      return;
    }
    if (Array.isArray(value.d)) {
      for (const item of value.d) await handleMessageObject(item, isCurrent);
    }
  };

  const handleSocketData = async (raw: unknown, messages: readonly unknown[], isCurrent: () => boolean) => {
    if (!isCurrent()) return;
    if (typeof raw !== 'string' || raw.length === 0) return;
    lastSocketMessageAt = clock();
    emit({ type: 'heartbeat', at: lastSocketMessageAt });
    if (raw === 'o') {
      socketState = 'authorizing';
      const accessToken = await token();
      if (isCurrent()) socket?.send(`authorize\n0\n\n${accessToken}`);
      return;
    }
    if (raw[0] === 'h') {
      socket?.send('[]');
      return;
    }
    if (raw[0] !== 'a') return;
    for (const message of messages) await handleMessageObject(message, isCurrent);
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
    journalSnapshotAbort?.abort();
    journalAccounting.reset();
    journalBackfillPlan.reset(); journalRoster = [];
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
    observe('connection', { state: 'disconnected', reason }, 'transport');
    socketState = 'closing';
    journalSnapshotAbort?.abort();
    journalAccounting.reset();
    journalBackfillPlan.reset(); journalRoster = [];
    // A dead transport may never deliver onclose (e.g. after Mac sleep).
    // Invalidate the router's connection state now so a later successful
    // sync is not suppressed as a duplicate connected=true notification.
    if (!renewalInProgress) emit({ type: 'connection', connected: false, at: clock() });
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
      observe('connection', { state: 'disconnected', reason: 'socket-close' }, 'transport');
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
      if (socket !== candidate || socketState === 'closing') return;
      const receivedAt = clock();
      let messages: unknown[] = [];
      let parseError: unknown;
      try {
        if (typeof event.data === 'string' && event.data[0] === 'a') {
          const parsed: unknown = JSON.parse(event.data.slice(1));
          if (!Array.isArray(parsed)) throw new TradovateTransportError('Invalid WebSocket frame');
          messages = parsed;
          // Capture before metadata/REST awaits. Analytics-only orderVersion events
          // must never update execution caches or emit a requested price as confirmed.
          if (evidenceListeners.size) {
            for (const message of messages) visitJournalSocketEvidence(message,
              (type, entity, source, eventType) => observe(type, entity, source, eventType, receivedAt));
          }
        }
      } catch (reason) { parseError = reason; }
      socketMessageTail = socketMessageTail
        .then(() => {
          if (socket !== candidate) return;
          if (parseError) throw parseError;
          return handleSocketData(event.data, messages, () => socket === candidate && socketState !== 'closing');
        })
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
      // closeSocket already reports an intentional close immediately;
      // unsolicited remote closes still need their own disconnect event.
      if (!renewalInProgress && socketState !== 'closing') {
        emit({ type: 'connection', connected: false, at: clock() });
      }
      observe('connection', { state: 'disconnected', reason: 'socket-close' }, 'transport');
      releaseSocket(candidate);
      scheduleReconnect(renewalInProgress ? 'planned-renewal' : 'socket-close');
    };
    let notOpenSince = 0;
    heartbeat = intervals(() => {
      if (socket !== candidate) return;
      // CONNECTING (0) hlídá connect watchdog; tady jde jen o CLOSING/CLOSED.
      if (candidate.readyState >= 2) {
        // Socket, který už není OPEN, ale neohlásil onclose (po spánku Macu
        // zemře TCP a undici zůstane v CLOSING). Dřív heartbeat takový tik
        // jen tiše přeskočil a stream se už nikdy neobnovil — bez logu, bez
        // reconnectu, controller zůstal fail-closed až do ručního restartu.
        const now = clock();
        if (!notOpenSince) { notOpenSince = now; return; }
        if (now - notOpenSince < Math.max(1, config.closeTimeoutMs ?? 5_000)) return;
        diagnostic(`WS ZOMBIE state=${socketState} readyState=${candidate.readyState} reason=no-close-event`);
        emitOrHoldError(contextualError(
          new TradovateTransportError(withConnectionLabel('Tradovate WebSocket closed without close event')),
          'websocket',
        ));
        if (!renewalInProgress) emit({ type: 'connection', connected: false, at: now });
        releaseSocket(candidate);
        scheduleReconnect('zombie-socket');
        return;
      }
      notOpenSince = 0;
      if (candidate.readyState !== 1) return;
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
    async listAccountRiskSnapshots(accountIds): Promise<BrokerAccountRiskSnapshot[]> {
      const uniqueAccountIds = [...new Set(accountIds)];
      return Promise.all(uniqueAccountIds.map(async accountId => {
        const encodedId = encodeURIComponent(String(accountId));
        const [cashBalances, riskStatuses, autoLiqSettings] = await Promise.all([
          request<TradovateCashBalanceEntity[]>(
            `/cashBalance/deps?masterid=${encodedId}`,
            { method: 'GET' },
          ),
          request<TradovateAccountRiskStatusEntity[]>(
            `/accountRiskStatus/deps?masterid=${encodedId}`,
            { method: 'GET' },
          ),
          request<TradovateUserAccountAutoLiqEntity[]>(
            `/userAccountAutoLiq/deps?masterid=${encodedId}`,
            { method: 'GET' },
          ),
        ]);
        const cashBalance = firstAccountDependent(cashBalances, accountId);
        const riskStatus = firstAccountDependent(riskStatuses, accountId);
        const autoLiq = firstAccountDependent(autoLiqSettings, accountId);
        return {
          accountId,
          at: clock(),
          realizedPnlUsd: finiteNumber(cashBalance?.realizedPnL),
          // Prop risk status vrací dvojici maxNetLiq/minNetLiq; jejich rozdíl
          // je nakonfigurovaný trailing limit. Ve sdíleném broker portu se
          // horní hodnota normalizuje jako `netLiq` podle Risk spec. Bohatší
          // cash snapshot je jen kompatibilní fallback — běžné GET /deps
          // entity obsahují `amount`, které za net liquidation nevydáváme.
          netLiq: activeRiskThreshold(riskStatus?.maxNetLiq)
            ?? finiteNumber(cashBalance?.netLiq),
          minNetLiq: activeRiskThreshold(riskStatus?.minNetLiq),
          dailyLossAutoLiq: activeRiskThreshold(autoLiq?.dailyLossAutoLiq),
          trailingMaxDrawdown: activeRiskThreshold(autoLiq?.trailingMaxDrawdown),
        };
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
    subscribeEvidence(listener) {
      evidenceListeners.add(listener);
      observe('connection', { state: syncReady ? 'synced' : 'starting' }, 'transport');
      if (!journalSnapshotTimer) journalSnapshotTimer = intervals(() => { void captureJournalPositions(); }, 300_000);
      void captureJournalPositions();
      return () => {
        evidenceListeners.delete(listener);
        if (!evidenceListeners.size) {
          journalSnapshotAbort?.abort();
          journalAccounting.reset();
          journalBackfillPlan.reset(); journalRoster = [];
          if (journalSnapshotTimer) { clearIntervals(journalSnapshotTimer); journalSnapshotTimer = null; }
        }
      };
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

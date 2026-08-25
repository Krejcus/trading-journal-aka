import type {
  TradovateLivePnlAnchor,
  TradovateLiveOrder,
  TradovateLivePnlPosition,
  TradovateLivePnlTick,
} from '../lib/tradovateLivePnlTypes.js';
import {
  latestTradovateOrderVersionsByOrderId,
  type TradovateOrderVersionEntity,
} from '../lib/tradovateOrderReadModel.js';

interface PositionEntity {
  id?: number;
  accountId?: number;
  contractId?: number;
  netPos?: number;
  netPrice?: number;
  timestamp?: string;
}

interface SnapshotEntity {
  errorText?: string;
  openPnL?: number;
  netLiq?: number;
  totalCashValue?: number;
}

interface OrderEntity {
  id?: number;
  accountId?: number;
  contractId?: number;
  timestamp?: string;
  action?: 'Buy' | 'Sell';
  orderType?: string;
  orderQty?: number;
  price?: number;
  stopPrice?: number;
  ordStatus?: string;
  admin?: boolean;
  ocoId?: number;
  parentId?: number;
  linkedId?: number;
}

export class TradovateLivePnlError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
    this.name = 'TradovateLivePnlError';
  }
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const timestamp = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

async function tradovateRequest<T>(options: {
  baseUrl: string;
  accessToken: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  fetchImpl: typeof fetch;
}): Promise<T> {
  const response = await options.fetchImpl(`${options.baseUrl}${options.path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${options.accessToken}`,
      ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body == null ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok || payload == null) {
    throw new TradovateLivePnlError(`Tradovate request failed (${response.status})`, response.status);
  }
  return payload;
}

const normalizePositions = (value: unknown): TradovateLivePnlPosition[] => {
  if (!Array.isArray(value)) throw new TradovateLivePnlError('Tradovate returned invalid positions');
  return value.flatMap((candidate): TradovateLivePnlPosition[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const raw = candidate as PositionEntity;
    const accountId = finite(raw.accountId);
    const contractId = finite(raw.contractId);
    const netPosition = finite(raw.netPos);
    if (accountId == null || contractId == null || netPosition == null) return [];
    return [{
      id: finite(raw.id),
      accountId,
      contractId,
      netPosition,
      averagePrice: finite(raw.netPrice),
      timestamp: timestamp(raw.timestamp),
    }];
  });
};

const normalizeOrders = (
  value: unknown,
  versionsByOrderId: ReadonlyMap<number, TradovateOrderVersionEntity>,
): TradovateLiveOrder[] => {
  if (!Array.isArray(value)) throw new TradovateLivePnlError('Tradovate returned invalid orders');
  return value.flatMap((candidate): TradovateLiveOrder[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const raw = candidate as OrderEntity;
    const id = finite(raw.id);
    const accountId = finite(raw.accountId);
    if (id == null || accountId == null) return [];
    const version = versionsByOrderId.get(id);
    return [{
      id,
      accountId,
      contractId: finite(raw.contractId),
      timestamp: timestamp(raw.timestamp),
      action: raw.action === 'Buy' || raw.action === 'Sell' ? raw.action : null,
      orderType: typeof version?.orderType === 'string'
        ? version.orderType
        : typeof raw.orderType === 'string' ? raw.orderType : null,
      quantity: finite(version?.orderQty) ?? finite(raw.orderQty),
      price: finite(version?.price) ?? finite(raw.price),
      stopPrice: finite(version?.stopPrice) ?? finite(raw.stopPrice),
      status: typeof raw.ordStatus === 'string' ? raw.ordStatus : null,
      admin: typeof raw.admin === 'boolean' ? raw.admin : null,
      ocoId: finite(raw.ocoId),
      parentId: finite(raw.parentId),
      linkedId: finite(raw.linkedId),
    }];
  });
};

/**
 * One cheap read model tick. It always refreshes positions and orders and
 * takes at most one cash snapshot, rotating contracts so request volume is
 * bounded even if several instruments are open at once.
 */
export async function loadTradovateLivePnlTick(options: {
  baseUrl: string;
  accessToken: string;
  connectionId: string;
  environment: 'demo' | 'live';
  contractCursor?: number;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<TradovateLivePnlTick> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const [positions, rawOrders] = await Promise.all([
    tradovateRequest<PositionEntity[]>({
      ...options,
      path: '/position/list',
      fetchImpl,
    }).then(normalizePositions),
    tradovateRequest<OrderEntity[]>({
      ...options,
      path: '/order/list',
      fetchImpl,
    }),
  ]);
  // Order versions carry the mutable order details, but avoid spending an
  // extra request on every lightweight tick while the account has no orders.
  const rawOrderVersions = Array.isArray(rawOrders) && rawOrders.length > 0
    ? await tradovateRequest<TradovateOrderVersionEntity[]>({
      ...options,
      path: '/orderVersion/list',
      fetchImpl,
    })
    : [];
  if (!Array.isArray(rawOrderVersions)) {
    throw new TradovateLivePnlError('Tradovate returned invalid order versions');
  }
  const orders = normalizeOrders(
    rawOrders,
    latestTradovateOrderVersionsByOrderId(rawOrderVersions),
  );
  const open = positions.filter(position => position.netPosition !== 0);
  const openCountByAccount = new Map<number, number>();
  for (const position of open) {
    openCountByAccount.set(position.accountId, (openCountByAccount.get(position.accountId) ?? 0) + 1);
  }
  const eligible = open.filter(position =>
    openCountByAccount.get(position.accountId) === 1 && position.averagePrice != null);
  const contractIds = [...new Set(eligible.map(position => position.contractId))].sort((a, b) => a - b);
  const cursor = Math.max(0, Math.trunc(options.contractCursor ?? 0));
  const selectedContractId = contractIds.length > 0 ? contractIds[cursor % contractIds.length] : null;
  const anchorPosition = selectedContractId == null
    ? null
    : eligible.find(position => position.contractId === selectedContractId) ?? null;

  let anchor: TradovateLivePnlAnchor | null = null;
  if (anchorPosition) {
    const snapshot = await tradovateRequest<SnapshotEntity>({
      ...options,
      path: '/cashBalance/getcashbalancesnapshot',
      method: 'POST',
      body: { accountId: anchorPosition.accountId },
      fetchImpl,
    });
    const openPnl = finite(snapshot.openPnL);
    if (!snapshot.errorText && openPnl != null) {
      anchor = {
        accountId: anchorPosition.accountId,
        contractId: anchorPosition.contractId,
        openPnl,
        netLiq: finite(snapshot.netLiq),
        totalCashValue: finite(snapshot.totalCashValue),
      };
    }
  }

  return {
    connectionId: options.connectionId,
    environment: options.environment,
    capturedAt: new Date(options.now ?? Date.now()).toISOString(),
    positions,
    orders,
    anchor,
    activeContractCount: contractIds.length,
    nextContractCursor: contractIds.length > 0 ? (cursor + 1) % contractIds.length : 0,
  };
}

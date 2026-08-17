import type {
  TradovateLivePnlAnchor,
  TradovateLivePnlPosition,
  TradovateLivePnlTick,
} from '../lib/tradovateLivePnlTypes.js';

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

/**
 * One cheap read model tick. It always refreshes positions and takes at most
 * one cash snapshot, rotating contracts so request volume is bounded even if
 * several instruments are open at once.
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
  const positions = normalizePositions(await tradovateRequest<PositionEntity[]>({
    ...options,
    path: '/position/list',
    fetchImpl,
  }));
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
    anchor,
    activeContractCount: contractIds.length,
    nextContractCursor: contractIds.length > 0 ? (cursor + 1) % contractIds.length : 0,
  };
}

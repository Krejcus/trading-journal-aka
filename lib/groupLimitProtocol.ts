/** Versioned group LIMIT lifecycle. Display evidence never grants execution authority. */
export const GROUP_LIMIT_CONTRACT = 1 as const;
export const GROUP_LIMIT_STATE_HASH_PATTERN = /^[a-z0-9]{8,64}$/;

export interface GroupLimitOrderState {
  brokerOrderId: string;
  quantity: number;
  filledQuantity: number;
  price: number | null;
  state: 'pending' | 'working' | 'filled' | 'canceled' | 'rejected' | 'unknown';
  sourceVersion?: string;
}

export interface GroupLimitAccountState {
  accountId: number;
  role: 'leader' | 'follower';
  expectedQuantity: number;
  openQuantity: number | null;
  entry: GroupLimitOrderState | null;
  stop: GroupLimitOrderState | null;
  target: GroupLimitOrderState | null;
  state: 'pending' | 'position' | 'flat' | 'unknown';
  verifiedAt: number | null;
  issue?: string;
}

export interface GroupLimitTradeState {
  groupId: string;
  entryOperationId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  /** Stable fingerprint of ownership, orders and quantities; excludes heartbeat time. */
  stateHash: string;
  state: 'pending' | 'position' | 'mixed' | 'flat' | 'unknown';
  accounts: GroupLimitAccountState[];
  pendingOperationId?: string;
}

export interface GroupLimitCommandFields {
  groupLimitContract: typeof GROUP_LIMIT_CONTRACT;
  groupLimitStateHash: string;
}

/** Bounded read-model validation. It never substitutes for worker ownership checks. */
export function isGroupLimitTradeStates(value: unknown): value is GroupLimitTradeState[] {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
  const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const qty = (v: unknown, positive = false): v is number => number(v) && Number.isSafeInteger(v) && v >= (positive ? 1 : 0) && v <= 1_000_000;
  const order = (v: unknown) => v === null || (object(v) && text(v.brokerOrderId)
    && qty(v.quantity, true) && qty(v.filledQuantity) && v.filledQuantity <= v.quantity
    && (v.price === null || (number(v.price) && v.price > 0))
    && ['pending', 'working', 'filled', 'canceled', 'rejected', 'unknown'].includes(String(v.state))
    && (v.sourceVersion === undefined || text(v.sourceVersion)));
  if (!Array.isArray(value) || value.length > 10) return false;
  const operations = new Set<string>();
  return value.every(trade => {
    if (!object(trade) || !text(trade.groupId) || !text(trade.entryOperationId)
      || !/^entry:[A-Za-z0-9_-]{8,100}$/.test(trade.entryOperationId)
      || operations.has(trade.entryOperationId) || !text(trade.symbol, 32)
      || (trade.side !== 'Buy' && trade.side !== 'Sell') || !text(trade.stateHash, 64)
      || !GROUP_LIMIT_STATE_HASH_PATTERN.test(trade.stateHash)
      || !['pending', 'position', 'mixed', 'flat', 'unknown'].includes(String(trade.state))
      || (trade.pendingOperationId !== undefined && !text(trade.pendingOperationId))
      || !Array.isArray(trade.accounts) || trade.accounts.length < 1 || trade.accounts.length > 65) return false;
    operations.add(trade.entryOperationId);
    const members = new Set<number>();
    let leaders = 0;
    return trade.accounts.every(account => {
      if (!object(account) || (!number(account.accountId) || !Number.isSafeInteger(account.accountId) || account.accountId <= 0) || members.has(account.accountId)
        || (account.role !== 'leader' && account.role !== 'follower') || !qty(account.expectedQuantity, true)
        || (account.openQuantity !== null && !qty(account.openQuantity))
        || !order(account.entry) || !order(account.stop) || !order(account.target)
        || !['pending', 'position', 'flat', 'unknown'].includes(String(account.state))
        || (account.verifiedAt !== null && (!number(account.verifiedAt) || account.verifiedAt < 0 || account.verifiedAt > 8.64e15))
        || (account.issue !== undefined && !text(account.issue, 500))) return false;
      members.add(account.accountId);
      if (account.role === 'leader') leaders++;
      return true;
    }) && leaders === 1;
  });
}

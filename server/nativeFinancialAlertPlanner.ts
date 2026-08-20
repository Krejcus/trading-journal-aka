export const CLOSED_TRADE_MARKER_KEY = 'state:closed-trade-pnl';
export const ACCOUNT_LOCK_MARKER_KEY = 'state:broker-account-locks';

export interface NativeFinancialAlertStateRow {
  user_id: string;
  device_id: string;
  incident_key: string;
  active: boolean;
  detail?: string | null;
}

export interface NativeClosedTradeAlertRow {
  user_id: string;
  device_id: string;
  trade_id: string;
  symbol: string;
  side: 'Long' | 'Short';
  quantity: number | string;
  realized_pnl_usd: number | string | null;
  follower_count: number;
  closed_at: string;
  created_at: string;
}

export interface NativeBrokerAccountAlertState {
  accountId: number;
  accountName: string;
  locked: boolean;
  reason: string | null;
}

export interface NativeFinancialNotification {
  userId: string;
  deviceId: string;
  key: string;
  title: string;
  body: string;
  kind: 'trade' | 'risk';
}

export interface NativeFinancialMarker {
  userId: string;
  deviceId: string;
  incidentKey: string;
  active: boolean;
  detail: string;
  notified: boolean;
}

const MAX_SEEN_TRADE_IDS = 40;
const BOOTSTRAP_RECENT_MS = 90_000;

const signedUsd = (value: number): string =>
  `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;

const finite = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

const parseTradeIds = (detail: string | null | undefined): string[] => {
  try {
    const parsed = JSON.parse(detail || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string').slice(-MAX_SEEN_TRADE_IDS)
      : [];
  } catch {
    return [];
  }
};

const parseAccountStates = (detail: string | null | undefined): Record<string, boolean> | null => {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
  } catch {
    return null;
  }
};

const markerMap = (states: readonly NativeFinancialAlertStateRow[]) =>
  new Map(states.map(state => [`${state.user_id}:${state.device_id}:${state.incident_key}`, state]));

/**
 * Durable closed-trade P&L notifications. A first observation never replays
 * old history, but a row created within the current cron window is not lost.
 */
export function planClosedTradePnlNotifications(options: {
  trades: readonly NativeClosedTradeAlertRow[];
  alertStates: readonly NativeFinancialAlertStateRow[];
  runtimes?: readonly { user_id: string; device_id: string }[];
  now: number;
}): { notifications: NativeFinancialNotification[]; markers: NativeFinancialMarker[] } {
  const states = markerMap(options.alertStates);
  const byRuntime = new Map<string, NativeClosedTradeAlertRow[]>();
  for (const trade of options.trades) {
    const key = `${trade.user_id}:${trade.device_id}`;
    const list = byRuntime.get(key) ?? [];
    list.push(trade);
    byRuntime.set(key, list);
  }
  for (const runtime of options.runtimes ?? []) {
    const key = `${runtime.user_id}:${runtime.device_id}`;
    if (!byRuntime.has(key)) byRuntime.set(key, []);
  }
  const notifications: NativeFinancialNotification[] = [];
  const markers: NativeFinancialMarker[] = [];

  for (const [runtimeKey, rows] of byRuntime) {
    const [userId, deviceId] = runtimeKey.split(':');
    const marker = states.get(`${runtimeKey}:${CLOSED_TRADE_MARKER_KEY}`);
    const seenIds = new Set(parseTradeIds(marker?.detail));
    const ordered = [...rows].sort((left, right) => Date.parse(left.closed_at) - Date.parse(right.closed_at));
    const fresh = ordered.filter(trade => {
      if (seenIds.has(trade.trade_id)) return false;
      if (marker) return true;
      const createdAt = Date.parse(trade.created_at);
      return Number.isFinite(createdAt) && options.now - createdAt <= BOOTSTRAP_RECENT_MS;
    });
    for (const trade of fresh) {
      const pnl = finite(trade.realized_pnl_usd);
      if (pnl == null) continue;
      const quantity = finite(trade.quantity);
      const followerText = trade.follower_count > 0
        ? ` · ${trade.follower_count} follower${trade.follower_count === 1 ? '' : 'ů'}`
        : '';
      notifications.push({
        userId,
        deviceId,
        key: `closed-pnl:${trade.trade_id}`,
        title: `${trade.symbol} ${trade.side}: ${signedUsd(pnl)}`,
        body: `Broker potvrdil uzavření${quantity == null ? '' : ` ${quantity} kontr.`}${followerText}.`,
        kind: 'trade',
      });
    }
    const nextIds = ordered.map(trade => trade.trade_id).slice(-MAX_SEEN_TRADE_IDS);
    const nextDetail = JSON.stringify(nextIds);
    if (!marker || marker.detail !== nextDetail) {
      markers.push({
        userId,
        deviceId,
        incidentKey: CLOSED_TRADE_MARKER_KEY,
        active: false,
        detail: nextDetail,
        notified: notifications.some(item => item.userId === userId && item.deviceId === deviceId),
      });
    }
  }
  return { notifications, markers };
}

/** Broker account lock/unlock edges. Missing accounts are left untouched. */
export function planBrokerAccountLockNotifications(options: {
  userId: string;
  deviceId: string;
  accounts: readonly NativeBrokerAccountAlertState[];
  alertStates: readonly NativeFinancialAlertStateRow[];
}): { notifications: NativeFinancialNotification[]; marker: NativeFinancialMarker | null } {
  const marker = markerMap(options.alertStates)
    .get(`${options.userId}:${options.deviceId}:${ACCOUNT_LOCK_MARKER_KEY}`);
  const previous = parseAccountStates(marker?.detail);
  const next = { ...(previous ?? {}) };
  const notifications: NativeFinancialNotification[] = [];

  for (const account of options.accounts) {
    const key = String(account.accountId);
    if (previous && previous[key] !== undefined && previous[key] !== account.locked) {
      notifications.push(account.locked
        ? {
          userId: options.userId,
          deviceId: options.deviceId,
          key: `account-locked:${key}`,
          title: `Účet zamčen: ${account.accountName}`,
          body: account.reason || 'Broker účet zablokoval pro další obchodování.',
          kind: 'risk',
        }
        : {
          userId: options.userId,
          deviceId: options.deviceId,
          key: `account-unlocked:${key}`,
          title: `Účet odemčen: ${account.accountName}`,
          body: 'Broker účet znovu povolil. Případný ARM zůstává ruční.',
          kind: 'risk',
        });
    }
    next[key] = account.locked;
  }
  const detail = JSON.stringify(next);
  return {
    notifications,
    marker: !marker || marker.detail !== detail
      ? {
        userId: options.userId,
        deviceId: options.deviceId,
        incidentKey: ACCOUNT_LOCK_MARKER_KEY,
        active: Object.values(next).some(Boolean),
        detail,
        notified: notifications.length > 0,
      }
      : null,
  };
}

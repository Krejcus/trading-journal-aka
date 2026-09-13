import type { TradovateAccountDisplayFeedState, TradovateAccountDisplaySnapshot } from './tradovateAccountDisplayTypes.js';

type Field = keyof TradovateAccountDisplaySnapshot['fields'];
export interface ConfirmedDisplayValue { value: number; requestedAt: string; confirmedAt: string }
export type AccountDisplayValues = Partial<Record<Field, ConfirmedDisplayValue>>;
export type AccountDisplayCache = Record<string, AccountDisplayValues>;
const fields: Field[] = ['dailyRealizedPnL', 'totalCashValue', 'totalCashValueSOD', 'realizedPnL', 'netLiq', 'openPnL'];

/** Merge only into display state. No risk timestamps or account execution fields are modified. */
export function mergeTradovateAccountDisplay(
  previous: AccountDisplayCache,
  feeds: readonly TradovateAccountDisplayFeedState[],
  membership: ReadonlyMap<string, { environment: 'demo' | 'live'; accountIds: ReadonlySet<number> }>,
  now = Date.now(),
): AccountDisplayCache {
  const next: AccountDisplayCache = {};
  for (const [key, value] of Object.entries(previous)) {
    const separator = key.lastIndexOf(':');
    const prefix = key.slice(0, separator);
    const environmentSeparator = prefix.indexOf(':');
    const environment = prefix.slice(0, environmentSeparator);
    const connectionId = prefix.slice(environmentSeparator + 1);
    const accountId = Number(key.slice(separator + 1));
    if (membership.get(connectionId)?.environment === environment && membership.get(connectionId)?.accountIds.has(accountId)) next[key] = value;
  }
  for (const feed of feeds.slice(0, 100)) {
    if (!feed || typeof feed !== 'object') continue;
    const connection = membership.get(feed.connectionId);
    if (!connection || feed.environment !== connection.environment || !Array.isArray(feed.snapshots)) continue;
    for (const snapshot of feed.snapshots.slice(0, 100)) {
      if (!snapshot || typeof snapshot !== 'object') continue;
      if (snapshot.connectionId !== feed.connectionId || snapshot.environment !== connection.environment || !connection.accountIds.has(snapshot.accountId)) continue;
      const requestedAt = Date.parse(snapshot.requestedAt);
      const confirmedAt = Date.parse(snapshot.confirmedAt);
      if (!Number.isFinite(requestedAt) || !Number.isFinite(confirmedAt) || confirmedAt < requestedAt || confirmedAt > now + 1_000) continue;
      const key = `${feed.environment}:${feed.connectionId}:${snapshot.accountId}`;
      const values = { ...next[key] };
      for (const field of fields) {
        const value = snapshot.fields?.[field];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const old = values[field];
        if (old && Date.parse(old.requestedAt) >= requestedAt) continue;
        values[field] = { value, requestedAt: snapshot.requestedAt, confirmedAt: snapshot.confirmedAt };
      }
      next[key] = values;
    }
  }
  return next;
}

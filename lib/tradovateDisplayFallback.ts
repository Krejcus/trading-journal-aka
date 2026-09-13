import { tradovateDisplayTradeDate } from './tradovateDisplayDay';
import type { TradovateAccountDisplaySnapshot } from './tradovateAccountDisplayTypes';
import type { TradovatePreflightResult } from '../services/tradovateOAuthConnection';

/** Per-mounted-user compatibility reader; never shares snapshots across logins. */
export function createTradovateDisplayFallback(options: {
  targeted: (connectionId: string, accountId: number) => Promise<TradovateAccountDisplaySnapshot | null>;
  legacy: (connectionId: string) => Promise<TradovatePreflightResult>;
}) {
  const legacyConnections = new Set<string>();
  return async (connectionId: string, environment: 'demo' | 'live', accountId: number): Promise<{ snapshots: TradovateAccountDisplaySnapshot[]; legacy: boolean }> => {
    const key = `${environment}:${connectionId}`;
    if (!legacyConnections.has(key)) {
      const snapshot = await options.targeted(connectionId, accountId);
      if (snapshot) {
        if (snapshot.connectionId !== connectionId || snapshot.environment !== environment || snapshot.accountId !== accountId)
          throw new Error('display-connection-mismatch');
        const requested = Date.parse(snapshot.requestedAt);
        const confirmed = Date.parse(snapshot.confirmedAt);
        if (!Number.isFinite(requested) || !Number.isFinite(confirmed) || confirmed < requested || !snapshot.fields
          || !Object.values(snapshot.fields).some(value => typeof value === 'number' && Number.isFinite(value)))
          throw new Error('display-cash-unavailable');
        return { snapshots: [snapshot], legacy: false };
      }
      legacyConnections.add(key);
    }
    const data = await options.legacy(connectionId);
    if (data.connectionId !== connectionId || data.environment !== environment) throw new Error('display-connection-mismatch');
    const snapshots = data.accounts.flatMap(account => {
      const confirmedAt = account.readState?.cashAsOf;
      const requestedAt = account.readState?.requestedAt ?? data.requestedAt;
      if (!confirmedAt || !requestedAt || !['available', 'partial'].includes(account.balance.coverage.availability)) return [];
      const fields: TradovateAccountDisplaySnapshot['fields'] = {};
      for (const field of ['totalCashValue', 'totalCashValueSOD', 'realizedPnL', 'netLiq'] as const) {
        const value = account.balance[field];
        if (typeof value === 'number' && Number.isFinite(value)) fields[field] = value;
      }
      const daily = account.daily?.find(day => day.tradeDate === tradovateDisplayTradeDate(Date.parse(confirmedAt)))?.reportedRealizedPnl;
      if (typeof daily === 'number' && Number.isFinite(daily)) fields.dailyRealizedPnL = daily;
      return [{ connectionId, environment, accountId: account.id, requestedAt, confirmedAt, fields }];
    });
    if (!snapshots.length) throw new Error('display-cash-unavailable');
    return { snapshots, legacy: true };
  };
}

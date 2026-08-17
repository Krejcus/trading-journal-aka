import type {
  TradovateAccountDataAccount,
  TradovateAccountFillPair,
  TradovateDailyAccountSummary,
} from './tradovateAccountDataTypes';
import type { TradovateHistorySnapshot } from './tradovateHistoricalTypes';

const syntheticId = (sourceKey: string): number => {
  const prefix = sourceKey.slice(0, 12);
  return -Math.max(1, Number.parseInt(prefix, 16) % Number.MAX_SAFE_INTEGER);
};

const side = (boughtAt: string | null, soldAt: string | null): 'Long' | 'Short' | null => {
  if (!boughtAt || !soldAt) return null;
  return Date.parse(boughtAt) <= Date.parse(soldAt) ? 'Long' : 'Short';
};

const signedHistoricalPnl = (
  reported: number | null,
  buyPrice: number | null,
  sellPrice: number | null,
): number | null => {
  if (reported == null || buyPrice == null || sellPrice == null || buyPrice === sellPrice) return reported;
  if (reported < 0) return reported;
  return Math.abs(reported) * Math.sign(sellPrice - buyPrice);
};

const historicalPair = (
  trade: TradovateHistorySnapshot['trades'][number],
): TradovateAccountFillPair => {
  const id = syntheticId(trade.sourceKey);
  return {
    id,
    positionId: null,
    buyFillId: trade.buyFillId ?? id,
    sellFillId: trade.sellFillId ?? id - 1,
    contractId: null,
    symbol: trade.symbol,
    openedAt: trade.boughtAt && trade.soldAt
      ? (Date.parse(trade.boughtAt) <= Date.parse(trade.soldAt) ? trade.boughtAt : trade.soldAt)
      : trade.boughtAt ?? trade.soldAt,
    closedAt: trade.boughtAt && trade.soldAt
      ? (Date.parse(trade.boughtAt) > Date.parse(trade.soldAt) ? trade.boughtAt : trade.soldAt)
      : trade.soldAt ?? trade.boughtAt,
    tradeDate: trade.tradeDate,
    side: side(trade.boughtAt, trade.soldAt),
    quantity: trade.quantity,
    buyPrice: trade.buyPrice,
    sellPrice: trade.sellPrice,
    // Repair unsigned Performance magnitudes in the client read model too, so
    // a localhost connected through the read-only production proxy is correct
    // before the server-side normalization is deployed.
    grossPnl: signedHistoricalPnl(trade.grossPnl, trade.buyPrice, trade.sellPrice),
    knownFees: null,
    netPnl: null,
    active: false,
  };
};

const mergeDaily = (
  daily: TradovateDailyAccountSummary[],
  historical: TradovateAccountFillPair[],
): TradovateDailyAccountSummary[] => {
  const byDate = new Map(daily.map(day => [day.tradeDate, { ...day }]));
  const historicalByDate = new Map<string, TradovateAccountFillPair[]>();
  for (const pair of historical) {
    if (!pair.tradeDate) continue;
    const values = historicalByDate.get(pair.tradeDate) ?? [];
    values.push(pair);
    historicalByDate.set(pair.tradeDate, values);
  }
  for (const [tradeDate, pairs] of historicalByDate) {
    const current = byDate.get(tradeDate);
    const gross = pairs.reduce((sum, pair) => sum + (pair.grossPnl ?? 0), 0);
    if (current) {
      current.grossTradePnl += gross;
      current.pairedTradeCount += pairs.length;
    } else {
      byDate.set(tradeDate, {
        tradeDate,
        reportedRealizedPnl: null,
        reportedWeekRealizedPnl: null,
        endingBalance: null,
        cashDelta: 0,
        grossTradePnl: gross,
        feeDelta: 0,
        knownFillFees: null,
        fillCount: 0,
        pairedTradeCount: pairs.length,
        ledgerEntryCount: 0,
      });
    }
  }
  return [...byDate.values()].sort((left, right) => right.tradeDate.localeCompare(left.tradeDate));
};

export function mergeTradovateHistoricalSnapshot(
  account: TradovateAccountDataAccount,
  snapshot: TradovateHistorySnapshot | undefined,
): TradovateAccountDataAccount {
  if (!snapshot) return account;
  const currentKeys = new Set(account.fillPairs.map(pair => `${pair.buyFillId}:${pair.sellFillId}`));
  const additions = snapshot.trades
    .filter(trade => !currentKeys.has(`${trade.buyFillId}:${trade.sellFillId}`))
    .map(historicalPair);
  const allPairs = [...account.fillPairs, ...additions]
    .sort((left, right) => Date.parse(right.closedAt ?? '') - Date.parse(left.closedAt ?? ''));
  const timestamps = allPairs.flatMap(pair => [pair.openedAt, pair.closedAt])
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value)));
  return {
    ...account,
    activity: {
      ...account.activity,
      fillPairCount: allPairs.length,
      firstFillAt: timestamps.length > 0 ? [...timestamps].sort()[0] : account.activity.firstFillAt,
      lastFillAt: timestamps.length > 0 ? [...timestamps].sort().at(-1) ?? null : account.activity.lastFillAt,
    },
    history: {
      ...account.history,
      coverage: snapshot.sync?.status === 'complete'
        ? { availability: 'available', count: snapshot.trades.length, httpStatus: 200 }
        : account.history.coverage,
      entryCount: Math.max(account.history.entryCount, snapshot.trades.length),
      firstEntryAt: timestamps.length > 0 ? [...timestamps].sort()[0] : account.history.firstEntryAt,
      lastEntryAt: timestamps.length > 0 ? [...timestamps].sort().at(-1) ?? null : account.history.lastEntryAt,
    },
    fillPairs: allPairs,
    daily: mergeDaily(account.daily, additions),
    historicalBackfill: snapshot.sync ? {
      status: snapshot.sync.status,
      tradeCount: snapshot.trades.length,
      pendingRangeCount: snapshot.sync.pendingRangeCount,
      requestedStart: snapshot.sync.requestedStart,
      requestedEnd: snapshot.sync.requestedEnd,
      syncedThrough: snapshot.sync.syncedThrough,
      lastError: snapshot.sync.lastError,
    } : undefined,
  };
}

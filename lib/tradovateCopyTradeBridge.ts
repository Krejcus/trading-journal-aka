import type { TradovateAccountDataResult } from './tradovateAccountDataTypes';
import type { TradovateAccountProfile } from './tradovateAccountProfileTypes';
import {
  accountRiskCushion,
  accountRiskFloor,
  accountRiskPeak,
  isWorkingTradovateOrder,
  profileMap,
} from './tradovateLiveView';
import type { LiveAccount, LiveOrder, LiveSnapshot } from '../services/tradecopiaLiveService';

const profileFirm = (profile: TradovateAccountProfile | undefined) => profile?.propFirm?.trim() || 'Tradovate';

const dailyRealizedPnl = (
  account: TradovateAccountDataResult['accounts'][number],
  capturedAt: string,
) => {
  const capturedDate = capturedAt.slice(0, 10);
  const day = account.daily.find(candidate => candidate.tradeDate === capturedDate);
  // This is the broker-reported current trade-date value from the latest
  // cashBalance.realizedPnL, including fees. Do not substitute copier stats.
  return day?.reportedRealizedPnl ?? 0;
};

/**
 * Risk UI potřebuje rozlišit potvrzenou nulu od chybějícího broker dne.
 * Obecný LiveAccount model je historicky numerický a neznámou hodnotu v něm
 * převádí na 0, proto sem posíláme samostatnou nullable mapu.
 */
export const tradovateBrokerDailyPnlByAccount = (
  data: TradovateAccountDataResult,
): Readonly<Record<string, number | null>> => {
  const currentTradeDate = data.capturedAt.slice(0, 10);
  return Object.fromEntries(data.accounts.map(account => [
    String(account.id),
    account.daily.find(day => day.tradeDate === currentTradeDate)?.reportedRealizedPnl ?? null,
  ]));
};

export function tradovateCopyTradeSnapshot(
  data: TradovateAccountDataResult,
  profiles: TradovateAccountProfile[],
): LiveSnapshot {
  const profilesById = profileMap(profiles);
  const accounts: LiveAccount[] = data.accounts.map(account => {
    const profile = profilesById.get(String(account.id));
    const positions = account.positions
      .filter(position => position.netPosition !== 0)
      .map(position => ({
        accountId: account.id,
        symbol: position.symbol ?? `Contract ${position.contractId}`,
        netPosition: position.netPosition,
        netPrice: position.averagePrice,
        realizedPnl: 0,
        unrealizedPnl: 0,
        updatedAt: position.timestamp,
      }));
    return {
      id: account.id,
      entityId: null,
      name: profile?.displayName?.trim() || account.name,
      firm: profileFirm(profile),
      phase: profile?.accountType ?? null,
      accountSize: profile?.accountSize ?? null,
      dailyLossLimit: profile?.dailyLossLimit ?? account.risk.dailyLossAutoLiq,
      balance: account.balance.totalCashValue ?? 0,
      equity: account.balance.netLiq ?? account.balance.totalCashValue ?? 0,
      // Copy Trade's Daily P&L must not reuse the lifetime/cumulative balance
      // snapshot. Use only the current captured trade date and include fees.
      realizedPnl: dailyRealizedPnl(account, data.capturedAt),
      weekRealizedPnl: account.balance.weekRealizedPnL ?? 0,
      unrealizedPnl: account.balance.openPnL ?? 0,
      unrealizedPnlSource: account.balance.openPnlSource ?? 'broker',
      unrealizedPnlUpdatedAt: account.balance.openPnlAsOf ?? data.capturedAt,
      peakEquity: accountRiskPeak(account, profile),
      drawdownFloor: accountRiskFloor(account, profile),
      cushion: accountRiskCushion(account, profile),
      positions,
      updatedAt: data.capturedAt,
      mapRowId: null,
      mappedAccountId: null,
      mappedAccountName: null,
      mappingStatus: null,
    };
  });

  const firms = [...new Set(accounts.map(account => account.firm))];
  return {
    run: null,
    accounts,
    appAccounts: [],
    connections: firms.map((firm, index) => ({
      id: `tradovate-oauth-${index + 1}`,
      firm,
      connected: true,
      status: 'Connected',
      accountCount: accounts.filter(account => account.firm === firm).length,
      disconnectedAt: null,
      disconnectReason: null,
      updatedAt: data.capturedAt,
    })),
    groups: [],
    alerts: [],
    totalBalance: accounts.reduce((sum, account) => sum + account.balance, 0),
    totalEquity: accounts.reduce((sum, account) => sum + account.equity, 0),
    totalRealizedPnl: accounts.reduce((sum, account) => sum + account.realizedPnl, 0),
    totalUnrealizedPnl: accounts.reduce((sum, account) => sum + account.unrealizedPnl, 0),
    worstCushion: accounts.reduce<number | null>((worst, account) => account.cushion == null ? worst : worst == null ? account.cushion : Math.min(worst, account.cushion), null),
  };
}

export function tradovateCopyTradeOrders(data: TradovateAccountDataResult): LiveOrder[] {
  return data.accounts.flatMap(account => account.orders.map(order => ({
    id: order.id,
    accountId: account.id,
    accountName: account.name,
    action: order.action ?? '—',
    orderType: order.orderType ?? '—',
    quantity: order.quantity ?? 0,
    price: order.price,
    stopPrice: order.stopPrice,
    status: order.status ?? 'Unknown',
    symbol: order.symbol ?? `Contract ${order.contractId ?? '—'}`,
    placedAt: order.timestamp,
    updatedAt: order.timestamp,
    working: isWorkingTradovateOrder(order),
  })));
}

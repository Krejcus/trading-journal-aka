import { hasCompleteTradovateRead, tradovateAccountReadState } from './tradovateLiveReadState';
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
import { findTradovatePropPlanPreset, tradovateAccountFirm } from './tradovatePropPlanCatalog';
import { tradovateDisplayTradeDate } from './tradovateDisplayDay';

const safeTradovateDisplayTradeDate = (value: string): string | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? tradovateDisplayTradeDate(parsed) : null;
};

const dailyRealizedPnl = (
  account: TradovateAccountDataResult['accounts'][number],
  capturedAt: string,
) => {
  const capturedDate = safeTradovateDisplayTradeDate(capturedAt);
  if (!capturedDate) return 0;
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
  const currentTradeDate = safeTradovateDisplayTradeDate(data.capturedAt);
  return Object.fromEntries(data.accounts.map(account => [
    String(account.id),
    currentTradeDate == null
      ? null
      : account.daily.find(day => day.tradeDate === currentTradeDate)?.reportedRealizedPnl ?? null,
  ]));
};

export function tradovateCopyTradeSnapshot(
  data: TradovateAccountDataResult,
  profiles: TradovateAccountProfile[],
): LiveSnapshot {
  const profilesById = profileMap(profiles);
  const accounts: LiveAccount[] = data.accounts.map(account => {
    const profile = profilesById.get(String(account.id));
    const plan = findTradovatePropPlanPreset(profile?.propFirm, profile?.planName, profile?.accountType);
    const dailyLossDisabled = profile?.dailyLossLimit === 0
      || (profile?.dailyLossLimit == null && plan != null && plan.dailyLossLimit == null);
    const readState = tradovateAccountReadState(account, data);
    const currentTradeDate = safeTradovateDisplayTradeDate(data.capturedAt);
    const dailyLossLimit = profile?.dailyLossLimit ?? account.risk.dailyLossAutoLiq;
    const dailyLossLimitSource = profile?.dailyLossLimit != null
      ? 'profile' as const
      : account.risk.dailyLossAutoLiq != null
        ? 'broker' as const
        : undefined;
    const dailyLossLimitUpdatedAt = profile?.dailyLossLimit != null
      ? profile.updatedAt
      : account.risk.dailyLossAutoLiq != null && hasCompleteTradovateRead(account.risk.limitsCoverage)
        ? readState.requestedAt
        : null;
    const riskFailure = [account.risk.limitsCoverage, account.risk.statusCoverage]
      .find(coverage => coverage != null && !hasCompleteTradovateRead(coverage));
    const riskDisplayUnavailableReason = riskFailure
      ? riskFailure.httpStatus === 401 || riskFailure.httpStatus === 403
        ? 'Tradovate nepovolil čtení risk limitu.'
        : riskFailure.httpStatus === 429
          ? 'Tradovate dočasně omezuje čtení risk limitu.'
          : 'Tradovate risk limit nepotvrdil.'
      : undefined;
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
    // Účet bez otevřené pozice nemá otevřený P&L. Číslo v zůstatku pochází ze čtení zůstatků,
    // které po zavření obchodu chodí později než stav pozic (11. 11. 2026: po zavření svítilo
    // −16,50 na účet ještě minutu). Když čtení pozic říká flat a není starší než to číslo,
    // ukazuje se nula s časem čtení pozic. Jen zobrazení; risk workera se tím nemění.
    const pnlAt = Date.parse(account.balance.openPnlAsOf ?? readState.cashAsOf ?? '');
    const positionsAt = Date.parse(readState.positionsAsOf ?? '');
    const flatByPositions = positions.length === 0 && hasCompleteTradovateRead(readState.positions)
      && Number.isFinite(positionsAt) && (!Number.isFinite(pnlAt) || positionsAt >= pnlAt)
      && account.balance.openPnL != null && account.balance.openPnL !== 0;
    return {
      id: account.id,
      riskDisplayConfigKey: JSON.stringify([profile?.accountSize, profile?.accountType,
        profile?.drawdownType, profile?.maxLoss, profile?.dailyLossLimit, dailyLossDisabled]),
      riskDisplayDrawdownDisabled: profile?.drawdownType === 'none',
      riskDisplayDailyLossDisabled: dailyLossDisabled,
      riskDisplayPending: [account.risk.limitsCoverage, account.risk.statusCoverage]
        .some(coverage => coverage != null && !hasCompleteTradovateRead(coverage)),
      riskDisplayUnavailableReason,
      entityId: null,
      name: profile?.displayName?.trim() || account.name,
      firm: tradovateAccountFirm(profile, account.name) || 'Tradovate',
      phase: profile?.accountType ?? null,
      accountSize: profile?.accountSize ?? null,
      dailyLossLimit,
      dailyLossLimitUpdatedAt,
      dailyLossLimitSource,
      balance: account.balance.totalCashValue ?? 0,
      equity: account.balance.netLiq ?? account.balance.totalCashValue ?? 0,
      // Copy Trade's Daily P&L must not reuse the lifetime/cumulative balance
      // snapshot. Use only the current captured trade date and include fees.
      realizedPnl: dailyRealizedPnl(account, data.capturedAt),
      dailyPnlTradeDate: currentTradeDate ?? undefined,
      dailyPnlUpdatedAt: account.readState?.dailyAsOf ?? null,
      dailyPnlAvailable: currentTradeDate != null
        && account.daily.some(day => day.tradeDate === currentTradeDate && day.reportedRealizedPnl != null),
      weekRealizedPnl: account.balance.weekRealizedPnL ?? 0,
      unrealizedPnl: flatByPositions ? 0 : account.balance.openPnL ?? 0,
      unrealizedPnlSource: flatByPositions ? 'estimated' : account.balance.openPnlSource
        ?? (account.balance.openPnL != null && hasCompleteTradovateRead(account.balance.coverage) ? 'broker' : 'stale'),
      unrealizedPnlUpdatedAt: flatByPositions ? readState.positionsAsOf : account.balance.openPnlAsOf ?? readState.cashAsOf,
      ...(account.balance.openPnlBehindPosition ? { unrealizedPnlBehindPosition: true } : {}),
      ...(readState.displayStreamCoverage ? { displayStreamCoverage: readState.displayStreamCoverage } : {}),
      ...(readState.displayProjection ? { displayProjection: readState.displayProjection } : {}),
      positionsAvailability: readState.positions.availability,
      ordersAvailability: readState.orders.availability,
      cashAvailability: account.balance.totalCashValue != null && account.balance.netLiq != null
        ? account.balance.coverage?.availability ?? 'unavailable' : 'unavailable',
      positionsUpdatedAt: readState.positionsAsOf,
      ordersUpdatedAt: readState.ordersAsOf,
      cashUpdatedAt: readState.cashAsOf,
      peakEquity: accountRiskPeak(account, profile),
      drawdownFloor: accountRiskFloor(account, profile),
      cushion: accountRiskCushion(account, profile),
      positions,
      updatedAt: readState.positionsAsOf,
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
    ...(order.ocoId != null || order.parentId != null ? { bracketLeg: true } : {}),
  })));
}

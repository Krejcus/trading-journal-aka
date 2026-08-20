import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes.js';
import type { NativeLiveActivityBrokerSnapshot } from './nativeLiveActivityBrokerSnapshot.js';
import type { NativeLiveActivityRuntimeRow } from './nativeLiveActivityUpdater.js';

export interface NativeWidgetCopierTradeRow {
  trade_id: string;
  symbol: string;
  side: 'Long' | 'Short';
  quantity: number | string;
  realized_pnl_usd: number | string | null;
  closed_at: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown, fallback = 0): number => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : fallback;
};
const bool = (value: unknown): boolean => value === true;

const controllerOf = (runtime: NativeLiveActivityRuntimeRow): Record<string, unknown> => {
  const root = object(runtime.status);
  return Object.keys(object(root.controller)).length > 0 ? object(root.controller) : root;
};

const groupOf = (runtime: NativeLiveActivityRuntimeRow): Record<string, unknown> =>
  object(object(runtime.status).group);

const runtimeStatus = (runtime: NativeLiveActivityRuntimeRow, now: number) => {
  const controller = controllerOf(runtime);
  const lastSeen = Date.parse(runtime.last_seen_at);
  if (!Number.isFinite(lastSeen) || now - lastSeen > 90_000) {
    return { status: 'WORKER OFFLINE', statusDetail: 'Heartbeat je starší než 90 sekund.' };
  }
  if (bool(controller.killSwitch)) return { status: 'KILL SWITCH', statusDetail: String(controller.lastError || 'Runtime je zastavený.') };
  if (controller.connected === false) return { status: 'BROKER OFFLINE', statusDetail: 'Tradovate spojení není dostupné.' };
  if (bool(controller.stuckOutbox)) return { status: 'STUCK OUTBOX', statusDetail: 'Nejasná operace blokuje další ARM.' };
  if (finite(controller.dayLockUntil) > now) return { status: 'DAY-LOCK', statusDetail: String(controller.dayLockReason || 'Denní zámek je aktivní.') };
  if (finite(controller.entryCooldownUntil) > now) return { status: 'COOLDOWN', statusDetail: 'Anti-revenge cooldown je aktivní.' };
  if (bool(controller.armed) && bool(controller.shadowMode)) return { status: 'SHADOW', statusDetail: 'Kopírka pouze sleduje.' };
  if (bool(controller.armed)) return { status: 'ARM LIVE', statusDetail: 'Kopírování je aktivní.' };
  return { status: 'DISARMED', statusDetail: 'Kopírování stojí.' };
};

export function buildNativeWidgetRemoteSnapshot(options: {
  runtime: NativeLiveActivityRuntimeRow;
  broker: NativeLiveActivityBrokerSnapshot;
  trades: readonly NativeWidgetCopierTradeRow[];
  profiles: readonly TradovateAccountProfile[];
  now: number;
}) {
  const controller = controllerOf(options.runtime);
  const group = groupOf(options.runtime);
  const profileNames = new Map(options.profiles.map(profile => [
    profile.externalAccountId,
    profile.displayName?.trim() || profile.accountName,
  ]));
  const dayLockUntil = finite(controller.dayLockUntil);
  const dayLocked = dayLockUntil > options.now;
  const accounts = options.broker.accounts.map(account => ({
    id: String(account.accountId),
    name: profileNames.get(String(account.accountId)) || account.accountName,
    balance: account.balance,
    pnl: account.totalPnl,
    openPnl: account.openPnl,
    locked: dayLocked || account.changesLocked || !account.canTrade,
    lockReason: dayLocked
      ? String(controller.dayLockReason || 'DAY-LOCK')
      : account.changesLocked ? 'Změny účtu jsou zamčené brokerem'
        : !account.canTrade ? 'Účet nemůže obchodovat' : null,
  })).sort((left, right) => Math.abs(right.pnl) - Math.abs(left.pnl)).slice(0, 6);
  const positions = options.broker.positions.map(position => ({
    accountName: profileNames.get(String(position.accountId))
      || options.broker.accounts.find(account => account.accountId === position.accountId)?.accountName
      || `Tradovate ${position.accountId}`,
    symbol: position.symbol || 'NQ',
    side: position.side,
    quantity: position.quantity,
    averagePrice: null,
  })).slice(0, 6);
  // Unknown point values remain absent. A null broker P&L must never become a
  // convincing zero-profit trade in a financial widget.
  const validTrades = options.trades.flatMap(trade => {
    if (trade.realized_pnl_usd == null) return [];
    const pnl = finite(trade.realized_pnl_usd, NaN);
    const timestamp = Date.parse(trade.closed_at);
    if (!Number.isFinite(pnl) || !Number.isFinite(timestamp)) return [];
    return [{
      id: trade.trade_id,
      symbol: trade.symbol,
      side: trade.side,
      pnl,
      quantity: finite(trade.quantity),
      timestamp,
    }];
  });
  // The durable ledger contains leader fills only. Reconstruct the leader's
  // curve; multiplying or summing follower equity would invent fills/slippage
  // that this source does not know.
  const leaderAccountId = finite(group.leaderAccountId, NaN);
  const currentEquity = accounts.find(account => account.id === String(leaderAccountId))?.balance
    ?? accounts.reduce((sum, account) => sum + account.balance, 0);
  const chronological = [...validTrades].reverse();
  const tradePnl = chronological.reduce((sum, trade) => sum + trade.pnl, 0);
  let runningEquity = currentEquity - tradePnl;
  const equity = [runningEquity];
  for (const trade of chronological) {
    runningEquity += trade.pnl;
    equity.push(runningEquity);
  }
  const dailyStats = object(controller.dailyStats);
  const followers = Array.isArray(group.followers) ? group.followers : [];
  return {
    version: 2 as const,
    updatedAt: options.now,
    journal: null,
    live: {
      connected: controller.connected === true,
      armed: bool(controller.armed),
      shadowMode: bool(controller.shadowMode),
      killSwitch: bool(controller.killSwitch),
      ...runtimeStatus(options.runtime, options.now),
      armExpiresAt: finite(controller.armExpiresAt),
      cooldownUntil: finite(controller.entryCooldownUntil),
      dayLockUntil,
      dayLockReason: typeof controller.dayLockReason === 'string' ? controller.dayLockReason : null,
      dailyRealizedPnl: finite(dailyStats.realizedPnlUsd, options.broker.realizedPnl),
      losingTrades: Math.max(0, Math.floor(finite(dailyStats.losingTrades))),
      followerCount: followers.length,
      openPositionCount: options.broker.positions.length,
      workingOrderCount: options.broker.workingOrderCount,
      realizedPnl: options.broker.realizedPnl,
      openPnl: options.broker.openPnl,
      totalPnl: options.broker.totalPnl,
      accounts,
      positions,
      recentTrades: validTrades.slice(0, 5),
      equity: equity.slice(-30),
    },
  };
}

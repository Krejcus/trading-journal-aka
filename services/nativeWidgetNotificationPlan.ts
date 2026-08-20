import type { NativeWidgetLiveState } from './nativeWidgetSnapshot';

export interface NativeWidgetLocalAlert {
  key: string;
  title: string;
  body: string;
  kind: 'trade' | 'risk';
}

const signedUsd = (value: number): string => `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;

/**
 * On-device only edge planner for broker-confirmed PnL and account locks.
 * It never replays the initial snapshot and never performs a broker action.
 */
export function planNativeWidgetLocalAlerts(
  previous: NativeWidgetLiveState | null,
  next: NativeWidgetLiveState,
): NativeWidgetLocalAlert[] {
  if (!previous) return [];
  const alerts: NativeWidgetLocalAlert[] = [];
  const beforeAccounts = new Map(previous.accounts.map(account => [account.id, account]));

  for (const account of next.accounts) {
    const before = beforeAccounts.get(account.id);
    if (!before || before.locked === account.locked) continue;
    alerts.push(account.locked
      ? {
        key: `account-locked:${account.id}`,
        title: `Účet zamčen: ${account.name}`,
        body: account.lockReason || 'Účet teď nemůže obchodovat. Otevři LIVE pro detail.',
        kind: 'risk',
      }
      : {
        key: `account-unlocked:${account.id}`,
        title: `Účet odemčen: ${account.name}`,
        body: 'Broker už účet nehlásí jako zamčený. Případný ARM zůstává ruční.',
        kind: 'risk',
      });
  }

  const knownTrades = new Set(previous.recentTrades.map(trade => trade.id));
  const freshTrades = next.recentTrades
    .filter(trade => !knownTrades.has(trade.id))
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp);
  for (const trade of freshTrades) {
    alerts.push({
      key: `trade-pnl:${trade.id}`,
      title: `${trade.symbol} ${trade.side}: ${signedUsd(trade.pnl)}`,
      body: `Broker potvrdil výsledek obchodu. Denní realizované PnL ${signedUsd(next.dailyRealizedPnl)}.`,
      kind: 'trade',
    });
  }
  return alerts;
}

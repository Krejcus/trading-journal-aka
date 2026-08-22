import type { Account, AccountDrawdownConfig, BusinessPayout, Trade } from '../types';
import type { FinancialAdjustment } from './tradingIncidents';
import { firmOf } from '../utils/accountFirm';

export interface DrawdownDay {
  date: string;
  openingBalance: number;
  tradePnl: number;
  incidentPnl: number;
  payouts: number;
  closingBalance: number;
  floorBefore: number;
  floorAfter: number;
  projectedFloorAfter?: number;
  roomAfter: number;
  locked: boolean;
}

export interface AccountDrawdownSummary {
  accountId: string;
  accountName: string;
  config: AccountDrawdownConfig;
  currentBalance: number;
  currentFloor: number;
  remainingRoom: number;
  remainingPct: number;
  locked: boolean;
  breached: boolean;
  projectedNextFloor?: number;
  history: DrawdownDay[];
}

const sizeKey = (balance: number): 25000 | 50000 | 100000 | 150000 | null => {
  const sizes = [25000, 50000, 100000, 150000] as const;
  return sizes.reduce<typeof sizes[number] | null>((best, size) => {
    if (Math.abs(balance - size) > 5000) return best;
    return best == null || Math.abs(balance - size) < Math.abs(balance - best) ? size : best;
  }, null);
};

/** Sdílené jádro trailing flooru: floor se smí posunout jen nahoru. */
export function trailingFloorFromHighWatermark(
  currentFloor: number,
  highWatermark: number,
  maxLoss: number,
): number {
  if (![currentFloor, highWatermark, maxLoss].every(Number.isFinite) || maxLoss < 0) {
    throw new Error('Neplatný vstup pro trailing drawdown floor');
  }
  return Math.max(currentFloor, highWatermark - maxLoss);
}

/** Firemní fallback. Neznámé programy záměrně nehádej — nastaví se ručně v účtu. */
export function inferDrawdownConfig(account: Account): AccountDrawdownConfig | null {
  if (account.drawdownConfig?.enabled === false || account.type === 'Backtest') return null;
  if (account.drawdownConfig) return { timezone: 'America/New_York', ...account.drawdownConfig };

  const firm = firmOf(account);
  const size = sizeKey(account.initialBalance);
  if (!size) return null;

  if (firm === 'TOPSTEP') {
    const amount = ({ 25000: 1000, 50000: 2000, 100000: 3000, 150000: 4500 } as const)[size];
    return {
      enabled: true,
      mode: 'eod_trailing',
      amount,
      lockTriggerBalance: account.initialBalance + amount,
      lockedFloor: account.initialBalance,
      timezone: 'America/New_York',
    };
  }

  if (firm === 'TRADEIFY' || firm === 'LUCID') {
    // 50K funded účty obou firem: EOD trail $2,000, lock při $52,100 na $50,100.
    // Ostatní velikosti jsou konzervativní Direct/Growth fallback a lze je přepsat v účtu.
    const amount = ({ 25000: 1000, 50000: 2000, 100000: 3500, 150000: 5000 } as const)[size];
    const funded = account.phase === 'Funded';
    return {
      enabled: true,
      mode: 'eod_trailing',
      amount,
      ...(funded ? {
        lockTriggerBalance: account.initialBalance + amount + 100,
        lockedFloor: account.initialBalance + 100,
      } : {}),
      timezone: 'America/New_York',
    };
  }

  return null;
}

const isoDate = (value: string | number | undefined): string | null => {
  if (value == null) return null;
  if (typeof value === 'string') {
    const match = value.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) return match[0];
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
};

export function calculateAccountDrawdown(
  account: Account,
  trades: Trade[],
  payouts: BusinessPayout[],
  adjustments: FinancialAdjustment[],
): AccountDrawdownSummary | null {
  const config = inferDrawdownConfig(account);
  if (!config || !Number.isFinite(config.amount) || config.amount <= 0) return null;

  const byDate = new Map<string, { tradePnl: number; incidentPnl: number; payouts: number }>();
  const day = (date: string) => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const created = { tradePnl: 0, incidentPnl: 0, payouts: 0 };
    byDate.set(date, created);
    return created;
  };

  trades
    .filter(trade => trade.accountId === account.id && trade.executionStatus !== 'Missed')
    .forEach(trade => {
      const date = isoDate(trade.exitDate || trade.date || trade.timestamp);
      if (date) day(date).tradePnl += Number(trade.pnl) || 0;
    });
  adjustments
    .filter(adjustment => adjustment.accountId === account.id)
    .forEach(adjustment => {
      const date = isoDate(adjustment.date || adjustment.timestamp);
      if (date) day(date).incidentPnl += Number(adjustment.amount) || 0;
    });
  payouts
    .filter(payout => payout.accountId === account.id && (payout.status || 'Received') === 'Received')
    .forEach(payout => {
      const date = isoDate(payout.date);
      if (date) day(date).payouts -= Math.abs(Number(payout.grossAmount ?? payout.amount) || 0);
    });

  const initialFloor = account.initialBalance - config.amount;
  let balance = account.initialBalance - (account.accumulatedChallengePnL || 0);
  let floor = config.manualCurrentFloor ?? initialFloor;
  let locked = Boolean(config.forceLocked);
  if (locked && config.lockedFloor != null) floor = config.lockedFloor;
  const history: DrawdownDay[] = [];
  const todayNy = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  let projectedNextFloor: number | undefined;

  for (const date of [...byDate.keys()].sort()) {
    const values = byDate.get(date)!;
    const openingBalance = balance;
    const floorBefore = floor;
    balance += values.tradePnl + values.incidentPnl + values.payouts;

    if (config.manualCurrentFloor == null && config.mode === 'eod_trailing' && !locked) {
      let nextFloor = trailingFloorFromHighWatermark(floor, balance, config.amount);
      let nextLocked = locked;
      if (config.lockTriggerBalance != null && balance >= config.lockTriggerBalance) {
        nextLocked = true;
        if (config.lockedFloor != null) nextFloor = config.lockedFloor;
      } else if (config.lockedFloor != null) {
        nextFloor = Math.min(nextFloor, config.lockedFloor);
      }
      // Dnešní zisk nesmí trail posunout intradenně. Jen zobrazíme odhad pro příští session.
      if (date < todayNy) {
        floor = nextFloor;
        locked = nextLocked;
      } else {
        projectedNextFloor = nextFloor;
      }
    }

    history.push({
      date,
      openingBalance,
      tradePnl: values.tradePnl,
      incidentPnl: values.incidentPnl,
      payouts: values.payouts,
      closingBalance: balance,
      floorBefore,
      floorAfter: floor,
      ...(date >= todayNy && projectedNextFloor != null ? { projectedFloorAfter: projectedNextFloor } : {}),
      roomAfter: balance - floor,
      locked,
    });
  }

  const remainingRoom = balance - floor;
  return {
    accountId: account.id,
    accountName: account.name,
    config,
    currentBalance: balance,
    currentFloor: floor,
    remainingRoom,
    remainingPct: config.amount > 0 ? (remainingRoom / config.amount) * 100 : 0,
    locked,
    breached: remainingRoom <= 0,
    projectedNextFloor,
    history,
  };
}

export function floorForDate(summary: AccountDrawdownSummary, date: string): number {
  if (date === 'Start') return summary.history[0]?.floorBefore ?? (summary.config.manualCurrentFloor ?? summary.currentFloor);
  const normalized = isoDate(date);
  if (!normalized) return summary.currentFloor;
  const matching = summary.history.find(item => item.date === normalized);
  if (matching) return matching.floorBefore;
  const previous = [...summary.history].reverse().find(item => item.date < normalized);
  return previous?.floorAfter ?? summary.history[0]?.floorBefore ?? summary.currentFloor;
}

export function portfolioFloorForDate(summaries: AccountDrawdownSummary[], date: string) {
  const breakdown = summaries.map(summary => ({
    accountId: summary.accountId,
    accountName: summary.accountName,
    floor: floorForDate(summary, date),
  }));
  return {
    total: breakdown.reduce((sum, item) => sum + item.floor, 0),
    breakdown,
  };
}

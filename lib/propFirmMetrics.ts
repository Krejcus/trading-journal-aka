import type { FirmPayoutRules } from './propFirmRules';
import type { TradovateAccountProfileInput } from './tradovateAccountProfileTypes';
import { trailingFloorFromHighWatermark } from '../services/propDrawdown';

export interface PropFirmAccountSnapshot {
  capturedAt: string | number | Date;
  balance: number;
}

export interface DailyLedgerEntry {
  date: string;
  closingBalance: number;
  pnl: number | null;
  capturedAt: string;
}

export interface ProfitDayProgress {
  completed: number;
  required: number;
  remaining: number;
}

export interface ConsistencyCheck {
  pct: number;
  limit: number | null;
  breached: boolean;
}

export interface PayoutEligibility {
  eligible: boolean;
  missing: {
    profitDays?: number;
    amountUsd?: number;
  };
  capUsd?: number;
}

export type HighWatermarkBasis = 'eod' | 'intraday';

export interface DrawdownFloorPoint {
  at: string;
  balance: number;
  floor: number;
  distance: number;
}

export interface DrawdownFloorResult {
  floor: number;
  balance: number;
  distance: number;
  highWatermark: number;
  highWatermarkBasis: HighWatermarkBasis | 'static';
  history: DrawdownFloorPoint[];
}

export interface BreachResult {
  breached: boolean;
  at?: string;
}

const chicagoDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timestamp = (value: string | number | Date): number => {
  const parsed = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Snapshot má neplatný capturedAt');
  return parsed;
};

const chicagoDate = (epochMs: number): string => {
  const parts = chicagoDateFormatter.formatToParts(new Date(epochMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
};

const sortedSnapshots = (snapshots: readonly PropFirmAccountSnapshot[]) => snapshots
  .map(snapshot => ({ ...snapshot, epochMs: timestamp(snapshot.capturedAt) }))
  .filter(snapshot => Number.isFinite(snapshot.balance))
  .sort((left, right) => left.epochMs - right.epochMs);

/** Poslední známý balance každého obchodního dne podle America/Chicago. */
export function dailyLedger(snapshots: readonly PropFirmAccountSnapshot[]): DailyLedgerEntry[] {
  const lastByDay = new Map<string, ReturnType<typeof sortedSnapshots>[number]>();
  for (const snapshot of sortedSnapshots(snapshots)) {
    lastByDay.set(chicagoDate(snapshot.epochMs), snapshot);
  }
  let previousBalance: number | null = null;
  return [...lastByDay.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, snapshot]) => {
    const pnl = previousBalance == null ? null : snapshot.balance - previousBalance;
    previousBalance = snapshot.balance;
    return {
      date,
      closingBalance: snapshot.balance,
      pnl,
      capturedAt: new Date(snapshot.epochMs).toISOString(),
    };
  });
}

const currentCycle = (ledger: readonly DailyLedgerEntry[], cycleDays: number | null): DailyLedgerEntry[] => {
  const ordered = [...ledger].sort((left, right) => left.date.localeCompare(right.date));
  if (!cycleDays || cycleDays <= 0 || ordered.length === 0) return ordered;
  const end = Date.parse(`${ordered[ordered.length - 1].date}T00:00:00Z`);
  const start = end - (cycleDays - 1) * 86_400_000;
  return ordered.filter(day => Date.parse(`${day.date}T00:00:00Z`) >= start);
};

const profitableDays = (ledger: readonly DailyLedgerEntry[], rules: FirmPayoutRules): number => {
  const minimum = rules.minProfitPerDayUsd ?? 0;
  return currentCycle(ledger, rules.payoutCycleDays)
    .filter(day => day.pnl != null && day.pnl > 0 && day.pnl >= minimum).length;
};

export function profitDayProgress(
  ledger: readonly DailyLedgerEntry[],
  rules: FirmPayoutRules,
): ProfitDayProgress | null {
  if (rules.profitDaysRequired == null) return null;
  const completed = profitableDays(ledger, rules);
  return {
    completed,
    required: rules.profitDaysRequired,
    remaining: Math.max(0, rules.profitDaysRequired - completed),
  };
}

export function consistencyCheck(
  ledger: readonly DailyLedgerEntry[],
  rules: FirmPayoutRules,
): ConsistencyCheck {
  const gains = currentCycle(ledger, rules.payoutCycleDays)
    .flatMap(day => day.pnl != null && day.pnl > 0 ? [day.pnl] : []);
  const totalPositive = gains.reduce((sum, value) => sum + value, 0);
  const pct = totalPositive > 0 ? (Math.max(...gains) / totalPositive) * 100 : 0;
  return {
    pct,
    limit: rules.consistencyPct,
    breached: rules.consistencyPct != null && pct > rules.consistencyPct,
  };
}

export function payoutEligibility(
  ledger: readonly DailyLedgerEntry[],
  rules: FirmPayoutRules,
  withdrawable: number,
): PayoutEligibility {
  const missing: PayoutEligibility['missing'] = {};
  const progress = profitDayProgress(ledger, rules);
  if (progress?.remaining) missing.profitDays = progress.remaining;
  if (rules.minPayoutUsd != null && withdrawable < rules.minPayoutUsd) {
    missing.amountUsd = rules.minPayoutUsd - Math.max(0, withdrawable);
  }
  return {
    eligible: Object.keys(missing).length === 0,
    missing,
    ...(rules.maxPayoutUsd == null ? {} : { capUsd: rules.maxPayoutUsd }),
  };
}

/**
 * Autoritativní floor ze snapshotů. `intraday` je explicitní výjimka např.
 * pro LucidFlex; běžný EOD trailing používá jen poslední balance CT dne.
 */
export function drawdownFloor(
  snapshots: readonly PropFirmAccountSnapshot[],
  profile: Pick<TradovateAccountProfileInput, 'accountSize' | 'maxLoss' | 'drawdownType'>,
  highWatermarkBasis: HighWatermarkBasis = profile.drawdownType === 'trailing' ? 'intraday' : 'eod',
): DrawdownFloorResult | null {
  const ordered = sortedSnapshots(snapshots);
  if (ordered.length === 0 || profile.maxLoss == null || profile.maxLoss < 0
    || profile.drawdownType == null || profile.drawdownType === 'none') return null;
  const initialBalance = profile.accountSize ?? ordered[0].balance;
  let floor = initialBalance - profile.maxLoss;
  let highWatermark = initialBalance;
  const history: DrawdownFloorPoint[] = [];

  if (profile.drawdownType === 'static') {
    history.push(...ordered.map(snapshot => ({
      at: new Date(snapshot.epochMs).toISOString(),
      balance: snapshot.balance,
      floor,
      distance: snapshot.balance - floor,
    })));
  } else if (highWatermarkBasis === 'intraday') {
    for (const snapshot of ordered) {
      highWatermark = Math.max(highWatermark, snapshot.balance);
      floor = trailingFloorFromHighWatermark(floor, highWatermark, profile.maxLoss);
      history.push({
        at: new Date(snapshot.epochMs).toISOString(),
        balance: snapshot.balance,
        floor,
        distance: snapshot.balance - floor,
      });
    }
  } else {
    const lastIndexByDay = new Map<string, number>();
    ordered.forEach((snapshot, index) => lastIndexByDay.set(chicagoDate(snapshot.epochMs), index));
    ordered.forEach((snapshot, index) => {
      if (lastIndexByDay.get(chicagoDate(snapshot.epochMs)) === index) {
        highWatermark = Math.max(highWatermark, snapshot.balance);
        floor = trailingFloorFromHighWatermark(floor, highWatermark, profile.maxLoss!);
      }
      history.push({
        at: new Date(snapshot.epochMs).toISOString(),
        balance: snapshot.balance,
        floor,
        distance: snapshot.balance - floor,
      });
    });
  }

  const last = history[history.length - 1];
  return {
    floor: last.floor,
    balance: last.balance,
    distance: last.distance,
    highWatermark,
    highWatermarkBasis: profile.drawdownType === 'static' ? 'static' : highWatermarkBasis,
    history,
  };
}

export function breachDetector(
  snapshots: readonly PropFirmAccountSnapshot[],
  floor: number | DrawdownFloorResult,
): BreachResult {
  if (typeof floor !== 'number') {
    const breach = floor.history.find(point => point.balance <= point.floor);
    return breach ? { breached: true, at: breach.at } : { breached: false };
  }
  const breach = sortedSnapshots(snapshots).find(snapshot => snapshot.balance <= floor);
  return breach
    ? { breached: true, at: new Date(breach.epochMs).toISOString() }
    : { breached: false };
}

import type { Trade } from '../types';

/**
 * Review týdne: obchody seskupené po týdnech (pondělí 00:00 místního času)
 * a po dnech, souhrn týdne. Čistě datové funkce, bez Reactu.
 */

const DAY_MS = 86_400_000;

/** Čas obchodu pro řazení a zařazení do týdne: vstup, jinak výstup. */
export function tradeTimeMs(trade: Pick<Trade, 'entryTime' | 'entryDate' | 'timestamp' | 'date'>): number {
  if (typeof trade.entryTime === 'number' && trade.entryTime > 0) return trade.entryTime;
  const entry = trade.entryDate ? Date.parse(trade.entryDate) : NaN;
  if (Number.isFinite(entry)) return entry;
  if (typeof trade.timestamp === 'number' && trade.timestamp > 0) return trade.timestamp;
  const date = Date.parse(trade.date);
  return Number.isFinite(date) ? date : 0;
}

/** Pondělí 00:00 (místní čas) týdne, do kterého čas patří. */
export function weekStartOf(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  const shift = (date.getDay() + 6) % 7; // pondělí = 0
  date.setDate(date.getDate() - shift);
  return date.getTime();
}

/** Začátky týdnů, ve kterých je aspoň jeden obchod (od nejstaršího). */
export function reviewWeeks(trades: readonly Trade[]): number[] {
  return [...new Set(trades.map(trade => weekStartOf(tradeTimeMs(trade))))].sort((a, b) => a - b);
}

/** Obchody jednoho týdne od nejstaršího. */
export function tradesInWeek(trades: readonly Trade[], weekStart: number): Trade[] {
  return trades
    .filter(trade => weekStartOf(tradeTimeMs(trade)) === weekStart)
    .sort((a, b) => tradeTimeMs(a) - tradeTimeMs(b));
}

const DAY_NAMES = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
export const dayLabel = (ms: number) => { const d = new Date(ms); return `${DAY_NAMES[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}.`; };

export function weekLabel(weekStart: number): string {
  const from = new Date(weekStart), to = new Date(weekStart + 4 * DAY_MS);
  return from.getMonth() === to.getMonth()
    ? `${from.getDate()}.–${to.getDate()}. ${to.getMonth() + 1}. ${to.getFullYear()}`
    : `${from.getDate()}. ${from.getMonth() + 1}. – ${to.getDate()}. ${to.getMonth() + 1}. ${to.getFullYear()}`;
}

export interface ReviewDay { key: string; label: string; pnl: number; trades: Trade[] }

/** Obchody týdne po dnech (v pořadí), s denním P&L. */
export function reviewDays(weekTrades: readonly Trade[]): ReviewDay[] {
  const days = new Map<string, ReviewDay>();
  for (const trade of weekTrades) {
    const ms = tradeTimeMs(trade), d = new Date(ms);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const day = days.get(key) ?? { key, label: dayLabel(ms), pnl: 0, trades: [] };
    day.trades.push(trade);
    day.pnl += Number(trade.pnl) || 0;
    days.set(key, day);
  }
  return [...days.values()];
}

export interface WeekStats { pnl: number; count: number; wins: number; winRate: number; best: number; worst: number; reviewed: number }

export function weekStats(weekTrades: readonly Trade[]): WeekStats {
  const pnls = weekTrades.map(trade => Number(trade.pnl) || 0);
  const wins = pnls.filter(pnl => pnl > 0).length;
  return {
    pnl: pnls.reduce((sum, pnl) => sum + pnl, 0),
    count: weekTrades.length,
    wins,
    winRate: weekTrades.length ? wins / weekTrades.length : 0,
    best: pnls.length ? Math.max(...pnls) : 0,
    worst: pnls.length ? Math.min(...pnls) : 0,
    reviewed: weekTrades.filter(trade => trade.needsReview !== true).length,
  };
}

export type PlanChoice = 'yes' | 'partial' | 'no';

/** „Dle plánu“ z uložených polí (stejný význam jako formulář Zkontrolovat). */
export function planChoiceOf(trade: Pick<Trade, 'planAdherence' | 'executionStatus' | 'isValid'>): PlanChoice | null {
  if (trade.planAdherence === 'Partial') return 'partial';
  if (trade.planAdherence === 'No' || trade.executionStatus === 'Invalid' || trade.isValid === false) return 'no';
  if (trade.planAdherence === 'Yes') return 'yes';
  return null;
}

/** Pole pro uložení volby „Dle plánu“ — „Ne“ = mimo plán (nevalidní). */
export function planPatch(choice: PlanChoice): Partial<Trade> {
  if (choice === 'no') return { planAdherence: 'No', executionStatus: 'Invalid', isValid: false };
  return { planAdherence: choice === 'yes' ? 'Yes' : 'Partial', executionStatus: 'Valid', isValid: true };
}

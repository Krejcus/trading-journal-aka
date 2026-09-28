import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import { planChoiceOf, planPatch, reviewDays, reviewWeeks, tradesInWeek, weekLabel, weekStartOf, weekStats } from '../lib/weeklyReview';

const at = (y: number, m: number, d: number, h = 16, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const trade = (id: string, ms: number, pnl: number, extra: Partial<Trade> = {}) =>
  ({ id, entryTime: ms, timestamp: ms + 60_000, date: new Date(ms).toISOString(), pnl, ...extra }) as Trade;

describe('review týdne', () => {
  it('týden začíná v pondělí 00:00 místního času', () => {
    expect(weekStartOf(at(2026, 9, 24))).toBe(at(2026, 9, 21, 0));
    expect(weekStartOf(at(2026, 9, 27, 23, 59))).toBe(at(2026, 9, 21, 0));
    expect(weekStartOf(at(2026, 9, 28, 0, 1))).toBe(at(2026, 9, 28, 0));
    expect(weekLabel(at(2026, 9, 21, 0))).toBe('21.–25. 9. 2026');
  });
  it('obchody týdne od nejstaršího, dny s denním P&L', () => {
    const trades = [trade('c', at(2026, 9, 24, 18), -50), trade('a', at(2026, 9, 22, 16), 100), trade('b', at(2026, 9, 22, 19), 25), trade('x', at(2026, 9, 15), 5)];
    expect(reviewWeeks(trades)).toEqual([at(2026, 9, 14, 0), at(2026, 9, 21, 0)]);
    const week = tradesInWeek(trades, at(2026, 9, 21, 0));
    expect(week.map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(reviewDays(week).map(day => [day.label, day.pnl, day.trades.length])).toEqual([['Út 22. 9.', 125, 2], ['Čt 24. 9.', -50, 1]]);
  });
  it('souhrn týdne včetně zkontrolovaných', () => {
    const week = [trade('a', at(2026, 9, 22), 100), trade('b', at(2026, 9, 23), -40, { needsReview: true }), trade('c', at(2026, 9, 24), 0)];
    expect(weekStats(week)).toEqual({ pnl: 60, count: 3, wins: 1, winRate: 1 / 3, best: 100, worst: -40, reviewed: 2 });
  });
  it('„Dle plánu“ čte i ukládá stejná pole jako formulář Zkontrolovat', () => {
    expect(planChoiceOf({ planAdherence: 'Partial' })).toBe('partial');
    expect(planChoiceOf({ executionStatus: 'Invalid' })).toBe('no');
    expect(planChoiceOf({ planAdherence: 'Yes' })).toBe('yes');
    expect(planChoiceOf({})).toBeNull();
    expect(planPatch('no')).toEqual({ planAdherence: 'No', executionStatus: 'Invalid', isValid: false });
    expect(planPatch('partial')).toEqual({ planAdherence: 'Partial', executionStatus: 'Valid', isValid: true });
  });
});

import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import { emptyDayJournal, pragueWallTime, type DayJournal, type DayNote } from '../lib/dayJournal';
import { mindAreaCounts, mindCorrelations, mindEntries } from '../lib/dayMindInsights';

const D1 = '2026-10-13';
const D2 = '2026-10-15';
const D3 = '2026-10-16';
const at = (day: string, clock: string) => pragueWallTime(day, clock);
const trade = (id: string, day: string, clock: string, pnl: number, plan: 'Yes' | 'No' | 'Partial'): Trade => ({
  id, accountId: 'a', pnl, direction: 'Long', date: day, entryTime: at(day, clock), timestamp: at(day, clock) + 10 * 60_000, riskAmount: 100, planAdherence: plan,
} as Trade);
const mind = (id: string, day: string, clock: string, areas: string[]): DayNote => ({
  id, session: 'day', text: `pozn ${id}`, time: null, price: null, voice: false, origin: 'mind', areas,
  writtenAt: new Date(at(day, clock)).toISOString(), updatedAt: new Date(at(day, clock)).toISOString(),
});
const journal = (day: string, notes: DayNote[]): DayJournal => ({ ...emptyDayJournal(day), notes });

const trades = [
  trade('a', D1, '10:00', 200, 'Yes'),
  trade('b', D2, '16:10', -300, 'No'),
  trade('c', D2, '16:40', -200, 'No'),
  trade('d', D2, '19:30', 100, 'Yes'),
  trade('e', D3, '10:00', 150, 'Yes'),
];
const journals = [
  journal(D1, [mind('m1', D1, '07:30', ['pohyb'])]),
  journal(D2, [mind('m2', D2, '15:58', ['rodina']), { ...mind('x', D2, '15:00', []), origin: 'chart' }]),
];

describe('mindEntries', () => {
  it('jen Hlava, od nejnovější, s dnem a obchody do 2 h po zápisu', () => {
    const entries = mindEntries(journals, trades);
    expect(entries.map(entry => entry.note.id)).toEqual(['m2', 'm1']);
    expect(entries[0].dayTrades).toMatchObject({ count: 3, offPlan: 2, rated: 3, pnl: -400 });
    expect(entries[0].after).toMatchObject({ count: 2, offPlan: 2, pnl: -500, rSum: -5 });
    expect(entries[1].after.count).toBe(0);
    expect(mindAreaCounts(entries)).toEqual({ pohyb: 1, rodina: 1 });
  });
});

describe('mindCorrelations', () => {
  it('podíl mimo plán ve dnech s oblastí a bez ní, dny bez zápisu', () => {
    const entries = mindEntries(journals, trades);
    const result = mindCorrelations(entries, trades, [D1, '2026-10-14', D2, D3]);
    const rodina = result.areas.find(item => item.area === 'rodina')!;
    expect(rodina).toMatchObject({ notes: 1, daysWith: 1, daysWithout: 2, offPlanWithout: 0, offPlanAfter: 1, ratedAfter: 2 });
    expect(rodina.offPlanWith).toBeCloseTo(2 / 3);
    expect(result.areas.find(item => item.area === 'pohyb')).toMatchObject({ offPlanWith: 0 });
    expect(result.areas.map(item => item.area)).toEqual(['rodina', 'pohyb']);
    expect(result.daysWithoutMind).toBeCloseTo(1 / 3);
  });
});

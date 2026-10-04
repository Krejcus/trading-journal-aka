import { describe, expect, it } from 'vitest';
import { ruleAdherenceRecent } from '../lib/ruleAdherence';
import { formatSessionDuration, sessionDurationMinutes, sessionOverlapMinutes, sessionSegments, timeToMinutes } from '../lib/sessionSchedule';
import type { DailyPrep, DailyReview } from '../types';

const prep = (date: string, completions: Array<[string, 'Pass' | 'Fail' | 'Pending']>) =>
  ({ id: date, date, scenarios: { bullish: '', bearish: '' }, ritualCompletions: completions.map(([ruleId, status]) => ({ ruleId, status })) }) as unknown as DailyPrep;
const review = (date: string, adherence: Array<[string, 'Pass' | 'Fail' | 'Pending']>) =>
  ({ id: date, date, ruleAdherence: adherence.map(([ruleId, status]) => ({ ruleId, status })) }) as unknown as DailyReview;

describe('ruleAdherenceRecent', () => {
  it('počítá jen rozhodnuté dny a review má přednost před přípravou', () => {
    const stats = ruleAdherenceRecent(
      ['ritual', 'rule'],
      [prep('2026-10-01', [['ritual', 'Pass']]), prep('2026-10-02', [['ritual', 'Pass']]), prep('2026-10-03', [['ritual', 'Pending']])],
      [review('2026-10-02', [['ritual', 'Fail'], ['rule', 'Pass']]), review('2026-10-03', [['rule', 'Fail']])],
      '2026-10-03',
    );
    expect(stats.ritual).toEqual({ passed: 1, evaluated: 2, since: '2026-10-01' });
    expect(stats.rule).toEqual({ passed: 1, evaluated: 2, since: '2026-10-02' });
  });

  it('bere posledních N vyhodnocených dní i po pauze a ignoruje budoucí dny', () => {
    const preps = [prep('2026-08-01', [['a', 'Fail']]), prep('2026-08-02', [['a', 'Pass']]), prep('2026-08-03', [['a', 'Pass']]), prep('2026-10-09', [['a', 'Fail']])];
    expect(ruleAdherenceRecent(['a', 'b'], preps, [], '2026-10-03', 2)).toEqual({
      a: { passed: 2, evaluated: 2, since: '2026-08-02' },
      b: { passed: 0, evaluated: 0, since: null },
    });
  });
});

describe('sessionSchedule', () => {
  it('převádí časy a rozdělí seanci přes půlnoc', () => {
    expect(timeToMinutes('15:30')).toBe(930);
    expect(timeToMinutes(undefined)).toBe(0);
    expect(sessionSegments('09:00', '16:00')).toEqual([[540, 960]]);
    expect(sessionSegments('22:00', '02:00')).toEqual([[1320, 1440], [0, 120]]);
    expect(sessionSegments('09:00', '09:00')).toEqual([]);
  });

  it('počítá délku a překryv i přes půlnoc', () => {
    expect(sessionDurationMinutes('15:30', '22:00')).toBe(390);
    expect(sessionDurationMinutes('22:00', '02:00')).toBe(240);
    expect(sessionOverlapMinutes({ startTime: '09:00', endTime: '16:00' }, { startTime: '15:30', endTime: '22:00' })).toBe(30);
    expect(sessionOverlapMinutes({ startTime: '23:00', endTime: '03:00' }, { startTime: '02:00', endTime: '08:00' })).toBe(60);
    expect(sessionOverlapMinutes({ startTime: '02:00', endTime: '08:00' }, { startTime: '09:00', endTime: '16:00' })).toBe(0);
  });

  it('formátuje délku', () => {
    expect(formatSessionDuration(45)).toBe('45 min');
    expect(formatSessionDuration(360)).toBe('6 h');
    expect(formatSessionDuration(390)).toBe('6:30 h');
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/dayJournalService', () => ({ loadDayJournalRange: async () => [] }));

import { dayNotesAsChartNotes } from '../hooks/useDayNotesForWindow';
import { chartNotesOfTrades } from '../lib/chartNotes';
import type { DayJournal } from '../lib/dayJournal';

const journal = (notes: DayJournal['notes']): DayJournal => ({ day: '2026-10-15', preps: {}, closes: {}, notes });
const note = (patch: Partial<DayJournal['notes'][number]>): DayJournal['notes'][number] => ({
  id: 'n1', session: 'london', text: 'Bias short', time: Date.UTC(2026, 9, 15, 8, 3, 20) / 1_000, price: 29_800,
  voice: false, origin: 'chart', writtenAt: '2026-10-15T06:30:00Z', updatedAt: '2026-10-15T06:30:00Z', ...patch,
});

describe('poznámky dne v grafu obchodu', () => {
  it('jen poznámky s kotvou; čas na minutu; fáze v textu', () => {
    const notes = dayNotesAsChartNotes([journal([
      note({}),
      note({ id: 'n2', time: null, price: null }),
      note({ id: 'n3', writtenAt: '2026-10-15T10:00:00Z' }),
      note({ id: 'n4', text: '   ' }),
    ])]);
    expect(notes.map(item => item.id)).toEqual(['day-note-n1', 'day-note-n3']);
    expect(notes[0].time % 60).toBe(0);
    expect(notes[0].text).toBe('Příprava · Bias short');
    expect(notes[1].text.startsWith('Živě · ')).toBe(true);
  });
});

describe('poznámky k obchodům v grafu Deníku', () => {
  it('kombinovaný obchod dá stejnou poznámku jednou', () => {
    const drawings = [{ id: 'note-a', type: 'note', p1: { time: 1, price: 2 }, text: 'x', offset: { dx: 1, dy: 2 } }];
    const notes = chartNotesOfTrades([{ drawings }, { drawings }, { drawings: [] }] as never);
    expect(notes.map(item => item.id)).toEqual(['note-a']);
  });
});

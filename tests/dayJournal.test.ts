import { describe, expect, it, vi } from 'vitest';
import {
  carryForward, closeTargetSession, closeUpsert, prepTargetSession, groupDayJournalRows, newDayNoteId, notePhase, noteUpsert, parseDayJournalRows,
  pragueClock, pragueDayKey, pragueWallTime, prepReady, prepUpsert, sessionAt, sessionWindows, type DayJournalRow, chartMarketDay } from '../lib/dayJournal';

vi.mock('../services/supabase', () => ({ supabase: {} }));
import { deleteDayNote, loadDayJournal, saveDayNote, saveDayPrep } from '../services/dayJournalService';

const DAY = '2026-10-13';
const NOTE_ID = '3f2a8c1e-4b5d-4e6f-8a7b-9c0d1e2f3a4b';
const at = (clock: string) => new Date(pragueWallTime(DAY, clock)).toISOString();
const row = (patch: Partial<DayJournalRow>): DayJournalRow => ({
  day: DAY, session: 'london', kind: 'prep', entry_key: 'prep:london', data: {}, written_at: at('07:53'), updated_at: at('07:58'), ...patch,
});

describe('Prague time', () => {
  it('maps wall clock to UTC across the October DST change', () => {
    expect(new Date(pragueWallTime(DAY, '09:00')).toISOString()).toBe('2026-10-13T07:00:00.000Z');
    expect(new Date(pragueWallTime('2026-11-02', '09:00')).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(pragueDayKey(Date.parse('2026-10-13T22:30:00Z'))).toBe('2026-10-14');
    expect(pragueClock(Date.parse('2026-10-13T13:30:00Z'))).toBe('15:30');
  });

  it('builds London/NY windows from user sessions and falls back on invalid clocks', () => {
    const windows = sessionWindows(DAY, [{ id: 'london', startTime: '08:30', endTime: '12:00' }, { id: 'ny', startTime: 'bad', endTime: '22:00' }]);
    expect(pragueClock(windows.london.start)).toBe('08:30');
    expect(pragueClock(windows.london.end)).toBe('12:00');
    expect(pragueClock(windows.ny.start)).toBe('15:30');
  });

  it('assigns overlapping time to NY and offers the next session to prepare and the last one to close', () => {
    const windows = sessionWindows(DAY);
    expect(sessionAt(pragueWallTime(DAY, '15:45'), windows)).toBe('ny');
    expect(sessionAt(pragueWallTime(DAY, '10:00'), windows)).toBe('london');
    expect(sessionAt(pragueWallTime(DAY, '07:00'), windows)).toBe('day');
    expect(prepTargetSession(pragueWallTime(DAY, '07:55'), windows)).toBe('london');
    expect(prepTargetSession(pragueWallTime(DAY, '15:20'), windows)).toBe('ny');
    expect(prepTargetSession(pragueWallTime(DAY, '23:00'), windows)).toBe('ny');
    expect(closeTargetSession(pragueWallTime(DAY, '13:10'), windows)).toBe('london');
    expect(closeTargetSession(pragueWallTime(DAY, '22:30'), windows)).toBe('ny');
  });
});

describe('notePhase', () => {
  const windows = sessionWindows(DAY);
  it('derives prep / live / later from when the note was written', () => {
    expect(notePhase({ session: 'london', writtenAt: at('07:53') }, windows)).toBe('prep');
    expect(notePhase({ session: 'london', writtenAt: at('10:12') }, windows)).toBe('live');
    expect(notePhase({ session: 'london', writtenAt: at('20:40') }, windows)).toBe('later');
    expect(notePhase({ session: 'ny', writtenAt: at('15:20') }, windows)).toBe('prep');
    expect(notePhase({ session: 'day', writtenAt: at('18:00') }, windows)).toBe('live');
    expect(notePhase({ session: 'day', writtenAt: '2026-10-14T06:00:00Z' }, windows)).toBe('later');
  });
});

describe('parseDayJournalRows', () => {
  it('reads prep, close and notes and drops junk rows instead of throwing', () => {
    const journal = parseDayJournalRows(DAY, [
      row({ data: { bias: 'long', scenario: 'Sweep Asia low, long z FVG.', rules: ['2 ztráty v řadě', '2 ztráty v řadě', '', 42], durationSec: 312 } }),
      row({ kind: 'close', session: 'london', entry_key: 'close:london', data: { summary: 'Long podle plánu.', execution: 'partial', verdicts: { [NOTE_ID]: 'ok', bogus: 'ok', [newDayNoteId()]: 'maybe' } } }),
      row({ kind: 'note', session: 'london', entry_key: `note:${NOTE_ID}`, written_at: at('10:12'), data: { text: ' Vstup po displacementu ', time: 1_791_000_000.7, price: 31_388.25, voice: true, origin: 'chart' } }),
      row({ kind: 'note', session: 'london', entry_key: 'note:not-a-uuid', data: { text: 'x' } }),
      row({ kind: 'note', session: 'ny', entry_key: `note:${newDayNoteId()}`, data: { text: '   ' } }),
      row({ kind: 'prep', session: 'day', entry_key: 'prep:day' }),
      row({ data: 'nonsense' as unknown as object, session: 'ny', entry_key: 'prep:ny' }),
      row({ day: '2026-10-12' }),
    ]);
    expect(journal.preps.london).toMatchObject({ bias: 'long', rules: ['2 ztráty v řadě'], durationSec: 312, writtenAt: at('07:53') });
    expect(journal.preps.ny).toBeUndefined();
    expect(journal.closes.london?.verdicts).toEqual({ [NOTE_ID]: 'ok' });
    expect(journal.closes.london?.execution).toBe('partial');
    expect(journal.notes).toHaveLength(1);
    expect(journal.notes[0]).toMatchObject({ id: NOTE_ID, text: 'Vstup po displacementu', time: 1_791_000_000, price: 31_388.25, voice: true });
  });

  it('groups a range by day in ascending order', () => {
    const days = groupDayJournalRows([row({ day: '2026-10-14' }), row({}), row({ day: 'junk' })]);
    expect(days.map(day => day.day)).toEqual([DAY, '2026-10-14']);
  });
});

describe('upsert rows', () => {
  const now = new Date(pragueWallTime(DAY, '07:58'));
  it('normalizes prep and close payloads and keys them per session', () => {
    const prep = prepUpsert(DAY, { session: 'ny', bias: 'short', scenario: 'x'.repeat(5000), rules: ['a', 'a', 'b'], durationSec: 61.6 }, now);
    expect(prep).toMatchObject({ kind: 'prep', session: 'ny', entry_key: 'prep:ny', written_at: now.toISOString() });
    expect((prep.data.scenario as string).length).toBe(4000);
    expect(prep.data).toMatchObject({ rules: ['a', 'b'], durationSec: 62, savedAt: now.toISOString() });
    expect(closeUpsert(DAY, { session: 'london', summary: 'ok', execution: 'plan', verdicts: {} }, now).entry_key).toBe('close:london');
    expect(() => prepUpsert('2026-13-40', { session: 'ny', bias: null, scenario: '', rules: [], durationSec: null }, now)).toThrow();
  });

  it('rejects empty or malformed notes and keeps an explicit written time', () => {
    const note = { id: NOTE_ID, session: 'london' as const, text: 'Tady čekám reakci', time: 1_791_000_000, price: -1, voice: false, origin: 'prep' as const };
    const upsert = noteUpsert(DAY, { ...note, writtenAt: at('07:40') }, now);
    expect(upsert).toMatchObject({ entry_key: `note:${NOTE_ID}`, written_at: at('07:40'), data: { price: null, origin: 'prep' } });
    expect(() => noteUpsert(DAY, { ...note, text: '  ' }, now)).toThrow('day-journal-invalid-note');
    expect(() => noteUpsert(DAY, { ...note, id: 'x' }, now)).toThrow('day-journal-invalid-note');
  });

  it('generates RFC 4122 v4 ids', () => {
    expect(newDayNoteId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('helpers', () => {
  it('requires bias and a scenario sentence or a pin before saving a prep', () => {
    expect(prepReady(null, 0)).toEqual({ ready: false, missing: ['bias', 'scenario'] });
    expect(prepReady({ bias: 'long', scenario: 'krátké' }, 0).missing).toEqual(['scenario']);
    expect(prepReady({ bias: 'long', scenario: '' }, 1).ready).toBe(true);
  });

  it('takes the last sentence of the summary as the carry-forward', () => {
    expect(carryForward('Long vyšel. Pak revenge. Do NY po TP odejít od monitoru.')).toBe('Do NY po TP odejít od monitoru.');
    expect(carryForward('')).toBe('');
  });
});

describe('dayJournalService', () => {
  function fakeClient(result: { data?: unknown; error?: { message: string } | null } = {}) {
    const calls: { method: string; args: unknown[] }[] = [];
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'upsert', 'delete', 'single']) {
      builder[method] = (...args: unknown[]) => { calls.push({ method, args }); return builder; };
    }
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null });
    const client = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
      from: (table: string) => { calls.push({ method: 'from', args: [table] }); return builder; },
    };
    return { client: client as never, calls };
  }

  it('upserts on the per-entry key with the owner id and returns the stored note', async () => {
    const stored = row({ kind: 'note', session: 'london', entry_key: `note:${NOTE_ID}`, data: { text: 'Pin', origin: 'prep' } });
    const { client, calls } = fakeClient({ data: stored });
    const note = await saveDayNote(DAY, { id: NOTE_ID, session: 'london', text: 'Pin', time: null, price: null, voice: false, origin: 'prep' }, client);
    expect(note.id).toBe(NOTE_ID);
    const upsertCall = calls.find(call => call.method === 'upsert')!;
    expect(upsertCall.args[0]).toMatchObject({ user_id: 'user-1', entry_key: `note:${NOTE_ID}` });
    expect(upsertCall.args[1]).toEqual({ onConflict: 'user_id,day,entry_key' });
  });

  it('propagates a save error so the UI keeps the draft', async () => {
    const { client } = fakeClient({ error: { message: 'offline' } });
    await expect(saveDayPrep(DAY, { session: 'london', bias: 'long', scenario: 'x', rules: [], durationSec: null }, client)).rejects.toThrow('offline');
  });

  it('loads one day filtered by owner and deletes notes by key', async () => {
    const { client, calls } = fakeClient({ data: [row({ data: { bias: 'neutral' } })] });
    const journal = await loadDayJournal(DAY, client);
    expect(journal.preps.london?.bias).toBe('neutral');
    expect(calls.filter(call => call.method === 'eq').map(call => call.args)).toEqual([['user_id', 'user-1'], ['day', DAY]]);
    await deleteDayNote(DAY, NOTE_ID, client);
    expect(calls.filter(call => call.method === 'eq').slice(-1)[0].args).toEqual(['entry_key', `note:${NOTE_ID}`]);
  });
});

describe('chartMarketDay — graf dne o víkendu', () => {
  it('sobota a neděle ukazují pátek, pracovní den sám sebe', () => {
    expect(chartMarketDay('2026-10-17')).toBe('2026-10-16'); // sobota
    expect(chartMarketDay('2026-10-18')).toBe('2026-10-16'); // neděle
    expect(chartMarketDay('2026-10-19')).toBe('2026-10-19'); // pondělí
    expect(chartMarketDay('2026-10-16')).toBe('2026-10-16'); // pátek
  });

  it('přes přelom měsíce', () => {
    expect(chartMarketDay('2026-11-01')).toBe('2026-10-30'); // neděle → pátek
  });
});

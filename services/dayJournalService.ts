import {
  closeUpsert, groupDayJournalRows, isDayKey, noteUpsert, parseDayJournalRows, prepUpsert,
  type DayClose, type DayJournal, type DayJournalRow, type DayJournalUpsert, type DayNote, type DayPrep,
} from '../lib/dayJournal';
import { supabase } from './supabase';

/**
 * Čtení a zápis deníku dne (`day_journal_entries`, owner-only RLS).
 * Každá poznámka je vlastní řádek a příprava / uzavření jeden řádek na
 * session, takže dvě zařízení si zápisy navzájem nepřepíšou. Chyba se
 * vždy propaguje — UI ponechá koncept a nabídne znovu uložit.
 */

const TABLE = 'day_journal_entries';
const COLUMNS = 'day,session,kind,entry_key,data,written_at,updated_at';
const RANGE_LIMIT = 2_000;

type Client = typeof supabase;

async function ownerId(client: Client): Promise<string> {
  const { data } = await client.auth.getSession();
  const id = data.session?.user?.id;
  if (!id) throw new Error('day-journal-signed-out');
  return id;
}

async function upsert(client: Client, row: DayJournalUpsert): Promise<DayJournalRow> {
  const userId = await ownerId(client);
  const { data, error } = await client
    .from(TABLE)
    .upsert({ ...row, user_id: userId }, { onConflict: 'user_id,day,entry_key' })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error(error?.message || 'day-journal-save-failed');
  return data as DayJournalRow;
}

export async function loadDayJournal(day: string, client: Client = supabase): Promise<DayJournal> {
  if (!isDayKey(day)) throw new Error('day-journal-invalid-day');
  const userId = await ownerId(client);
  const { data, error } = await client.from(TABLE).select(COLUMNS).eq('user_id', userId).eq('day', day);
  if (error) throw new Error(error.message || 'day-journal-load-failed');
  return parseDayJournalRows(day, (data ?? []) as DayJournalRow[]);
}

/** Rozsah dnů včetně obou krajů (export, kouč, přehled týdne). */
export async function loadDayJournalRange(from: string, to: string, client: Client = supabase): Promise<DayJournal[]> {
  if (!isDayKey(from) || !isDayKey(to) || from > to) throw new Error('day-journal-invalid-range');
  const userId = await ownerId(client);
  const { data, error } = await client.from(TABLE).select(COLUMNS)
    .eq('user_id', userId).gte('day', from).lte('day', to)
    .order('day', { ascending: true }).limit(RANGE_LIMIT);
  if (error) throw new Error(error.message || 'day-journal-load-failed');
  return groupDayJournalRows((data ?? []) as DayJournalRow[]);
}

export async function saveDayPrep(day: string, prep: Omit<DayPrep, 'writtenAt' | 'savedAt'>, client: Client = supabase, now = new Date()): Promise<DayPrep> {
  const row = await upsert(client, prepUpsert(day, prep, now));
  const parsed = parseDayJournalRows(day, [row]).preps[prep.session];
  if (!parsed) throw new Error('day-journal-save-failed');
  return parsed;
}

export async function saveDayClose(day: string, close: Omit<DayClose, 'writtenAt' | 'closedAt'>, client: Client = supabase, now = new Date()): Promise<DayClose> {
  const row = await upsert(client, closeUpsert(day, close, now));
  const parsed = parseDayJournalRows(day, [row]).closes[close.session];
  if (!parsed) throw new Error('day-journal-save-failed');
  return parsed;
}

export async function saveDayNote(
  day: string,
  note: Pick<DayNote, 'id' | 'session' | 'text' | 'time' | 'price' | 'voice' | 'origin'> & { writtenAt?: string },
  client: Client = supabase,
  now = new Date(),
): Promise<DayNote> {
  const row = await upsert(client, noteUpsert(day, note, now));
  const parsed = parseDayJournalRows(day, [row]).notes[0];
  if (!parsed) throw new Error('day-journal-save-failed');
  return parsed;
}

export async function deleteDayNote(day: string, id: string, client: Client = supabase): Promise<void> {
  if (!isDayKey(day)) throw new Error('day-journal-invalid-day');
  const userId = await ownerId(client);
  const { error } = await client.from(TABLE).delete().eq('user_id', userId).eq('day', day).eq('entry_key', `note:${id}`);
  if (error) throw new Error(error.message || 'day-journal-delete-failed');
}

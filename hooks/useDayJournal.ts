import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyDayJournal, isDayKey, newDayNoteId, noteEntryKey, noteUpsert, type DayClose, type DayJournal, type DayNote, type DayPrep } from '../lib/dayJournal';
import { deleteDayNote, loadDayJournal, loadDayJournalRange, saveDayClose, saveDayNote, saveDayPrep } from '../services/dayJournalService';

/**
 * Stav deníku jednoho dne. Poznámky se ukládají optimisticky: v UI jsou
 * hned a každá neuložená změna (nová i upravená poznámka) leží ve frontě
 * v localStorage, dokud ji server nepotvrdí — přežije zavření appky i výpadek
 * sítě. Ukládání jedné poznámky jde postupně (pořadí v DB = pořadí úprav)
 * a starší odpověď nikdy nepřepíše novější úpravu. Příprava a uzavření se
 * ukládají tlačítkem a chyba se vrací volajícímu (formulář zůstane).
 *
 * Klíče začínají `alphatrade_`, takže je odhlášení smaže (utils/appStorage).
 */

export type NoteInput = Pick<DayNote, 'session' | 'text' | 'time' | 'price' | 'voice' | 'origin' | 'areas'>;

const PENDING_PREFIX = 'alphatrade_day_journal_pending_';
const pendingKey = (day: string) => `${PENDING_PREFIX}${day}`;

/** Poznámka z fronty, jen pokud projde stejnou validací jako zápis. */
function validPending(value: unknown): value is DayNote {
  const note = value as DayNote | null;
  if (!note || typeof note !== 'object' || typeof note.writtenAt !== 'string' || typeof note.updatedAt !== 'string') return false;
  try { noteUpsert('2000-01-01', note, new Date()); return true; } catch { return false; }
}
export function readPending(day: string): DayNote[] {
  try {
    const raw = window.localStorage.getItem(pendingKey(day));
    const list = raw ? JSON.parse(raw) as unknown[] : [];
    return Array.isArray(list) ? list.filter(validPending) : [];
  } catch { return []; }
}
function writePending(day: string, notes: readonly DayNote[]) {
  try {
    if (notes.length) window.localStorage.setItem(pendingKey(day), JSON.stringify(notes));
    else window.localStorage.removeItem(pendingKey(day));
  } catch { /* soukromé okno: jen bez offline zálohy */ }
}
const putPending = (day: string, note: DayNote) => writePending(day, [...readPending(day).filter(item => item.id !== note.id), note]);
const dropPending = (day: string, id: string, updatedAt?: string) =>
  writePending(day, readPending(day).filter(item => item.id !== id || (updatedAt != null && item.updatedAt !== updatedAt)));
function pendingDays(): string[] {
  try {
    const days: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PENDING_PREFIX) && isDayKey(key.slice(PENDING_PREFIX.length))) days.push(key.slice(PENDING_PREFIX.length));
    }
    return days;
  } catch { return []; }
}

export function useDayJournal(day: string) {
  const [journal, setJournal] = useState<DayJournal>(() => emptyDayJournal(day));
  const journalRef = useRef(journal);
  journalRef.current = journal;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const dayRef = useRef(day);
  dayRef.current = day;
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken(value => value + 1), []);
  // Řetěz ukládání po poznámkách a čas posledního lokálního uložení
  // (načtení, které začalo dřív, ho nesmí zahodit).
  const chains = useRef(new Map<string, Promise<unknown>>());
  const savedAt = useRef(new Map<string, number>());

  const syncNote = useCallback((target: string, note: DayNote): Promise<DayNote> => {
    setPending(current => new Set(current).add(note.id));
    const previous = chains.current.get(note.id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      try {
        const saved = await saveDayNote(target, note);
        dropPending(target, note.id, note.updatedAt);
        savedAt.current.set(note.id, Date.now());
        if (dayRef.current === target) {
          // Jen když mezitím nevznikla novější úprava — ta má přednost.
          setJournal(current => ({ ...current, notes: current.notes.map(item => (item.id === note.id && item.updatedAt === note.updatedAt ? { ...saved, updatedAt: note.updatedAt } : item)) }));
          setFailed(current => { const next = new Set(current); next.delete(note.id); return next; });
        }
        return saved;
      } catch (reason) {
        if (dayRef.current === target) setFailed(current => new Set(current).add(note.id));
        throw reason;
      }
    });
    chains.current.set(note.id, run);
    void run.finally(() => {
      if (chains.current.get(note.id) !== run) return;
      chains.current.delete(note.id);
      if (dayRef.current === target) setPending(current => { const next = new Set(current); next.delete(note.id); return next; });
    }).catch(() => {});
    return run;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    setStatus(current => (current === 'ready' && journalRef.current.day === day ? 'ready' : 'loading'));
    if (journalRef.current.day !== day) { setJournal(emptyDayJournal(day)); setFailed(new Set()); setPending(new Set()); }
    loadDayJournal(day)
      .then(loaded => {
        if (cancelled) return;
        // Neuložené změny z fronty a poznámky uložené až po startu načtení.
        const offline = readPending(day);
        const fresh = journalRef.current.day === day
          ? journalRef.current.notes.filter(note => (savedAt.current.get(note.id) ?? 0) >= startedAt || chains.current.has(note.id))
          : [];
        const byId = new Map(loaded.notes.map(note => [note.id, note]));
        for (const note of [...fresh, ...offline]) byId.set(note.id, note);
        setJournal({ ...loaded, notes: [...byId.values()].sort((a, b) => a.writtenAt.localeCompare(b.writtenAt)) });
        setStatus('ready');
        setError(null);
        for (const note of offline) if (!chains.current.has(note.id)) void syncNote(day, note).catch(() => {});
      })
      .catch(reason => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : 'Deník dne se nepodařilo načíst.');
        setStatus('error');
        const offline = readPending(day);
        if (offline.length) setJournal(current => ({ ...current, notes: [...current.notes.filter(note => !offline.some(item => item.id === note.id)), ...offline] }));
      });
    return () => { cancelled = true; };
  }, [day, reloadToken, syncNote]);

  // Neuložené poznámky jiných dnů (offline včera) se dorovnají na pozadí,
  // ať je kouč i MCP vidí, i když se na ten den nikdo nepodívá.
  useEffect(() => {
    for (const other of pendingDays()) {
      if (other === dayRef.current) continue;
      for (const note of readPending(other)) {
        void saveDayNote(other, note).then(() => dropPending(other, note.id, note.updatedAt), () => {});
      }
    }
  }, [reloadToken]);

  // Návrat do appky (jiné zařízení mohlo mezitím zapsat).
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  const addNote = useCallback((input: NoteInput): DayNote => {
    const now = new Date().toISOString();
    const note: DayNote = { ...input, id: newDayNoteId(), writtenAt: now, updatedAt: now };
    const target = dayRef.current;
    putPending(target, note);
    setJournal(current => ({ ...current, notes: [...current.notes, note] }));
    void syncNote(target, note).catch(() => {});
    return note;
  }, [syncNote]);

  const updateNote = useCallback(async (id: string, patch: Partial<Pick<DayNote, 'text' | 'time' | 'price' | 'areas'>>) => {
    const target = dayRef.current;
    const original = journalRef.current.notes.find(note => note.id === id);
    if (!original) return;
    const updated: DayNote = { ...original, ...patch, updatedAt: new Date().toISOString() };
    putPending(target, updated);
    setJournal(current => ({ ...current, notes: current.notes.map(note => (note.id === id ? updated : note)) }));
    await syncNote(target, updated);
  }, [syncNote]);

  const retryNote = useCallback((id: string) => {
    const note = journalRef.current.notes.find(item => item.id === id);
    if (note) void syncNote(dayRef.current, note).catch(() => {});
  }, [syncNote]);

  const removeNote = useCallback(async (id: string) => {
    const target = dayRef.current;
    const removed = journalRef.current.notes.find(note => note.id === id);
    const queued = readPending(target).find(note => note.id === id);
    setJournal(current => ({ ...current, notes: current.notes.filter(note => note.id !== id) }));
    // Případné rozběhlé uložení musí doběhnout dřív než smazání.
    await (chains.current.get(id) ?? Promise.resolve()).catch(() => {});
    try {
      const known = removed ?? queued;
      await deleteDayNote(target, id, undefined, known ? noteEntryKey(known) : undefined);
      dropPending(target, id);
    } catch (reason) {
      // Vrátit jen tuhle poznámku (ostatní mezitím přidané zůstanou).
      if (dayRef.current === target && removed) setJournal(current => (current.notes.some(note => note.id === id) ? current : { ...current, notes: [...current.notes, removed].sort((a, b) => a.writtenAt.localeCompare(b.writtenAt)) }));
      if (queued) putPending(target, queued);
      throw reason;
    }
  }, []);

  const savePrep = useCallback(async (prep: Omit<DayPrep, 'writtenAt' | 'savedAt'>) => {
    const target = dayRef.current;
    const saved = await saveDayPrep(target, prep);
    if (dayRef.current === target) setJournal(current => ({ ...current, preps: { ...current.preps, [prep.session]: saved } }));
    return saved;
  }, []);

  const saveClose = useCallback(async (close: Omit<DayClose, 'writtenAt' | 'closedAt'>) => {
    const target = dayRef.current;
    const saved = await saveDayClose(target, close);
    if (dayRef.current === target) setJournal(current => ({ ...current, closes: { ...current.closes, [close.session]: saved } }));
    return saved;
  }, []);

  return { journal, status, error, reload, failed, pending, addNote, updateNote, retryNote, removeNote, savePrep, saveClose };
}

/** Deníky víc dnů najednou (řada uzavřených dnů). Chyba = prázdná mapa. */
export function useDayJournalRange(days: readonly string[], refreshKey = 0) {
  const [journals, setJournals] = useState<ReadonlyMap<string, DayJournal>>(new Map());
  const from = days[0];
  const to = days[days.length - 1];
  useEffect(() => {
    if (!from || !to) return;
    let cancelled = false;
    loadDayJournalRange(from, to)
      .then(list => { if (!cancelled) setJournals(new Map(list.map(item => [item.day, item]))); })
      .catch(() => { if (!cancelled) setJournals(new Map()); });
    return () => { cancelled = true; };
  }, [from, to, refreshKey]);
  return journals;
}

import { useEffect, useState } from 'react';
import type { ChartNote } from '../lib/chartNotes';
import { DEFAULT_NOTE_OFFSET } from '../lib/chartNotes';
import { notePhase, sessionWindows, type DayJournal, type DayNotePhase } from '../lib/dayJournal';
import { loadDayJournalRange } from '../services/dayJournalService';

/**
 * Poznámky dne (příprava, živě, retro) pro okno grafu obchodu — jedna vrstva
 * poznámek podle času: co sis ráno napsal k ceně, uvidíš večer v review přímo
 * v grafu obchodu. Jen pro čtení; zapisuje se v Deníku dne.
 */

const PHASE_LABELS: Record<DayNotePhase, string> = { prep: 'Příprava', live: 'Živě', later: 'Retro' };
const cache = new Map<string, { at: number; notes: ChartNote[] }>();
/** Víc panelů se stejným oknem = jeden dotaz. */
const inflight = new Map<string, Promise<ChartNote[]>>();
const FRESH_MS = 60_000;

export const dayNotesAsChartNotes = (journals: readonly DayJournal[]): ChartNote[] => journals.flatMap(journal => {
  const windows = sessionWindows(journal.day);
  return journal.notes
    // Hlava (osobní) do grafu obchodu nejde — ten se snímkuje a sdílí.
    .filter(note => note.origin !== 'mind' && note.time !== null && note.price !== null && note.text.trim())
    .map(note => ({
      id: `day-note-${note.id}`,
      time: Math.floor(note.time! / 60) * 60,
      price: note.price!,
      text: `${PHASE_LABELS[notePhase(note, windows)]} · ${note.text}`,
      ...DEFAULT_NOTE_OFFSET,
    }));
});

export function useDayNotesForWindow(fromDay: string | null, toDay: string | null, enabled = true): ChartNote[] {
  const key = fromDay && toDay ? `${fromDay}:${toDay}` : null;
  const [notes, setNotes] = useState<ChartNote[]>(() => (key && cache.get(key)?.notes) || []);
  useEffect(() => {
    if (!enabled || !key || !fromDay || !toDay) { setNotes([]); return; }
    let cancelled = false;
    const load = () => {
      const cached = cache.get(key);
      if (cached) setNotes(cached.notes);
      if (cached && Date.now() - cached.at < FRESH_MS) return;
      if (!cached) setNotes([]);
      let request = inflight.get(key);
      if (!request) {
        request = loadDayJournalRange(fromDay, toDay)
          .then(journals => {
            const next = dayNotesAsChartNotes(journals);
            cache.set(key, { at: Date.now(), notes: next });
            return next;
          })
          .finally(() => inflight.delete(key!));
        inflight.set(key, request);
      }
      request
        .then(next => { if (!cancelled) setNotes(next); })
        .catch(() => { /* bez poznámek dne — graf obchodu funguje dál */ });
    };
    load();
    const onVisibility = () => { if (document.visibilityState === 'visible') { cache.delete(key); load(); } };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, fromDay, key, toDay]);
  return notes;
}

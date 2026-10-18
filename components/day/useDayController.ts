import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionConfig, Trade } from '../../types';
import {
  DAY_SESSIONS, DAY_SESSION_LABEL, chartMarketDay, closeTargetSession, isWeekendDay, tradingWeekOf, weekendBeforeMonday, editedAt, notePhase, pragueClock, pragueDayKey, prepReady, prepTargetSession, sessionWindows,
  type DayBias, type DayExecution, type DayJournal, type DayNote, type DayScope, type DaySession, type DayVerdict,
} from '../../lib/dayJournal';
import { loadDayJournalRange } from '../../services/dayJournalService';
import { dayChecklist, dayFeed, dayStats, tradesForDay, tradesInScope, type DayViewScope } from '../../lib/dayJournalView';
import { planPatch, type PlanChoice } from '../../lib/weeklyReview';
import { detectMindAreas, mergeMindAreas } from '../../lib/dayMind';
import { useDayJournal, type NoteInput } from '../../hooks/useDayJournal';
import { useDayChartData } from '../../hooks/useDayChartData';
import { useDictation } from '../../hooks/useDictation';
import type { DayAxisTick, DayPinPoint, DayPinView } from './DayNotesLayer';

export type DayMode = 'day' | 'prep' | 'close';
export type DaySelection = { kind: 'note' | 'trade'; id: string } | null;
/** Druh nové poznámky: trh (obchodní) nebo Hlava (osobní). */
export type DayNoteKind = 'market' | 'mind';
/** Filtr poznámek v časové ose a grafu. */
export type DayNoteFilter = 'all' | 'market' | 'mind';

const NOTE_KIND_KEY = 'alphatrade_day_note_kind';
const readNoteKind = (): DayNoteKind => { try { return window.localStorage.getItem(NOTE_KIND_KEY) === 'mind' ? 'mind' : 'market'; } catch { return 'market'; } };

export interface PrepDraft { bias: DayBias | null; scenario: string; rules: string[]; openedAt: number; touched: boolean }
export interface CloseDraft { summary: string; execution: DayExecution | null; verdicts: Record<string, DayVerdict>; touched: boolean }

// Prefix `alphatrade_` → koncepty smaže odhlášení (utils/appStorage).
const draftKey = (day: string, kind: 'prep' | 'close', session: DaySession) => `alphatrade_day_journal_draft_${kind}_${day}_${session}`;
function readDraft<T>(key: string): T | null {
  try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}
function writeDraft(key: string, value: unknown | null) {
  try { if (value == null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* jen bez konceptu */ }
}

/** Dnešní pražské datum; po půlnoci se samo posune. */
export function usePragueNow(tickMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(timer);
  }, [tickMs]);
  return now;
}

export function useDayController({ trades, allTrades, sessions, initialDate, onUpdateTrade }: {
  trades: readonly Trade[];
  allTrades: readonly Trade[];
  sessions: readonly SessionConfig[];
  initialDate?: string;
  onUpdateTrade: (id: string | number, updates: Partial<Trade>) => unknown;
}) {
  const now = usePragueNow();
  const today = pragueDayKey(now);
  const [day, setDay] = useState(() => initialDate ?? today);
  useEffect(() => { if (initialDate) setDay(initialDate); }, [initialDate]);
  const isToday = day === today;
  const windows = useMemo(() => sessionWindows(day, sessions), [day, sessions]);
  // Graf o víkendu ukazuje seance posledního obchodního dne (pátek).
  const marketDay = chartMarketDay(day);
  const chartWindows = useMemo(() => marketDay === day ? windows : sessionWindows(marketDay, sessions), [day, marketDay, sessions, windows]);
  const weekendMarketDay = marketDay === day ? null : marketDay;

  // Víkend: přehled uplynulého týdne, plán na další týden a Hlava za týden.
  const weekend = isWeekendDay(day);
  const week = useMemo(() => tradingWeekOf(day), [day]);
  const weekTrades = useMemo(() => (weekend ? week.days.flatMap(item => tradesForDay(trades, item)) : []), [trades, week, weekend]);
  const weekStats = useMemo(() => dayStats(weekTrades), [weekTrades]);
  // Ostatní dny týdne (aktuální den je živě v `journal`); v pondělí víkend před ním (plán na týden).
  const [otherJournals, setOtherJournals] = useState<DayJournal[]>([]);
  const contextRange = useMemo((): [string, string] | null => {
    if (weekend) return [week.monday, week.weekend[1]];
    return weekendBeforeMonday(day);
  }, [day, week, weekend]);
  useEffect(() => {
    setOtherJournals([]);
    if (!contextRange) return;
    let cancelled = false;
    loadDayJournalRange(contextRange[0], contextRange[1])
      .then(journals => { if (!cancelled) setOtherJournals(journals.filter(item => item.day !== day)); })
      .catch(() => { /* bez kontextu týdne — den funguje dál */ });
    return () => { cancelled = true; };
  }, [contextRange, day]);

  const { journal, status: journalStatus, error: journalError, failed, pending, addNote, updateNote, retryNote, removeNote, savePrep: persistPrep, saveClose: persistClose, reload } = useDayJournal(day);
  const dayTrades = useMemo(() => tradesForDay(trades, day), [trades, day]);
  const chart = useDayChartData(day, dayTrades, allTrades, now);

  const [mode, setMode] = useState<DayMode>('day');
  const [modeSession, setModeSession] = useState<DaySession>(() => prepTargetSession(now, windows));
  const [scope, setScopeState] = useState<DayViewScope>('day');
  const [selected, setSelected] = useState<DaySelection>(null);
  const [placing, setPlacing] = useState<'note' | 'voice' | null>(null);
  const [pendingPoint, setPendingPoint] = useState<DayPinPoint | null>(null);
  const [noteKind, setNoteKindState] = useState<DayNoteKind>(readNoteKind);
  const setNoteKind = useCallback((next: DayNoteKind) => {
    setNoteKindState(next);
    try { window.localStorage.setItem(NOTE_KIND_KEY, next); } catch { /* jen bez paměti volby */ }
  }, []);
  const [noteFilter, setNoteFilter] = useState<DayNoteFilter>('all');
  const dictation = useDictation();
  const cancelDictation = dictation.cancel;

  // Přepnutí dne: výběr, umisťování i režim se zahodí.
  useEffect(() => {
    setSelected(null); setPlacing(null); setPendingPoint(null); setMode('day'); setScopeState('day'); setNoteFilter('all');
    cancelDictation();
  }, [day, cancelDictation]);

  const shiftDay = useCallback((delta: number) => {
    setDay(current => {
      const [y, m, d] = current.split('-').map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
      return next > today ? current : next;
    });
  }, [today]);

  // ── Koncepty přípravy a uzavření (per session, přežijí přepnutí) ──────
  const [prepDrafts, setPrepDrafts] = useState<Partial<Record<DaySession, PrepDraft>>>({});
  const [closeDrafts, setCloseDrafts] = useState<Partial<Record<DaySession, CloseDraft>>>({});
  useEffect(() => { setPrepDrafts({}); setCloseDrafts({}); }, [day]);

  const prepDraft = useCallback((session: DaySession): PrepDraft => {
    const current = prepDrafts[session];
    if (current) return current;
    const saved = journal.preps[session];
    const stored = readDraft<PrepDraft>(draftKey(day, 'prep', session));
    if (stored && !saved) return { ...stored, openedAt: Date.now() };
    return { bias: saved?.bias ?? null, scenario: saved?.scenario ?? '', rules: saved?.rules ?? [], openedAt: Date.now(), touched: false };
  }, [day, journal.preps, prepDrafts]);
  const updatePrepDraft = useCallback((session: DaySession, patch: Partial<PrepDraft> | ((draft: PrepDraft) => Partial<PrepDraft>)) => {
    setPrepDrafts(current => {
      const base = current[session] ?? prepDraft(session);
      const next = { ...base, ...(typeof patch === 'function' ? patch(base) : patch), touched: true };
      writeDraft(draftKey(day, 'prep', session), next);
      return { ...current, [session]: next };
    });
  }, [day, prepDraft]);

  const closeDraft = useCallback((session: DaySession): CloseDraft => {
    const current = closeDrafts[session];
    if (current) return current;
    const saved = journal.closes[session];
    const stored = readDraft<CloseDraft>(draftKey(day, 'close', session));
    if (stored && !saved) return stored;
    return { summary: saved?.summary ?? '', execution: saved?.execution ?? null, verdicts: saved?.verdicts ?? {}, touched: false };
  }, [closeDrafts, day, journal.closes]);
  const updateCloseDraft = useCallback((session: DaySession, patch: Partial<CloseDraft> | ((draft: CloseDraft) => Partial<CloseDraft>)) => {
    setCloseDrafts(current => {
      const base = current[session] ?? closeDraft(session);
      const next = { ...base, ...(typeof patch === 'function' ? patch(base) : patch), touched: true };
      writeDraft(draftKey(day, 'close', session), next);
      return { ...current, [session]: next };
    });
  }, [closeDraft, day]);

  // Otevřená příprava drží svůj koncept ve stavu (čas otevření pro stopky);
  // až po načtení deníku, ať koncept vychází z uložené přípravy.
  useEffect(() => {
    if (mode !== 'prep' || journalStatus !== 'ready') return;
    setPrepDrafts(current => (current[modeSession] ? current : { ...current, [modeSession]: prepDraft(modeSession) }));
  }, [journalStatus, mode, modeSession, prepDraft]);

  const savePrep = useCallback(async (session: DaySession) => {
    // Bez načteného deníku by uložení přepsalo přípravu z jiného zařízení.
    if (journalStatus !== 'ready') throw new Error('Deník dne se ještě načítá — zkus to za chvíli.');
    const draft = prepDraft(session);
    const pins = journal.notes.filter(note => note.session === session && note.origin === 'prep').length;
    if (!prepReady(draft, pins).ready) throw new Error('Chybí bias nebo scénář.');
    const previous = journal.preps[session];
    const elapsed = Math.round((Date.now() - draft.openedAt) / 1000);
    const saved = await persistPrep({
      session, bias: draft.bias, scenario: draft.scenario, rules: draft.rules,
      durationSec: previous?.durationSec != null ? previous.durationSec + (draft.touched ? elapsed : 0) : elapsed,
    });
    // Co uživatel mezitím dopsal, zůstává jako rozpracovaný koncept.
    setPrepDrafts(current => {
      const latest = current[session];
      if (latest && (latest.bias !== draft.bias || latest.scenario !== draft.scenario || latest.rules.join('|') !== draft.rules.join('|'))) return current;
      writeDraft(draftKey(day, 'prep', session), null);
      return { ...current, [session]: { ...draft, touched: false, openedAt: Date.now() } };
    });
    return saved;
  }, [day, journal.notes, journal.preps, journalStatus, persistPrep, prepDraft]);

  const saveClose = useCallback(async (session: DaySession) => {
    if (journalStatus !== 'ready') throw new Error('Deník dne se ještě načítá — zkus to za chvíli.');
    const draft = closeDraft(session);
    if (!draft.execution) throw new Error('Vyber, jak jsi dodržel plán.');
    const saved = await persistClose({ session, summary: draft.summary.trim(), execution: draft.execution, verdicts: draft.verdicts });
    setCloseDrafts(current => {
      const latest = current[session];
      if (latest && (latest.summary !== draft.summary || latest.execution !== draft.execution || JSON.stringify(latest.verdicts) !== JSON.stringify(draft.verdicts))) return current;
      writeDraft(draftKey(day, 'close', session), null);
      return { ...current, [session]: { ...draft, touched: false } };
    });
    return saved;
  }, [closeDraft, day, journalStatus, persistClose]);

  // ── Režimy ────────────────────────────────────────────────────────────
  const openPrep = useCallback((session?: DaySession) => {
    setModeSession(session ?? prepTargetSession(Date.now(), windows));
    setMode('prep'); setSelected(null); setPlacing(null); setPendingPoint(null);
  }, [windows]);
  const openClose = useCallback((session?: DaySession) => {
    setModeSession(session ?? closeTargetSession(Date.now(), windows));
    setMode('close'); setSelected(null); setPlacing(null); setPendingPoint(null);
  }, [windows]);
  const backToDay = useCallback(() => { setMode('day'); setPlacing(null); setPendingPoint(null); cancelDictation(); }, [cancelDictation]);
  const setScope = useCallback((next: DayViewScope) => { setScopeState(next); setSelected(null); }, []);

  // ── Poznámky ──────────────────────────────────────────────────────────
  const pinSessionFor = useCallback((point: DayPinPoint | null): DayScope => {
    if (mode === 'prep' || mode === 'close') return modeSession;
    if (scope !== 'day') return scope;
    if (!point) return 'day';
    const ms = point.time * 1000;
    if (ms >= windows.ny.start && ms < windows.ny.end) return 'ny';
    if (ms >= windows.london.start && ms < windows.london.end) return 'london';
    return 'day';
  }, [mode, modeSession, scope, windows]);

  const createNote = useCallback((text: string, point: DayPinPoint | null, voice: boolean, kindOverride?: DayNoteKind) => {
    const body = text.trim();
    // Příprava a uzavření píšou jen poznámky k trhu (body plánu).
    const kind = kindOverride ?? (mode === 'day' ? noteKind : 'market');
    if (!body) return null;
    // Hlava patří ke dni, ne k session; oblasti pozná appka z textu.
    const input: NoteInput = kind === 'mind'
      ? { session: 'day', text: body, time: point?.time ?? null, price: point?.price ?? null, voice, origin: 'mind', areas: mergeMindAreas(body) }
      : { session: pinSessionFor(point), text: body, time: point?.time ?? null, price: point?.price ?? null, voice, origin: mode === 'prep' ? 'prep' : point ? 'chart' : 'feed' };
    return addNote(input);
  }, [addNote, mode, noteKind, pinSessionFor]);

  /** Úprava textu: u Hlavy se přepočítají rozpoznané oblasti, ručně přidané zůstanou. */
  const editNoteText = useCallback((note: DayNote, text: string) => {
    if (note.origin !== 'mind') return updateNote(note.id, { text });
    // Ručně vypnutá oblast se nevrátí: přibude jen to, co nový text přidal oproti starému.
    const before = new Set<string>(detectMindAreas(note.text));
    const added = detectMindAreas(text).filter(area => !before.has(area));
    return updateNote(note.id, { text, areas: mergeMindAreas('', [...(note.areas ?? []), ...added]) });
  }, [updateNote]);

  /** Víkend: plán na další týden (ukáže se v pondělní přípravě). */
  const createWeekPlan = useCallback((text: string) => {
    const body = text.trim();
    if (!body) return null;
    return addNote({ session: 'day', text: body, time: null, price: null, voice: false, origin: 'week' });
  }, [addNote]);

  const noteMatches = useCallback((note: DayNote) => noteFilter === 'all' || (noteFilter === 'mind') === (note.origin === 'mind'), [noteFilter]);

  const rateTrade = useCallback(async (trade: Trade, choice: PlanChoice) => {
    await onUpdateTrade(trade.id, planPatch(choice));
  }, [onUpdateTrade]);

  // ── Odvozené pohledy ──────────────────────────────────────────────────
  const scopedTrades = useMemo(() => tradesInScope(dayTrades, scope, windows), [dayTrades, scope, windows]);
  const stats = useMemo(() => dayStats(scopedTrades), [scopedTrades]);
  const sessionStats = useMemo(() => Object.fromEntries(DAY_SESSIONS.map(session => [session, dayStats(tradesInScope(dayTrades, session, windows))])) as Record<DaySession, ReturnType<typeof dayStats>>, [dayTrades, windows]);
  const feed = useMemo(() => dayFeed(journal, dayTrades, windows, scope)
    .filter(item => item.kind === 'note' ? noteMatches(item.note) : noteFilter !== 'mind'), [dayTrades, journal, noteFilter, noteMatches, scope, windows]);
  const mindTicks = useMemo((): DayAxisTick[] => (mode !== 'day' ? [] : journal.notes
    .filter(note => note.origin === 'mind' && note.time == null && noteMatches(note))
    .map(note => ({ id: note.id, time: Math.floor(Date.parse(note.writtenAt) / 1000), text: note.text }))
    .filter(tick => Number.isFinite(tick.time))), [journal.notes, mode, noteMatches]);
  const checklist = useMemo(() => dayChecklist(journal, dayTrades, windows, now), [dayTrades, journal, now, windows]);

  const pinViews = useCallback((filter: (note: DayNote) => boolean, ghost?: (note: DayNote) => boolean): DayPinView[] => journal.notes
    // Filtr Trh / Hlava platí jen v pohledu dne — příprava a uzavření ukazují své body vždy.
    .filter(note => note.time != null && note.price != null && (mode !== 'day' || noteMatches(note)))
    .filter(note => filter(note) || Boolean(ghost?.(note)))
    .map(note => {
      const phase = notePhase(note, windows);
      const written = pragueClock(Date.parse(note.writtenAt));
      const sessionName = note.session === 'day' ? '' : ` ${DAY_SESSION_LABEL[note.session]}`;
      if (note.origin === 'mind') return {
        id: note.id, time: note.time!, price: note.price!, phase, voice: note.voice, text: note.text, mind: true,
        meta: `zapsáno ${written} · hlava`, rayFrom: null, ghost: false,
        status: failed.has(note.id) ? 'failed' as const : pending.has(note.id) ? 'pending' as const : undefined,
      };
      return {
        id: note.id, time: note.time!, price: note.price!, phase, voice: note.voice, text: note.text,
        meta: `zapsáno ${written} · ${phase === 'prep' ? `příprava${sessionName}` : phase === 'live' ? 'živě' : 'dopsáno zpětně'}${(() => { const at = editedAt(note.writtenAt, note.updatedAt); return at ? ` · upraveno ${pragueClock(Date.parse(at))}` : ''; })()}`,
        rayFrom: phase === 'prep' ? Math.floor(Date.parse(note.writtenAt) / 1000) : null,
        ghost: !filter(note) && Boolean(ghost?.(note)),
        status: failed.has(note.id) ? 'failed' as const : pending.has(note.id) ? 'pending' as const : undefined,
      };
    }), [failed, journal.notes, mode, noteMatches, pending, windows]);

  /** Hlava za týden (víkend): od nejnovější. */
  const weekMindNotes = useMemo(() => (weekend ? [...otherJournals.filter(item => item.day !== day).flatMap(item => item.notes.map(note => ({ day: item.day, note }))), ...journal.notes.map(note => ({ day, note }))] : [])
    .filter(item => item.note.origin === 'mind')
    .sort((a, b) => Date.parse(b.note.writtenAt) - Date.parse(a.note.writtenAt)), [day, journal.notes, otherJournals, weekend]);
  /** Plán na týden: o víkendu z tohoto víkendu, v pondělí z víkendu před ním. */
  const weekPlans = useMemo(() => [...otherJournals.filter(item => item.day !== day).flatMap(item => item.notes), ...(weekend ? journal.notes : [])]
    .filter(note => note.origin === 'week')
    .sort((a, b) => Date.parse(a.writtenAt) - Date.parse(b.writtenAt)), [day, journal.notes, otherJournals, weekend]);

  const selectedTrade = selected?.kind === 'trade' ? dayTrades.find(trade => String(trade.id) === selected.id) ?? null : null;
  const selectedNote = selected?.kind === 'note' ? journal.notes.find(note => note.id === selected.id) ?? null : null;

  return {
    now, today, day, setDay, shiftDay, isToday, windows, chartWindows, marketDay, weekendMarketDay,
    journal, journalStatus, journalError, failedNotes: failed, pendingNotes: pending, retryNote, updateNote, removeNote, reload,
    dayTrades, scopedTrades, stats, sessionStats, feed, checklist, chart,
    mode, modeSession, setModeSession, openPrep, openClose, backToDay,
    scope, setScope, selected, setSelected, selectedTrade, selectedNote,
    placing, setPlacing, pendingPoint, setPendingPoint,
    dictation, createNote, createWeekPlan, editNoteText, rateTrade,
    noteKind, setNoteKind, noteFilter, setNoteFilter, mindTicks,
    weekend, week, weekTrades, weekStats, weekMindNotes, weekPlans,
    prepDraft, updatePrepDraft, savePrep, closeDraft, updateCloseDraft, saveClose,
    pinViews,
  };
}

export type DayController = ReturnType<typeof useDayController>;

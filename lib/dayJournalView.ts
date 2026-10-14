import type { Trade } from '../types';
import { tradeRMultiple } from '../utils/tradeRisk';
import { planChoiceOf, tradeTimeMs, type PlanChoice } from './weeklyReview';
import {
  DAY_SESSIONS, carryForward, notePhase, pragueClock, pragueDayKey, sessionAt,
  type DayClose, type DayJournal, type DayNote, type DayNotePhase, type DayPrep, type DayScope, type DaySession, type SessionWindows,
} from './dayJournal';

/**
 * Model pohledu dne: obchody dne, souhrny podle rozsahu (den / London /
 * NY), checklist žurnálu, časová osa a řada posledních dnů. Čisté funkce,
 * UI jen vykresluje.
 */

export type DayViewScope = 'day' | DaySession;

const exitMs = (trade: Trade) => {
  const exit = typeof trade.timestamp === 'number' && trade.timestamp > 0 ? trade.timestamp : NaN;
  return Number.isFinite(exit) ? exit : tradeTimeMs(trade);
};

/** Obchody, jejichž vstup padl na pražský den (bez nevzatých příkazů). */
export function tradesForDay(trades: readonly Trade[], day: string): Trade[] {
  return trades
    .filter(trade => !trade.untaken && trade.executionStatus !== 'Missed')
    .filter(trade => { const at = tradeTimeMs(trade); return at > 0 && pragueDayKey(at) === day; })
    .sort((a, b) => tradeTimeMs(a) - tradeTimeMs(b));
}

export const tradeScope = (trade: Trade, windows: SessionWindows): DayScope => sessionAt(tradeTimeMs(trade), windows);

export function tradesInScope(trades: readonly Trade[], scope: DayViewScope, windows: SessionWindows): Trade[] {
  return scope === 'day' ? [...trades] : trades.filter(trade => tradeScope(trade, windows) === scope);
}

export interface DayStats {
  count: number;
  pnl: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** Součet R jen když ho mají všechny obchody — jinak `null` (žádné částečné součty). */
  rSum: number | null;
  maxDrawdown: number;
  best: number | null;
  avgHoldMinutes: number | null;
  rated: number;
}

export function dayStats(trades: readonly Trade[]): DayStats {
  let pnl = 0, wins = 0, losses = 0, run = 0, peak = 0, maxDrawdown = 0, holdSum = 0, holdCount = 0, rated = 0;
  let rSum: number | null = 0;
  let best: number | null = null;
  for (const trade of [...trades].sort((a, b) => exitMs(a) - exitMs(b))) {
    const value = Number(trade.pnl) || 0;
    pnl += value;
    if (value > 0 && !trade.isBE) wins += 1;
    else if (value < 0 && !trade.isBE) losses += 1;
    run += value;
    peak = Math.max(peak, run);
    maxDrawdown = Math.min(maxDrawdown, run - peak);
    best = best == null ? value : Math.max(best, value);
    const r = tradeRMultiple(trade);
    rSum = rSum == null || r == null ? null : rSum + r;
    const hold = Number(trade.durationMinutes);
    if (Number.isFinite(hold) && hold >= 0) { holdSum += hold; holdCount += 1; }
    if (planChoiceOf(trade)) rated += 1;
  }
  const decided = wins + losses;
  return {
    count: trades.length, pnl, wins, losses,
    winRate: decided ? wins / decided : null,
    rSum: trades.length ? rSum : null,
    maxDrawdown, best,
    avgHoldMinutes: holdCount ? holdSum / holdCount : null,
    rated,
  };
}

// ── Stav session a checklist ────────────────────────────────────────────

export type SessionStage = 'upcoming' | 'running' | 'ended';

export function sessionStage(session: DaySession, windows: SessionWindows, now: number): SessionStage {
  const window = windows[session];
  return now < window.start ? 'upcoming' : now < window.end ? 'running' : 'ended';
}

export interface ChecklistItem { id: string; label: string; meta: string; done: boolean; action?: { kind: 'prep' | 'close'; session: DaySession } | { kind: 'rate' } }

const durationLabel = (seconds: number | null) => seconds == null ? '' : seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
const SESSION_NAME: Record<DaySession, string> = { london: 'London', ny: 'New York' };

/** Poznámka „patří“ k obchodu, když ukazuje do jeho času (vstup −2 min až výstup +10 min). */
export function notesForTrade(notes: readonly DayNote[], trade: Trade): DayNote[] {
  const from = Math.floor(tradeTimeMs(trade) / 1000) - 120;
  const to = Math.floor(exitMs(trade) / 1000) + 600;
  return notes.filter(note => note.time != null && note.time >= from && note.time <= to);
}

export function dayChecklist(journal: DayJournal, trades: readonly Trade[], windows: SessionWindows, now: number): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const session of DAY_SESSIONS) {
    const prep = journal.preps[session];
    items.push({
      id: `prep:${session}`, label: `Příprava ${SESSION_NAME[session]}`, done: Boolean(prep),
      meta: prep ? [pragueClock(Date.parse(prep.writtenAt)), durationLabel(prep.durationSec)].filter(Boolean).join(' · ') : sessionStage(session, windows, now) === 'upcoming' ? `do ${pragueClock(windows[session].start)}` : 'chybí',
      action: { kind: 'prep', session },
    });
  }
  const rated = trades.filter(trade => planChoiceOf(trade)).length;
  if (trades.length) items.push({ id: 'rated', label: 'Ohodnocené obchody', meta: `${rated}/${trades.length}`, done: rated === trades.length, action: { kind: 'rate' } });
  const losses = trades.filter(trade => trade.pnl < 0 && !trade.isBE);
  if (losses.length) {
    const covered = losses.filter(trade => (trade.notes ?? '').trim() || notesForTrade(journal.notes, trade).length).length;
    items.push({ id: 'loss-notes', label: 'Poznámka u každé ztráty', meta: `${covered}/${losses.length}`, done: covered === losses.length });
  }
  for (const session of DAY_SESSIONS) {
    const close = journal.closes[session];
    const stage = sessionStage(session, windows, now);
    items.push({
      id: `close:${session}`, label: `Uzavřít ${SESSION_NAME[session]}`, done: Boolean(close),
      meta: close ? pragueClock(Date.parse(close.closedAt)) : stage === 'upcoming' ? `po ${pragueClock(windows[session].start)}` : 'čeká',
      action: { kind: 'close', session },
    });
  }
  return items;
}

// ── Časová osa ──────────────────────────────────────────────────────────

export type FeedItem =
  | { kind: 'prep'; key: string; at: number; session: DaySession; prep: DayPrep; pins: number }
  | { kind: 'note'; key: string; at: number; note: DayNote; phase: DayNotePhase }
  | { kind: 'trade'; key: string; at: number; trade: Trade; session: DayScope; plan: PlanChoice | null; notes: DayNote[] }
  | { kind: 'close'; key: string; at: number; session: DaySession; close: DayClose };

export function dayFeed(journal: DayJournal, trades: readonly Trade[], windows: SessionWindows, scope: DayViewScope): FeedItem[] {
  const inScope = (session: DayScope) => scope === 'day' || session === scope;
  const items: FeedItem[] = [];
  for (const session of DAY_SESSIONS) {
    const prep = journal.preps[session];
    if (prep && inScope(session)) {
      const pins = journal.notes.filter(note => note.session === session && note.origin === 'prep').length;
      items.push({ kind: 'prep', key: `prep:${session}`, at: Date.parse(prep.writtenAt), session, prep, pins });
    }
    const close = journal.closes[session];
    if (close && inScope(session)) items.push({ kind: 'close', key: `close:${session}`, at: Date.parse(close.writtenAt), session, close });
  }
  for (const note of journal.notes) {
    // Poznámky z přípravy jsou součástí karty přípravy, ne samostatné řádky.
    if (note.origin === 'prep' || !inScope(note.session === 'day' && note.time != null ? sessionAt(note.time * 1000, windows) : note.session)) continue;
    items.push({ kind: 'note', key: `note:${note.id}`, at: Date.parse(note.writtenAt), note, phase: notePhase(note, windows) });
  }
  for (const trade of trades) {
    const session = tradeScope(trade, windows);
    if (!inScope(session)) continue;
    items.push({ kind: 'trade', key: `trade:${trade.id}`, at: tradeTimeMs(trade), trade, session, plan: planChoiceOf(trade), notes: notesForTrade(journal.notes, trade) });
  }
  return items.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

// ── Řada posledních dnů ─────────────────────────────────────────────────

export type StreakState = 'full' | 'part' | 'none' | 'open';
export interface StreakDay { day: string; state: StreakState; title: string }

/** Posledních `count` obchodních dnů (po–pá) končících dnem `today`. */
export function tradingDaysBack(today: string, count: number): string[] {
  const out: string[] = [];
  const [y, m, d] = today.split('-').map(Number);
  for (let offset = 0; out.length < count && offset < count * 3; offset += 1) {
    const date = new Date(Date.UTC(y, m - 1, d - offset));
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    out.unshift(date.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Plný den = obě přípravy a uzavření každé session, ve které se obchodovalo
 * (aspoň jedno uzavření). Dnešek bez uzavření = otevřený.
 */
export function streakState(journal: DayJournal | undefined, tradeSessions: ReadonlySet<DayScope>, isToday: boolean): StreakState {
  const preps = journal ? DAY_SESSIONS.filter(session => journal.preps[session]).length : 0;
  const closes = journal ? DAY_SESSIONS.filter(session => journal.closes[session]).length : 0;
  const tradedClosed = DAY_SESSIONS.filter(session => tradeSessions.has(session)).every(session => journal?.closes[session]);
  if (preps === DAY_SESSIONS.length && closes > 0 && tradedClosed) return 'full';
  if (isToday) return 'open';
  return preps + closes + (journal?.notes.length ?? 0) > 0 ? 'part' : 'none';
}

const STREAK_TITLE: Record<StreakState, string> = { full: 'Kompletní den', part: 'Částečně', none: 'Bez žurnálu', open: 'Dnes · rozpracováno' };

export function dayStreak(days: readonly string[], journals: ReadonlyMap<string, DayJournal>, trades: readonly Trade[], windowsOf: (day: string) => SessionWindows, today: string): StreakDay[] {
  return days.map(day => {
    const windows = windowsOf(day);
    const sessions = new Set(tradesForDay(trades, day).map(trade => tradeScope(trade, windows)));
    const state = streakState(journals.get(day), sessions, day === today);
    return { day, state, title: STREAK_TITLE[state] };
  });
}

/** Krátký výtah přípravy pro kartu v časové ose. */
export function prepSummary(prep: DayPrep, pins: number): string {
  const parts = [prep.bias ? `Bias ${prep.bias === 'long' ? 'Long' : prep.bias === 'short' ? 'Short' : 'Neutrál'}` : 'Bez biasu'];
  const scenario = prep.scenario.trim();
  if (scenario) parts.push(scenario.length > 90 ? `${scenario.slice(0, 88)}…` : scenario);
  if (pins) parts.push(`${pins} ${pins === 1 ? 'poznámka' : pins < 5 ? 'poznámky' : 'poznámek'} v grafu`);
  return parts.join(' · ');
}

export const closeCarry = (close: DayClose | undefined) => close ? carryForward(close.summary) : '';

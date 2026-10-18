import { useEffect, useRef } from 'react';
import { REVIEW_FOCUS_EVENT } from '../CandleKitTradeChart';
import type { Trade } from '../../types';
import { DAY_ANCHOR_ACCOUNT_ID, type SessionWindows } from '../../lib/dayJournal';
import type { DayViewScope } from '../../lib/dayJournalView';
import type { DayMode } from './useDayController';
import type { DaySession } from '../../lib/dayJournal';
import type { DayBand } from './DayNotesLayer';
import { SESSION_STYLE } from './DayPrimitives';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Viditelný úsek grafu (ms) pro režim a rozsah. */
export function focusRange(params: { mode: DayMode; session: DaySession; scope: DayViewScope; windows: SessionWindows; now: number; isToday: boolean }): { from: number; to: number } {
  const { mode, session, scope, windows: w, now, isToday } = params;
  const cap = (end: number, minimum: number) => (isToday ? Math.min(end, Math.max(now + 45 * MIN, minimum)) : end);
  if (mode === 'prep') {
    // London: od včerejšího odpoledne (NY + Asie), NY: celé dopoledne; budoucnost session vpravo.
    return session === 'london'
      ? { from: w.london.start - 15 * HOUR, to: w.london.end + 30 * MIN }
      : { from: w.ny.start - 8.5 * HOUR, to: w.ny.end + 30 * MIN };
  }
  if (mode === 'close') {
    const window = w[session];
    return { from: window.start - 30 * MIN, to: cap(window.end, window.start + 2 * HOUR) + 15 * MIN };
  }
  if (scope === 'day') return { from: w.london.start - 2 * HOUR, to: cap(w.ny.end, w.london.start + 3 * HOUR) + 15 * MIN };
  const window = w[scope];
  return { from: window.start - 45 * MIN, to: cap(window.end, window.start + 2 * HOUR) + 15 * MIN };
}

/**
 * Úsek [A, B] → vstup/výstup pro review graf (ten k úseku přidá polovinu
 * jeho délky na každou stranu).
 */
export function focusTarget(range: { from: number; to: number }) {
  const quarter = Math.max(MIN, (range.to - range.from) / 4);
  return { entryMs: range.from + quarter, exitMs: Math.max(range.from + quarter + MIN, range.to - quarter) };
}

/**
 * Kotva grafu bez obchodu: review graf potřebuje „obchod“ — tenhle nemá
 * plnění ani SL, takže nic nekreslí, jen určí první záběr.
 */
export function dayAnchorTrade(day: string, target: { entryMs: number; exitMs: number }): Trade {
  return {
    id: `day:${day}`,
    accountId: DAY_ANCHOR_ACCOUNT_ID,
    instrument: 'MNQ',
    symbol: 'MNQ',
    signal: '',
    pnl: 0,
    date: day,
    direction: 'Long',
    timestamp: target.exitMs,
    entryTime: target.entryMs,
    durationMinutes: Math.round((target.exitMs - target.entryMs) / MIN),
  } as Trade;
}

/** Pásy London / NY (a včerejší NY v ranní přípravě). */
export function sessionBands(windows: SessionWindows, mode: DayMode, previousNy?: { start: number; end: number } | null): DayBand[] {
  const bands: DayBand[] = [];
  if (mode === 'prep' && previousNy) bands.push({ id: 'ny-prev', start: Math.floor(previousNy.start / 1000), end: Math.floor(previousNy.end / 1000), label: 'VČERA NY', color: 'rgba(249,115,22,0.55)', fill: 'rgba(249,115,22,0.035)' });
  for (const session of ['london', 'ny'] as const) {
    const tint = SESSION_STYLE[session].tint;
    bands.push({ id: session, start: Math.floor(windows[session].start / 1000), end: Math.floor(windows[session].end / 1000), label: SESSION_STYLE[session].name.toUpperCase(), color: `${tint}0.7)`, fill: `${tint}0.06)` });
  }
  return bands;
}

/**
 * Přesun záběru review grafu při změně režimu / rozsahu / výběru (událost
 * mimo React — graf se nepřekresluje). První záběr dává kotva grafu.
 */
export function useReviewFocus(focusKey: string, detail: { entryMs: number; exitMs: number; id: string }, ready: boolean, resetKey: string) {
  const last = useRef<string | null>(null);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  useEffect(() => { last.current = null; }, [resetKey]);
  useEffect(() => {
    if (!ready) return;
    if (last.current === null) { last.current = focusKey; return; }
    if (last.current === focusKey) return;
    last.current = focusKey;
    window.dispatchEvent(new CustomEvent(REVIEW_FOCUS_EVENT, { detail: detailRef.current }));
  }, [focusKey, ready]);
}

import type { Trade } from '../types';
import { tradeRMultiple } from '../utils/tradeRisk';
import { pragueDayKey, type DayJournal, type DayNote } from './dayJournal';
import { tradesForDay } from './dayJournalView';
import { MIND_AREAS, isMindArea, type MindArea } from './dayMind';
import { planChoiceOf, tradeTimeMs } from './weeklyReview';

/**
 * Přehled Hlava: každý osobní zápis s tím, co se ten den a v hodinách po
 * něm dělo v tradingu, a jednoduché souvislosti po oblastech (podíl obchodů
 * mimo plán ve dnech se zápisem dané oblasti a bez něj). Jen počty z dat —
 * žádné odhady; malé vzorky se označí.
 */

export const MIND_CONTEXT_MS = 2 * 60 * 60_000;

export interface MindTradeSummary { count: number; offPlan: number; rated: number; pnl: number; rSum: number | null }
export interface MindEntry {
  day: string;
  note: DayNote;
  areas: MindArea[];
  /** Celý den zápisu. */
  dayTrades: MindTradeSummary;
  /** Obchody otevřené do 2 h po zápisu. */
  after: MindTradeSummary;
}

const summarize = (trades: readonly Trade[]): MindTradeSummary => {
  let pnl = 0, offPlan = 0, rated = 0;
  let rSum: number | null = 0;
  for (const trade of trades) {
    pnl += Number(trade.pnl) || 0;
    const plan = planChoiceOf(trade);
    if (plan) rated += 1;
    if (plan === 'no') offPlan += 1;
    const r = tradeRMultiple(trade);
    rSum = r == null || rSum == null ? null : rSum + r;
  }
  return { count: trades.length, offPlan, rated, pnl, rSum: trades.length ? rSum : null };
};

const areasOf = (note: DayNote): MindArea[] => (note.areas ?? []).filter(isMindArea);

/** Zápisy Hlava od nejnovějšího, každý s obchody dne a do 2 h po zápisu. */
export function mindEntries(journals: readonly DayJournal[], trades: readonly Trade[]): MindEntry[] {
  const byDay = new Map<string, Trade[]>();
  const tradesOf = (day: string) => {
    let list = byDay.get(day);
    if (!list) { list = tradesForDay(trades, day); byDay.set(day, list); }
    return list;
  };
  const out: MindEntry[] = [];
  for (const journal of journals) {
    for (const note of journal.notes) {
      if (note.origin !== 'mind') continue;
      const written = Date.parse(note.writtenAt);
      // Den obchodů = den zápisu (poznámka dopsaná později patří ke dni deníku).
      const day = journal.day;
      const dayList = tradesOf(day);
      const writtenDay = Number.isFinite(written) ? pragueDayKey(written) : day;
      const afterList = (writtenDay === day ? dayList : tradesOf(writtenDay))
        .filter(trade => { const at = tradeTimeMs(trade); return at >= written && at <= written + MIND_CONTEXT_MS; });
      out.push({ day, note, areas: areasOf(note), dayTrades: summarize(dayList), after: summarize(afterList) });
    }
  }
  return out.sort((a, b) => Date.parse(b.note.writtenAt) - Date.parse(a.note.writtenAt));
}

export interface MindAreaCorrelation {
  area: MindArea;
  notes: number;
  /** Obchodní dny se zápisem oblasti / bez něj (jen dny s ohodnocenými obchody). */
  daysWith: number;
  daysWithout: number;
  offPlanWith: number | null;
  offPlanWithout: number | null;
  /** Mimo plán v obchodech do 2 h po zápisu oblasti. */
  offPlanAfter: number | null;
  ratedAfter: number;
}

const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/**
 * Souvislosti po oblastech v obchodních dnech `days`. Podíl mimo plán =
 * obchody „mimo plán“ / ohodnocené obchody.
 */
export function mindCorrelations(entries: readonly MindEntry[], trades: readonly Trade[], days: readonly string[]): { areas: MindAreaCorrelation[]; daysWithoutMind: number | null } {
  const dayStats = new Map(days.map(day => [day, summarize(tradesForDay(trades, day))]));
  const tradingDays = days.filter(day => (dayStats.get(day)?.count ?? 0) > 0);
  const mindDays = new Set(entries.map(entry => entry.day));
  const areas = MIND_AREAS.map((area): MindAreaCorrelation => {
    const withArea = entries.filter(entry => entry.areas.includes(area));
    const areaDays = new Set(withArea.map(entry => entry.day));
    let offWith = 0, ratedWith = 0, offWithout = 0, ratedWithout = 0, daysWith = 0, daysWithout = 0;
    for (const day of tradingDays) {
      const stats = dayStats.get(day)!;
      if (!stats.rated) continue;
      if (areaDays.has(day)) { offWith += stats.offPlan; ratedWith += stats.rated; daysWith += 1; } else { offWithout += stats.offPlan; ratedWithout += stats.rated; daysWithout += 1; }
    }
    const offAfter = withArea.reduce((sum, entry) => sum + entry.after.offPlan, 0);
    const ratedAfter = withArea.reduce((sum, entry) => sum + entry.after.rated, 0);
    return {
      area, notes: withArea.length, daysWith, daysWithout,
      offPlanWith: share(offWith, ratedWith), offPlanWithout: share(offWithout, ratedWithout),
      offPlanAfter: share(offAfter, ratedAfter), ratedAfter,
    };
  }).filter(item => item.notes > 0);
  return { areas, daysWithoutMind: share(tradingDays.filter(day => !mindDays.has(day)).length, tradingDays.length) };
}

/** Počty zápisů po oblastech (štítky filtru). */
export function mindAreaCounts(entries: readonly MindEntry[]): Partial<Record<MindArea, number>> {
  const counts: Partial<Record<MindArea, number>> = {};
  for (const entry of entries) for (const area of entry.areas) counts[area] = (counts[area] ?? 0) + 1;
  return counts;
}

import type { DailyPrep, DailyReview, RuleCompletion } from '../types';

export interface RuleAdherenceStat {
  /** Dny, kdy bylo pravidlo označené jako splněné. */
  passed: number;
  /** Dny, kdy bylo pravidlo vůbec vyhodnocené (splněno / nesplněno). */
  evaluated: number;
  /** Nejstarší započítaný den (YYYY-MM-DD), pokud nějaký je. */
  since: string | null;
}

const decided = (entry: RuleCompletion | undefined): 'Pass' | 'Fail' | null =>
  entry?.status === 'Pass' || entry?.status === 'Fail' ? entry.status : null;

/**
 * Dodržení každého pravidla za posledních `limit` dní, kdy bylo vyhodnocené
 * (ne kalendářních — po pauze v deníku by jinak sloupec zůstal prázdný).
 * Večerní review má přednost před ranní přípravou: rituál odškrtnutý ráno
 * může večer dostat „nesplněno“. Dny bez rozhodnutí (Pending / bez záznamu)
 * se nepočítají, stejně jako dny po `today`.
 */
export function ruleAdherenceRecent(
  ruleIds: readonly string[],
  preps: readonly DailyPrep[],
  reviews: readonly DailyReview[],
  today: string,
  limit = 30,
): Record<string, RuleAdherenceStat> {
  const prepByDate = new Map<string, DailyPrep>();
  preps.forEach(prep => { if (prep?.date && prep.date <= today) prepByDate.set(prep.date, prep); });
  const reviewByDate = new Map<string, DailyReview>();
  reviews.forEach(review => { if (review?.date && review.date <= today) reviewByDate.set(review.date, review); });
  const dates = [...new Set([...prepByDate.keys(), ...reviewByDate.keys()])].sort().reverse();

  const result: Record<string, RuleAdherenceStat> = {};
  ruleIds.forEach(ruleId => {
    const stat: RuleAdherenceStat = { passed: 0, evaluated: 0, since: null };
    for (const date of dates) {
      if (stat.evaluated >= limit) break;
      const status = decided(reviewByDate.get(date)?.ruleAdherence?.find(entry => entry?.ruleId === ruleId))
        ?? decided(prepByDate.get(date)?.ritualCompletions?.find(entry => entry?.ruleId === ruleId));
      if (!status) continue;
      stat.evaluated += 1;
      stat.since = date;
      if (status === 'Pass') stat.passed += 1;
    }
    result[ruleId] = stat;
  });
  return result;
}

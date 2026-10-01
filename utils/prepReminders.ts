import type { DailyPrep, SessionConfig } from '../types';

/** Dnešní datum ve tvaru YYYY-MM-DD podle místního času. */
export const getTodayStr = (date: Date = new Date()) => {
  const d = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
  return d.toISOString().split('T')[0];
};

const parseTimeToMinutes = (timeStr: string) => {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
};

export interface PrepReminderState {
  isPrepMissing: boolean;
  nextSession: { session: SessionConfig; minutesToStart: number } | null;
}

/**
 * Podklad pro připomínky přípravy před seancí (60/15 min). Nic neblokuje ani
 * neotevírá — dříve to byla součást Guardiana, zůstaly jen notifikace.
 */
export function getPrepReminderState(sessions: SessionConfig[], preps: DailyPrep[], currentTime: Date = new Date()): PrepReminderState {
  const todayStr = getTodayStr(currentTime);
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  let nextSession: PrepReminderState['nextSession'] = null;

  sessions.forEach(s => {
    const start = parseTimeToMinutes(s.startTime);
    const end = parseTimeToMinutes(s.endTime);
    const isOvernight = end < start;
    const isActive = isOvernight
      ? (currentMinutes >= start || currentMinutes < end)
      : (currentMinutes >= start && currentMinutes < end);
    if (isActive) return;
    let diff = start - currentMinutes;
    if (diff < 0) diff += 24 * 60;
    if (!nextSession || diff < nextSession.minutesToStart) nextSession = { session: s, minutesToStart: diff };
  });

  return { isPrepMissing: !preps.some(p => p.date === todayStr), nextSession };
}

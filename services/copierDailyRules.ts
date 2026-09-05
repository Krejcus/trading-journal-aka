import { tradingWindowSlotsOf, type CopyGroupTradingWindow, type DayLockTrigger } from './liveCopyTrading';

export type CopierTradingWindowState = 'inside' | 'outside' | 'off';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
};

export const clockMinutes = (value: string): number => {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};

export function zonedMinuteOfDay(at: number, timeZone: string): number | null {
  if (!Number.isFinite(at)) return null;
  try {
    const parts = formatterFor(timeZone).formatToParts(new Date(at));
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    return Number.isSafeInteger(hour) && Number.isSafeInteger(minute)
      ? hour * 60 + minute
      : null;
  } catch {
    return null;
  }
}

/** Konec posledního okna dne (minuta dne). */
export const lastTradingWindowEnd = (window: CopyGroupTradingWindow): number => (
  Math.max(...tradingWindowSlotsOf(window).map(slot => clockMinutes(slot.to)))
);

/** „15:30–22:00, 23:00–23:30" — pro audit, chyby ARM a UI. */
export const formatTradingWindows = (window: CopyGroupTradingWindow): string => (
  tradingWindowSlotsOf(window).map(slot => `${slot.from}–${slot.to}`).join(', ')
);

/** Start is inclusive, end is exclusive; inside = uvnitř kteréhokoli okna. Invalid zone evidence is outside. */
export function tradingWindowStateAt(
  window: CopyGroupTradingWindow,
  at: number,
): CopierTradingWindowState {
  if (!window.enabled) return 'off';
  const minute = zonedMinuteOfDay(at, window.timeZone);
  if (minute == null) return 'outside';
  return tradingWindowSlotsOf(window).some(slot => (
    minute >= clockMinutes(slot.from) && minute < clockMinutes(slot.to)
  ))
    ? 'inside'
    : 'outside';
}

/** Po konci POSLEDNÍHO okna dne (mezera mezi okny není konec). */
export function isAfterTradingWindowsAt(
  window: CopyGroupTradingWindow,
  at: number,
): boolean {
  if (!window.enabled) return false;
  const minute = zonedMinuteOfDay(at, window.timeZone);
  if (minute == null) return false;
  return minute >= lastTradingWindowEnd(window);
}

export function isTradingWindowWarningAt(
  window: CopyGroupTradingWindow,
  at: number,
): boolean {
  if (!window.enabled) return false;
  const minute = zonedMinuteOfDay(at, window.timeZone);
  if (minute == null) return false;
  const end = lastTradingWindowEnd(window);
  return minute >= end - 10 && minute < end;
}

export function dayLockRuleLabel(trigger: DayLockTrigger): string {
  switch (trigger) {
    case 'manual': return 'Ruční zámek';
    case 'daily-loss': return 'Denní ztrátový limit';
    case 'losing-trades': return 'Max. ztrátových obchodů';
    case 'max-trades': return 'Max. obchodů';
    case 'window-end': return 'Konec obchodního okna';
  }
}

/**
 * Přehrávání grafu dne na telefonu: kurzor v unixových sekundách nad 1m
 * svíčkami dne. Čisté funkce (testované); stav a časovač drží komponenta.
 */

export const DAY_REPLAY_SPEEDS = [1, 3, 10, 30] as const;
export type DayReplaySpeed = (typeof DAY_REPLAY_SPEEDS)[number];

/** Jeden krok přehrávání = jedna 1m svíčka. */
export const DAY_REPLAY_STEP_S = 60;
/** Při rychlosti 1× trvá krok 600 ms (10 min trhu za 6 s). */
export const DAY_REPLAY_TICK_MS = 600;

/** Interval časovače pro rychlost. */
export const dayReplayTickMs = (speed: DayReplaySpeed) => Math.max(20, Math.round(DAY_REPLAY_TICK_MS / speed));

/** Další rychlost v kolečku (po poslední zase první). */
export function nextDayReplaySpeed(speed: DayReplaySpeed): DayReplaySpeed {
  const index = DAY_REPLAY_SPEEDS.indexOf(speed);
  return DAY_REPLAY_SPEEDS[(index + 1) % DAY_REPLAY_SPEEDS.length];
}

/** Rozsah přehrávání: od začátku okna (nebo první svíčky) po poslední svíčku. */
export function dayReplayRange(candleTimes: readonly number[], fromSec: number | null): { start: number; end: number } | null {
  if (!candleTimes.length) return null;
  const first = candleTimes[0];
  const end = candleTimes[candleTimes.length - 1];
  const start = fromSec == null ? first : Math.min(end, Math.max(first, Math.floor(fromSec / 60) * 60));
  return { start, end };
}

/** Posun kurzoru o `steps` svíček, sevřený do rozsahu. */
export function stepDayReplay(cursor: number, steps: number, range: { start: number; end: number }): number {
  return Math.min(range.end, Math.max(range.start, cursor + steps * DAY_REPLAY_STEP_S));
}

/** Svíčky do kurzoru (včetně) — co by trader v tu chvíli viděl. */
export function candlesUntil<T extends { time: number }>(candles: readonly T[], cursor: number | null): T[] {
  if (cursor == null) return candles as T[];
  // Svíčky jsou seřazené: binární hledání posledního indexu <= kurzor.
  let low = 0;
  let high = candles.length - 1;
  let last = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (candles[middle].time <= cursor) { last = middle; low = middle + 1; } else high = middle - 1;
  }
  return candles.slice(0, last + 1);
}

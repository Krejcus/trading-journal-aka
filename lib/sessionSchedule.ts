/** Výpočty pro časovou osu seancí v Nastavení (časy „HH:MM“ v rámci jednoho dne). */

const DAY_MINUTES = 1440;

export function timeToMinutes(value: string | undefined): number {
  const [hours, minutes] = String(value ?? '').split(':').map(Number);
  const total = (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
  return Math.min(DAY_MINUTES, Math.max(0, total));
}

/** Úseky seance v minutách dne; seance přes půlnoc (22:00–02:00) má dva úseky. */
export function sessionSegments(start: string | undefined, end: string | undefined): Array<[number, number]> {
  const from = timeToMinutes(start);
  const to = timeToMinutes(end);
  if (from === to) return [];
  if (to > from) return [[from, to]];
  return [[from, DAY_MINUTES], [0, to]].filter(([a, b]) => b > a) as Array<[number, number]>;
}

export function sessionDurationMinutes(start: string | undefined, end: string | undefined): number {
  return sessionSegments(start, end).reduce((sum, [a, b]) => sum + (b - a), 0);
}

export function sessionOverlapMinutes(
  a: { startTime?: string; endTime?: string },
  b: { startTime?: string; endTime?: string },
): number {
  let total = 0;
  for (const [a1, a2] of sessionSegments(a.startTime, a.endTime)) {
    for (const [b1, b2] of sessionSegments(b.startTime, b.endTime)) {
      total += Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
    }
  }
  return total;
}

/** 45 → „45 min“, 360 → „6 h“, 390 → „6:30 h“. */
export function formatSessionDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)}${rest ? `:${String(rest).padStart(2, '0')}` : ''} h`;
}

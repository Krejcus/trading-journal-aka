/**
 * Konec denní seance CME Globex (futures na indexy): 16:00 chicagského času, pondělí až pátek.
 * Jen pro UPOZORNĚNÍ na obrazovce — nic podle toho neobchoduje ani neruší.
 */
const CHICAGO_MINUTES = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });

/** Kolik minut zbývá do konce dnešní seance; null mimo obchodní den nebo po jejím konci. */
export function minutesToCmeSessionClose(nowMs: number): number | null {
  const parts = Object.fromEntries(CHICAGO_MINUTES.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return null;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const left = 16 * 60 - minutes;
  return left > 0 ? left : null;
}

/** Text varování, když do konce seance zbývá nejvýš `within` minut a účet má pozici nebo čekající příkaz. */
export function cmeSessionCloseWarning(nowMs: number, exposure: { position: boolean; pendingEntry: boolean }, within = 15): string | null {
  const left = minutesToCmeSessionClose(nowMs);
  if (left === null || left > within || (!exposure.position && !exposure.pendingEntry)) return null;
  const what = exposure.position
    ? 'burza pak zruší SL i TP a pozice zůstane BEZ ochrany: zavři ji, nebo s tím počítej (po otevření trhu ochranu zadej znovu)'
    : 'čekající vstup burza na konci seance zruší';
  return `Za ${left} min končí burzovní seance (hodinová přestávka) — ${what}.`;
}

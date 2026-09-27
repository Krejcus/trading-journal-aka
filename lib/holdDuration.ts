/**
 * Délka držení obchodu z přesných časů (ms): pod minutu na vteřiny, pod
 * hodinu minuty a vteřiny, pak hodiny a minuty, od dne dny a hodiny.
 * Bez platných časů null — volající použije uložené `duration`.
 */
export function formatHoldDuration(entryMs: unknown, exitMs: unknown): string | null {
  const from = typeof entryMs === 'number' ? entryMs : Date.parse(String(entryMs));
  const to = typeof exitMs === 'number' ? exitMs : Date.parse(String(exitMs));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

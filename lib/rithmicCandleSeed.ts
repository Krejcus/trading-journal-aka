/**
 * Svíčky po (znovu)připojení ke službě. Služba posílá dvě úvodní zprávy: nejdřív svíčky od svého startu, potom
 * celou historii. Kdyby se graf pokaždé přepsal tím, co zrovna přišlo, po návratu do appky by dvakrát přeskočil
 * (krátká řada → dlouhá řada). Proto se nová řada se stávající SPOJUJE: starší svíčky zůstanou, od první nové
 * svíčky dál platí nová data. Jen zobrazení.
 */
export interface SeedCandle { time: number }

export function mergeSeedCandles<T extends SeedCandle>(current: readonly T[], incoming: readonly T[], sameSource: boolean): T[] {
  if (!incoming.length) return sameSource ? [...current] : [];
  // Jiný zdroj (účet, systém, kontrakt), nebo nová řada sahá stejně daleko či dál do minulosti → platí celá nová.
  if (!sameSource || !current.length || incoming[0].time <= current[0].time) return [...incoming];
  const from = incoming[0].time;
  const older = current.filter((bar) => bar.time < from);
  return [...older, ...incoming];
}

type DisplayBar = SeedCandle & { open: number; high: number; low: number; close: number; volume: number };

/** The replay and the local ticks can both contain the boundary minute. Their volumes overlap. */
export function mergeRithmicDisplayHistory(history: readonly DisplayBar[], live: readonly DisplayBar[]): DisplayBar[] {
  const last = history.at(-1);
  if (!last) return [...live];
  const tail = live.filter(bar => bar.time >= last.time);
  const boundary = tail[0];
  if (boundary?.time !== last.time) return [...history, ...tail];
  return [...history.slice(0, -1), {
    ...last, high: Math.max(last.high, boundary.high), low: Math.min(last.low, boundary.low),
    close: boundary.close, volume: Math.max(last.volume, boundary.volume),
  }, ...tail.slice(1)];
}

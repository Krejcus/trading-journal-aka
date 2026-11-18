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

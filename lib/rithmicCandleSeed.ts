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

/**
 * Opravené svíčky ze zprávy `bars` (služba je posílá po výpadku spojení pro ceny): dokončené minuty se v grafu
 * nahradí správnými z historie a chybějící se doplní. Co je dokončené, říká SLUŽBA (`throughSec` = poslední
 * dokončená minuta zprávy) — hodiny zařízení se nepoužívají (telefon je může mít posunuté). Novější minuta se
 * nepřepisuje (tu dál skládají ticky) a nic se nepřidává před začátek řady, kterou graf má. Jen zobrazení.
 */
export function patchSeedCandles<T extends SeedCandle>(current: readonly T[], repaired: readonly T[], throughSec: number): T[] {
  if (!current.length || !repaired.length || !Number.isFinite(throughSec)) return [...current];
  const first = current[0].time;
  const usable = repaired.filter((bar) => Number.isFinite(bar.time) && bar.time >= first && bar.time <= throughSec);
  if (!usable.length) return [...current];
  const byTime = new Map<number, T>();
  for (const bar of current) byTime.set(bar.time, bar);
  for (const bar of usable) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

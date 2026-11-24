/**
 * Oprava svíček po výpadku spojení pro ceny (24. 11. 2026). JEN ZOBRAZENÍ — nic odsud nerozhoduje o příkazech.
 *
 * Svíčky služba skládá z ticků. Když spojení pro ceny spadne a obnoví se, minuta obnovy začíná až prvním tickem po
 * obnově (chybí jí otevření a kus rozsahu) a minuty uvnitř výpadku chybí celé. Stránka, která zůstala otevřená,
 * by tu neúplnou svíčku ukazovala napořád (telefon připojený později dostane z historie správnou → dva různé grafy).
 * Proto si služba po skončení minuty obnovy jedním malým dotazem přečte dotčené minuty z historie Rithmicu a pošle
 * je stránkám jako zprávu `bars`.
 */
export interface RepairBar { time: number; open: number; high: number; low: number; close: number; volume: number }

/** Nejdelší výpadek, který se doplňuje jedním dotazem (starší svíčky přinese běžná historie při dalším připojení). */
export const BAR_REPAIR_MAX_SPAN_SEC = 6 * 3_600;
/** Jak dlouho po skončení minuty obnovy se čeká, než ji historie Rithmicu má. */
export const BAR_REPAIR_SETTLE_MS = 8_000;

export interface BarRepairWindow {
  /** První opravovaná minuta (včetně), sekundy. */
  fromSec: number;
  /** Minuta obnovy = poslední opravovaná (včetně), sekundy. */
  lastSec: number;
  /** Kdy se smí ptát (minuta obnovy skončila a historie ji má), ms. */
  dueAtMs: number;
}

export function barRepairWindow(gapFromMs: number, restoredAtMs: number): BarRepairWindow {
  const lastSec = Math.floor(restoredAtMs / 60_000) * 60;
  // O minutu dřív: pád spojení se pozná až chvíli po posledním ticku (napůl mrtvé spojení), start procesu může
  // přejít přes hranici minuty.
  const gapSec = Math.floor(Math.min(gapFromMs, restoredAtMs) / 60_000) * 60 - 60;
  return { fromSec: Math.max(gapSec, lastSec - BAR_REPAIR_MAX_SPAN_SEC), lastSec, dueAtMs: (lastSec + 60) * 1_000 + BAR_REPAIR_SETTLE_MS };
}

/** Dvě čekající opravy (spojení se rozpadá opakovaně) se sloučí do jedné: jedno okno, jeden dotaz. */
export function mergeRepairWindows(a: BarRepairWindow, b: BarRepairWindow): BarRepairWindow {
  const lastSec = Math.max(a.lastSec, b.lastSec);
  return { fromSec: Math.max(Math.min(a.fromSec, b.fromSec), lastSec - BAR_REPAIR_MAX_SPAN_SEC), lastSec, dueAtMs: Math.max(a.dueAtMs, b.dueAtMs) };
}

/**
 * Z odpovědi historie jen dokončené svíčky okna, seřazené. `complete` = je mezi nimi i minuta obnovy (na zavřeném
 * trhu nebo v minutě bez obchodu být nemusí — pak se pošle, co je, a dál se neptá).
 */
export function repairedBarsFrom(rows: readonly RepairBar[], window: BarRepairWindow): { bars: RepairBar[]; complete: boolean } {
  const byTime = new Map<number, RepairBar>();
  for (const row of rows) {
    if (![row.time, row.open, row.high, row.low, row.close].every(Number.isFinite)) continue;
    if (row.time < window.fromSec || row.time > window.lastSec) continue;
    byTime.set(row.time, { time: row.time, open: row.open, high: row.high, low: row.low, close: row.close, volume: Number.isFinite(row.volume) ? row.volume : 0 });
  }
  return { bars: [...byTime.values()].sort((a, b) => a.time - b.time), complete: byTime.has(window.lastSec) };
}

/** Opravené svíčky do řady historie: stejné minuty nahradí, chybějící vloží; řada zůstává seřazená. */
export function mergeRepairedBars<T extends { time: number }>(history: readonly T[], repaired: readonly T[]): T[] {
  if (!repaired.length) return [...history];
  const byTime = new Map<number, T>();
  for (const bar of history) byTime.set(bar.time, bar);
  for (const bar of repaired) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Helper for resolving the "session-relevant" time of a trade.
 *
 * Většina widgetů (Session breakdown, Tactical Timeline, Weekly Overview, hourly
 * stats) chce zobrazit obchod podle toho **kdy se entoval**, ne kdy se zavřel.
 *
 * Bez tohoto helperu obchod entrnutý v NY session (např. 21:55) ale zavřený
 * po jejím konci (22:30) padá mimo NY → P&L "zmizí" z widgetu.
 *
 * Priorita: entryTime (number ms) → entryDate (ISO string) → timestamp (exit fallback).
 */
export function getTradeEntryDate(trade: { entryTime?: any; entryDate?: any; timestamp?: any }): Date {
  let entryMs: number | null = null;
  if (trade.entryTime != null) {
    const n = Number(trade.entryTime);
    if (!isNaN(n) && n > 0) entryMs = n;
  }
  if (entryMs == null && trade.entryDate) {
    const n = new Date(trade.entryDate).getTime();
    if (!isNaN(n) && n > 0) entryMs = n;
  }
  return new Date(entryMs ?? trade.timestamp ?? Date.now());
}

/** Minuta dne (0–1439) pro entry čas obchodu. Použít pro session/hour binning. */
export function getTradeEntryMinuteOfDay(trade: { entryTime?: any; entryDate?: any; timestamp?: any }): number {
  const d = getTradeEntryDate(trade);
  return d.getHours() * 60 + d.getMinutes();
}

import type { Trade } from '../types';

// Entry čas obchodu (epoch ms) s fallbackem — historie se řadí podle OTEVŘENÍ pozice, ne exitu.
// entryTime (epoch) → entryDate (ISO) → timestamp (exit epoch) → date (exit ISO).
export const historyEntryMs = (t: any): number => {
  if (typeof t?.entryTime === 'number' && t.entryTime > 0) return t.entryTime;
  if (t?.entryDate) { const p = Date.parse(t.entryDate); if (!isNaN(p)) return p; }
  if (typeof t?.timestamp === 'number' && t.timestamp > 0) return t.timestamp;
  const d = Date.parse(t?.date); return isNaN(d) ? 0 : d;
};

/** Neplatný obchod: v Historii je jen v sekci „Mimo plán“, ne mezi kartami. */
export const isInvalidHistoryTrade = (t: Trade): boolean =>
  ((t as any).executionStatus || ((t as any).isValid === false ? 'Invalid' : 'Valid')) === 'Invalid';

/** Karty Historie v pořadí, jak je stránka ukáže (bez neplatných, nejnovější vstup první). */
export const historyCardOrder = (trades: readonly Trade[]): Trade[] =>
  trades.filter(trade => !isInvalidHistoryTrade(trade)).sort((a, b) => historyEntryMs(b) - historyEntryMs(a));

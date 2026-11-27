/**
 * Bubliny velkých obchodů: výběr toho, co se kreslí, a velikost kruhu. Čisté funkce pro indikátor
 * Bubliny — jen zobrazení.
 */
import type { OrderFlowTrade } from '../lib/orderFlowStore';

/**
 * Obchody od `minSize` výš, nejvýš `maxCount` největších, seřazené od největšího (kreslí se první,
 * menší zůstanou navrchu a jsou vidět).
 */
export function selectOrderFlowBubbles(trades: readonly OrderFlowTrade[], minSize: number, maxCount: number): OrderFlowTrade[] {
  const limit = Math.max(1, Math.floor(maxCount));
  const picked = trades.filter((trade) => trade.size >= minSize);
  picked.sort((a, b) => b.size - a.size || a.at - b.at);
  return picked.length > limit ? picked.slice(0, limit) : picked;
}

/** Poloměr v pixelech: plocha roste s velikostí obchodu proti prahu, shora omezená. */
export function orderFlowBubbleRadius(size: number, minSize: number, scale: number): number {
  const ratio = Math.max(1, size / Math.max(1, minSize));
  return Math.min(34, (3 + 4 * Math.sqrt(ratio)) * Math.min(3, Math.max(0.3, scale)));
}

/** Krátký zápis velikosti do bubliny: 950, 1,2k. */
export function orderFlowSizeLabel(size: number): string {
  const value = Math.round(size);
  return value < 1_000 ? String(value) : `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace('.', ',')}k`;
}

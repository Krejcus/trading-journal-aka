import type { TradeEntryOrder } from './journalEntryOrders.js';

/**
 * „Kdybys ho nezrušil“: co by zrušený vstupní příkaz udělal dál podle svíček.
 * Jako u backtestu — limit se vyplní dotykem ceny, potom rozhoduje první
 * dotyk bracketu (SL/TP). Svíčka, ve které padne SL i TP, je nejasná.
 * Počítá se od první celé minuty po zrušení (dřív by se vyplnil skutečně).
 */
export interface OutcomeCandle { time: number; high: number; low: number }

export type EntryOrderOutcome =
  | { kind: 'nofill'; closestAt: number; closestPrice: number; missBy: number }
  | { kind: 'fill'; fillAt: number; price: number; result: 'tp' | 'sl' | 'ambiguous' | 'open'; resultAt: number | null; exitPrice: number | null; points: number | null };

/** Jak daleko dopředu se hledá vyplnění a výsledek. */
export const OUTCOME_HORIZON_MS = 6 * 60 * 60_000;

export function cancelledOrderOutcome(order: TradeEntryOrder, candles: readonly OutcomeCandle[], horizonMs = OUTCOME_HORIZON_MS): EntryOrderOutcome | null {
  if (order.end?.kind !== 'cancel' || !order.legs.length) return null;
  const price = order.legs[order.legs.length - 1].price;
  const sell = order.side === 'Sell';
  const from = order.end.at, until = from + horizonMs;
  const after = candles.filter(candle => candle.time * 1000 >= from && candle.time * 1000 <= until)
    .sort((a, b) => a.time - b.time);
  if (!after.length) return null;
  // Sell limit / buy stop čekají nahoře, buy limit / sell stop dole.
  const above = (order.type === 'Limit') === sell;
  const fillIndex = after.findIndex(candle => above ? candle.high >= price : candle.low <= price);
  if (fillIndex < 0) {
    const closest = after.reduce((best, candle) => (above ? candle.high > best.high : candle.low < best.low) ? candle : best, after[0]);
    const closestPrice = above ? closest.high : closest.low;
    return { kind: 'nofill', closestAt: closest.time * 1000, closestPrice, missBy: Math.abs(price - closestPrice) };
  }
  const fill = after[fillIndex];
  const sl = order.bracket?.sl ?? null, tp = order.bracket?.tp ?? null;
  const base = { kind: 'fill' as const, fillAt: fill.time * 1000, price };
  if (sl == null && tp == null) return { ...base, result: 'open', resultAt: null, exitPrice: null, points: null };
  const signed = (exit: number) => (sell ? price - exit : exit - price);
  for (const candle of after.slice(fillIndex)) {
    const hitSl = sl != null && (sell ? candle.high >= sl : candle.low <= sl);
    const hitTp = tp != null && (sell ? candle.low <= tp : candle.high >= tp);
    if (hitSl && hitTp) return { ...base, result: 'ambiguous', resultAt: candle.time * 1000, exitPrice: null, points: null };
    if (hitSl) return { ...base, result: 'sl', resultAt: candle.time * 1000, exitPrice: sl, points: signed(sl!) };
    if (hitTp) return { ...base, result: 'tp', resultAt: candle.time * 1000, exitPrice: tp, points: signed(tp!) };
  }
  return { ...base, result: 'open', resultAt: null, exitPrice: null, points: null };
}

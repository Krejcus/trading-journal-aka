import type { MarketCandle } from '../services/marketDataCalculations';

/**
 * Review: nová data jsou stejná série, jen delší nebo s obnovenou poslední
 * svíčkou (živé čtení), případně se zepředu dotáhla starší historie — první
 * svíčka předchozích dat je v nových na stejném čase se stejnou cenou. Jiný
 * kontrakt se liší cenou (rollover ~300 bodů), jiný týden časem.
 */
export function sameCandleSeries(previous: readonly Pick<MarketCandle, 'time' | 'open' | 'close'>[], next: readonly Pick<MarketCandle, 'time' | 'open' | 'close'>[]): boolean {
  if (!previous.length || !next.length || next.length < previous.length - 1) return false;
  const a = previous[0];
  // Data jsou seřazená podle času: dotažená historie posune první svíčku dopředu v poli.
  const b = next[0].time === a.time ? next[0] : next.find(candle => candle.time === a.time);
  return b != null && a.open === b.open && a.close === b.close;
}

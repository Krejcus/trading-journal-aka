import type { MarketCandle } from '../services/marketDataCalculations';

/**
 * Review: nová data jsou stejná série, jen delší nebo s obnovenou poslední
 * svíčkou (živé čtení) — začátek i první cena sedí. Jiný kontrakt se liší
 * cenou (rollover ~300 bodů), jiný týden časem první svíčky.
 */
export function sameCandleSeries(previous: readonly Pick<MarketCandle, 'time' | 'open' | 'close'>[], next: readonly Pick<MarketCandle, 'time' | 'open' | 'close'>[]): boolean {
  if (!previous.length || !next.length || next.length < previous.length - 1) return false;
  const a = previous[0], b = next[0];
  return a.time === b.time && a.open === b.open && a.close === b.close;
}

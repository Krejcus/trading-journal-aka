import { aggregateCandles, MARKET_TIMEFRAME_MINUTES, type MarketCandle, type MarketTimeframe } from './marketData';

/**
 * Rozpracovaná svíčka plynulého Bar Replaye na libovolném timeframu.
 *
 * Mezi kroky se další 1m svíčka „rodí“ po cestě z `candleReplayPath`. Na 1m
 * grafu je to přímo ona, na vyšším timeframu bar, do kterého patří — stejnou
 * agregací jako zbytek grafu. Kurzor je čas poslední odkryté 1m svíčky.
 *
 * Výpočet je rozdělený: základ (poslední hotový bar z odkrytých svíček) se
 * spočítá jednou za krok, slití s rozpracovanou minutou pak v každém snímku
 * animace jen jedním zarovnáním času.
 */
export const formingReplayBase = (
  rawCandles: readonly MarketCandle[],
  cursorTime: number,
  timeframe: MarketTimeframe,
): MarketCandle | null => {
  const minutes = MARKET_TIMEFRAME_MINUTES[timeframe];
  if (!Number.isFinite(minutes) || minutes <= 1) return null;
  // Celý interval aktuálního baru se vejde do posledních `minutes` 1m svíček.
  const tail: MarketCandle[] = [];
  for (let index = rawCandles.length - 1; index >= 0; index -= 1) {
    const candle = rawCandles[index];
    if (candle.time > cursorTime) continue;
    if (candle.time <= cursorTime - minutes * 60) break;
    tail.push(candle);
  }
  tail.reverse();
  return aggregateCandles(tail, timeframe).at(-1) ?? null;
};

export const formingReplayBar = (
  base: MarketCandle | null,
  partial: MarketCandle,
  timeframe: MarketTimeframe,
): MarketCandle => {
  const own = aggregateCandles([partial], timeframe)[0] ?? partial;
  if (!base || base.time !== own.time) return own;
  return {
    time: base.time,
    open: base.open,
    high: Math.max(base.high, partial.high),
    low: Math.min(base.low, partial.low),
    close: partial.close,
    volume: base.volume + partial.volume,
  };
};

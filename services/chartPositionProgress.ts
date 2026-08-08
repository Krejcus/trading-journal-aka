import type { MarketCandle } from './marketData';
import { isPositionDrawing, type PositionDrawing } from './chartPositionDrawing';

export type PositionProgressOutcome = 'open' | 'target' | 'stop';

export interface PositionProgress {
  entryTime: number;
  currentTime: number;
  entryPrice: number;
  currentPrice: number;
  outcome: PositionProgressOutcome;
  profitable: boolean;
}

const touches = (candle: MarketCandle, price: number): boolean => (
  candle.low <= price && candle.high >= price
);

/**
 * Index první svíčky s časem >= `time`. Svíčky chodí seřazené, takže hledáme
 * půlením — renderer tuhle funkci volá při každém překreslení pro každou
 * pozici, takže lineární průchod (a hlavně alokace odfiltrovaného pole) se
 * na dlouhé historii sečetl do desítek sekund zamrzlého vlákna.
 */
const firstIndexAtOrAfter = (candles: MarketCandle[], time: number): number => {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (candles[mid].time < time) low = mid + 1;
    else high = mid;
  }
  return low;
};

/**
 * Derives the replay-only visual progress of a Long/Short Position drawing.
 * Nothing is persisted back into the drawing: its planned width and anchors
 * therefore remain fully editable while the replay advances.
 */
export const calculatePositionProgress = (
  drawing: PositionDrawing,
  candles: MarketCandle[],
): PositionProgress | null => {
  if (!isPositionDrawing(drawing) || drawing.points.length < 3 || candles.length === 0) return null;
  const [entryPoint, targetPoint, stopPoint] = drawing.points;
  const boxEndTime = Math.max(targetPoint.time, stopPoint.time);
  // Úsek [rangeStart, rangeEnd) místo odfiltrovaného pole — stejné svíčky,
  // jen bez kopie celé historie při každém překreslení.
  const rangeStart = firstIndexAtOrAfter(candles, entryPoint.time);
  const rangeEnd = firstIndexAtOrAfter(candles, boxEndTime + 1);

  let entryIndex = -1;
  for (let index = rangeStart; index < rangeEnd; index += 1) {
    if (touches(candles[index], entryPoint.price)) { entryIndex = index; break; }
  }
  if (entryIndex < 0) return null;

  const isLong = drawing.tool === 'LongPosition';
  const entryPrice = entryPoint.price;
  const targetPrice = targetPoint.price;
  const stopPrice = stopPoint.price;
  const entryCandle = candles[entryIndex];

  // Match the backtest engine's deterministic OHLC rule: if the same candle
  // contains both terminal prices, stop wins because intrabar order is unknown.
  for (let index = entryIndex; index < rangeEnd; index += 1) {
    const candle = candles[index];
    if (touches(candle, stopPrice)) {
      return {
        entryTime: entryCandle.time,
        currentTime: candle.time,
        entryPrice,
        currentPrice: stopPrice,
        outcome: 'stop',
        profitable: false,
      };
    }
    if (touches(candle, targetPrice)) {
      return {
        entryTime: entryCandle.time,
        currentTime: candle.time,
        entryPrice,
        currentPrice: targetPrice,
        outcome: 'target',
        profitable: true,
      };
    }
  }

  const latest = rangeEnd > rangeStart ? candles[rangeEnd - 1] : undefined;
  if (!latest) return null;
  return {
    entryTime: entryCandle.time,
    currentTime: latest.time,
    entryPrice,
    currentPrice: latest.close,
    outcome: 'open',
    profitable: isLong ? latest.close >= entryPrice : latest.close <= entryPrice,
  };
};

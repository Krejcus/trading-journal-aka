import type { MarketCandle } from './marketData';

export interface BacktestExitModel {
  long: boolean;
  stop?: number;
  target?: number;
  cutoffTime?: number;
  slippagePoints?: number;
  tickSize?: number;
  /** Round-trip fees expressed as price points for this exit quantity. */
  feePoints?: number;
}

/** The same adverse execution and limit protection used by the replay engine. */
export const backtestExitPrice = (
  requested: number, long: boolean, slippagePoints = 0, tickSize = 0, target?: number,
): number => {
  const slipped = requested + (long ? -slippagePoints : slippagePoints);
  const rounded = tickSize > 0 ? Math.round(slipped / tickSize) * tickSize : slipped;
  return target === undefined ? rounded : long ? Math.max(target, rounded) : Math.min(target, rounded);
};

/** Known open crossings precede intrabar extrema; unknown SL/TP order is stop-first. */
export const evaluateBacktestBracket = (candle: MarketCandle, model: BacktestExitModel) => {
  const { long, stop, target } = model;
  const fill = (requested: number, reason: 'sl' | 'tp' | 'cutoff', atOpen: boolean, ambiguous = false) => ({
    price: backtestExitPrice(requested, long, model.slippagePoints, model.tickSize, reason === 'tp' ? target : undefined),
    reason, atOpen, ambiguous,
  });
  if (model.cutoffTime !== undefined && candle.time >= model.cutoffTime) return fill(candle.open, 'cutoff', true);
  const stopAtOpen = stop !== undefined && (long ? candle.open <= stop : candle.open >= stop);
  const targetAtOpen = target !== undefined && (long ? candle.open >= target : candle.open <= target);
  if (stopAtOpen) return fill(candle.open, 'sl', true);
  if (targetAtOpen) return fill(candle.open, 'tp', true);
  const hitStop = stop !== undefined && (long ? candle.low <= stop : candle.high >= stop);
  const hitTarget = target !== undefined && (long ? candle.high >= target : candle.low <= target);
  if (hitStop) return fill(stop, 'sl', false, hitTarget);
  if (hitTarget) return fill(target, 'tp', false);
  return null;
};

/** A missing first minute is a gap too. No later bar repairs missing chronology. */
export const backtestContiguousWindow = (candles: readonly MarketCandle[], entryTime: number, cutoffTime = Infinity) => {
  const following: MarketCandle[] = [];
  let previousTime = entryTime;
  let hasGaps = false;
  for (const candle of candles) {
    if (candle.time <= entryTime) continue;
    if (Math.abs(candle.time - previousTime - 60) > 2) { hasGaps = true; break; }
    following.push(candle);
    previousTime = candle.time;
    if (candle.time >= cutoffTime) break;
  }
  return { following, hasGaps };
};

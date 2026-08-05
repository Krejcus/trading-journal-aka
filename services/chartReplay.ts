import type { MarketCandle } from './marketData';

export const CHART_REPLAY_SPEEDS = [10, 7, 5, 3, 1, 0.5, 0.3, 0.2, 0.1] as const;

export type ChartReplaySpeed = typeof CHART_REPLAY_SPEEDS[number];

export type ChartReplayPhase = 'off' | 'selecting' | 'active';

export interface ChartReplayState {
  phase: ChartReplayPhase;
  cursorTime: number | null;
  startTime: number | null;
  playing: boolean;
  speed: ChartReplaySpeed;
}

export const DEFAULT_CHART_REPLAY_STATE: ChartReplayState = {
  phase: 'off',
  cursorTime: null,
  startTime: null,
  playing: false,
  speed: 1,
};

/** TradingView speed means the number of replay updates made per second. */
export const chartReplayDelayMs = (speed: ChartReplaySpeed): number =>
  Math.max(50, Math.round(1_000 / speed));

const upperBound = (candles: MarketCandle[], unixSeconds: number): number => {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (candles[middle].time <= unixSeconds) low = middle + 1;
    else high = middle;
  }
  return low;
};

export const revealReplayCandles = (
  candles: MarketCandle[],
  cursorTime: number | null,
): MarketCandle[] => {
  if (cursorTime === null || candles.length === 0) return [];
  return candles.slice(0, upperBound(candles, cursorTime));
};

export const nearestReplayCandleTime = (
  candles: MarketCandle[],
  requestedTime: number,
): number | null => {
  if (candles.length === 0 || !Number.isFinite(requestedTime)) return null;
  const afterIndex = upperBound(candles, requestedTime);
  const before = candles[Math.max(0, afterIndex - 1)];
  const after = candles[Math.min(candles.length - 1, afterIndex)];
  if (!before) return after?.time ?? null;
  if (!after) return before.time;
  return requestedTime - before.time <= after.time - requestedTime ? before.time : after.time;
};

/** Advances to the next actually available 1m candle, skipping CME data gaps. */
export const advanceReplayTime = (
  candles: MarketCandle[],
  cursorTime: number | null,
  steps = 1,
): number | null => {
  if (candles.length === 0) return null;
  if (cursorTime === null) return candles[0].time;
  const nextIndex = upperBound(candles, cursorTime) + Math.max(0, Math.floor(steps) - 1);
  const next = candles[nextIndex];
  return next?.time ?? null;
};

export const isReplayAtLatestCandle = (
  candles: MarketCandle[],
  cursorTime: number | null,
): boolean => candles.length === 0
  || cursorTime === null
  || cursorTime >= candles[candles.length - 1].time;

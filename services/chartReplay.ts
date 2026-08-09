import type { MarketCandle } from './marketData';

export const CHART_REPLAY_SPEEDS = [10, 7, 5, 3, 1, 0.5, 0.3, 0.2, 0.1] as const;
export const CHART_REPLAY_STEP_MINUTES = [1, 5, 15, 30, 60, 240, 1_440] as const;

export type ChartReplaySpeed = typeof CHART_REPLAY_SPEEDS[number];
export type ChartReplayStepMinutes = typeof CHART_REPLAY_STEP_MINUTES[number];

export type ChartReplayPhase = 'off' | 'selecting' | 'active';

export interface ChartReplayState {
  phase: ChartReplayPhase;
  cursorTime: number | null;
  startTime: number | null;
  playing: boolean;
  speed: ChartReplaySpeed;
  /** Optional so sessions saved before replay timeframes were introduced still load as 1m. */
  stepMinutes?: ChartReplayStepMinutes;
}

export const DEFAULT_CHART_REPLAY_STATE: ChartReplayState = {
  phase: 'off',
  cursorTime: null,
  startTime: null,
  playing: false,
  speed: 1,
  stepMinutes: 1,
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

/** Number of source candles that are safe to expose at this replay cursor. */
export const replayCandleCountAt = (
  candles: MarketCandle[],
  cursorTime: number | null,
): number => cursorTime === null ? 0 : upperBound(candles, cursorTime);

export const revealReplayCandles = (
  candles: MarketCandle[],
  cursorTime: number | null,
): MarketCandle[] => {
  if (cursorTime === null || candles.length === 0) return [];
  return candles.slice(0, replayCandleCountAt(candles, cursorTime));
};

export interface ReplayChartDataSeed<T> {
  key: string;
  bars: T[];
}

/**
 * Keeps ChartView's data identity stable for the lifetime of one replay pane.
 *
 * Older source candles can be prepended without rebuilding the seed: the chart
 * receives them from the component's own setData() call, which restores the
 * viewport in the same layout phase. Rebuilding the seed instead would let
 * CandleKit call setData() on its own and reset the Lightweight Charts
 * viewport. The factory is deliberately lazy so a prepend also avoids mapping
 * the whole candle array when the seed can be retained.
 */
export const retainReplayChartDataSeed = <T>(
  current: ReplayChartDataSeed<T> | null,
  key: string,
  createBars: () => T[],
): ReplayChartDataSeed<T> => current?.key === key
  ? current
  : { key, bars: createBars() };

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

/**
 * Advances by wall-clock replay intervals while still landing exclusively on
 * actually available source candles. This keeps 5m/15m replay deterministic
 * across CME maintenance windows and other data gaps.
 */
export const advanceReplayTimeByInterval = (
  candles: MarketCandle[],
  cursorTime: number | null,
  stepMinutes: ChartReplayStepMinutes,
  steps = 1,
): number | null => {
  if (candles.length === 0) return null;
  if (cursorTime === null) return candles[0].time;
  const intervalSeconds = Math.max(1, Math.floor(stepMinutes))
    * 60
    * Math.max(1, Math.floor(steps));
  const next = candles[upperBound(candles, cursorTime + intervalSeconds - 1)];
  return next?.time ?? null;
};

/**
 * Časy za poslední svíčkou, o které se protáhne časová osa.
 *
 * Lightweight Charts zná jen časy, které dostal v datech — vpravo od poslední
 * svíčky proto osa končí. Prázdné (`whitespace`) body v pomocné sérii ji
 * protáhnou dál, aniž by se cokoli vykreslilo, takže v replay je vidět, kam
 * čas teprve poteče.
 *
 * Kalendář se neřeší: kroky jsou pravidelné násobky intervalu, takže přes
 * víkend osa ukáže i časy, kdy se neobchoduje.
 */
export const futureAxisTimes = (
  lastCandleTime: number | null | undefined,
  intervalSeconds: number,
  count: number,
): number[] => {
  if (!Number.isFinite(lastCandleTime as number)) return [];
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return [];
  const total = Math.max(0, Math.floor(count));
  const start = Number(lastCandleTime);
  return Array.from({ length: total }, (_, index) => start + (index + 1) * Math.floor(intervalSeconds));
};

export type ChartReplayShortcut = 'toggle-play' | 'step-forward';

/**
 * Klávesa pro ovládání Bar Replay: mezerník přehrává, šipka doprava krokuje.
 *
 * Modifikátory se ignorují záměrně — Cmd/Ctrl/Alt kombinace patří jiným
 * zkratkám (undo, reset pohledu) a replay by jim je přebíral.
 */
export const chartReplayShortcut = (
  event: Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'repeat'>,
): ChartReplayShortcut | null => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.code === 'Space') return event.repeat ? null : 'toggle-play';
  // Podržená šipka krokuje dál, na rozdíl od přepínání přehrávání.
  if (event.code === 'ArrowRight') return 'step-forward';
  return null;
};

export const isReplayAtLatestCandle = (
  candles: MarketCandle[],
  cursorTime: number | null,
): boolean => candles.length === 0
  || cursorTime === null
  || cursorTime >= candles[candles.length - 1].time;

export interface ReplayLogicalRange {
  from: number;
  to: number;
}

/**
 * Keeps the newest replay candle at the same screen position as bars append.
 * A chart that the user has intentionally scrolled into history stays fixed.
 */
export const replayViewportAfterBarsUpdate = (
  visibleRange: ReplayLogicalRange,
  previousBarCount: number,
  nextBarCount: number,
): ReplayLogicalRange => {
  const appendedBarCount = Math.max(0, nextBarCount - previousBarCount);
  const previousNewestIndex = previousBarCount - 1;
  const boundaryTolerance = 0.01;
  const wasFollowingNewestBar = previousBarCount > 0
    && previousNewestIndex >= visibleRange.from - boundaryTolerance
    && previousNewestIndex <= visibleRange.to + boundaryTolerance;

  if (!wasFollowingNewestBar || appendedBarCount === 0) return { ...visibleRange };

  return {
    from: visibleRange.from + appendedBarCount,
    to: visibleRange.to + appendedBarCount,
  };
};

/**
 * Where the viewport belongs after older history is prepended and the chart
 * receives the whole series again.
 *
 * Přes časy se to obnovit nedá: `setVisibleRange` vyžaduje, aby hraniční čas
 * padl na existující bar, jenže časová osa je děravá (víkendy, pauzy mezi
 * sessions) a knihovna si rozsah upravila po svém — graf pak skočil o hodiny
 * jinam. Počet předřazených barů ale známe přesně, takže se logický rozsah dá
 * spočítat absolutně: bary, na které se uživatel dívá, se posunuly doprava.
 */
export const replayLogicalRangeAfterPrepend = (
  visibleRange: ReplayLogicalRange,
  prependedBarCount: number,
): ReplayLogicalRange => {
  const shift = Number.isFinite(prependedBarCount) ? Math.max(0, Math.floor(prependedBarCount)) : 0;
  return { from: visibleRange.from + shift, to: visibleRange.to + shift };
};

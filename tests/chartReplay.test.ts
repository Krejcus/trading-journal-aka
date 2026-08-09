import { describe, expect, it } from 'vitest';
import { aggregateCandles, type MarketCandle } from '../services/marketData';
import {
  advanceReplayTime,
  advanceReplayTimeByInterval,
  chartReplayDelayMs,
  chartReplayShortcut,
  futureAxisTimes,
  isReplayAtLatestCandle,
  nearestReplayCandleTime,
  retainReplayChartDataSeed,
  replayLogicalRangeAfterPrepend,
  replayViewportAfterBarsUpdate,
  revealReplayCandles,
} from '../services/chartReplay';

const candle = (time: number): MarketCandle => ({
  time,
  open: time,
  high: time + 1,
  low: time - 1,
  close: time + 0.25,
  volume: 1,
});

const candles = [candle(60), candle(120), candle(180), candle(600)];

describe('chart replay timeline', () => {
  it('never reveals a candle after the replay cursor', () => {
    expect(revealReplayCandles(candles, 179).map(row => row.time)).toEqual([60, 120]);
    expect(revealReplayCandles(candles, 180).map(row => row.time)).toEqual([60, 120, 180]);
  });

  it('builds higher timeframes only from already revealed minute bars', () => {
    const minuteBars = [candle(0), candle(60), candle(120), candle(180), candle(240), candle(300)];
    const fiveMinuteBars = aggregateCandles(revealReplayCandles(minuteBars, 120), '5m');

    expect(fiveMinuteBars).toHaveLength(1);
    expect(fiveMinuteBars[0].time).toBe(0);
    expect(fiveMinuteBars[0].close).toBe(120.25);
    expect(fiveMinuteBars[0].high).toBe(121);
  });

  it('snaps selection to the closest available candle', () => {
    expect(nearestReplayCandleTime(candles, 151)).toBe(180);
    expect(nearestReplayCandleTime(candles, 149)).toBe(120);
    expect(nearestReplayCandleTime(candles, -100)).toBe(60);
    expect(nearestReplayCandleTime(candles, 900)).toBe(600);
  });

  it('advances by available candles instead of leaking through data gaps', () => {
    expect(advanceReplayTime(candles, 120)).toBe(180);
    expect(advanceReplayTime(candles, 180)).toBe(600);
    expect(advanceReplayTime(candles, 600)).toBeNull();
  });

  it('catches up delayed playback steps without leaking intermediate bars', () => {
    expect(advanceReplayTime(candles, 60, 2)).toBe(180);
    expect(advanceReplayTime(candles, 120, 2)).toBe(600);
    expect(advanceReplayTime(candles, 180, 2)).toBeNull();
  });

  it('advances higher replay timeframes by elapsed time and lands on available data', () => {
    const minuteBars = [60, 120, 180, 240, 300, 360, 900].map(candle);

    expect(advanceReplayTimeByInterval(minuteBars, 60, 5)).toBe(360);
    expect(advanceReplayTimeByInterval(minuteBars, 360, 5)).toBe(900);
    expect(advanceReplayTimeByInterval(minuteBars, 900, 5)).toBeNull();
  });

  it('applies delayed playback catch-up to the selected replay timeframe', () => {
    const minuteBars = Array.from({ length: 20 }, (_, index) => candle(index * 60));

    expect(advanceReplayTimeByInterval(minuteBars, 0, 5, 2)).toBe(600);
  });

  it('uses TradingView-style updates per second speeds', () => {
    expect(chartReplayDelayMs(10)).toBe(100);
    expect(chartReplayDelayMs(0.5)).toBe(2_000);
    expect(chartReplayDelayMs(0.1)).toBe(10_000);
  });

  it('detects the end of available data', () => {
    expect(isReplayAtLatestCandle(candles, 599)).toBe(false);
    expect(isReplayAtLatestCandle(candles, 600)).toBe(true);
  });

  it('keeps a visible newest replay bar at the same screen position', () => {
    expect(replayViewportAfterBarsUpdate({ from: -10, to: 20 }, 11, 12)).toEqual({
      from: -9,
      to: 21,
    });
  });

  it('moves by every appended bar during fast replay catch-up', () => {
    expect(replayViewportAfterBarsUpdate({ from: 0, to: 10 }, 11, 14)).toEqual({
      from: 3,
      to: 13,
    });
  });

  it('does not move a viewport intentionally scrolled into history', () => {
    expect(replayViewportAfterBarsUpdate({ from: 0, to: 8 }, 11, 12)).toEqual({
      from: 0,
      to: 8,
    });
  });

  it('does not move an HTF pane while only its current candle is updating', () => {
    expect(replayViewportAfterBarsUpdate({ from: -10, to: 20 }, 11, 11)).toEqual({
      from: -10,
      to: 20,
    });
  });

  it('keeps the same bars in view after older history is prepended', () => {
    const current = Array.from({ length: 500 }, (_, index) => candle(100_000 + index * 60));
    const prepended = [
      ...Array.from({ length: 1_500 }, (_, index) => candle(index * 60)),
      ...current,
    ];
    // Uživatel se dívá na bary 100–200 dosavadní série.
    const before = { from: 100, to: 200 };
    const after = replayLogicalRangeAfterPrepend(before, 1_500);

    expect(after).toEqual({ from: 1_600, to: 1_700 });
    expect(prepended[after.from].time).toBe(current[before.from].time);
    expect(prepended[after.to].time).toBe(current[before.to].time);
  });

  it('leaves the viewport untouched when nothing was prepended', () => {
    expect(replayLogicalRangeAfterPrepend({ from: -10, to: 120 }, 0)).toEqual({ from: -10, to: 120 });
  });

  it('retains the exact ChartView seed identity when older source data is prepended', () => {
    const seed = retainReplayChartDataSeed<number>(null, 'trade:1m', () => [100, 200]);
    let rebuilt = false;
    const retained = retainReplayChartDataSeed(seed, 'trade:1m', () => {
      rebuilt = true;
      return [0, 100, 200];
    });

    expect(retained).toBe(seed);
    expect(retained.bars).toBe(seed.bars);
    expect(rebuilt).toBe(false);
  });

  it('creates a fresh ChartView seed only for a different replay pane', () => {
    const seed = retainReplayChartDataSeed<number>(null, 'trade:1m', () => [100, 200]);
    const next = retainReplayChartDataSeed(seed, 'trade:5m', () => [100]);

    expect(next).not.toBe(seed);
    expect(next.bars).toEqual([100]);
  });

});

describe('chartReplayShortcut — klávesy pro Bar Replay', () => {
  const key = (overrides: Partial<Parameters<typeof chartReplayShortcut>[0]>) => chartReplayShortcut({
    code: 'Space', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false,
    ...overrides,
  });

  it('mezerník přepíná přehrávání', () => {
    expect(key({})).toBe('toggle-play');
  });

  it('šipka doprava krokuje o svíčku', () => {
    expect(key({ code: 'ArrowRight' })).toBe('step-forward');
  });

  it('podržený mezerník nepřepíná dokola, podržená šipka krokuje dál', () => {
    expect(key({ repeat: true })).toBeNull();
    expect(key({ code: 'ArrowRight', repeat: true })).toBe('step-forward');
  });

  it('kombinace s modifikátorem patří jiným zkratkám', () => {
    expect(key({ metaKey: true })).toBeNull();
    expect(key({ ctrlKey: true })).toBeNull();
    expect(key({ altKey: true })).toBeNull();
    expect(key({ shiftKey: true })).toBeNull();
    expect(key({ code: 'ArrowRight', altKey: true })).toBeNull();
  });

  it('ostatní klávesy ignoruje', () => {
    expect(key({ code: 'ArrowLeft' })).toBeNull();
    expect(key({ code: 'KeyR' })).toBeNull();
  });
});

describe('futureAxisTimes — protažení časové osy za poslední svíčku', () => {
  it('navazuje pravidelnými kroky za poslední svíčkou', () => {
    expect(futureAxisTimes(1_000, 60, 3)).toEqual([1_060, 1_120, 1_180]);
  });

  it('krok odpovídá timeframu panelu', () => {
    expect(futureAxisTimes(1_000, 300, 2)).toEqual([1_300, 1_600]);
  });

  it('bez svíček nebo s nesmyslným krokem nevrací nic', () => {
    expect(futureAxisTimes(null, 60, 5)).toEqual([]);
    expect(futureAxisTimes(undefined, 60, 5)).toEqual([]);
    expect(futureAxisTimes(1_000, 0, 5)).toEqual([]);
    expect(futureAxisTimes(1_000, 60, 0)).toEqual([]);
  });

  it('nikdy nevrátí čas poslední svíčky — ten už v datech je', () => {
    expect(futureAxisTimes(1_000, 60, 4)).not.toContain(1_000);
  });
});

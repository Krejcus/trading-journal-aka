import { describe, expect, it } from 'vitest';
import { aggregateCandles, type MarketCandle } from '../services/marketData';
import {
  advanceReplayTime,
  chartReplayDelayMs,
  isReplayAtLatestCandle,
  nearestReplayCandleTime,
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

  it('uses TradingView-style updates per second speeds', () => {
    expect(chartReplayDelayMs(10)).toBe(100);
    expect(chartReplayDelayMs(0.5)).toBe(2_000);
    expect(chartReplayDelayMs(0.1)).toBe(10_000);
  });

  it('detects the end of available data', () => {
    expect(isReplayAtLatestCandle(candles, 599)).toBe(false);
    expect(isReplayAtLatestCandle(candles, 600)).toBe(true);
  });
});

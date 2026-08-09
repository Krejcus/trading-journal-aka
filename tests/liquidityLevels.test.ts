import { describe, expect, it } from 'vitest';
import { DEFAULT_INDICATOR_SETTINGS } from '../components/ChartIndicatorSettingsDialog';
import { calculateLiquidityLevels } from '../services/liquidityLevels';
import type { MarketCandle } from '../services/marketData';

const candle = (iso: string, open: number, high: number, low: number, close: number, volume = 10): MarketCandle => ({
  time: Date.parse(iso) / 1000, open, high, low, close, volume,
});

const settings = () => structuredClone(DEFAULT_INDICATOR_SETTINGS.levels);

describe('calculateLiquidityLevels', () => {
  it('calculates current, previous day and previous week levels from CME trading days', () => {
    const candles = [
      candle('2026-07-27T22:00:00Z', 95, 100, 90, 98),
      candle('2026-07-28T12:00:00Z', 98, 110, 94, 105),
      candle('2026-08-03T22:00:00Z', 115, 120, 112, 118),
      candle('2026-08-04T12:00:00Z', 118, 125, 111, 122),
    ];
    const result = calculateLiquidityLevels(candles, settings());
    const byName = Object.fromEntries(result.levels.map(level => [level.name, level]));
    expect(byName.PDH.price).toBe(110);
    expect(byName.PDL.price).toBe(90);
    expect(byName.PWH.price).toBe(110);
    expect(byName.PWL.price).toBe(90);
    expect(byName.dHigh.price).toBe(125);
    expect(byName.dLow.price).toBe(111);
  });

  it('matches configured session hours and freezes the latest session box', () => {
    const value = settings();
    value.timezone = 'UTC';
    value.asiaStart = 1;
    value.asiaEnd = 3;
    value.showLondon = false;
    value.showNewYork = false;
    const result = calculateLiquidityLevels([
      candle('2026-08-02T01:00:00Z', 100, 105, 99, 102),
      candle('2026-08-02T02:00:00Z', 102, 108, 98, 104),
      candle('2026-08-02T03:00:00Z', 104, 107, 100, 106),
    ], value);
    expect(result.sessionBoxes).toEqual([expect.objectContaining({ name: 'ASIA', high: 108, low: 98 })]);
    expect(result.levels.map(level => level.name)).toEqual(expect.arrayContaining(['ASIA H', 'ASIA L']));
  });

  it('calculates both independent VWAP deviation multipliers', () => {
    const value = settings();
    value.dev1Multiplier = 1;
    value.dev2Multiplier = 2;
    const result = calculateLiquidityLevels([
      candle('2026-08-02T22:00:00Z', 100, 101, 99, 100, 10),
      candle('2026-08-02T22:01:00Z', 102, 103, 101, 102, 10),
    ], value);
    const mean = result.vwap.at(-1)!.value;
    expect(result.upper2.at(-1)!.value - mean).toBeCloseTo((result.upper1.at(-1)!.value - mean) * 2);
    expect(mean - result.lower2.at(-1)!.value).toBeCloseTo((mean - result.lower1.at(-1)!.value) * 2);
  });

  it('marks previous-day VWAP as swept after its first touch', () => {
    const result = calculateLiquidityLevels([
      candle('2026-08-01T22:00:00Z', 100, 101, 99, 100, 10),
      candle('2026-08-02T22:00:00Z', 101, 102, 98, 99, 10),
    ], settings());
    expect(result.levels.find(level => level.name === 'pdVWAP')).toEqual(expect.objectContaining({
      hits: 1,
      swept: true,
    }));
  });

  it('exposes the bias table only when enabled', () => {
    const candles = [
      candle('2026-08-01T22:00:00Z', 100, 110, 90, 105),
      candle('2026-08-02T22:00:00Z', 106, 115, 104, 112),
    ];
    expect(calculateLiquidityLevels(candles, settings()).biasRows).toHaveLength(0);
    const value = settings(); value.showBiasTable = true;
    expect(calculateLiquidityLevels(candles, value).biasRows.map(row => row.label)).toEqual(expect.arrayContaining(['PDC', 'VWAP', 'IB']));
  });
});

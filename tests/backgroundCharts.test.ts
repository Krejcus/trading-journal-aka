import { describe, expect, it } from 'vitest';
import { createBackgroundChartState, stepBackgroundChart } from '../lib/backgroundCharts';

const seeded = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

describe('ozdobný graf v pozadí', () => {
  it('svíčky i křivka přibývají s časem a nepřerostou strop', () => {
    const random = seeded(7);
    const state = createBackgroundChartState(random);
    const candles = state.candles.length, equity = state.equity.length;
    for (let i = 0; i < 200; i++) stepBackgroundChart(state, 0.1, random);
    expect(state.candles.length).toBeGreaterThan(candles);
    expect(state.equity.length).toBeGreaterThan(equity);
    for (let i = 0; i < 20000; i++) stepBackgroundChart(state, 0.5, random);
    expect(state.candles.length).toBeLessThanOrEqual(700);
    expect(state.equity.length).toBeLessThanOrEqual(1400);
  });

  it('každá svíčka má maximum nad tělem a minimum pod ním; rozsah osy je konečný', () => {
    const random = seeded(3);
    const state = createBackgroundChartState(random);
    for (let i = 0; i < 500; i++) stepBackgroundChart(state, 0.2, random);
    for (const candle of state.candles) {
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
      expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
    }
    expect(state.hi).toBeGreaterThan(state.lo);
    expect(Number.isFinite(state.equityHi - state.equityLo)).toBe(true);
  });

  it('s nulovým časem (rychlost 0) graf stojí', () => {
    const state = createBackgroundChartState(seeded(5));
    const before = JSON.stringify(state);
    stepBackgroundChart(state, 0);
    expect(JSON.stringify(state)).toBe(before);
  });
});

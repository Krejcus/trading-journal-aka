import { describe, expect, it } from 'vitest';
import { runSim, simPath } from '../services/monteCarloRiskModel';

describe('parametric risk simulation economics', () => {
  it('compounds known wins and charges each executed trade exactly once', () => {
    const path = simPath(1, 100, 1, 1, 0.1, 2, 3, null, true);
    expect(Array.from(path.full!)).toEqual([100, 108, 116.8, 126.47999999999999]);
    expect(path.executedTrades).toBe(3);
    expect(path.wins).toBe(3);
  });
  it('stops after insolvency and never generates a negative risk or another fee', () => {
    const path = simPath(1, 100, 0, 1, 0.5, 1, 20, null, true);
    expect(Array.from(path.full!).slice(0, 7)).toEqual([100, 49, 23.5, 10.75, 4.375, 1.1875, 0]);
    expect(Array.from(path.full!).slice(6)).toEqual(Array(15).fill(0));
    expect(path.executedTrades).toBe(6);
    expect(path.insolvent).toBe(true);
    expect(path.maxdd).toBe(100);
  });
  it('counts net losses when a gross winner does not cover fees', () => {
    const path = simPath(1, 1000, 1, 0.3, 0.001, 100, 20, null, true);
    expect(path.wins).toBe(0);
    expect(path.winStreak).toBe(0);
    expect(path.streak).toBe(path.executedTrades);
    expect(path.final).toBe(0);
  });
  it('reports a cost-adjusted starting expectancy and an explicit gross comparator', () => {
    const costly = runSim(1000, 90, 0.3, 0.1, 20, 100, 10, 30);
    const free = runSim(1000, 90, 0.3, 0.1, 20, 0, 10, 30);
    expect(costly.grossExpR).toBeCloseTo(0.17);
    expect(costly.expR).toBeCloseTo(-99.83);
    expect(costly.pProfit).toBe(0);
    expect(costly.insolvency).toBe(100);
    expect(free.expR).toBeCloseTo(0.17);
  });
  it('reproduces seeded outputs and displays net scenario win rate over executed trades', () => {
    const a = runSim(1000, 55, 2, 1, 50, 1, 30, 30);
    expect(runSim(1000, 55, 2, 1, 50, 1, 30, 30)).toEqual(a);
    expect(a.best).toHaveLength(51);
    expect(a.bandIdx[0]).toBe(0);
    expect(a.bandIdx.at(-1)).toBe(50);
    const bankrupt = runSim(1000, 90, 0.3, 0.1, 20, 100, 10, 30);
    expect(bankrupt.scen.med.winPct).toBe(0);
  });
  it('rejects non-finite or impossible model input instead of emitting misleading NaN statistics', () => {
    expect(() => runSim(0, 50, 2, 1, 10, 0, 10, 30)).toThrow();
    expect(() => runSim(1000, 50, 2, 1, 0, 0, 10, 30)).toThrow();
    expect(() => runSim(1000, 50, 2, 1, 10, -1, 10, 30)).toThrow();
    expect(() => runSim(1000, Number.NaN, 2, 1, 10, 0, 10, 30)).toThrow();
  });
});

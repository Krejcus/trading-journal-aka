import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import { reuseMonteCarloInput } from '../lib/monteCarloInput';

const fixtures = () => [
  { pnl: 25, executionStatus: 'Valid' as const, notes: 'before', screenshots: ['image-a'] },
  { pnl: -10, executionStatus: 'Invalid' as const, notes: 'other', screenshots: [] },
  { pnl: 100, executionStatus: 'Missed' as const, notes: 'missed', screenshots: [] },
];

describe('Monte Carlo input identity', () => {
  it('reuses simulation inputs while full incoming trade metadata changes', () => {
    const original = fixtures();
    const previous = reuseMonteCarloInput(null, original, 50_000);
    const incoming = original.map(trade => ({ ...trade, notes: 'updated', screenshots: ['image-b'], needsReview: true }));
    expect(reuseMonteCarloInput(previous, incoming, 50_000)).toBe(previous);
    expect(incoming[0].notes).toBe('updated');
    expect(incoming[0].screenshots).toEqual(['image-b']);
    expect(original[0].notes).toBe('before');
  });

  it('invalidates when an included PnL changes', () => {
    const trades = fixtures();
    const previous = reuseMonteCarloInput(null, trades, 50_000);
    const next = reuseMonteCarloInput(previous, [{ ...trades[0], pnl: 26 }, ...trades.slice(1)], 50_000);
    expect(next).not.toBe(previous);
    expect(next.pnls).toEqual([26, -10]);
  });

  it('invalidates when execution status changes inclusion in the simulation', () => {
    const trades = fixtures();
    const previous = reuseMonteCarloInput(null, trades, 50_000);
    expect(reuseMonteCarloInput(previous, [{ ...trades[0], executionStatus: 'Missed' }, ...trades.slice(1)], 50_000)).not.toBe(previous);
    expect(reuseMonteCarloInput(previous, [...trades.slice(0, 2), { ...trades[2], executionStatus: 'Valid' }], 50_000)).not.toBe(previous);
  });

  it('retains Valid-to-Invalid edits without rerunning their identical numerical simulation', () => {
    const trades = fixtures();
    const previous = reuseMonteCarloInput(null, trades, 50_000);
    expect(reuseMonteCarloInput(previous, [{ ...trades[0], executionStatus: 'Invalid' }, ...trades.slice(1)], 50_000)).toBe(previous);
  });

  it('invalidates when included PnL order changes, or included rows are added or removed', () => {
    const trades = fixtures();
    const previous = reuseMonteCarloInput(null, trades, 50_000);
    for (const incoming of [[trades[1], trades[0], trades[2]], [...trades, trades[0]], trades.slice(1)]) {
      expect(reuseMonteCarloInput(previous, incoming, 50_000)).not.toBe(previous);
    }
  });

  it('invalidates when initial balance changes even though PnLs stay equal', () => {
    const trades = fixtures();
    const previous = reuseMonteCarloInput(null, trades, 50_000);
    const next = reuseMonteCarloInput(previous, trades, 60_000);
    expect(next).not.toBe(previous);
    expect(next.initialBalance).toBe(60_000);
  });

  it('keeps updates to excluded Missed trades outside the simulation', () => {
    const trades = fixtures();
    const previous = reuseMonteCarloInput(null, trades, 50_000);
    expect(reuseMonteCarloInput(previous, [...trades.slice(0, 2), { ...trades[2], pnl: -500 }], 50_000)).toBe(previous);
  });

  it('matches the existing numerical fallback and empty-input behavior', () => {
    const trades = [{ pnl: Number.NaN }, { pnl: 0 }, {}] as Array<Pick<Trade, 'pnl' | 'executionStatus'>>;
    expect(reuseMonteCarloInput(null, trades, Number.NaN)).toEqual({ pnls: [0, 0, 0], initialBalance: 0 });
    const empty = reuseMonteCarloInput(null, [], 0);
    expect(reuseMonteCarloInput(empty, [], 0)).toBe(empty);
  });
});

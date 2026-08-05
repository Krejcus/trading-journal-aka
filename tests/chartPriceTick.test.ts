import { describe, expect, it } from 'vitest';
import {
  formatNqMnqTickPrice,
  roundNqMnqPriceToTick,
} from '../services/chartPriceTick';

describe('NQ/MNQ chart price ticks', () => {
  it('rounds free cursor prices to the nearest tradable quarter point', () => {
    expect(roundNqMnqPriceToTick(28_000.66)).toBe(28_000.75);
    expect(roundNqMnqPriceToTick(28_000.62)).toBe(28_000.5);
    expect(roundNqMnqPriceToTick(28_000.11)).toBe(28_000);
  });

  it('formats only valid .00, .25, .50 and .75 endings', () => {
    expect(formatNqMnqTickPrice(28_000.11)).toBe('28000.00');
    expect(formatNqMnqTickPrice(28_000.26)).toBe('28000.25');
    expect(formatNqMnqTickPrice(28_000.49)).toBe('28000.50');
    expect(formatNqMnqTickPrice(28_000.66)).toBe('28000.75');
  });
});

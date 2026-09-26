import { describe, expect, it } from 'vitest';
import { nearestCandleIndex } from '../services/candleSearch';

// Původní lineární verze z CandleKitTradeChart — binární musí dávat totéž.
const linear = (candles: Array<{ time: number }>, target: number) => {
  let nearest = 0;
  let distance = Math.abs((candles[0]?.time || target) - target);
  for (let index = 1; index < candles.length; index += 1) {
    const next = Math.abs(candles[index].time - target);
    if (next < distance) { nearest = index; distance = next; }
  }
  return nearest;
};

describe('nejbližší svíčka (binární hledání)', () => {
  it('shoda s lineární verzí na děravé časové ose (víkendy, pauzy, remízy)', () => {
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
      const candles: Array<{ time: number }> = [];
      let time = 1_000_000;
      const count = 1 + Math.floor(random() * 300);
      for (let index = 0; index < count; index++) { time += 60 * (1 + Math.floor(random() * (random() < 0.05 ? 500 : 3))); candles.push({ time }); }
      for (let probe = 0; probe < 50; probe++) {
        const target = candles[0].time - 5000 + Math.floor(random() * (time - candles[0].time + 10_000));
        expect(nearestCandleIndex(candles, target)).toBe(linear(candles, target));
      }
      // Přesně v půlce mezi dvěma svíčkami vyhraje dřívější.
      if (candles.length > 1) expect(nearestCandleIndex(candles, (candles[0].time + candles[1].time) / 2)).toBe(linear(candles, (candles[0].time + candles[1].time) / 2));
    }
  });
  it('prázdné a jednoprvkové pole', () => {
    expect(nearestCandleIndex([], 5)).toBe(0);
    expect(nearestCandleIndex([{ time: 10 }], 5)).toBe(0);
  });
});

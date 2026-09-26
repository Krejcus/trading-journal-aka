import { describe, expect, it } from 'vitest';
import { candleReplayPath, partialReplayCandle, type ReplayCandle } from '../lib/candleReplayPath';

const candle: ReplayCandle = { time: 1_790_000_040, open: 100, high: 104, low: 98, close: 103, volume: 60 };
const ms = (seconds: number) => candle.time * 1000 + seconds * 1000;
const firstAt = (path: ReturnType<typeof candleReplayPath>, price: number) => path.find(point => point.price === price)!.at;

describe('cesta ceny uvnitř svíčky (animace přehrávání)', () => {
  it('bez plnění: býčí svíčka odhadem nejdřív low, pak high', () => {
    const path = candleReplayPath(candle);
    expect(path[0]).toEqual({ at: 0, price: 100 });
    expect(path.at(-1)).toEqual({ at: 1, price: 103 });
    expect(firstAt(path, 98)).toBeLessThan(firstAt(path, 104));
  });
  it('plnění rozhoduje: stop na high ve 20. s → high dřív než low, i když je svíčka býčí', () => {
    const path = candleReplayPath(candle, [{ at: ms(20), price: 104 }]);
    expect(firstAt(path, 104)).toBeCloseTo(20 / 60);
    expect(firstAt(path, 104)).toBeLessThan(firstAt(path, 98));
  });
  it('vstup i výstup v jedné svíčce: oba body v pořadí podle času', () => {
    const path = candleReplayPath(candle, [{ at: ms(45), price: 99 }, { at: ms(10), price: 102 }]);
    const anchors = path.filter(point => point.price === 99 || point.price === 102);
    expect(anchors.map(point => point.price)).toEqual([102, 99]);
  });
  it('plnění mimo minutu se ignoruje, cena mimo rozsah se ořízne', () => {
    const path = candleReplayPath(candle, [{ at: ms(-5), price: 90 }, { at: ms(30), price: 110 }]);
    expect(path.some(point => point.price === 90)).toBe(false);
    expect(Math.max(...path.map(point => point.price))).toBe(104);
  });
  it('rozpracovaná svíčka nepřekročí rozsah a na konci je skutečná', () => {
    const path = candleReplayPath(candle, [{ at: ms(20), price: 104 }]);
    for (let step = 0; step <= 20; step += 1) {
      const partial = partialReplayCandle(candle, path, step / 20);
      expect(partial.high).toBeLessThanOrEqual(candle.high);
      expect(partial.low).toBeGreaterThanOrEqual(candle.low);
      expect(partial.open).toBe(candle.open);
    }
    expect(partialReplayCandle(candle, path, 0.5).high).toBe(104);
    expect(partialReplayCandle(candle, path, 1)).toEqual(candle);
  });
});

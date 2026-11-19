import { describe, expect, it } from 'vitest';
import { mergeRithmicDisplayHistory, mergeSeedCandles } from '../lib/rithmicCandleSeed';

const bars = (...times: number[]) => times.map((time) => ({ time, close: time }));

// 18. 11. 2026 (nahrávka z iPhonu): po návratu do appky graf dvakrát přeskočil — služba pošle nejdřív svíčky
// od svého startu a pak celou historii, a graf se pokaždé přepsal tím, co zrovna přišlo.
describe('svíčky po znovupřipojení ke službě', () => {
  it('kratší řada od služby stávající graf NEZKRÁTÍ: starší svíčky zůstanou, od první nové platí nová data', () => {
    const current = bars(60, 120, 180, 240);
    const merged = mergeSeedCandles(current, [{ time: 180, close: 999 }, { time: 240, close: 998 }, { time: 300, close: 997 }], true);
    expect(merged.map((bar) => bar.time)).toEqual([60, 120, 180, 240, 300]);
    expect(merged.find((bar) => bar.time === 180)?.close).toBe(999); // překryv bere nová data
  });

  it('řada sahající stejně daleko nebo dál do minulosti nahradí vše (celá historie)', () => {
    expect(mergeSeedCandles(bars(120, 180), bars(60, 120, 180, 240), true).map((bar) => bar.time)).toEqual([60, 120, 180, 240]);
    expect(mergeSeedCandles(bars(60, 120), bars(60, 120, 180), true).map((bar) => bar.time)).toEqual([60, 120, 180]);
  });

  it('jiný účet, systém nebo kontrakt: staré svíčky se nikdy nemíchají s novými', () => {
    expect(mergeSeedCandles(bars(60, 120, 180), bars(180, 240), false).map((bar) => bar.time)).toEqual([180, 240]);
    expect(mergeSeedCandles(bars(60, 120), [], false)).toEqual([]);
  });

  it('prázdná zpráva od téže služby graf nevymaže; první načtení vezme, co přišlo', () => {
    expect(mergeSeedCandles(bars(60, 120), [], true).map((bar) => bar.time)).toEqual([60, 120]);
    expect(mergeSeedCandles([], bars(60), true).map((bar) => bar.time)).toEqual([60]);
  });

  it('výpadek delší než stávající řada: mezera se doplní z nové řady, nic se nezdvojí', () => {
    const merged = mergeSeedCandles(bars(60, 120), bars(100, 160, 220), true);
    expect(merged.map((bar) => bar.time)).toEqual([60, 100, 160, 220]);
    expect(new Set(merged.map((bar) => bar.time)).size).toBe(merged.length);
  });
});

it('joins cached replay to newer ticks without duplicating the boundary minute or adding overlapping volume', () => {
  const cached = { time: 60, open: 10, high: 16, low: 8, close: 11, volume: 20 };
  const overlap = { time: 60, open: 12, high: 15, low: 7, close: 13, volume: 12 };
  const next = { ...overlap, time: 120 };
  expect(mergeRithmicDisplayHistory([cached], [overlap, next])).toEqual([
    { ...cached, low: 7, close: 13 }, next,
  ]);
  expect(mergeRithmicDisplayHistory([cached], [next])).toEqual([cached, next]);
  expect(mergeRithmicDisplayHistory([], [next])).toEqual([next]);
});

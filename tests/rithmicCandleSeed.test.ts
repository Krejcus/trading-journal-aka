import { describe, expect, it } from 'vitest';
import { mergeSeedCandles } from '../lib/rithmicCandleSeed';

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

describe('patchSeedCandles — opravené svíčky po výpadku cen', () => {
  const bar = (time: number, open: number) => ({ time, open });
  const M = (n: number) => 999_000 + n * 60;

  it('nahradí neúplnou dokončenou svíčku správnou z historie', async () => {
    const { patchSeedCandles } = await import('../lib/rithmicCandleSeed');
    const current = [bar(M(13), 1), bar(M(14), 26898.25), bar(M(15), 3), bar(M(16), 4)];
    expect(patchSeedCandles(current, [bar(M(14), 26903.25)], M(14))).toEqual([bar(M(13), 1), bar(M(14), 26903.25), bar(M(15), 3), bar(M(16), 4)]);
  });

  it('doplní minuty, které z výpadku chybí, a řadu nechá seřazenou', async () => {
    const { patchSeedCandles } = await import('../lib/rithmicCandleSeed');
    const current = [bar(M(10), 1), bar(M(14), 9)];
    expect(patchSeedCandles(current, [bar(M(12), 3), bar(M(11), 2), bar(M(13), 4)], M(13)).map((b) => b.time)).toEqual([M(10), M(11), M(12), M(13), M(14)]);
  });

  it('co je dokončené, říká služba: minutu za její hranicí nepřepíše (tu skládají ticky)', async () => {
    const { patchSeedCandles } = await import('../lib/rithmicCandleSeed');
    const current = [bar(M(15), 1), bar(M(16), 2)];
    expect(patchSeedCandles(current, [bar(M(16), 777)], M(15))).toEqual(current);
  });

  it('nezávisí na hodinách zařízení: poslední svíčku grafu opraví, když ji služba označí za dokončenou', async () => {
    const { patchSeedCandles } = await import('../lib/rithmicCandleSeed');
    expect(patchSeedCandles([bar(M(13), 1), bar(M(14), 26898.25)], [bar(M(14), 26903.25)], M(14))).toEqual([bar(M(13), 1), bar(M(14), 26903.25)]);
  });

  it('nepřidává nic před začátek řady, prázdný graf a zprávu bez hranice nechá být', async () => {
    const { patchSeedCandles } = await import('../lib/rithmicCandleSeed');
    expect(patchSeedCandles([bar(M(10), 1)], [bar(M(5), 9)], M(9))).toEqual([bar(M(10), 1)]);
    expect(patchSeedCandles([], [bar(M(5), 9)], M(9))).toEqual([]);
    expect(patchSeedCandles([bar(M(10), 1), bar(M(11), 2)], [bar(M(10), 9)], Number.NaN)).toEqual([bar(M(10), 1), bar(M(11), 2)]);
  });
});

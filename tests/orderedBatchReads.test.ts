import { describe, expect, it } from 'vitest';
import { orderedBatchReads } from '../lib/orderedBatchReads';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

describe('orderedBatchReads', () => {
  it('vrací výsledky v pořadí dávek, i když doběhnou v jiném', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const running = orderedBatchReads(3, index => gates[index].promise, 3);
    gates[2].resolve('c'); gates[0].resolve('a'); gates[1].resolve('b');
    expect(await running).toEqual(['a', 'b', 'c']);
  });

  it('nepřekročí souběžnost', async () => {
    let active = 0, peak = 0;
    await orderedBatchReads(10, async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 2));
      active -= 1;
    }, 4);
    expect(peak).toBe(4);
  });

  it('po selhání nespouští další dávky a vyhodí chybu s nejnižším indexem', async () => {
    const started: number[] = [];
    await expect(orderedBatchReads(10, async index => {
      started.push(index);
      await new Promise(r => setTimeout(r, index === 0 ? 5 : 1));
      if (index === 0 || index === 1) throw new Error(`fail-${index}`);
      return index;
    }, 2)).rejects.toThrow('fail-0');
    expect(started.length).toBeLessThan(10);
  });

  it('bez dávek nic nespustí', async () => {
    expect(await orderedBatchReads(0, async () => 1)).toEqual([]);
  });
});

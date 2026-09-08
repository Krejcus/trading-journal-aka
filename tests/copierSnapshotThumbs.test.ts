import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  pickCopierThumbSnapshot,
  getCopierThumbUrl,
  getCachedCopierThumbs,
  invalidateCopierThumb,
  __resetCopierThumbCacheForTests,
} from '../services/copierSnapshotThumbs';

const entry = { kind: 'entry', at: 1000, path: 'ep/entry.jpg' };
const exit = { kind: 'exit', at: 2000, path: 'ep/exit.jpg' };
const slMoved = { kind: 'sl-moved', at: 1500, path: 'ep/sl.jpg' };

describe('pickCopierThumbSnapshot', () => {
  it('preferuje snapshot po uzavření (exit) bez ohledu na pořadí v poli', () => {
    expect(pickCopierThumbSnapshot([exit, entry])).toBe(exit);
    expect(pickCopierThumbSnapshot([entry, slMoved, exit])).toBe(exit);
  });

  it('při více exitech bere nejnovější', () => {
    const olderExit = { kind: 'exit', at: 900, path: 'ep/exit-old.jpg' };
    expect(pickCopierThumbSnapshot([olderExit, entry, exit])).toBe(exit);
  });

  it('bez exitu bere nejnovější snapshot podle at', () => {
    expect(pickCopierThumbSnapshot([entry, slMoved])).toBe(slMoved);
  });

  it('prázdné nebo chybějící pole → undefined', () => {
    expect(pickCopierThumbSnapshot([])).toBeUndefined();
    expect(pickCopierThumbSnapshot(undefined)).toBeUndefined();
  });
});

describe('getCopierThumbUrl', () => {
  beforeEach(() => __resetCopierThumbCacheForTests());

  it('podepisuje jen vybraný snapshot a výsledek cachuje', async () => {
    const sign = vi.fn(async (s: typeof entry[]) => s.map(x => ({ ...x, url: `signed:${x.path}` })));
    const first = await getCopierThumbUrl('t1', [entry, exit], sign, 0);
    const second = await getCopierThumbUrl('t1', [entry, exit], sign, 1000);
    expect(first).toBe('signed:ep/exit.jpg');
    expect(second).toBe(first);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toEqual([exit]);
    expect(getCachedCopierThumbs(1000).get('t1')).toBe(first);
  });

  it('souběžné požadavky sdílí jeden podpis', async () => {
    let resolve!: (v: Array<typeof entry & { url: string }>) => void;
    const sign = vi.fn(() => new Promise<Array<typeof entry & { url: string }>>(r => { resolve = r; }));
    const a = getCopierThumbUrl('t1', [exit], sign, 0);
    const b = getCopierThumbUrl('t1', [exit], sign, 0);
    resolve([{ ...exit, url: 'signed:x' }]);
    expect(await a).toBe('signed:x');
    expect(await b).toBe('signed:x');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('po vypršení TTL nebo invalidaci podepíše znovu', async () => {
    const sign = vi.fn(async (s: typeof entry[]) => s.map(x => ({ ...x, url: `signed:${x.path}:${Math.random()}` })));
    const first = await getCopierThumbUrl('t1', [exit], sign, 0);
    const expired = await getCopierThumbUrl('t1', [exit], sign, 51 * 60 * 1000);
    expect(expired).not.toBe(first);
    expect(getCachedCopierThumbs(0).has('t1')).toBe(true);
    invalidateCopierThumb('t1');
    expect(getCachedCopierThumbs(0).has('t1')).toBe(false);
    await getCopierThumbUrl('t1', [exit], sign, 0);
    expect(sign).toHaveBeenCalledTimes(3);
  });

  it('bez snapshotu nebo při selhání podpisu vrací null a nic necachuje', async () => {
    expect(await getCopierThumbUrl('t1', [], vi.fn(), 0)).toBeNull();
    const failing = vi.fn(async () => { throw new Error('boom'); });
    expect(await getCopierThumbUrl('t2', [exit], failing, 0)).toBeNull();
    const empty = vi.fn(async () => []);
    expect(await getCopierThumbUrl('t3', [exit], empty, 0)).toBeNull();
    expect(getCachedCopierThumbs(0).size).toBe(0);
  });
});

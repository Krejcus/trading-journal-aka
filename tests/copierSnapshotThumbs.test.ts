import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  pickCopierThumbSnapshot,
  getCopierThumbUrl,
  getCachedCopierThumbs,
  invalidateCopierThumb,
  prefetchCopierThumbUrls,
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
    const first = await getCopierThumbUrl('owner-a', 't1', [entry, exit], sign, 0);
    const second = await getCopierThumbUrl('owner-a', 't1', [entry, exit], sign, 1000);
    expect(first).toBe('signed:ep/exit.jpg');
    expect(second).toBe(first);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toEqual([exit]);
    expect(getCachedCopierThumbs('owner-a', 1000).get('t1')).toBe(first);
  });

  it('souběžné požadavky sdílí jeden podpis', async () => {
    let resolve!: (v: Array<typeof entry & { url: string }>) => void;
    const sign = vi.fn(() => new Promise<Array<typeof entry & { url: string }>>(r => { resolve = r; }));
    const a = getCopierThumbUrl('owner-a', 't1', [exit], sign, 0);
    const b = getCopierThumbUrl('owner-a', 't1', [exit], sign, 0);
    resolve([{ ...exit, url: 'signed:x' }]);
    expect(await a).toBe('signed:x');
    expect(await b).toBe('signed:x');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('po vypršení TTL nebo invalidaci podepíše znovu', async () => {
    const sign = vi.fn(async (s: typeof entry[]) => s.map(x => ({ ...x, url: `signed:${x.path}:${Math.random()}` })));
    const first = await getCopierThumbUrl('owner-a', 't1', [exit], sign, 0);
    const expired = await getCopierThumbUrl('owner-a', 't1', [exit], sign, 51 * 60 * 1000);
    expect(expired).not.toBe(first);
    expect(getCachedCopierThumbs('owner-a', 0).has('t1')).toBe(true);
    invalidateCopierThumb('owner-a', 't1');
    expect(getCachedCopierThumbs('owner-a', 0).has('t1')).toBe(false);
    await getCopierThumbUrl('owner-a', 't1', [exit], sign, 0);
    expect(sign).toHaveBeenCalledTimes(3);
  });

  it('bez snapshotu nebo při selhání podpisu vrací null a nic necachuje', async () => {
    expect(await getCopierThumbUrl('owner-a', 't1', [], vi.fn(), 0)).toBeNull();
    const failing = vi.fn(async () => { throw new Error('boom'); });
    expect(await getCopierThumbUrl('owner-a', 't2', [exit], failing, 0)).toBeNull();
    const empty = vi.fn(async () => []);
    expect(await getCopierThumbUrl('owner-a', 't3', [exit], empty, 0)).toBeNull();
    expect(getCachedCopierThumbs('owner-a', 0).size).toBe(0);
  });

  it('podepíše více miniatur jedním voláním a oddělí cache vlastníků', async () => {
    const secondExit = { ...exit, path: 'ep/exit-2.jpg', at: 3000 };
    const sign = vi.fn(async (snapshots: typeof entry[]) => snapshots.map(item => ({ ...item, url: `signed:${item.path}` })));
    const urls = await prefetchCopierThumbUrls('owner-a', [
      { tradeId: 't1', snapshots: [entry, exit] },
      { tradeId: 't2', snapshots: [secondExit] },
    ], sign, 0);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toEqual([exit, secondExit]);
    expect([...urls]).toEqual([
      ['t1', 'signed:ep/exit.jpg'],
      ['t2', 'signed:ep/exit-2.jpg'],
    ]);
    expect(getCachedCopierThumbs('owner-b', 0).size).toBe(0);
    await getCopierThumbUrl('owner-b', 't1', [exit], sign, 0);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('pomalejší starý požadavek nepřepíše novější snapshot stejného obchodu', async () => {
    const newer = { ...exit, at: 3000, path: 'ep/new-exit.jpg' };
    const releases = new Map<string, (value: Array<typeof exit & { url: string }>) => void>();
    const sign = vi.fn((snapshots: typeof exit[]) => new Promise<Array<typeof exit & { url: string }>>(resolve => {
      releases.set(snapshots[0].path, resolve);
    }));

    const oldRequest = getCopierThumbUrl('owner-a', 't1', [exit], sign, 0);
    const newRequest = getCopierThumbUrl('owner-a', 't1', [newer], sign, 1);
    releases.get(newer.path)?.([{ ...newer, url: 'signed:new' }]);
    expect(await newRequest).toBe('signed:new');
    releases.get(exit.path)?.([{ ...exit, url: 'signed:old' }]);
    expect(await oldRequest).toBe('signed:old');
    expect(getCachedCopierThumbs('owner-a', 2).get('t1')).toBe('signed:new');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
import {
  __resetJournalDetailCacheForTests,
  cacheVerifiedJournalDetail,
  getCachedJournalDetail,
  journalDetailSelectionKey,
} from '../services/journalTradeDetail';
import {
  __resetCopierSnapshotSignedUrlCacheForTests,
  getCachedCopierSnapshotSignedUrls,
} from '../services/copierSnapshotSignedUrlCache';
import { __resetImageDecodeCacheForTests, isImageDecoded, preloadDecodedImage } from '../services/imageDecodeCache';

const trade = (id: string): Trade => ({ id, accountId: `account-${id}`, instrument: 'MNQ', direction: 'Long', pnl: 1, date: '2026-09-20', timestamp: 1 } as Trade);

describe('trade detail fast path', () => {
  beforeEach(() => {
    __resetJournalDetailCacheForTests();
    __resetCopierSnapshotSignedUrlCacheForTests();
    __resetImageDecodeCacheForTests();
  });

  it('keeps the same selection identity across background array refreshes', () => {
    const selected = { ...trade('combined_group'), combinedTradeIds: ['a', 'b'] };
    const first = [trade('a'), trade('b')];
    const refreshed = first.map(row => ({ ...row }));
    expect(journalDetailSelectionKey(selected, first)).toBe(journalDetailSelectionKey({ ...selected }, refreshed));
    expect(journalDetailSelectionKey(selected, [...refreshed].reverse())).toBe(journalDetailSelectionKey(selected, first));
    expect(journalDetailSelectionKey({ ...selected, combinedTradeIds: ['a'] }, refreshed)).not.toBe(journalDetailSelectionKey(selected, first));
  });

  it('reuses verified rows only inside the same auth scope and TTL', () => {
    const rows = [trade('a')];
    cacheVerifiedJournalDetail('auth-1:owner-a', ['a'], rows, 100);
    expect(getCachedJournalDetail('auth-1:owner-a', ['a'], 29_999)).toBe(rows);
    expect(getCachedJournalDetail('auth-1:owner-b', ['a'], 200)).toBeNull();
    expect(getCachedJournalDetail('auth-2:owner-a', ['a'], 200)).toBeNull();
    expect(getCachedJournalDetail('auth-1:owner-a', ['a'], 30_100)).toBeNull();
  });

  it('batch-signs only missing paths, preserves order and isolates auth scopes', async () => {
    const snapshots = [
      { kind: 'entry', at: 1, path: 'episode/entry.png' },
      { kind: 'exit', at: 2, path: 'episode/exit.png' },
    ];
    const sign = vi.fn(async (paths: string[]) => paths.map(path => ({ path, signedUrl: `signed:${path}`, error: null })));
    const first = await getCachedCopierSnapshotSignedUrls('auth-1:owner-a', snapshots, sign, 0);
    const second = await getCachedCopierSnapshotSignedUrls('auth-1:owner-a', snapshots, sign, 1_000);
    await getCachedCopierSnapshotSignedUrls('auth-1:owner-b', snapshots, sign, 1_000);
    expect(first.map(item => item.path)).toEqual(snapshots.map(item => item.path));
    expect(second).toEqual(first);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls[0][0]).toEqual(snapshots.map(item => item.path));
  });

  it('keeps successful batch results when another path fails', async () => {
    const snapshots = [
      { kind: 'entry', at: 1, path: 'ok.png' },
      { kind: 'exit', at: 2, path: 'missing.png' },
    ];
    const result = await getCachedCopierSnapshotSignedUrls('scope', snapshots, async () => [
      { path: 'ok.png', signedUrl: 'signed:ok', error: null },
      { path: 'missing.png', signedUrl: null, error: 'not-found' },
    ], 0);
    expect(result).toEqual([{ ...snapshots[0], url: 'signed:ok' }]);
  });

  it('deduplicates concurrent image decode work and retries failures', async () => {
    let release!: () => void;
    const load = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const a = preloadDecodedImage('one.png', load);
    const b = preloadDecodedImage('one.png', load);
    release();
    await Promise.all([a, b]);
    await preloadDecodedImage('one.png', load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(isImageDecoded('one.png')).toBe(true);

    const failing = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce(undefined);
    await expect(preloadDecodedImage('two.png', failing)).rejects.toThrow('fail');
    await expect(preloadDecodedImage('two.png', failing)).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

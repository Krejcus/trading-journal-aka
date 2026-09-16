import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyGroupLibraryRequestFence } from '../lib/copyGroupLibraryRequestFence';

const remote = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../services/supabase', () => ({ supabase: {
  from: () => ({ select: () => ({ eq: () => ({ order: () => ({ abortSignal: remote.read }) }) }) }),
} }));
import { COPY_GROUP_LIBRARY_READ_TIMEOUT_MS, copyGroupLibraryErrorMessage, loadCopyGroupLibrary, readCopyGroupCache, writeCopyGroupCache } from '../services/copyGroupLibrary';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const profile = (multiplier: number): CopyGroupConfig => ({
  id: 'profile', name: 'Profile', enabled: false, leaderAccountId: 11,
  followers: [{ accountId: 22, mode: 'on-submit', multiplier }],
});
const setup = () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  return new CopyGroupLibraryRequestFence('owner');
};
const pendingRead = () => {
  let resolve!: (value: { data: unknown[]; error: null }) => void;
  remote.read.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  return (groups: CopyGroupConfig[]) => resolve({
    data: groups.map(config => ({ group_id: config.id, config, updated_at: '2026-09-06T00:00:00Z' })),
    error: null,
  });
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('copy group refresh cache ordering', () => {
  it.each(['save', 'import', 'delete', 'follower-update'] as const)(
    'a pre-%s cloud response cannot overwrite confirmed UI or its cache', async operation => {
      const fence = setup();
      writeCopyGroupCache('owner', [profile(1)]);
      const finishRead = pendingRead();
      const read = fence.beginRead()!;
      const loading = loadCopyGroupLibrary('owner', [], () => fence.canAcceptRead(read));
      const write = fence.beginWrite();
      let ui = operation === 'delete' ? [] : [profile(2)];
      writeCopyGroupCache('owner', ui);
      fence.endWrite(write);
      finishRead([profile(1)]);
      const response = await loading;
      if (fence.canAcceptRead(read)) ui = response.groups;
      expect(ui.map(item => item.followers[0].multiplier)).toEqual(operation === 'delete' ? [] : [2]);
      expect(readCopyGroupCache('owner', []).map(item => item.followers[0].multiplier))
        .toEqual(operation === 'delete' ? [] : [2]);
    },
  );

  it('a late empty read cannot erase the first profile just created', async () => {
    const fence = setup();
    const finishRead = pendingRead();
    const read = fence.beginRead()!;
    const loading = loadCopyGroupLibrary('owner', [], () => fence.canAcceptRead(read));
    const write = fence.beginWrite();
    writeCopyGroupCache('owner', [profile(3)]);
    fence.endWrite(write);
    finishRead([]);
    await loading;
    expect(readCopyGroupCache('owner', [])[0].followers[0].multiplier).toBe(3);
  });

  it('account change invalidates a delayed read even if the same account signs in again', async () => {
    const fence = setup();
    const finishRead = pendingRead();
    const read = fence.beginRead()!;
    const loading = loadCopyGroupLibrary('owner', [], () => fence.canAcceptRead(read));
    fence.setOwner('different');
    fence.setOwner('owner');
    writeCopyGroupCache('owner', [profile(4)]);
    finishRead([profile(1)]);
    await loading;
    expect(readCopyGroupCache('owner', [])[0].followers[0].multiplier).toBe(4);
  });

  it('a current successful read still refreshes the cache normally', async () => {
    const fence = setup();
    const finishRead = pendingRead();
    const read = fence.beginRead()!;
    const loading = loadCopyGroupLibrary('owner', [], () => fence.canAcceptRead(read));
    finishRead([profile(5)]);
    expect((await loading).groups[0].followers[0].multiplier).toBe(5);
    expect(readCopyGroupCache('owner', [])[0].followers[0].multiplier).toBe(5);
  });

  it('times out a suspended read and ignores its late cache update after a successful retry', async () => {
    vi.useFakeTimers();
    setup();
    writeCopyGroupCache('owner', [profile(1)]);
    const finishOldRead = pendingRead();
    const first = loadCopyGroupLibrary('owner', []).catch(error => error);
    const signal = remote.read.mock.calls.at(-1)?.[0] as AbortSignal;
    await vi.advanceTimersByTimeAsync(COPY_GROUP_LIBRARY_READ_TIMEOUT_MS);
    expect((await first).message).toContain('trvá příliš dlouho');
    expect(signal.aborted).toBe(true);
    expect(readCopyGroupCache('owner', [])[0].followers[0].multiplier).toBe(1);

    const finishRetry = pendingRead();
    const retry = loadCopyGroupLibrary('owner', []);
    finishRetry([profile(2)]);
    await retry;
    finishOldRead([]);
    await Promise.resolve();
    expect(readCopyGroupCache('owner', [])[0].followers[0].multiplier).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an explicit recovery read is fenced against focus events and pre-retry responses', async () => {
    const fence = setup();
    const finishBackground = pendingRead();
    const old = fence.beginRead()!;
    const background = loadCopyGroupLibrary('owner', [], () => fence.canAcceptRead(old));
    const write = fence.beginWrite();
    const finishRetry = pendingRead();
    const retry = loadCopyGroupLibrary('owner', [], () => fence.canAcceptWrite(write));
    expect(fence.beginRead()).toBeNull();
    finishRetry([profile(2)]);
    expect((await retry).groups[0].followers[0].multiplier).toBe(2);
    finishBackground([profile(1)]);
    await background;
    expect(readCopyGroupCache('owner', [])[0].followers[0].multiplier).toBe(2);
    fence.endWrite(write);
  });

  it('keeps cache on a Safari network error and exposes an actionable reason', async () => {
    setup();
    writeCopyGroupCache('owner', [profile(3)]);
    remote.read.mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Load failed' } });
    const error = await loadCopyGroupLibrary('owner', []).catch(reason => reason);
    expect(copyGroupLibraryErrorMessage(error)).toContain('Zkontroluj internet');
    expect(readCopyGroupCache('owner', [])[0].followers[0].multiplier).toBe(3);
    expect(copyGroupLibraryErrorMessage(new Error('JWT expired'))).toContain('znovu přihlas');
    expect(copyGroupLibraryErrorMessage(new Error('permission denied for table copy_groups'))).toContain('permission denied');
  });
});

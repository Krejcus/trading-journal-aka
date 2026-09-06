import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyGroupLibraryRequestFence } from '../lib/copyGroupLibraryRequestFence';

const remote = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../services/supabase', () => ({ supabase: {
  from: () => ({ select: () => ({ eq: () => ({ order: remote.read }) }) }),
} }));
import { loadCopyGroupLibrary, readCopyGroupCache, writeCopyGroupCache } from '../services/copyGroupLibrary';
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

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
});

import { describe, expect, it } from 'vitest';
import { CopyGroupLibraryRequestFence } from '../lib/copyGroupLibraryRequestFence';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};

describe('copy group cloud read/write ordering', () => {
  it.each(['save', 'import', 'delete', 'follower-update'] as const)(
    '%s keeps the locally confirmed configuration when an older focus refresh resolves last', async operation => {
      const fence = new CopyGroupLibraryRequestFence('owner-a');
      const response = deferred<string[]>();
      const token = fence.beginRead()!;
      let groups: string[];
      const refresh = response.promise.then(next => {
        if (fence.canAcceptRead(token)) groups = next;
      });
      const write = fence.beginWrite();
      groups = operation === 'delete' ? [] : [`confirmed-${operation}`];
      expect(fence.beginRead()).toBeNull(); // visibility/focus must not issue another request during persistence
      fence.endWrite(write);
      response.resolve(['old-profile']);
      await refresh;
      expect(groups).toEqual(operation === 'delete' ? [] : [`confirmed-${operation}`]);
      expect(fence.canAcceptRead(fence.beginRead()!)).toBe(true);
    },
  );

  it('a failed write cannot be hidden by an older successful refresh, and a deliberate retry can read again', async () => {
    const fence = new CopyGroupLibraryRequestFence('a');
    const token = fence.beginRead()!;
    const write = fence.beginWrite();
    let state = { draft: 'edited', error: 'cloud unavailable' };
    fence.endWrite(write);
    if (fence.canAcceptRead(token)) state = { draft: 'old cloud value', error: '' };
    expect(state).toEqual({ draft: 'edited', error: 'cloud unavailable' });
    expect(fence.canAcceptRead(fence.beginRead()!)).toBe(true);
  });

  it('waits for every overlapping write, including an idempotent completion callback', () => {
    const fence = new CopyGroupLibraryRequestFence('a');
    const first = fence.beginWrite();
    const second = fence.beginWrite();
    fence.endWrite(first);
    fence.endWrite(first);
    expect(fence.canAcceptWrite(second)).toBe(true);
    expect(fence.beginRead()).toBeNull();
    fence.endWrite(second);
    expect(fence.canAcceptRead(fence.beginRead()!)).toBe(true);
  });

  it('rejects requests from the previous owner even after switching A → B → A', () => {
    const fence = new CopyGroupLibraryRequestFence('a');
    const oldRead = fence.beginRead()!;
    const oldWrite = fence.beginWrite();
    fence.setOwner('b');
    fence.setOwner('a');
    const currentWrite = fence.beginWrite();
    fence.endWrite(oldWrite);
    expect(fence.canAcceptRead(oldRead)).toBe(false);
    expect(fence.canAcceptWrite(oldWrite)).toBe(false);
    expect(fence.canAcceptWrite(currentWrite)).toBe(true);
    expect(fence.beginRead()).toBeNull();
  });

  it('unmount/StrictMode cleanup invalidates old work without blocking the next mount', () => {
    const fence = new CopyGroupLibraryRequestFence('a');
    const read = fence.beginRead()!;
    const write = fence.beginWrite();
    fence.invalidate();
    expect(fence.canAcceptRead(read)).toBe(false);
    expect(fence.canAcceptWrite(write)).toBe(false);
    expect(fence.canAcceptRead(fence.beginRead()!)).toBe(true);
  });

  it('only accepts the newest refresh, while an unchanged owner preserves it', () => {
    const fence = new CopyGroupLibraryRequestFence('a');
    const oldRead = fence.beginRead()!;
    const newRead = fence.beginRead()!;
    fence.setOwner('a');
    expect(fence.canAcceptRead(oldRead)).toBe(false);
    expect(fence.canAcceptRead(newRead)).toBe(true);
  });
});

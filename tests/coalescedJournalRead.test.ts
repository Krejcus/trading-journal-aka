import { describe, expect, it, vi } from 'vitest';
import { coalescedJournalRead } from '../services/coalescedJournalRead';
describe('coalesced journal reads', () => {
  it('coalesces bursts and invalidates an in-flight read with one trailing read', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const latest: (() => boolean)[] = [];
      const read = vi.fn(async (isLatest: () => boolean) => { latest.push(isLatest); await new Promise<void>(r => { release = r; }); });
      const queue = coalescedJournalRead({ read });
      for (let i = 0; i < 20; i++) queue.request();
      await vi.advanceTimersByTimeAsync(350); expect(read).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 20; i++) queue.request();
      await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(1); expect(latest[0]()).toBe(false);
      release(); await vi.advanceTimersByTimeAsync(350); expect(read).toHaveBeenCalledTimes(2); expect(latest[1]()).toBe(true);
      queue.dispose(); expect(latest[1]()).toBe(false); release();
      await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

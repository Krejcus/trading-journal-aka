import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTradovateAccountDisplayFeed } from '../server/tradovateAccountDisplayFeed';

describe('display snapshot queue', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-11T12:00:00Z')); });
  afterEach(() => vi.useRealTimers());
  it('coalesces events, scopes account access and preserves an event arriving during a read', async () => {
    let resolve!: (value: {totalCashValue:number}) => void;
    const read = vi.fn(() => new Promise<{totalCashValue:number}>(r => { resolve = r; }));
    const feed = createTradovateAccountDisplayFeed({ connectionId:'c', environment:'demo', accountIds:()=>[10], read });
    feed.invalidate(999); feed.invalidate(10); feed.invalidate(10);
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(1);
    feed.invalidate(10); resolve({totalCashValue:0});
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.state().snapshots[0].fields.totalCashValue).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
    feed.close(); resolve({totalCashValue:1});
  });
  it('honors retry-after and does not refresh timestamps on failure', async () => {
    const read = vi.fn().mockResolvedValueOnce({totalCashValue:50_000}).mockRejectedValueOnce(Object.assign(new Error('limited'), {status:429,retryAfterMs:30_000})).mockResolvedValue({totalCashValue:50_001});
    const feed = createTradovateAccountDisplayFeed({connectionId:'c',environment:'demo',accountIds:()=>[10],read});
    feed.invalidate(null); await vi.advanceTimersByTimeAsync(250);
    const confirmed = feed.state().snapshots[0].confirmedAt;
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.state().snapshots[0].confirmedAt).toBe(confirmed);
    await vi.advanceTimersByTimeAsync(29_999); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(3);
    feed.close();
  });
  it('discards data after account removal or connection reset', async () => {
    let resolve!: (value:{totalCashValue:number})=>void;
    let ids = [10];
    const feed = createTradovateAccountDisplayFeed({connectionId:'c',environment:'demo',accountIds:()=>ids,read:()=>new Promise(r=>{resolve=r;})});
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(250);
    ids=[]; resolve({totalCashValue:1}); await vi.advanceTimersByTimeAsync(0);
    expect(feed.state().snapshots).toEqual([]);
    ids=[10]; feed.invalidate(10); await vi.advanceTimersByTimeAsync(1_000);
    feed.reset(); resolve({totalCashValue:2}); await vi.advanceTimersByTimeAsync(0);
    expect(feed.state().snapshots).toEqual([]); feed.close();
  });
  it('recovers from a hung transport and ignores its late result', async () => {
    let resolve!: (value:{totalCashValue:number})=>void;
    const read = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({totalCashValue:2});
    const feed = createTradovateAccountDisplayFeed({connectionId:'c',environment:'demo',accountIds:()=>[10],read});
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(feed.state().lastErrorAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(feed.state().snapshots[0].fields.totalCashValue).toBe(2);
    resolve({totalCashValue:1}); await vi.advanceTimersByTimeAsync(0);
    expect(feed.state().snapshots[0].fields.totalCashValue).toBe(2);
    feed.close();
  });

});

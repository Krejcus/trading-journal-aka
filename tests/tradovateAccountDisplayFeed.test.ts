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
    await vi.advanceTimersByTimeAsync(29_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    feed.close(); resolve({totalCashValue:1});
  });
  it('honors explicit endpoint p-time and does not refresh timestamps on failure', async () => {
    const read = vi.fn().mockResolvedValueOnce({totalCashValue:50_000}).mockRejectedValueOnce(Object.assign(new Error('limited'), {status:429,evidence:'p-time',retryAfterMs:30_000})).mockResolvedValue({totalCashValue:50_001});
    const feed = createTradovateAccountDisplayFeed({connectionId:'c',environment:'demo',accountIds:()=>[10],read,minReadIntervalMs:1_000});
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
    const feed = createTradovateAccountDisplayFeed({connectionId:'c',environment:'demo',accountIds:()=>ids,minReadIntervalMs:1_000,read:()=>new Promise(r=>{resolve=r;})});
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
    const feed = createTradovateAccountDisplayFeed({connectionId:'c',environment:'demo',accountIds:()=>[10],read,minReadIntervalMs:1_000});
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(feed.state().lastErrorAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(feed.state().snapshots[0].fields.totalCashValue).toBe(2);
    resolve({totalCashValue:1}); await vi.advanceTimersByTimeAsync(0);
    expect(feed.state().snapshots[0].fields.totalCashValue).toBe(2);
    feed.close();
  });

  it('default throttle coalesces cash invalidation storms while preserving the actual read timestamp', async () => {
    const read = vi.fn().mockResolvedValue({ totalCashValue: 50_000 });
    const feed = createTradovateAccountDisplayFeed({ connectionId: 'c', environment: 'demo', accountIds: () => [10], read });
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(250);
    const first = feed.state().snapshots[0];
    for (let i = 0; i < 100; i += 1) feed.invalidate(10);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(read).toHaveBeenCalledTimes(1);
    expect(feed.state().snapshots[0]).toEqual(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(Date.parse(feed.state().snapshots[0].requestedAt) - Date.parse(first.requestedAt)).toBe(30_000);
    feed.close();
  });

  it.each([undefined, 30_000, 7_200_000])('raw 429 waits at least an hour and reset cannot bypass it (RetryAfter %s)', async retryAfterMs => {
    const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error('http429'), { status: 429, retryAfterMs }))
      .mockResolvedValue({ totalCashValue: 50_000 });
    const feed = createTradovateAccountDisplayFeed({ connectionId: 'c', environment: 'demo', accountIds: () => [10], read });
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(250);
    const retryAt = Date.parse(feed.state().retryAt!);
    expect(retryAt - Date.now()).toBe(Math.max(3_600_000, retryAfterMs ?? 0));
    const lastErrorAt = feed.state().lastErrorAt;
    feed.reset(); feed.invalidate(10);
    expect(feed.state().retryAt).toBe(new Date(retryAt).toISOString());
    expect(feed.state().lastErrorAt).toBe(lastErrorAt);
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2);
    feed.close();
  });

  it('captcha is terminal despite repeated audit, reconnect and reset invalidations', async () => {
    const read = vi.fn().mockRejectedValue(Object.assign(new Error('manual-captcha'), { status: 429, evidence: 'captcha', captchaRequired: true, retryAfterMs: 30_000 }));
    const feed = createTradovateAccountDisplayFeed({ connectionId: 'c', environment: 'demo', accountIds: () => [10], read });
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(250);
    expect(feed.state()).toMatchObject({ captchaRequired: true, retryAt: null });
    await vi.advanceTimersByTimeAsync(4 * 3_600_000); expect(read).toHaveBeenCalledTimes(1);
    feed.setStreamConnected(true); feed.reset(); feed.invalidate(null);
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(read).toHaveBeenCalledTimes(1); expect(feed.state().captchaRequired).toBe(true); expect(feed.state().snapshots).toEqual([]);
    feed.close();
  });

  it('a late 429 after reset extends an already scheduled timer before the next physical read', async () => {
    let reject!: (reason: unknown) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValue({ totalCashValue: 50_000 });
    const feed = createTradovateAccountDisplayFeed({ connectionId: 'c', environment: 'demo', accountIds: () => [10], read });
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(250);
    feed.reset(); feed.invalidate(10); await vi.advanceTimersByTimeAsync(0);
    reject(Object.assign(new Error('late-http429'), { status: 429 })); await vi.advanceTimersByTimeAsync(0);
    const retryAt = Date.parse(feed.state().retryAt!);
    await vi.advanceTimersByTimeAsync(15_000); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(retryAt - Date.now()); expect(read).toHaveBeenCalledTimes(2);
    feed.close();
  });

  it('local budget refusal is not relabelled as a new hour-long upstream penalty', async () => {
    const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error('budget-limited'), { status: 429, blockedBeforeDispatch: true, retryAfterMs: 20_000 }))
      .mockResolvedValue({ totalCashValue: 50_000 });
    const feed = createTradovateAccountDisplayFeed({ connectionId: 'c', environment: 'demo', accountIds: () => [10], read, minReadIntervalMs: 1000 });
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(250);
    expect(Date.parse(feed.state().retryAt!) - Date.now()).toBe(20_000);
    await vi.advanceTimersByTimeAsync(19_999); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2);
    feed.close();
  });

  it('partial snapshots do not refresh omitted fields or invent absent values', async () => {
    const read = vi.fn().mockResolvedValueOnce({ totalCashValue: 50_000, netLiq: 50_100 }).mockResolvedValueOnce({ totalCashValue: 50_010 });
    const feed = createTradovateAccountDisplayFeed({ connectionId: 'c', environment: 'demo', accountIds: () => [10], read });
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(250);
    feed.invalidate(10); await vi.advanceTimersByTimeAsync(30_000);
    expect(feed.state().snapshots[0].fields).toEqual({ totalCashValue: 50_010 });
    expect(feed.state().snapshots[0].fields.netLiq).toBeUndefined(); feed.close();
  });

});

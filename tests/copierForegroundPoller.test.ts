import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCopierForegroundPoller, isCopierStatusFresh } from '../lib/copierForegroundPoller';
afterEach(()=>vi.useRealTimers());
describe('foreground copier status refresh',()=>{
 it('refreshes immediately on return and does no polling while hidden',async()=>{
  vi.useFakeTimers();let visible=true;const read=vi.fn().mockResolvedValue(undefined);const invalidate=vi.fn();
  const poller=createCopierForegroundPoller({visible:()=>visible,read,invalidate});
  await vi.advanceTimersByTimeAsync(2000);expect(read).toHaveBeenCalledTimes(2);
  visible=false;poller.resume();await vi.advanceTimersByTimeAsync(600_000);expect(read).toHaveBeenCalledTimes(2);
  visible=true;poller.resume();expect(read).toHaveBeenCalledTimes(3);expect(invalidate).toHaveBeenCalledTimes(1);
  poller.stop();await vi.advanceTimersByTimeAsync(10000);expect(read).toHaveBeenCalledTimes(3);
 });
 it('discards pre-sleep responses, coalesces resume events, and never overlaps requests',async()=>{
  vi.useFakeTimers();let visible=true;let finish!:()=>void;let accepted=0;
  const read=vi.fn(async(current:()=>boolean)=>{await new Promise<void>(r=>{finish=r;});if(current())accepted++;});
  const poller=createCopierForegroundPoller({visible:()=>visible,read,invalidate:vi.fn()});
  visible=false;poller.resume();visible=true;poller.resume();poller.resume();
  expect(read).toHaveBeenCalledTimes(1);finish();await vi.advanceTimersByTimeAsync(0);
  expect(accepted).toBe(0);expect(read).toHaveBeenCalledTimes(2);
  finish();await vi.advanceTimersByTimeAsync(0);expect(accepted).toBe(1);poller.stop();
 });
 it('does not accept a response or reschedule after disposal',async()=>{
  vi.useFakeTimers();let finish!:()=>void;let accepted=false;
  const read=vi.fn(async(current:()=>boolean)=>{await new Promise<void>(r=>{finish=r;});accepted=current();});
  const poller=createCopierForegroundPoller({visible:()=>true,read,invalidate:vi.fn()});
  poller.stop();finish();await vi.advanceTimersByTimeAsync(10000);
  expect(accepted).toBe(false);expect(read).toHaveBeenCalledTimes(1);
 });
 it('recovers on a later cycle after a failed read',async()=>{
  vi.useFakeTimers();const read=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(undefined);
  const poller=createCopierForegroundPoller({visible:()=>true,read,invalidate:vi.fn()});
  await vi.advanceTimersByTimeAsync(2000);expect(read).toHaveBeenCalledTimes(2);poller.stop();
 });
 it('focus while already visible refreshes without invalidating and coalesces a short event burst',async()=>{
  vi.useFakeTimers();let now=10_000;const read=vi.fn().mockResolvedValue(undefined);const invalidate=vi.fn();
  const poller=createCopierForegroundPoller({visible:()=>true,read,invalidate,now:()=>now});
  await vi.advanceTimersByTimeAsync(0);expect(read).toHaveBeenCalledTimes(1);
  poller.resume();await vi.advanceTimersByTimeAsync(0);expect(read).toHaveBeenCalledTimes(2);
  now+=500;poller.resume();await vi.advanceTimersByTimeAsync(0);expect(read).toHaveBeenCalledTimes(2);
  expect(invalidate).not.toHaveBeenCalled();poller.stop();
 });
 it('keeps a read started after resume current across duplicate focus events',async()=>{
  vi.useFakeTimers();let visible=true;let finish!:()=>void;let accepted=0;let now=0;
  const read=vi.fn(async(current:()=>boolean)=>{await new Promise<void>(resolve=>{finish=resolve;});if(current())accepted++;});
  const poller=createCopierForegroundPoller({visible:()=>visible,read,invalidate:vi.fn(),now:()=>now});
  visible=false;poller.resume();visible=true;now=2_000;poller.resume();now=2_100;poller.resume();
  finish();await vi.advanceTimersByTimeAsync(0);expect(accepted).toBe(0);
  finish();await vi.advanceTimersByTimeAsync(0);expect(accepted).toBe(1);expect(read).toHaveBeenCalledTimes(2);poller.stop();
 });
});

describe('copier status freshness',()=>{
 it('ages from observedAt on a ticking clock and fails closed after the 15 second boundary',()=>{
  expect(isCopierStatusFresh(10_000,24_999,true)).toBe(true);
  expect(isCopierStatusFresh(10_000,25_000,true)).toBe(false);
 });
 it('marks a failed or stale read unavailable without deleting its observation timestamp',()=>{
  expect(isCopierStatusFresh(10_000,11_000,false)).toBe(false);
  expect(isCopierStatusFresh(null,11_000,true)).toBe(false);
 });
 it('tolerates a small negative age instead of depending on the client wall clock',()=>{
  expect(isCopierStatusFresh(10_200,10_000,true)).toBe(true);
 });
});

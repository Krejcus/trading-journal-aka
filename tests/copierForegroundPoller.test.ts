import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCopierForegroundPoller } from '../lib/copierForegroundPoller';
afterEach(()=>vi.useRealTimers());
describe('foreground copier status refresh',()=>{
 it('refreshes immediately on return and does no polling while hidden',async()=>{
  vi.useFakeTimers();let visible=true;const read=vi.fn().mockResolvedValue(undefined);const invalidate=vi.fn();
  const poller=createCopierForegroundPoller({visible:()=>visible,read,invalidate});
  await vi.advanceTimersByTimeAsync(2000);expect(read).toHaveBeenCalledTimes(2);
  visible=false;poller.resume();await vi.advanceTimersByTimeAsync(600_000);expect(read).toHaveBeenCalledTimes(2);
  visible=true;poller.resume();expect(read).toHaveBeenCalledTimes(3);expect(invalidate).toHaveBeenCalledTimes(2);
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
});

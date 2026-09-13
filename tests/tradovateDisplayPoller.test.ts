import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import {createTradovateDisplayPoller,type DisplayPollState} from '../lib/tradovateDisplayPoller';
const makeState=():DisplayPollState=>({userId:'a',membership:new Map([['c',{environment:'demo',accountIds:new Set([10,11])}]]),worker:null,publish:vi.fn()});
describe('display scheduling',()=>{
 beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));});
 afterEach(()=>vi.useRealTimers());
 it('coalesces legacy reads, pauses hidden and catches up on return',async()=>{
  const state=makeState();let visible=false;
  const read=vi.fn().mockResolvedValue({snapshots:[],legacy:true});
  const poller=createTradovateDisplayPoller({current:()=>state,visible:()=>visible,failure:vi.fn(),read});
  await vi.advanceTimersByTimeAsync(120000);expect(read).not.toHaveBeenCalled();
  visible=true;poller.resume();await vi.advanceTimersByTimeAsync(0);expect(read).toHaveBeenCalledTimes(1);
  poller.resume();await vi.advanceTimersByTimeAsync(59999);expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);expect(read).toHaveBeenCalledTimes(2);poller.stop();
 });
 it('honors Retry-After even when visibility/online repeatedly trigger resume',async()=>{
  const state=makeState();const failure=vi.fn();
  const read=vi.fn().mockRejectedValueOnce({status:429,retryAfterMs:90000}).mockResolvedValue({snapshots:[],legacy:true});
  const poller=createTradovateDisplayPoller({current:()=>state,visible:()=>true,failure,read});
  await vi.advanceTimersByTimeAsync(30000);expect(failure).toHaveBeenLastCalledWith(true);
  poller.resume();await vi.advanceTimersByTimeAsync(89999);expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);expect(read).toHaveBeenCalledTimes(2);expect(failure).toHaveBeenLastCalledWith(false);poller.stop();
 });
 it('discards an in-flight response on user change and stop',async()=>{
  const state=makeState();let resolve!:(value:{snapshots:[];legacy:true})=>void;
  const read=vi.fn(()=>new Promise<{snapshots:[];legacy:true}>(r=>{resolve=r;}));
  const poller=createTradovateDisplayPoller({current:()=>state,visible:()=>true,failure:vi.fn(),read});
  await vi.advanceTimersByTimeAsync(30000);state.userId='b';poller.stop();resolve({snapshots:[],legacy:true});
  await vi.advanceTimersByTimeAsync(60000);expect(state.publish).not.toHaveBeenCalled();expect(read).toHaveBeenCalledTimes(1);
 });
 it('uses fallback after worker stream loss without declaring old snapshots fresh',async()=>{
  const state=makeState();const confirmedAt=new Date().toISOString();
  state.worker={userId:'a',receivedAt:Date.now(),feeds:[{connectionId:'c',environment:'demo',streamConnected:true,lastErrorAt:null,retryAt:null,pendingAccountIds:[],snapshots:[10,11].map(accountId=>({connectionId:'c',environment:'demo',accountId,requestedAt:confirmedAt,confirmedAt,fields:{dailyRealizedPnL:0,totalCashValue:50000}}))}]};
  const read=vi.fn().mockResolvedValue({snapshots:[],legacy:true});
  const poller=createTradovateDisplayPoller({current:()=>{state.worker!.receivedAt=Date.now();return state;},visible:()=>true,failure:vi.fn(),read});
  await vi.advanceTimersByTimeAsync(30000);expect(read).not.toHaveBeenCalled();
  state.worker.feeds[0].streamConnected=false;await vi.advanceTimersByTimeAsync(10000);expect(read).toHaveBeenCalledTimes(1);poller.stop();
 });
 it('respects a shared API pause without issuing its own probe',async()=>{
  const state=makeState();const read=vi.fn().mockResolvedValue({snapshots:[],legacy:true});
  const until=Date.now()+90000;
  const poller=createTradovateDisplayPoller({current:()=>state,visible:()=>true,pausedUntil:()=>until,failure:vi.fn(),read});
  await vi.advanceTimersByTimeAsync(89999);expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);expect(read).toHaveBeenCalledTimes(1);poller.stop();
 });

});

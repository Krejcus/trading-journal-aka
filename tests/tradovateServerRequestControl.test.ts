import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createControlledTradovateServerFetch, createServerTradovateRequestControl, resetServerTradovatePendingPenaltiesForTests } from '../server/tradovateServerRequestControl';
import type { TradovateRequestControlSnapshot } from '../lib/tradovateRequestControl';
const fixture = () => {
  let now = 1000;
  let mono = 0;
  const state: TradovateRequestControlSnapshot = {version:1,brokerUserId:42,serverNow:now,epoch:0,blockedUntil:null,captchaRequired:false,evidence:null,reason:null,backgroundReservedHour:0,backgroundReservedMinute:0};
  const rpc = vi.fn(async (_name:string, args:Record<string,unknown>) => {
    state.serverNow = now;
    if(args.p_mode === 'penalize') { state.epoch++; state.blockedUntil = Math.max(state.blockedUntil ?? 0,now+Number(args.p_retry_after_ms)); state.captchaRequired ||= args.p_captcha_required === true; state.evidence=args.p_evidence as typeof state.evidence; }
    if(args.p_mode === 'reserve') {
      if(state.captchaRequired || (state.blockedUntil ?? 0)>now) return {data:{allowed:false,code:state.captchaRequired?'tradovate-request-captcha':'tradovate-request-cooldown',snapshot:{...state}},error:null};
      return {data:{allowed:true,grant:{version:1,grantId:args.p_grant_id,brokerUserId:42,purpose:args.p_purpose,units:args.p_units,serverNow:now,validUntil:now+Number(args.p_ttl_ms),epoch:state.epoch}},error:null};
    }
    return {data:{allowed:true,snapshot:{...state}},error:null};
  });
  const context={db:{rpc} as unknown as SupabaseClient,userId:'owner',connectionId:'connection',brokerUserId:42};
  return {state,rpc,context,clock:()=>now,monotonic:()=>mono,advance:(ms:number)=>{now+=ms;mono+=ms;}, jump:(ms:number)=>{now+=ms;}};
};
describe('server broker-user request control',()=>{
 beforeEach(resetServerTradovatePendingPenaltiesForTests);
 it('reserves every physical request and forwards the exact response without consuming it',async()=>{
  const f=fixture();const upstream=vi.fn(async()=>Response.json({value:0}));
  const fetcher=createControlledTradovateServerFetch(f.context,upstream,'background',f.clock,f.monotonic);
  const response=await fetcher('https://broker.test/a');expect(await response.json()).toEqual({value:0});await fetcher('https://broker.test/b');
  expect(upstream).toHaveBeenCalledTimes(2);expect(f.rpc.mock.calls.map(([,a])=>a.p_mode)).toEqual(['reserve','read','reserve','read']);
  expect(f.rpc.mock.calls[0][1]).toMatchObject({p_owner_user_id:'owner',p_connection_id:'connection',p_units:1});
  expect(f.rpc.mock.calls[0][1].p_grant_id).not.toBe(f.rpc.mock.calls[2][1].p_grant_id);
 });
 it('fails closed before HTTP if migration/RPC is missing or identity is unknown',async()=>{
  const f=fixture();const upstream=vi.fn();f.rpc.mockResolvedValueOnce({data:null,error:{message:'function missing'}} as never);
  await expect(createControlledTradovateServerFetch(f.context,upstream)('https://broker.test/a')).rejects.toMatchObject({code:'tradovate-request-control-unavailable',status:503,notDispatched:true});
  await expect(createControlledTradovateServerFetch({...f.context,brokerUserId:null},upstream)('https://broker.test/a')).rejects.toMatchObject({code:'tradovate-request-identity-unavailable'});
  expect(upstream).not.toHaveBeenCalled();
 });
 it('does not dispatch a reserved request when a penalty arrives during the last authority await',async()=>{
  const f=fixture();const original=f.rpc.getMockImplementation()!;f.rpc.mockImplementation(async(n,a)=>{if(a.p_mode==='read'){f.state.epoch++;f.state.blockedUntil=90000;}return original(n,a);});
  const upstream=vi.fn();await expect(createControlledTradovateServerFetch(f.context,upstream,'background',f.clock,f.monotonic)('https://broker.test')).rejects.toMatchObject({code:'tradovate-request-cooldown'});expect(upstream).not.toHaveBeenCalled();
 });
 it('expires grants by monotonic elapsed time even if wall clock jumps backward',async()=>{
  const f=fixture();const original=f.rpc.getMockImplementation()!;f.rpc.mockImplementation(async(n,a)=>{const result=await original(n,a);f.advance(a.p_mode==='reserve'?4000:2000);if(a.p_mode==='read')f.jump(-6000);return result;});
  const upstream=vi.fn();await expect(createControlledTradovateServerFetch(f.context,upstream,'background',f.clock,f.monotonic)('https://broker.test')).rejects.toMatchObject({code:'tradovate-request-grant-expired'});
  expect(upstream).not.toHaveBeenCalled();
 });
 it.each([{status:429,body:{},duration:3600000,evidence:'raw-429',captcha:false},{status:200,body:{'p-ticket':'redacted','p-time':42},duration:42000,evidence:'p-time',captcha:false},{status:200,body:{'p-ticket':'redacted','p-captcha':true},duration:3600000,evidence:'captcha',captcha:true}])('publishes $evidence and never retries or clears it on success',async({status,body,duration,evidence,captcha})=>{
  const f=fixture();const upstream=vi.fn(async()=>Response.json(body,{status}));const fetcher=createControlledTradovateServerFetch(f.context,upstream,'background',f.clock,f.monotonic);
  expect((await fetcher('https://broker.test')).status).toBe(status);
  expect(f.rpc.mock.calls.at(-1)?.[1]).toMatchObject({p_mode:'penalize',p_evidence:evidence,p_retry_after_ms:duration,p_captcha_required:captcha});
  await expect(fetcher('https://broker.test')).rejects.toMatchObject({code:captcha?'tradovate-request-captcha':'tradovate-request-cooldown'});expect(upstream).toHaveBeenCalledTimes(1);
 });
 it('internal credential maintenance skips soft grants but honors fresh shared cooldown',async()=>{
  const f=fixture();const upstream=vi.fn(async()=>Response.json({access_token:'test'}));
  const fetcher=createControlledTradovateServerFetch(f.context,upstream,'management',f.clock,f.monotonic);
  await fetcher('https://broker.test/token');expect(f.rpc.mock.calls.map(([,a])=>a.p_mode)).toEqual(['read']);
  f.state.blockedUntil=90000;
  await expect(fetcher('https://broker.test/token')).rejects.toMatchObject({code:'tradovate-request-cooldown'});expect(upstream).toHaveBeenCalledTimes(1);
 });
 it('internal maintenance refuses a stale control read before physical dispatch',async()=>{
  const f=fixture();const original=f.rpc.getMockImplementation()!;f.rpc.mockImplementation(async(n,a)=>{f.advance(6000);return original(n,a);});const upstream=vi.fn();
  await expect(createControlledTradovateServerFetch(f.context,upstream,'management',f.clock,f.monotonic)('https://broker.test/token')).rejects.toMatchObject({code:'tradovate-request-control-stale'});expect(upstream).not.toHaveBeenCalled();
 });
 it('does not claim not-sent when penalty persistence fails after HTTP', async () => {
  const f=fixture();const original=f.rpc.getMockImplementation()!;f.rpc.mockImplementation(async(n,a)=>a.p_mode==='penalize'?{data:null,error:{message:'database unavailable'}} as never:original(n,a));
  const upstream=vi.fn(async()=>Response.json({}, {status:429}));
  await expect(createControlledTradovateServerFetch(f.context,upstream,'background',f.clock,f.monotonic)('https://broker.test')).rejects.toMatchObject({code:'tradovate-request-penalty-persist-failed',notDispatched:false});
  expect(upstream).toHaveBeenCalledTimes(1);
  // A newly constructed wrapper for another app owner still shares the same
  // broker principal and must first persist this observation, never probe.
  const next=fixture();const nextUpstream=vi.fn();
  await expect(createControlledTradovateServerFetch({...next.context,userId:'another-owner'},nextUpstream,'management',next.clock,next.monotonic)('https://broker.test/token')).rejects.toMatchObject({code:'tradovate-request-cooldown'});
  expect(next.rpc.mock.calls.map(([,a])=>a.p_mode)).toEqual(['penalize','read']);
  expect(nextUpstream).not.toHaveBeenCalled();
 });
 it('rejects a response scoped to another broker principal',async()=>{
  const f=fixture();f.state.brokerUserId=99;await expect(createServerTradovateRequestControl(f.context).read()).rejects.toMatchObject({code:'tradovate-request-control-invalid-scope'});
 });
 it('budget503 remains a local denial and does not publish a raw429 penalty',async()=>{
  const f=fixture();f.rpc.mockResolvedValueOnce({data:{allowed:false,code:'tradovate-request-budget',retryAfterMs:1000,snapshot:f.state},error:null} as never);const upstream=vi.fn();
  await expect(createControlledTradovateServerFetch(f.context,upstream)('https://broker.test')).rejects.toMatchObject({code:'tradovate-request-budget',status:503});expect(f.rpc).toHaveBeenCalledTimes(1);expect(upstream).not.toHaveBeenCalled();
 });
 it('423 headers stop a separate local wrapper during delayed body inspection and preserve a short p-time', async () => {
  const f=fixture(); let finish!:()=>void;
  const body=new ReadableStream<Uint8Array>({start(controller){finish=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({'p-ticket':'t','p-time':15})));controller.close();};}});
  const upstream=vi.fn(async()=>new Response(body,{status:423,headers:{'Content-Type':'application/json'}}));
  const first=createControlledTradovateServerFetch(f.context,upstream,'background',f.clock,f.monotonic)('https://broker.test');
  // Let the first physical fetch return headers and acquire its local hold.
  await new Promise(resolve=>setTimeout(resolve,10));
  const secondUpstream=vi.fn();
  await expect(createControlledTradovateServerFetch(f.context,secondUpstream,'management',f.clock,f.monotonic)('https://broker.test/token'))
    .rejects.toMatchObject({code:'tradovate-request-penalty-inspection-pending',notDispatched:true});
  expect(secondUpstream).not.toHaveBeenCalled();
  finish(); expect((await first).status).toBe(423);
  expect(f.rpc.mock.calls.filter(([,a])=>a.p_mode==='penalize').map(([,a])=>a.p_retry_after_ms)).toEqual([15000]);
  expect(f.state.blockedUntil).toBe(16000);
 });
 it('raw429 is published before waiting for its response body', async () => {
  const f=fixture(); let finish!:()=>void;
  const body=new ReadableStream<Uint8Array>({start(controller){finish=()=>{controller.enqueue(new TextEncoder().encode('{}'));controller.close();};}});
  const first=createControlledTradovateServerFetch(f.context,async()=>new Response(body,{status:429}),'background',f.clock,f.monotonic)('https://broker.test');
  await new Promise(resolve=>setTimeout(resolve,10));
  expect(f.state.blockedUntil).toBe(3601000);
  const next=vi.fn();
  await expect(createControlledTradovateServerFetch(f.context,next,'management',f.clock,f.monotonic)('https://broker.test/token')).rejects.toMatchObject({code:'tradovate-request-cooldown'});
  expect(next).not.toHaveBeenCalled(); finish(); await first;
 });
});

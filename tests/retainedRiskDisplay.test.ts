import { describe, expect, it } from 'vitest';
import { retainedRiskDisplay } from '../lib/retainedRiskDisplay';
const now=Date.parse('2026-09-12T08:00:00Z');
const input={key:'user:demo:1:dll:1200:day',enabled:true,value:1200,confirmedAt:'2026-09-12T07:59:50Z',verified:true};
describe('retained risk amounts are display only',()=>{
 it('retains amount and original time when verification expires or refresh is incomplete',()=>{
  const previous=retainedRiskDisplay(null,input,now);
  expect(retainedRiskDisplay(previous,{...input,value:null,confirmedAt:null,verified:false},now+60000)).toEqual({...previous,stale:true});
  expect(retainedRiskDisplay(previous,{...input,verified:false},now+60000)).toEqual({...previous,stale:true});
  expect(retainedRiskDisplay(previous,input,now+60000)).toEqual({...previous,stale:true});
 });
 it('never revives previous risk across identity, rule, or session changes',()=>{
  const previous=retainedRiskDisplay(null,input,now);
  expect(retainedRiskDisplay(previous,{...input,key:'other',value:null},now)).toBeNull();
  expect(retainedRiskDisplay(previous,{...input,enabled:false},now)).toBeNull();
 });
 it('updates promptly when a newly confirmed amount changes, including zero',()=>{
  const previous=retainedRiskDisplay(null,input,now);
  expect(retainedRiskDisplay(previous,{...input,value:0,confirmedAt:'2026-09-12T08:00:00Z'},now)).toMatchObject({value:0,stale:false});
 });
 it('does not accept older, invalid, or future evidence',()=>{
  const previous=retainedRiskDisplay(null,input,now);
  for(const confirmedAt of ['invalid','2099-01-01T00:00:00Z','2026-09-12T07:00:00Z'])
   expect(retainedRiskDisplay(previous,{...input,value:9999,confirmedAt},now)).toEqual({...previous,stale:true});
  expect(retainedRiskDisplay(null,{...input,value:NaN},now)).toBeNull();
 });
 it('během načítání zůstane čerstvá ověřená hodnota ověřená, ne šedá',()=>{
  const now=Date.parse('2026-10-04T09:26:17Z');
  const old={key:'k',value:546,confirmedAt:'2026-10-04T09:26:00Z',stale:false};
  const input={key:'k',enabled:true,value:null,confirmedAt:null,verified:false};
  expect(retainedRiskDisplay(old,{...input,pending:true},now)).toEqual({...old,stale:false});
  // Bez načítání (selhání čtení) dál „poslední známá“.
  expect(retainedRiskDisplay(old,input,now)?.stale).toBe(true);
  // Po ověřovacím okně ani načítání nepomůže.
  expect(retainedRiskDisplay(old,{...input,pending:true},now+60_000)?.stale).toBe(true);
  // Už zastaralá hodnota se načítáním neoživí.
  expect(retainedRiskDisplay({...old,stale:true},{...input,pending:true},now)?.stale).toBe(true);
 });
 it('o chvíli starší ověřený důkaz o stejné částce novější hodnotu nezešedí; jiná částka ano',()=>{
  const now=Date.parse('2026-10-04T07:29:10Z');
  const old={key:'k',value:546.04,confirmedAt:'2026-10-04T07:28:59Z',stale:false};
  const older={key:'k',enabled:true,value:546.0400000000009,confirmedAt:'2026-10-04T07:28:52Z',verified:true};
  expect(retainedRiskDisplay(old,older,now)).toEqual({...old,stale:false});
  expect(retainedRiskDisplay(old,{...older,value:400},now)?.stale).toBe(true);
  expect(retainedRiskDisplay(old,{...older,verified:false},now)?.stale).toBe(true);
 });
});

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
});

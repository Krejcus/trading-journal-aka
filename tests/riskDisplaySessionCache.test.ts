import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect,vi} from 'vitest';
import {readRiskDisplaySession,writeRiskDisplaySession} from '../lib/riskDisplaySessionCache';
import {LiveRiskValue} from '../components/LiveRiskValue';
const now=Date.parse('2026-09-12T07:00:00Z');
const identity='account:config:2026-09-12:dll';
const saved={key:identity,value:1200,confirmedAt:'2026-09-12T06:58:00Z',stale:false};
function storage(){const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};}
describe('DLL/DD reload cache',()=>{
 it('restores only the same user, connection, account and rule with unchanged evidence time',()=>{
  const store=storage();writeRiskDisplaySession('user:demo:connection',identity,saved,store);
  expect(readRiskDisplaySession('user:demo:connection',identity,store,now)).toEqual({...saved,stale:true});
  expect(readRiskDisplaySession('other:demo:connection',identity,store,now)).toBeNull();
  expect(readRiskDisplaySession('user:live:connection',identity,store,now)).toBeNull();
  expect(readRiskDisplaySession('user:demo:connection','changed-rule',store,now)).toBeNull();
 });
 it('expires across trading days and rejects future timestamps',()=>{
  const store=storage();writeRiskDisplaySession('u',identity,saved,store);
  expect(readRiskDisplaySession('u',identity,store,Date.parse('2026-09-13T07:00:00Z'))).toBeNull();
  expect(readRiskDisplaySession('u',identity,store,now-86400000)).toBeNull();
 });
 it('supports zero and clears an explicitly disabled limit',()=>{
  const store=storage();writeRiskDisplaySession('u',identity,{...saved,value:0},store);
  expect(readRiskDisplaySession('u',identity,store,now)?.value).toBe(0);
  writeRiskDisplaySession('u',identity,null,store);expect(readRiskDisplaySession('u',identity,store,now)).toBeNull();
 });
 it('renders cached green value on the first render while new data is pending',()=>{
  const store=storage();writeRiskDisplaySession('u',identity,saved,store);
  vi.useFakeTimers();vi.setSystemTime(now);vi.stubGlobal('window',{sessionStorage:store});
  try {
   const html=renderToStaticMarkup(React.createElement(LiveRiskValue,{identity,storageScope:'u',enabled:true,value:null,confirmedAt:null,verified:false,color:()=>'text-emerald-500',label:'DLL zbývá'}));
   expect(html).toContain('1,200');expect(html).toContain('text-emerald-500');expect(html).toContain('data-risk-display="last-known"');expect(html).not.toContain('Načítám');
  } finally {vi.unstubAllGlobals();vi.useRealTimers();}
 });
 it('tolerates blocked storage without affecting the dashboard',()=>{
  const blocked={getItem:()=>{throw Error();},setItem:()=>{throw Error();},removeItem:()=>{throw Error();}};
  expect(readRiskDisplaySession('u',identity,blocked,now)).toBeNull();expect(()=>writeRiskDisplaySession('u',identity,saved,blocked)).not.toThrow();
 });
});

import { liveBalanceDisplay, liveDailyPnlDisplay } from '../lib/liveBalanceDisplay';
import { isLiveAccountReadVerified } from '../lib/liveReadFreshness';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import { describe, expect, it } from 'vitest';
import { readTradovateDisplaySession, writeTradovateDisplaySession } from '../lib/tradovateDisplaySessionCache';
import { mergeTradovateAccountDisplay } from '../lib/tradovateAccountDisplayMerge';
const now = Date.parse('2026-09-11T19:00:00Z');
const value = {value:0,requestedAt:'2026-09-11T18:00:00Z',confirmedAt:'2026-09-11T18:00:01Z'};
const cache = {'demo:c:10':{totalCashValue:value,dailyRealizedPnL:value}};
function storage() { const data = new Map<string,string>(); return {getItem:(k:string)=>data.get(k) ?? null,setItem:(k:string,v:string)=>{data.set(k,v);}}; }
describe('display session reload',()=>{
 it('restores real zero for only the same user with unchanged timestamps',()=>{
  const store=storage();writeTradovateDisplaySession('a',cache,store,now);
  expect(readTradovateDisplaySession('a',store,now+1000)).toEqual(cache);
  expect(readTradovateDisplaySession('b',store,now)).toEqual({});
 });
 it('retains only display cash and daily amounts, never risk or open positions',()=>{
  const store=storage();writeTradovateDisplaySession('a',{'demo:c:10':{...cache['demo:c:10'],openPnL:value,netLiq:value}},store,now);
  expect(readTradovateDisplaySession('a',store,now)).toEqual(cache);
 });
 it('keeps balance across session rollover but discards yesterday daily P&L',()=>{
  const store=storage();writeTradovateDisplaySession('a',cache,store,now);
  expect(readTradovateDisplaySession('a',store,Date.parse('2026-09-11T23:00:00Z'))).toEqual({'demo:c:10':{totalCashValue:value}});
  expect(readTradovateDisplaySession('a',store,now+86400001)).toEqual({});
 });
 it('rejects future, invalid and malformed values and tolerates inaccessible storage',()=>{
  const store=storage();store.setItem('alphatrade:tradovate-display:v1:a',JSON.stringify({'demo:c:10':{totalCashValue:{...value,confirmedAt:'2099-01-01'}}}));
  expect(readTradovateDisplaySession('a',store,now)).toEqual({});
  store.setItem('alphatrade:tradovate-display:v1:a','bad');expect(readTradovateDisplaySession('a',store,now)).toEqual({});
  const blocked={getItem:()=>{throw Error();},setItem:()=>{throw Error();}};
  expect(readTradovateDisplaySession('a',blocked,now)).toEqual({});
  expect(()=>writeTradovateDisplaySession('a',cache,blocked,now)).not.toThrow();
 });
 it('shows restored values during bootstrap without granting risk freshness',()=>{
  const store=storage();writeTradovateDisplaySession('a',cache,store,now);
  const account={id:10,balance:0,realizedPnl:0,cashAvailability:'unavailable',cashUpdatedAt:null,dailyPnlAvailable:false,
    displayValues:readTradovateDisplaySession('a',store,now)['demo:c:10']} as LiveAccount;
  expect(liveBalanceDisplay(account,now)).toMatchObject({value:0,confirmedAt:value.confirmedAt});
  expect(liveDailyPnlDisplay(account,now,true)).toMatchObject({value:0,confirmedAt:value.confirmedAt});
  expect(isLiveAccountReadVerified(account,'cash',now)).toBe(false);
  expect(liveBalanceDisplay({...account,cashAvailability:'denied'},now).value).toBeNull();
 });
 it('keeps the daily source timestamp when cash is newer',()=>{
  const account={realizedPnl:10,dailyPnlAvailable:true,cashAvailability:'available',cashUpdatedAt:new Date(now).toISOString(),dailyPnlUpdatedAt:value.confirmedAt} as LiveAccount;
  expect(liveDailyPnlDisplay(account,now).confirmedAt).toBe(value.confirmedAt);
 });
 it('restored values remain subject to current account and environment membership',()=>{
  const store=storage();writeTradovateDisplaySession('a',cache,store,now);const restored=readTradovateDisplaySession('a',store,now);
  expect(mergeTradovateAccountDisplay(restored,[],new Map(),now)).toEqual({});
  expect(mergeTradovateAccountDisplay(restored,[],new Map([['c',{environment:'live',accountIds:new Set([10])}]]),now)).toEqual({});
 });
});

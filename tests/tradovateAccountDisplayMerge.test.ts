import { describe, expect, it } from 'vitest';
import { mergeTradovateAccountDisplay } from '../lib/tradovateAccountDisplayMerge';
import type { TradovateAccountDisplayFeedState } from '../lib/tradovateAccountDisplayTypes';
const membership = new Map([['c', {environment:'demo' as const, accountIds:new Set([10])}]]);
const feed: TradovateAccountDisplayFeedState = {connectionId:'c', environment:'demo', pendingAccountIds:[],lastErrorAt:null,retryAt:null,
 snapshots:[{connectionId:'c', environment:'demo', accountId:10,requestedAt:'2026-09-11T12:00:00Z',confirmedAt:'2026-09-11T12:00:01Z',fields:{totalCashValue:50_000,realizedPnL:0}}]};
const now=Date.parse('2026-09-11T12:01:00Z');
describe('display-only account merge',()=>{
 it('keeps each field timestamp when a later response is partial',()=>{
  const initial=mergeTradovateAccountDisplay({},[feed],membership,now);
  const later={...feed,snapshots:[{...feed.snapshots[0],requestedAt:'2026-09-11T12:00:10Z',confirmedAt:'2026-09-11T12:00:11Z',fields:{totalCashValue:50_010}}]};
  const merged=mergeTradovateAccountDisplay(initial,[later],membership,now);
  expect(merged['demo:c:10'].realizedPnL).toEqual(initial['demo:c:10'].realizedPnL);
  expect(merged['demo:c:10'].totalCashValue?.value).toBe(50_010);
  expect(mergeTradovateAccountDisplay(merged,[feed],membership,now)).toEqual(merged);
 });
 it('rejects foreign connections, environments, accounts and future timestamps',()=>{
  for(const snapshot of [
   {...feed.snapshots[0],connectionId:'foreign'}, {...feed.snapshots[0],environment:'live' as const},
   {...feed.snapshots[0],accountId:11}, {...feed.snapshots[0],confirmedAt:'2099-01-01T00:00:00Z'},
  ]) expect(mergeTradovateAccountDisplay({},[{...feed,snapshots:[snapshot]}],membership,now)).toEqual({});
 });
 it('drops data when membership is revoked',()=>{
  const initial=mergeTradovateAccountDisplay({},[feed],membership,now);
  expect(mergeTradovateAccountDisplay(initial,[feed],new Map(),now)).toEqual({});
  expect(mergeTradovateAccountDisplay(initial,[],new Map([['c',{environment:'live',accountIds:new Set([10])}]]),now)).toEqual({});
 });
});

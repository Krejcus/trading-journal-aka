import { describe, expect, it } from 'vitest';
import { mergeTradovateAccountDisplay, nextTradovateDisplayVouches, vouchedTradovateAccountDisplay } from '../lib/tradovateAccountDisplayMerge';
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

describe('worker ručí za nezměněnou částku', () => {
  const live: TradovateAccountDisplayFeedState = { ...feed, streamConnected: true,
    snapshots: [{ ...feed.snapshots[0], fields: { totalCashValue: 50_000, dailyRealizedPnL: 120, netLiq: 50_000 } }] };
  const at = Date.parse('2026-09-11T12:05:00Z');
  it('s připojeným streamem, bez chyby a čekajícího čtení ručí k času statusu', () => {
    expect(vouchedTradovateAccountDisplay([live], membership, at, at)).toEqual({ 'demo:c:10': {
      totalCashValue: { value: 50_000, confirmedAt: '2026-09-11T12:00:01Z', vouchedAt: '2026-09-11T12:05:00.000Z' },
      dailyRealizedPnL: { value: 120, confirmedAt: '2026-09-11T12:00:01Z', vouchedAt: '2026-09-11T12:05:00.000Z' },
    } });
  });
  it('neručí bez streamu, s chybou, při čekajícím čtení, se snímkem starším než audit ani za cizí účet', () => {
    for (const bad of [
      { ...live, streamConnected: false }, { ...live, streamConnected: undefined },
      { ...live, lastErrorAt: '2026-09-11T12:04:00Z' }, { ...live, retryAt: '2026-09-11T12:06:00Z' },
      { ...live, pendingAccountIds: [10] },
      { ...live, snapshots: [{ ...live.snapshots[0], accountId: 11 }] },
      { ...live, connectionId: 'foreign' },
    ]) expect(vouchedTradovateAccountDisplay([bad], membership, at, at)).toEqual({});
    expect(vouchedTradovateAccountDisplay([live], membership, Date.parse('2026-09-11T12:11:02Z'), Date.parse('2026-09-11T12:11:02Z'))).toEqual({});
    expect(vouchedTradovateAccountDisplay([live], membership, at + 60_000, at)).toEqual({});
  });
});

describe('dobíhání a rušení ručení mezi statusy', () => {
  const live: TradovateAccountDisplayFeedState = { ...feed, streamConnected: true,
    snapshots: [{ ...feed.snapshots[0], fields: { totalCashValue: 50_000, dailyRealizedPnL: 120 } }] };
  const t0 = Date.parse('2026-09-11T12:05:00Z');
  const first = nextTradovateDisplayVouches({}, [live], membership, t0, t0);
  it('čekající čtení (audit) ručení neprodlouží, ale nechá ho dobíhat', () => {
    const next = nextTradovateDisplayVouches(first, [{ ...live, pendingAccountIds: [10] }], membership, t0 + 5_000, t0 + 5_000);
    expect(next).toEqual(first);
    const resumed = nextTradovateDisplayVouches(next, [live], membership, t0 + 9_000, t0 + 9_000);
    expect(resumed['demo:c:10'].totalCashValue?.vouchedAt).toBe('2026-09-11T12:05:09.000Z');
  });
  it('výpadek streamu, backoff, chybějící feed nebo odebrané spojení ručení hned zruší', () => {
    for (const feeds of [[{ ...live, streamConnected: false }], [{ ...live, retryAt: '2026-09-11T12:06:00Z' }], []]) {
      expect(nextTradovateDisplayVouches(first, feeds, membership, t0 + 2_000, t0 + 2_000)).toEqual({});
    }
    expect(nextTradovateDisplayVouches(first, [live], new Map(), t0 + 2_000, t0 + 2_000)).toEqual({});
  });
  it('jiná částka v nejnovějším snímku zruší ručení toho pole i při chybě feedu', () => {
    const changed = { ...live, lastErrorAt: '2026-09-11T12:05:01Z', snapshots: [{ ...live.snapshots[0],
      requestedAt: '2026-09-11T12:05:00Z', confirmedAt: '2026-09-11T12:05:00.500Z', fields: { totalCashValue: 49_000, dailyRealizedPnL: 120 } }] };
    const next = nextTradovateDisplayVouches(first, [changed], membership, t0 + 2_000, t0 + 2_000);
    expect(next['demo:c:10'].totalCashValue).toBeUndefined();
    expect(next['demo:c:10'].dailyRealizedPnL).toEqual(first['demo:c:10'].dailyRealizedPnL);
  });
  it('duplicitní kopie spojení: ručí se jen, když jsou zdravé všechny (obě pořadí)', () => {
    for (const copies of [[{ ...live, streamConnected: false }, live], [live, { ...live, streamConnected: false }],
      [{ ...live, pendingAccountIds: [10] }, live], [live, { ...live, pendingAccountIds: [10] }]]) {
      expect(vouchedTradovateAccountDisplay(copies, membership, t0, t0)).toEqual({});
    }
    const older = { ...live, snapshots: [{ ...live.snapshots[0], requestedAt: '2026-09-11T11:59:00Z', confirmedAt: '2026-09-11T11:59:01Z', fields: { totalCashValue: 48_000 } }] };
    for (const copies of [[older, live], [live, older]]) {
      expect(vouchedTradovateAccountDisplay(copies, membership, t0, t0)['demo:c:10'].totalCashValue?.value).toBe(50_000);
    }
  });
  it('starší status nepřepíše novější ručení stejné částky', () => {
    const later = nextTradovateDisplayVouches({}, [live], membership, t0 + 10_000, t0 + 10_000);
    const next = nextTradovateDisplayVouches(later, [live], membership, t0, t0 + 10_000);
    expect(next['demo:c:10'].totalCashValue?.vouchedAt).toBe('2026-09-11T12:05:10.000Z');
  });
});

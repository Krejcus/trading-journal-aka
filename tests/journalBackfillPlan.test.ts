import { describe, expect, it } from 'vitest';
import { createJournalBackfillPlan, validateJournalBackfillScope, JOURNAL_BACKFILL_TYPES } from '../lib/journalBackfillPlan';
import { createJournalAccountingBackfill } from '../lib/journalAccountingBackfill';
import { journalObservation, projectJournalEvidence, type JournalEvidence } from '../lib/tradovateJournalEvidence';

describe('bounded historical read plan', () => {
  it('uses one list per source, never per current follower, and advances after a slow source', () => {
    const plan = createJournalBackfillPlan();
    expect(plan.next('fillfee', () => []).path).toBe('/fillFee/list');
    expect(plan.cycle()[0]).toBe('fillpair');
    expect(new Set(plan.cycle()).size).toBe(JOURNAL_BACKFILL_TYPES.length);
    plan.reset(); expect(plan.cycle()[0]).toBe('fillfee');
  });
  it('switches oversized lists to batches of exact known parents and rotates without invented IDs', () => {
    const plan = createJournalBackfillPlan(); plan.useScoped('orderversion');
    const refs = () => Array.from({ length: 205 }, (_, i) => 1000 + i);
    const first = plan.next('orderversion', refs), second = plan.next('orderversion', refs), third = plan.next('orderversion', refs);
    expect(first.path).toBe(`/orderVersion/ldeps?masterids=${refs().slice(0,100).join(',')}`);
    expect([first.ids?.length, second.ids?.length, third.ids?.length]).toEqual([100,100,5]);
    expect(third.remaining).toBe(0); expect(plan.next('orderversion', refs).ids).toEqual(first.ids);
    expect(plan.next('contract', () => []).path).toBeNull();
    expect(plan.next('cashbalancelog', () => [3,2,3]).path).toBe('/cashBalanceLog/ldeps?masterids=2,3');
  });
  it('validates parent scope before recording any row', () => {
    const plan = createJournalBackfillPlan(); plan.useScoped('fillfee');
    const fees = plan.next('fillfee', () => [10,20]);
    expect(() => validateJournalBackfillScope(fees, [{ id: 10, commission: 1 }])).not.toThrow();
    expect(() => validateJournalBackfillScope(fees, [{ id: 30, commission: 1 }])).toThrow('invalid-list');
    expect(() => validateJournalBackfillScope(fees, Array.from({ length:10001 },()=>({id:10})))).toThrow('response-too-large');
  });
  it('uses only observed IDs for references and keeps stream corrections/tombstones authoritative', () => {
    const cache = createJournalAccountingBackfill();
    cache.remember(journalObservation('order', { id: 10, accountId: 1, contractId: 50 }, 'stream', 'Created', 1)!);
    cache.remember(journalObservation('command', { id: 20, orderId: 10 }, 'stream', 'Created', 1)!);
    expect(cache.references('contract')).toEqual([50]); expect(cache.references('order')).toEqual([10]);
    const revision = cache.begin();
    cache.remember(journalObservation('orderversion', { id: 20, orderId: 10, stopPrice: 100 }, 'stream', 'Updated', 2)!);
    expect(cache.select('orderversion', [{id:20,orderId:10,stopPrice:90}], revision, 3).contended).toBe(1);
    cache.remember(journalObservation('orderversion', { id: 20 }, 'stream', 'Deleted', 4)!);
    expect(cache.select('orderversion', [{id:20,orderId:10,stopPrice:90}], cache.begin(), 5).observations).toEqual([]);
  });
  it('recovers three confirmed SL moves in one minute from historical reports, not receipt timestamps', () => {
    const cache = createJournalAccountingBackfill(); const events: JournalEvidence[] = [];
    const add = (type: Parameters<typeof cache.select>[0], rows: unknown) => {
      for (const event of cache.select(type, rows, cache.begin(), 100000).observations) {
        cache.remember(event);
        events.push({ ...event,id:`event-${events.length}`,connectionId:'connection',environment:'demo',sessionId:'session',sequence:events.length });
      }
    };
    add('order',[{ id:10,accountId:1,contractId:1,action:'Sell',parentId:9 }]);
    const times = [Date.parse('2026-09-12T13:00:01.125Z'),Date.parse('2026-09-12T13:00:01.635Z'),Date.parse('2026-09-12T13:00:44.400Z')];
    add('orderversion',[1,2,3].map(id=>({id,orderId:10,orderType:'Stop',stopPrice:100+id,orderQty:1})));
    add('command',[1,2,3].map(id=>({id,orderId:10,commandType:id===1?'New':'Modify',timestamp:new Date(times[id-1]-10).toISOString()})));
    expect(projectJournalEvidence(events).protection.every(row=>row.status==='pending')).toBe(true);
    add('executionreport',[1,2,3].map(id=>({id:10+id,commandId:id,orderId:10,execType:id===1?'New':'Replaced',timestamp:new Date(times[id-1]).toISOString()})));
    expect(projectJournalEvidence(events).protection.map(row=>[row.at,row.price,row.status,row.timeSource])).toEqual(times.map((time,i)=>[time,101+i,'confirmed','broker']));
    add('commandreport',[{id:50,commandId:3,commandStatus:'ExecutionRejected',timestamp:new Date(times[2]+1).toISOString()}]);
    expect(projectJournalEvidence(events).protection[2].status).toBe('uncertain');
  });
});

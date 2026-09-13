import { describe,expect,it } from 'vitest';
import { compactJournalInputEntities,journalCompactedEvidence,journalInputMode,type JournalInputEntity } from '../lib/journalInputCompaction';
import { orderedJournalEvidence,latestJournalEvidence,type JournalEvidence } from '../lib/tradovateJournalEvidence';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import { journalAccountsFixture } from './fixtures/journalAccounts';

const fixture=journalAccountsFixture(undefined,12,true);
async function compact(events:JournalEvidence[],size=3) {
  const entities=new Map<string,JournalInputEntity>(),retained:JournalEvidence[]=[],seen:JournalEvidence[]=[];
  for(let i=0;i<events.length;i+=size) {
    const page=events.slice(i,i+size); seen.push(...page);
    for(const row of await compactJournalInputEntities(page,[...entities.values()],async key=>seen.filter(e=>`${e.entityType}:${e.entity.id}`===key))) entities.set(row.key,row);
    retained.push(...page.filter(e=>journalInputMode(e)==='retained'));
  }
  return journalCompactedEvidence(retained,[...entities.values()],orderedJournalEvidence(events).at(-1)??null);
}
describe('lossless financial input compaction',()=>{
  it('keeps all position/fill/snapshot/gap observations and exact twelve-account results',async()=>{
    const result=await compact(fixture.events);
    expect(projectJournalAccounts(result,fixture.accounts)).toEqual(projectJournalAccounts(fixture.events,fixture.accounts));
    expect(result.filter(e=>journalInputMode(e)==='retained')).toEqual(fixture.events.filter(e=>journalInputMode(e)==='retained'));
  });
  it('merges partial fields without changing the immutable raw records',async()=>{
    const base={ ...fixture.events[0],entityType:'order' as const,entity:{ id:10,accountId:1,contractId:1,action:'Buy',timestamp:new Date(100).toISOString() },receivedAt:100 };
    const patch={ ...base,id:'a'.repeat(64),sequence:100,receivedAt:200,entity:{ id:10,ordStatus:'Filled' } };
    const result=await compact([base,patch],1);
    expect(latestJournalEvidence(result)).toEqual(latestJournalEvidence([base,patch]));
    expect(patch.entity).toEqual({ id:10,ordStatus:'Filled' });
  });
  it('rebuilds late insertion because it can make a previously accepted later patch stale',async()=>{
    const base={ ...fixture.events[0],entityType:'order' as const,entity:{ id:10,accountId:1,timestamp:new Date(100).toISOString() },receivedAt:100 };
    const later={ ...base,id:'a'.repeat(64),sequence:2,receivedAt:300,entity:{ id:10,ordStatus:'Filled',timestamp:new Date(200).toISOString() } };
    const insertion={ ...base,id:'b'.repeat(64),sequence:3,receivedAt:200,entity:{ id:10,ordStatus:'Working',timestamp:new Date(300).toISOString() } };
    const result=await compact([base,later,insertion],1);
    expect(latestJournalEvidence(result)).toEqual(latestJournalEvidence([base,later,insertion]));
    expect(latestJournalEvidence(result).get('order:10')?.entity.ordStatus).toBe('Working');
  });
  it('preserves late fee corrections and unknown-account fill activity that invalidates a snapshot',async()=>{
    const fee=fixture.events.find(e=>e.entityType==='fillfee')!;
    const correction={ ...fee,id:'c'.repeat(64),receivedAt:5000,sequence:1000,entity:{ id:fee.entity.id,commission:2 } };
    const fill=fixture.events.find(e=>e.entityType==='fill')!;
    const unknown={ ...fill,id:'d'.repeat(64),receivedAt:50,sequence:1001,entity:{ id:fill.entity.id,price:20001 } };
    const events=[...fixture.events,correction,unknown];
    expect(projectJournalAccounts(await compact(events),fixture.accounts)).toEqual(projectJournalAccounts(events,fixture.accounts));
  });
  it('keeps open-position observation time from stale patches and coverage-only events',async()=>{
    const events=fixture.events.filter(e=>!(e.entityType==='fill' && e.entity.action==='Sell'));
    events.push({ ...events[0],id:'e'.repeat(64),entityType:'journalbackfill',receivedAt:5000,entity:{ id:'coverage',kind:'observed' } });
    expect(projectJournalAccounts(await compact(events),fixture.accounts)).toEqual(projectJournalAccounts(events,fixture.accounts));
  });
  it('retains unknown/missing identifiers and their diagnostics',async()=>{
    const missing={ ...fixture.events[0],id:'f'.repeat(64),entityType:'executionreport' as const,entity:{ orderId:10 },receivedAt:5000 };
    const events=[...fixture.events,missing];
    expect(projectJournalAccounts(await compact(events),fixture.accounts)).toEqual(projectJournalAccounts(events,fixture.accounts));
  });
});

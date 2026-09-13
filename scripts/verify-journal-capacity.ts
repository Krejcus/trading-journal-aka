import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { journalAccountsFixture } from '../tests/fixtures/journalAccounts.js';
import { projectJournalAccounts } from '../lib/journalAccountProjection.js';
import { journalPositionWrite } from '../lib/journalTradeFacts.js';
import { journalPositionChunks } from '../server/journalStagedImport.js';
import type { JournalEvidence } from '../lib/tradovateJournalEvidence.js';

const base=journalAccountsFixture(undefined,12);
for(const rounds of [200,1000,2000]) {
  const events:JournalEvidence[]=[];
  const add=(event:JournalEvidence)=>events.push({...event,id:(100000+events.length).toString(16).padStart(64,'0'),sequence:events.length+1});
  base.events.filter(e=>e.entityType==='position'||e.entityType==='contract').forEach(add);
  for(let round=0;round<rounds;round++)for(const e of base.events.filter(e=>e.entityType!=='position'&&e.entityType!=='contract')) {
    const entity={...e.entity};
    for(const key of ['id','orderId','buyFillId','sellFillId'])if(typeof entity[key]==='number')entity[key]+=round*1000;
    if(typeof entity.timestamp==='string')entity.timestamp=new Date(Date.parse(entity.timestamp)+round*10000).toISOString();
    add({...e,entity,receivedAt:e.receivedAt+round*10000});
  }
  const started=performance.now();
  const result=projectJournalAccounts(events,base.accounts);
  const elapsedMs=Math.round(performance.now()-started);
  assert.equal(result.ready.length,rounds*12);assert.equal(result.pending.length,0);
  const totals=Array.from({length:12},(_,index)=>result.ready.filter(p=>p.accountId===index+1).reduce((sum,p)=>sum+p.history.netPnl!,0));
  assert.deepEqual(totals,Array.from({length:12},(_,i)=>19*(i+1)*rounds));
  const writes=result.ready.map(journalPositionWrite);
  let chunks:number|null=null,limit:string|null=null;
  try {chunks=journalPositionChunks(writes).length;}catch(error){limit=String(error);assert.match(limit,/journal-import-partition-required/);}
  console.log(JSON.stringify({accounts:12,positions:result.ready.length,sourceRows:events.length,sourceBytes:Buffer.byteLength(JSON.stringify(events)),projectionBytes:Buffer.byteLength(JSON.stringify(writes)),elapsedMs,chunks,limit,heapMiB:Math.round(process.memoryUsage().heapUsed/1048576)}));
}

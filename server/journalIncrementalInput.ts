import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredJournalEvidence,validateJournalEvidencePage,type JournalFeedScope } from '../lib/journalEvidenceFeed.js';
import { compactJournalInputEntities,journalCompactedEvidence,journalInputKey,journalInputMode,compareJournalInputOrder,type JournalInputEntity } from '../lib/journalInputCompaction.js';
import type { JournalEvidence } from '../lib/tradovateJournalEvidence.js';

const integer=(value:unknown):value is number=>typeof value==='number' && Number.isSafeInteger(value) && value>=0;
function readEntity(value:unknown,scope:JournalFeedScope):JournalInputEntity {
  if (!value || typeof value!=='object') throw new Error('journal-input-entity-invalid');
  const row=value as JournalInputEntity;
  const latest=readStoredJournalEvidence(row.latest,scope),orderedThrough=readStoredJournalEvidence(row.orderedThrough,scope);
  if (row.key!==journalInputKey(latest) || row.key!==journalInputKey(orderedThrough) || journalInputMode(latest)!=='entity'
    || journalInputMode(orderedThrough)!=='entity' || compareJournalInputOrder(latest,orderedThrough)>0) throw new Error('journal-input-entity-invalid');
  return { key:row.key,latest,orderedThrough };
}

/** Each committed source batch is durable independently of final projection.
 * A caller timeout cannot publish a prefix or force a restart from source zero. */
export async function prepareJournalInput(db:SupabaseClient,scope:JournalFeedScope,
  options:{ maxPages?:number; maxMs?:number }={}) {
  const maxPages=options.maxPages ?? 8,maxMs=options.maxMs ?? 5000;
  if (!Number.isSafeInteger(maxPages) || maxPages<1 || maxPages>64 || !Number.isFinite(maxMs) || maxMs<=0) throw new Error('invalid-journal-input-budget');
  const started=Date.now(),common={ p_user_id:scope.ownerId,p_connection_id:scope.connectionId };
  const invoke=async(name:string,args:Record<string,unknown>={})=>{
    const { data,error }=await db.rpc(name,{ ...common,...args });
    if (error) throw new Error(error.message.includes('journal-connection-not-found') ? 'journal-connection-not-found'
      : error.message.includes('journal-input-changed') ? 'journal-input-changed' : 'journal-input-unavailable');
    return data;
  };
  const rebuild=async(key:string,through:number)=>{
    const events:JournalEvidence[]=[]; let after=0,bytes=0;
    for(;;) {
      const data=await invoke('read_journal_input_entity_history',{ p_key:key,p_after:after,p_through:through });
      const page=validateJournalEvidencePage({ ...data,scope },scope,after,through);
      for(const row of page.rows) {
        if (journalInputKey(row.event)!==key) throw new Error('journal-input-entity-mismatch');
        events.push(row.event);
      }
      bytes+=Buffer.byteLength(JSON.stringify(page.rows));
      if (events.length>100_000 || bytes>32_000_000) throw new Error('journal-import-partition-required');
      after=page.next; if (!page.hasMore) return events;
    }
  };
  let through=0,targetThrough=0;
  for(let step=0;step<maxPages;step++) {
    const context=await invoke('read_journal_input_batch');
    if (context?.version!==1 || !integer(context.generation) || !integer(context.after) || !integer(context.through) || typeof context.ready!=='boolean' || context.ready!==(context.after===context.through)
      || !Array.isArray(context.entities) || context.entities.length>250) throw new Error('journal-input-context-invalid');
    const page=validateJournalEvidencePage({ ...context,scope },scope,context.after);
    through=page.after; targetThrough=page.through;
    if (context.ready) {
      const retained:JournalEvidence[]=[],entities:JournalInputEntity[]=[];
      let after='',bytes=0;
      const watermark=context.watermark==null ? null : readStoredJournalEvidence(context.watermark,scope);
      for(;;) {
        const data=await invoke('read_journal_input_snapshot',{ p_generation:context.generation,p_after:after });
        if (data?.generation!==context.generation || data.through!==through || !Array.isArray(data.rows) || data.rows.length>250) throw new Error('journal-input-snapshot-invalid');
        if (!data.rows.length) break;
        bytes+=Buffer.byteLength(JSON.stringify(data.rows));
        if (bytes>96_000_000 || retained.length+entities.length+data.rows.length>250_000) throw new Error('journal-import-partition-required');
        for(const row of data.rows) {
          if (typeof row.key!=='string' || Buffer.compare(Buffer.from(row.key),Buffer.from(after))<=0) throw new Error('journal-input-snapshot-invalid');
          after=row.key;
          if (row.entity!==null) {
            const entity=readEntity(row.entity,scope);
            if (row.event!==null || row.key!==`e:${entity.key}`) throw new Error('journal-input-snapshot-invalid');
            entities.push(entity);
          } else {
            const event=readStoredJournalEvidence(row.event,scope);
            if (row.key!==`r:${event.id}` || journalInputMode(event)!=='retained') throw new Error('journal-input-snapshot-invalid');
            retained.push(event);
          }
        }
      }
      return { ready:true as const,through,targetThrough,events:journalCompactedEvidence(retained,entities,watermark) };
    }
    if (!page.rows.length) throw new Error('journal-input-context-invalid');
    const events=page.rows.map(row=>row.event);
    const expectedKeys=new Set(events.filter(e=>journalInputMode(e)==='entity').map(journalInputKey));
    const previous=context.entities.map((row:unknown)=>readEntity(row,scope)) as JournalInputEntity[];
    if (new Set(previous.map(row=>row.key)).size!==previous.length || previous.some(row=>!expectedKeys.has(row.key))) throw new Error('journal-input-context-invalid');
    const updates=await compactJournalInputEntities(events,previous,key=>rebuild(key,page.next));
    const ack=await invoke('commit_journal_input_batch',{ p_generation:context.generation,p_after:page.after,p_next:page.next,p_updates:updates });
    if (ack?.accepted===false && ack.stale===true) return { ready:false as const,through,targetThrough };
    if (ack?.accepted!==true || ack.through!==page.next || ack.targetThrough!==page.through || ack.generation!==context.generation+1) throw new Error('journal-input-commit-not-confirmed');
    through=ack.through;
    if (Date.now()-started>=maxMs) break;
  }
  return { ready:false as const,through,targetThrough };
}

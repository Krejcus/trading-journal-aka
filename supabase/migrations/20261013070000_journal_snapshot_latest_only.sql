-- 13. 10. 2026: the journal import had failed on every call since 7. 10.
-- For one connection the compacted input snapshot had grown to 504 pages of
-- 250 rows (102.5 MB JSON); the HTTP transfer took 80–150 s, past the 120 s
-- import lease, and every import ended as `journal-input-unavailable`.
--
-- The projection reads only `latest` of each compacted entity
-- (`journalCompactedEvidence`); `orderedThrough` is needed solely for batch
-- compaction (`read_journal_input_batch`), and it doubled the entity payload.
-- This read returns entities as {key, latest} and pages up to 2000 rows.
-- Same keyset order, same generation fence and same 55000 error as
-- `read_journal_input_snapshot`, which stays unchanged for older deployments.

create or replace function public.read_journal_input_snapshot_latest(p_user_id uuid,p_connection_id uuid,p_generation bigint,
  p_after text default '',p_limit integer default 1000)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare head public.tradovate_journal_input_heads%rowtype; result jsonb;
begin
  select * into head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id;
  if not found or head.version<>1 or head.generation is distinct from p_generation or head.through<>head.target_through then
    raise exception 'journal-input-changed' using errcode='55000';
  end if;
  if p_after is null or length(p_after)>800 then raise exception 'invalid-journal-input-page' using errcode='22023'; end if;
  if p_limit is null or p_limit<1 or p_limit>2000 then raise exception 'invalid-journal-input-page' using errcode='22023'; end if;
  with entity_page as (
    select ('e:'||c.entity_key) collate "C" as key,
      jsonb_build_object('key',c.entity_key,'latest',c.latest) as entity,
      null::jsonb as event
    from public.tradovate_journal_input_entities c
    where c.user_id=p_user_id and c.connection_id=p_connection_id
      and ('e:'||c.entity_key) collate "C" > p_after collate "C"
    order by ('e:'||c.entity_key) collate "C" limit p_limit
  ), retained_page as (
    select ('r:'||r.event_id) collate "C" as key, null::jsonb as entity, r.evidence as event
    from public.tradovate_journal_input_retained r
    where r.user_id=p_user_id and r.connection_id=p_connection_id
      and ('r:'||r.event_id) collate "C" > p_after collate "C"
    order by ('r:'||r.event_id) collate "C" limit p_limit
  ), page as (
    select * from (select * from entity_page union all select * from retained_page) u
    order by u.key collate "C" limit p_limit
  )
  select jsonb_build_object('generation',head.generation,'through',head.through,'watermark',head.watermark,
    'rows',coalesce(jsonb_agg(jsonb_build_object('key',key,'entity',entity,'event',event) order by key collate "C"),'[]'::jsonb)) into result from page;
  return result;
end; $$;

revoke all on function public.read_journal_input_snapshot_latest(uuid,uuid,bigint,text,integer) from public,anon,authenticated;
grant execute on function public.read_journal_input_snapshot_latest(uuid,uuid,bigint,text,integer) to service_role;

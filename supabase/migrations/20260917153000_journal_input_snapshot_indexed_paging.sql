-- 17. 9. 2026: read_journal_input_snapshot built the whole entity+retained set
-- (44 000 rows for one connection), sorted it and returned 250 rows — on every
-- page. One import walked ~180 pages at ~1,2 s each, three connections and
-- several clients ran it concurrently, and the PostgREST pool was exhausted:
-- every API route (copier relay, pilot lease, preflight) timed out.
--
-- Same page contents and order as before ("C" collation, all `e:` keys before
-- `r:` keys), but each branch is an indexed range scan bounded by the page
-- cursor and the page size, so a page costs milliseconds.

create index if not exists tradovate_journal_input_entities_page_idx
  on public.tradovate_journal_input_entities (user_id, connection_id, (('e:' || entity_key) collate "C"));
create index if not exists tradovate_journal_input_retained_page_idx
  on public.tradovate_journal_input_retained (user_id, connection_id, (('r:' || event_id) collate "C"));

create or replace function public.read_journal_input_snapshot(p_user_id uuid,p_connection_id uuid,p_generation bigint,p_after text default '')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare head public.tradovate_journal_input_heads%rowtype; result jsonb;
begin
  select * into head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id;
  if not found or head.version<>1 or head.generation is distinct from p_generation or head.through<>head.target_through then
    raise exception 'journal-input-changed' using errcode='40001';
  end if;
  if p_after is null or length(p_after)>800 then raise exception 'invalid-journal-input-page' using errcode='22023'; end if;
  with entity_page as (
    select ('e:'||c.entity_key) collate "C" as key,
      jsonb_build_object('key',c.entity_key,'latest',c.latest,'orderedThrough',c.ordered_through) as entity,
      null::jsonb as event
    from public.tradovate_journal_input_entities c
    where c.user_id=p_user_id and c.connection_id=p_connection_id
      and ('e:'||c.entity_key) collate "C" > p_after collate "C"
    order by ('e:'||c.entity_key) collate "C" limit 250
  ), retained_page as (
    select ('r:'||r.event_id) collate "C" as key, null::jsonb as entity, r.evidence as event
    from public.tradovate_journal_input_retained r
    where r.user_id=p_user_id and r.connection_id=p_connection_id
      and ('r:'||r.event_id) collate "C" > p_after collate "C"
    order by ('r:'||r.event_id) collate "C" limit 250
  ), page as (
    select * from (select * from entity_page union all select * from retained_page) u
    order by u.key collate "C" limit 250
  )
  select jsonb_build_object('generation',head.generation,'through',head.through,'watermark',head.watermark,
    'rows',coalesce(jsonb_agg(jsonb_build_object('key',key,'entity',entity,'event',event) order by key collate "C"),'[]'::jsonb)) into result from page;
  return result;
end; $$;

revoke all on function public.read_journal_input_snapshot(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.read_journal_input_snapshot(uuid,uuid,bigint,text) to service_role;

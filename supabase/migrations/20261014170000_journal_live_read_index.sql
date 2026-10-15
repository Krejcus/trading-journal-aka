-- 14. 10. 2026: čtení živého vstupu deníku procházelo i archivované řádky.
-- Stránkovací index nezná `archived_epoch`, takže po archivaci (Lucid: ~50k
-- entit, ~70k retained) filtr zahodil přes 10k řádků na stránku a stránka
-- trvala ~2,6 s (max 26 s) — import by se nevešel pod 8 s timeout API.
-- Živé řádky mají vlastní částečný index ve stejném pořadí stránek;
-- archivované nad aktivní epochou (rozpracovaný nebo zrušený bod) se čtou
-- přes epochový index — mimo archivaci a úklid jich je nula.

create index if not exists tradovate_journal_input_entities_live_page_idx on public.tradovate_journal_input_entities
  (user_id, connection_id, (('e:'||entity_key) collate "C")) where archived_epoch is null;
create index if not exists tradovate_journal_input_retained_live_page_idx on public.tradovate_journal_input_retained
  (user_id, connection_id, (('r:'||event_id) collate "C")) where archived_epoch is null;

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
  with entity_live as (
    select ('e:'||c.entity_key) collate "C" as key, c.entity_key, c.latest
    from public.tradovate_journal_input_entities c
    where c.user_id=p_user_id and c.connection_id=p_connection_id and c.archived_epoch is null
      and ('e:'||c.entity_key) collate "C" > p_after collate "C"
    order by ('e:'||c.entity_key) collate "C" limit p_limit
  ), entity_reopened as (
    select ('e:'||c.entity_key) collate "C" as key, c.entity_key, c.latest
    from public.tradovate_journal_input_entities c
    where c.user_id=p_user_id and c.connection_id=p_connection_id and c.archived_epoch>head.checkpoint_epoch
      and ('e:'||c.entity_key) collate "C" > p_after collate "C"
    order by ('e:'||c.entity_key) collate "C" limit p_limit
  ), retained_live as (
    select ('r:'||r.event_id) collate "C" as key, r.evidence
    from public.tradovate_journal_input_retained r
    where r.user_id=p_user_id and r.connection_id=p_connection_id and r.archived_epoch is null
      and ('r:'||r.event_id) collate "C" > p_after collate "C"
    order by ('r:'||r.event_id) collate "C" limit p_limit
  ), retained_reopened as (
    select ('r:'||r.event_id) collate "C" as key, r.evidence
    from public.tradovate_journal_input_retained r
    where r.user_id=p_user_id and r.connection_id=p_connection_id and r.archived_epoch>head.checkpoint_epoch
      and ('r:'||r.event_id) collate "C" > p_after collate "C"
    order by ('r:'||r.event_id) collate "C" limit p_limit
  ), page as (
    select * from (
      select e.key, jsonb_build_object('key',e.entity_key,'latest',e.latest) as entity, null::jsonb as event
        from (select * from entity_live union all select * from entity_reopened) e
      union all
      select r.key, null::jsonb, r.evidence from (select * from retained_live union all select * from retained_reopened) r
    ) u order by u.key collate "C" limit p_limit
  )
  select jsonb_build_object('generation',head.generation,'through',head.through,'watermark',head.watermark,'checkpointEpoch',head.checkpoint_epoch,
    'rows',coalesce(jsonb_agg(jsonb_build_object('key',key,'entity',entity,'event',event) order by key collate "C"),'[]'::jsonb)) into result from page;
  return result;
end; $$;

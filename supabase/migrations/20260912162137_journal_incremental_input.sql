-- Local draft: rebuildable derived input; immutable broker evidence is retained.
create function public.journal_input_mode(e jsonb) returns text language sql immutable set search_path='' as $$
  select case when e->>'entityType' in ('position','fill','connection','positionsnapshot') or e#>'{entity,id}' is null or e#>'{entity,id}'='null'::jsonb then 'retained'
    when e->>'entityType'='journalbackfill' then 'watermark' else 'entity' end
$$;
create function public.journal_input_key(e jsonb) returns text language sql immutable set search_path='' as $$
  select (e->>'entityType') || ':' || (e#>>'{entity,id}')
$$;
create index tradovate_journal_evidence_entity_idx on public.tradovate_journal_evidence(user_id,connection_id,public.journal_input_key(evidence),ingest_id);

create table public.tradovate_journal_input_heads (
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  version int not null default 1,
  through bigint not null default 0,
  target_through bigint not null default 0,
  generation bigint not null default 0,
  watermark jsonb,
  primary key(user_id,connection_id)
);
create table public.tradovate_journal_input_entities (
  user_id uuid not null, connection_id uuid not null, entity_key text not null,
  latest jsonb not null, ordered_through jsonb not null,
  primary key(user_id,connection_id,entity_key),
  foreign key(user_id,connection_id) references public.tradovate_journal_input_heads on delete cascade
);
create table public.tradovate_journal_input_retained (
  user_id uuid not null, connection_id uuid not null, event_id text not null,
  evidence jsonb not null,
  primary key(user_id,connection_id,event_id),
  foreign key(user_id,connection_id) references public.tradovate_journal_input_heads on delete cascade
);
alter table public.tradovate_journal_input_heads enable row level security;
alter table public.tradovate_journal_input_entities enable row level security;
alter table public.tradovate_journal_input_retained enable row level security;
revoke all on public.tradovate_journal_input_heads,public.tradovate_journal_input_entities,public.tradovate_journal_input_retained from public,anon,authenticated;
grant select,insert,update,delete on public.tradovate_journal_input_heads,public.tradovate_journal_input_entities,public.tradovate_journal_input_retained to service_role;

create function public.read_journal_input_batch(p_user_id uuid,p_connection_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare head public.tradovate_journal_input_heads%rowtype; newest bigint; result jsonb;
begin
  if not exists(select 1 from public.tradovate_oauth_connections c where c.user_id=p_user_id and c.id=p_connection_id and c.environment='demo') then
    raise exception 'journal-connection-not-found' using errcode='42501';
  end if;
  insert into public.tradovate_journal_input_heads(user_id,connection_id) values(p_user_id,p_connection_id) on conflict do nothing;
  select * into head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id for update;
  if head.version<>1 then raise exception 'journal-input-version-mismatch' using errcode='22023'; end if;
  -- Freeze one source snapshot until all its input has been processed and its
  -- financial projection has been published. Continuous arrival cannot starve it.
  if head.through=head.target_through and (head.through=0 or exists(select 1 from public.tradovate_journal_projection_heads h
    where h.user_id=p_user_id and h.connection_id=p_connection_id and h.completed_revision>=head.through)) then
    select coalesce(max(e.ingest_id),0) into newest from public.tradovate_journal_evidence e where e.user_id=p_user_id and e.connection_id=p_connection_id;
    if newest>head.target_through then
      update public.tradovate_journal_input_heads h set target_through=newest,generation=h.generation+1
        where h.user_id=p_user_id and h.connection_id=p_connection_id returning * into head;
    end if;
  end if;
  with candidates as materialized (
    select e.ingest_id,e.evidence from public.tradovate_journal_evidence e where e.user_id=p_user_id and e.connection_id=p_connection_id
      and e.ingest_id>head.through and e.ingest_id<=head.target_through order by e.ingest_id limit 251
  ), page as materialized (select * from candidates order by ingest_id limit 250)
  select jsonb_build_object('version',head.version,'generation',head.generation,'after',head.through,'through',head.target_through,
    'ready',head.through=head.target_through,'watermark',head.watermark,
    'hasMore',(select count(*) from candidates)>250,
    'next',case when (select count(*) from candidates)>250 then (select max(ingest_id) from page) else head.target_through end,
    'rows',(select coalesce(jsonb_agg(jsonb_build_object('cursor',ingest_id,'event',evidence) order by ingest_id),'[]'::jsonb) from page),
    'entities',(select coalesce(jsonb_agg(jsonb_build_object('key',c.entity_key,'latest',c.latest,'orderedThrough',c.ordered_through)),'[]'::jsonb)
      from public.tradovate_journal_input_entities c where c.user_id=p_user_id and c.connection_id=p_connection_id and c.entity_key in (
        select public.journal_input_key(evidence) from page where public.journal_input_mode(evidence)='entity'))) into result;
  return result;
end; $$;

create function public.commit_journal_input_batch(p_user_id uuid,p_connection_id uuid,p_generation bigint,p_after bigint,p_next bigint,p_updates jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare head public.tradovate_journal_input_heads%rowtype; page jsonb; expected bigint; keys text[]; item jsonb; receipt jsonb;
begin
  select * into head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id for update;
  if not found then raise exception 'journal-input-not-found' using errcode='42501'; end if;
  if head.generation is distinct from p_generation or head.through is distinct from p_after then return jsonb_build_object('accepted',false,'stale',true); end if;
  if head.through>=head.target_through or jsonb_typeof(p_updates) is distinct from 'array' or octet_length(p_updates::text)>3000000 then
    raise exception 'invalid-journal-input-batch' using errcode='22023';
  end if;
  with candidates as materialized (select e.ingest_id,e.evidence from public.tradovate_journal_evidence e where e.user_id=p_user_id and e.connection_id=p_connection_id
    and e.ingest_id>head.through and e.ingest_id<=head.target_through order by e.ingest_id limit 251),
  selected as (select * from candidates order by ingest_id limit 250)
  select (select jsonb_agg(evidence order by ingest_id) from selected),
    case when (select count(*) from candidates)>250 then (select max(ingest_id) from selected) else head.target_through end into page,expected;
  if expected is distinct from p_next or page is null then raise exception 'invalid-journal-input-cursor' using errcode='22023'; end if;
  select coalesce(array_agg(distinct public.journal_input_key(e)),'{}'::text[]) into keys from jsonb_array_elements(page) e where public.journal_input_mode(e)='entity';
  if jsonb_array_length(p_updates)<>cardinality(keys)
    or (select count(distinct e->>'key') from jsonb_array_elements(p_updates) e)<>cardinality(keys) then
    raise exception 'invalid-journal-input-entities' using errcode='22023';
  end if;
  for item in select * from jsonb_array_elements(p_updates) loop
    if not coalesce((item->>'key')=any(keys),false)
      or public.journal_input_key(item->'latest') is distinct from item->>'key'
      or public.journal_input_key(item->'orderedThrough') is distinct from item->>'key'
      or not exists(select 1 from public.tradovate_journal_evidence e where e.user_id=p_user_id and e.connection_id=p_connection_id and e.ingest_id<=p_next
        and e.event_id=item#>>'{latest,id}' and (e.evidence-'entity')=((item->'latest')-'entity'))
      or not exists(select 1 from public.tradovate_journal_evidence e where e.user_id=p_user_id and e.connection_id=p_connection_id and e.ingest_id<=p_next
        and e.event_id=item#>>'{orderedThrough,id}' and e.evidence=item->'orderedThrough') then
      raise exception 'invalid-journal-input-entity' using errcode='22023';
    end if;
    insert into public.tradovate_journal_input_entities(user_id,connection_id,entity_key,latest,ordered_through)
      values(p_user_id,p_connection_id,item->>'key',item->'latest',item->'orderedThrough')
      on conflict(user_id,connection_id,entity_key) do update set latest=excluded.latest,ordered_through=excluded.ordered_through;
  end loop;
  insert into public.tradovate_journal_input_retained(user_id,connection_id,event_id,evidence)
    select p_user_id,p_connection_id,e->>'id',e from jsonb_array_elements(page) e where public.journal_input_mode(e)='retained' on conflict do nothing;
  select e into receipt from jsonb_array_elements(page) e order by (e->>'receivedAt')::double precision desc limit 1;
  update public.tradovate_journal_input_heads h set through=p_next,generation=h.generation+1,
    watermark=case when h.watermark is null or (receipt->>'receivedAt')::double precision>(h.watermark->>'receivedAt')::double precision then receipt else h.watermark end
    where h.user_id=p_user_id and h.connection_id=p_connection_id returning * into head;
  return jsonb_build_object('accepted',true,'through',head.through,'targetThrough',head.target_through,'generation',head.generation);
end; $$;

create function public.read_journal_input_entity_history(p_user_id uuid,p_connection_id uuid,p_key text,p_after bigint,p_through bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_after is null or p_after<0 or p_through is null or p_through<p_after or p_key is null or length(p_key)>700
    or not exists(select 1 from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id and p_through<=h.target_through) then
    raise exception 'invalid-journal-input-history' using errcode='22023';
  end if;
  with candidates as materialized(select e.ingest_id,e.evidence from public.tradovate_journal_evidence e where e.user_id=p_user_id and e.connection_id=p_connection_id
    and public.journal_input_key(e.evidence)=p_key and e.ingest_id>p_after and e.ingest_id<=p_through order by e.ingest_id limit 251),
    page as (select * from candidates order by ingest_id limit 250)
  select jsonb_build_object('after',p_after,'through',p_through,'hasMore',(select count(*) from candidates)>250,
    'next',case when (select count(*) from candidates)>250 then (select max(ingest_id) from page) else p_through end,
    'rows',(select coalesce(jsonb_agg(jsonb_build_object('cursor',ingest_id,'event',evidence) order by ingest_id),'[]'::jsonb) from page)) into result;
  return result;
end; $$;

create function public.read_journal_input_snapshot(p_user_id uuid,p_connection_id uuid,p_generation bigint,p_after text default '')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare head public.tradovate_journal_input_heads%rowtype; result jsonb;
begin
  select * into head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id;
  if not found or head.version<>1 or head.generation is distinct from p_generation or head.through<>head.target_through then
    raise exception 'journal-input-changed' using errcode='40001';
  end if;
  if p_after is null or length(p_after)>800 then raise exception 'invalid-journal-input-page' using errcode='22023'; end if;
  with all_rows as (
    select 'e:'||c.entity_key as key,jsonb_build_object('key',c.entity_key,'latest',c.latest,'orderedThrough',c.ordered_through) as entity,null::jsonb as event
      from public.tradovate_journal_input_entities c where c.user_id=p_user_id and c.connection_id=p_connection_id
    union all select 'r:'||r.event_id,null::jsonb,r.evidence from public.tradovate_journal_input_retained r where r.user_id=p_user_id and r.connection_id=p_connection_id
  ), page as (select * from all_rows r where r.key collate "C">p_after collate "C" order by r.key collate "C" limit 250)
  select jsonb_build_object('generation',head.generation,'through',head.through,'watermark',head.watermark,
    'rows',coalesce(jsonb_agg(jsonb_build_object('key',key,'entity',entity,'event',event) order by key collate "C"),'[]'::jsonb)) into result from page;
  return result;
end; $$;

revoke all on function public.journal_input_mode(jsonb),public.journal_input_key(jsonb),public.read_journal_input_batch(uuid,uuid),
  public.commit_journal_input_batch(uuid,uuid,bigint,bigint,bigint,jsonb),public.read_journal_input_entity_history(uuid,uuid,text,bigint,bigint),
  public.read_journal_input_snapshot(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.journal_input_mode(jsonb),public.journal_input_key(jsonb),public.read_journal_input_batch(uuid,uuid),
  public.commit_journal_input_batch(uuid,uuid,bigint,bigint,bigint,jsonb),public.read_journal_input_entity_history(uuid,uuid,text,bigint,bigint),
  public.read_journal_input_snapshot(uuid,uuid,bigint,text) to service_role;

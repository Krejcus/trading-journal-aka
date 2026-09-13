-- Owner-only availability of recorded historical reads. This is not financial
-- projection state or proof of historical coverage. No broker calls or writes.
create index journal_source_latest_idx on public.tradovate_journal_evidence
  (user_id, connection_id, environment, (evidence #>> '{entity,entityType}'), received_at desc, ingest_id desc)
  where entity_type = 'journalbackfill';

-- The API authenticates the JWT and supplies p_user_id. Browser roles cannot
-- read the OAuth credential table and cannot execute this function.
create function public.read_journal_source_status(p_user_id uuid, p_connection_ids uuid[])
returns jsonb language plpgsql stable security invoker
set search_path = public, pg_temp
as $$
declare
  owner_id uuid := p_user_id;
  result jsonb;
begin
  if owner_id is null or p_connection_ids is null
     or cardinality(p_connection_ids) not between 1 and 25
     or array_position(p_connection_ids, null) is not null
     or (select count(distinct id) from unnest(p_connection_ids) id) <> cardinality(p_connection_ids)
     or (select count(*) from public.tradovate_oauth_connections
         where user_id = owner_id and id = any(p_connection_ids)) <> cardinality(p_connection_ids) then
    raise exception 'journal-source-invalid-scope' using errcode = '42501';
  end if;
  select jsonb_build_object('connections', jsonb_agg(jsonb_build_object(
    'connectionId', c.id, 'environment', c.environment, 'sources', sources.rows) order by c.id)) into result
  from public.tradovate_oauth_connections c
  cross join lateral (
    select jsonb_agg(jsonb_build_object('type', source.type, 'recordedAt', latest.received_at,
      'metadata', case when latest.ingest_id is null then null else jsonb_build_object(
        'kind', latest.evidence #> '{entity,kind}',
        'startedAt', latest.evidence #> '{entity,startedAt}',
        'completedAt', latest.evidence #> '{entity,completedAt}',
        'scope', latest.evidence #> '{entity,scope}',
        'scanned', latest.evidence #> '{entity,scanned}',
        'recorded', latest.evidence #> '{entity,recorded}',
        'contended', latest.evidence #> '{entity,contended}',
        'requested', latest.evidence #> '{entity,requested}',
        'remaining', latest.evidence #> '{entity,remaining}') end) order by source.type) as rows
    from unnest(array['fillfee','fillpair','order','fill','orderversion','command',
      'commandreport','executionreport','contract','cashbalancelog']) source(type)
    left join lateral (
      select e.ingest_id, e.received_at, e.evidence
      from public.tradovate_journal_evidence e
      where e.user_id = owner_id and e.connection_id = c.id and e.environment = c.environment
        and e.entity_type = 'journalbackfill' and e.evidence #>> '{entity,entityType}' = source.type
      -- Upload order may differ from observation order; late old success must
      -- not overwrite a newer failure. These are recorder times, not broker times.
      order by e.received_at desc, e.ingest_id desc limit 1
    ) latest on true
  ) sources
  where c.user_id = owner_id and c.id = any(p_connection_ids);
  return result;
end;
$$;
revoke all on function public.read_journal_source_status(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.read_journal_source_status(uuid, uuid[]) to service_role;

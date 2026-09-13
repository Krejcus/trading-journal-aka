-- Local draft only. Apply after a separate production backup/export approval.
-- Serialize commits per connection so an incremental reader cannot skip a
-- transaction whose identity value was allocated before a later committed batch.
create function public.append_tradovate_journal_evidence(
  p_user_id uuid, p_connection_id uuid, p_device_id uuid, p_events jsonb
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
begin
  if jsonb_typeof(p_events) is distinct from 'array'
     or jsonb_array_length(p_events) not between 1 and 100
     or octet_length(p_events::text) > 300000 then
    raise exception 'invalid-journal-batch' using errcode = '22023';
  end if;
  perform 1 from public.tradovate_oauth_connections c
    where c.id = p_connection_id and c.user_id = p_user_id and c.environment = 'demo'
    for update;
  if not found then raise exception 'invalid-journal-connection' using errcode = '42501'; end if;
  perform 1 from public.tradovate_copier_devices d
    where d.id = p_device_id and d.user_id = p_user_id and d.connection_id = p_connection_id
      and d.environment = 'demo' and d.revoked_at is null
    for share;
  if not found then raise exception 'invalid-journal-device' using errcode = '42501'; end if;
  if exists (select 1 from jsonb_array_elements(p_events) e
    where e->>'connectionId' is distinct from p_connection_id::text
      or e->>'environment' is distinct from 'demo') then
    raise exception 'invalid-journal-connection' using errcode = '22023';
  end if;
  insert into public.tradovate_journal_evidence (
    user_id, connection_id, device_id, event_id, environment, session_id,
    sequence, entity_type, received_at, evidence
  ) select p_user_id, p_connection_id, p_device_id, e->>'id', 'demo',
      (e->>'sessionId')::uuid, (e->>'sequence')::bigint, e->>'entityType',
      to_timestamp((e->>'receivedAt')::double precision / 1000.0), e
    from jsonb_array_elements(p_events) e
    on conflict (user_id, connection_id, event_id) do nothing;
  return jsonb_build_object('accepted', true, 'ids', (
    select jsonb_agg(e->>'id' order by ord) from jsonb_array_elements(p_events) with ordinality as items(e, ord)
  ));
end;
$$;
revoke all on function public.append_tradovate_journal_evidence(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.append_tradovate_journal_evidence(uuid, uuid, uuid, jsonb) to service_role;

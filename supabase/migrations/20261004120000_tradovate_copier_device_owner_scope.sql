-- Jeden spárovaný Mac worker pro všechny propfirmy vlastníka (4. 10. 2026).
-- Výchozí scope zůstává 'connection' (lease jen pro připojení, se kterým byl
-- Mac spárován). Scope 'owner' nastaví až výslovný souhlas uživatele v LIVE;
-- pak smí zařízení brát krátké lease i pro další připojená demo připojení
-- svého vlastníka, aby nová propfirma nepotřebovala CLI ani reinstall.

alter table public.tradovate_copier_devices
  add column if not exists scope text not null default 'connection'
    check (scope in ('connection', 'owner')),
  add column if not exists owner_scope_granted_at timestamptz;

comment on column public.tradovate_copier_devices.scope is
  'connection = lease jen pro connection_id; owner = lease pro všechna připojená demo OAuth připojení vlastníka (výslovný souhlas v LIVE).';

-- Evidence obchodů z propfirmy načtené přes owner-scope Mac: zařízení smí
-- zapisovat i pro další připojení vlastníka. Jinak beze změny proti
-- 20260912115949 (ověřeno proti produkční definici 4. 10. 2026).
create or replace function public.append_tradovate_journal_evidence(
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
    where d.id = p_device_id and d.user_id = p_user_id
      and (d.connection_id = p_connection_id or d.scope = 'owner')
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

-- Mac patří uživateli, ne propfirmě (5. 10. 2026). Smazání OAuth připojení
-- (dnes jen soft-disconnect, ale pro jistotu) nesmí smazat spárovaný Mac,
-- jeho příkazy ani runtime stav — jen se odpojí kotva. Claim/ACK i realtime
-- jsou klíčované device_id, connection_id je u nich jen provenance.
alter table public.tradovate_copier_devices alter column connection_id drop not null;
alter table public.tradovate_copier_devices drop constraint if exists tradovate_copier_devices_connection_id_fkey;
alter table public.tradovate_copier_devices add constraint tradovate_copier_devices_connection_id_fkey
  foreign key (connection_id) references public.tradovate_oauth_connections(id) on delete set null;

alter table public.tradovate_copier_commands alter column connection_id drop not null;
alter table public.tradovate_copier_commands drop constraint if exists tradovate_copier_commands_connection_id_fkey;
alter table public.tradovate_copier_commands add constraint tradovate_copier_commands_connection_id_fkey
  foreign key (connection_id) references public.tradovate_oauth_connections(id) on delete set null;

alter table public.tradovate_copier_device_runtime alter column connection_id drop not null;
alter table public.tradovate_copier_device_runtime drop constraint if exists tradovate_copier_device_runtime_connection_id_fkey;
alter table public.tradovate_copier_device_runtime add constraint tradovate_copier_device_runtime_connection_id_fkey
  foreign key (connection_id) references public.tradovate_oauth_connections(id) on delete set null;

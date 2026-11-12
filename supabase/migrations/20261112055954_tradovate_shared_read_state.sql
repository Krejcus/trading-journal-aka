-- Display/read transport only. No copier commands, broker writes or execution evidence.
create table public.tradovate_shared_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  principal text not null,
  route_key text not null,
  channel text not null,
  payload jsonb,
  source_started_at timestamptz,
  fresh_until timestamptz not null default '-infinity',
  retry_at timestamptz not null default '-infinity',
  lease_id uuid,
  lease_started_at timestamptz,
  lease_connection_id uuid,
  lease_auth_version text,
  authorization_versions jsonb not null default '{}'::jsonb,
  lease_until timestamptz not null default '-infinity',
  updated_at timestamptz not null default now(),
  primary key (user_id, principal, route_key, channel),
  check (length(route_key) = 64),
  check (length(channel) between 1 and 180),
  check (payload is null or pg_column_size(payload) <= 4194304)
);
alter table public.tradovate_shared_reads enable row level security;
revoke all on public.tradovate_shared_reads from public, anon, authenticated;
grant select, insert, update, delete on public.tradovate_shared_reads to service_role;
create index tradovate_shared_reads_updated_at_idx on public.tradovate_shared_reads(user_id, updated_at);

-- Invoker privileges, service-role only. Every call checks the CURRENT connection:
-- a cached payload is never a substitute for OAuth ownership/revocation checks.
create function public.tradovate_shared_read_v1(
  p_user_id uuid, p_connection_id uuid, p_environment text, p_route_key text,
  p_channel text, p_action text, p_lease_id uuid default null,
  p_payload jsonb default null, p_ttl_ms integer default 0,
  p_retry_ms integer default 0
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_connection public.tradovate_oauth_connections%rowtype;
  v_principal text;
  v_row public.tradovate_shared_reads%rowtype;
  v_lease uuid;
  v_auth_version text;
  v_inserted integer;
begin
  select * into v_connection from public.tradovate_oauth_connections
    where id = p_connection_id and user_id = p_user_id
      and environment = p_environment and connection_status = 'connected'
      and encrypted_access_token is not null;
  if not found then raise exception 'tradovate-not-connected'; end if;
  if p_route_key !~ '^[a-f0-9]{64}$' or length(p_channel) not between 1 and 180
    or p_action not in ('peek','last-known','claim','publish','fail') then
    raise exception 'invalid-shared-read-request';
  end if;
  -- Multiple connections of the same owner/login share the data, but never
  -- cross environment, route or granted scope. Unknown identities stay isolated.
  v_principal := p_environment || ':' || coalesce('broker:' || v_connection.tradovate_user_id::text,
    'connection:' || p_connection_id::text) || ':' || md5(coalesce(v_connection.scope, ''));
  v_auth_version := md5(v_connection.encrypted_access_token || v_connection.connected_at::text);
  if p_action in ('peek','last-known') then
    select * into v_row from public.tradovate_shared_reads where
      user_id = p_user_id and principal = v_principal and route_key = p_route_key and channel = p_channel;
  else
    insert into public.tradovate_shared_reads(user_id,principal,route_key,channel)
      values(p_user_id,v_principal,p_route_key,p_channel) on conflict do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      -- Bounded opportunistic retention; no extra cron or production configuration.
      delete from public.tradovate_shared_reads where (user_id,principal,route_key,channel) in (
        select user_id,principal,route_key,channel from public.tradovate_shared_reads
          where user_id=p_user_id and updated_at < v_now - interval '2 days'
          order by updated_at limit 100
      );
    end if;
    select * into v_row from public.tradovate_shared_reads where
      user_id = p_user_id and principal = v_principal and route_key = p_route_key and channel = p_channel for update;
  end if;
  if p_action in ('publish','fail') then
    -- A crashed/slow reader cannot publish over a later lease or revive an expired one.
    if p_lease_id is null or v_row.lease_id is distinct from p_lease_id or v_row.lease_until <= v_now
      or v_row.lease_started_at < v_connection.connected_at
      or v_row.lease_connection_id is distinct from p_connection_id
      or v_row.lease_auth_version is distinct from v_auth_version then
      return jsonb_build_object('state','superseded');
    end if;
    if p_action = 'publish' then
      if p_payload is null or p_ttl_ms not between 1 and 600000 then raise exception 'invalid-shared-read-payload'; end if;
      update public.tradovate_shared_reads set payload = p_payload,
        source_started_at = v_row.lease_started_at,
        authorization_versions = authorization_versions || jsonb_build_object(p_connection_id::text,v_auth_version),
        fresh_until = v_now + p_ttl_ms * interval '1 millisecond', retry_at = '-infinity',
        lease_id = null, lease_until = '-infinity', updated_at = v_now
      where user_id = p_user_id and principal = v_principal and route_key = p_route_key and channel = p_channel;
    else
      update public.tradovate_shared_reads set retry_at = greatest(retry_at, v_now +
        least(86400000, greatest(1000,p_retry_ms)) * interval '1 millisecond'),
        lease_id = null, lease_until = '-infinity', updated_at = v_now
      where user_id = p_user_id and principal = v_principal and route_key = p_route_key and channel = p_channel;
    end if;
    return jsonb_build_object('state','stored');
  end if;
  if v_row.payload is not null and (v_row.fresh_until > v_now
      or (p_action='last-known' and v_row.source_started_at > v_now - interval '24 hours'))
    and v_row.source_started_at >= v_connection.connected_at
    and (not (v_row.authorization_versions ? p_connection_id::text)
      or v_row.authorization_versions ->> p_connection_id::text = v_auth_version) then
    if not (v_row.authorization_versions ? p_connection_id::text) then
      update public.tradovate_shared_reads set authorization_versions = authorization_versions ||
        jsonb_build_object(p_connection_id::text,v_auth_version) where user_id = p_user_id
        and principal = v_principal and route_key = p_route_key and channel = p_channel;
    end if;
    return jsonb_build_object('state','ready','payload',v_row.payload);
  end if;
  if p_action in ('peek','last-known') then return jsonb_build_object('state','empty'); end if;
  if v_row.retry_at > v_now then
    return jsonb_build_object('state','backoff','retryAfterMs',ceil(extract(epoch from (v_row.retry_at-v_now))*1000));
  end if;
  if v_row.lease_until > v_now then
    return jsonb_build_object('state','busy','retryAfterMs',500);
  end if;
  v_lease := gen_random_uuid();
  update public.tradovate_shared_reads set lease_id = v_lease,
    lease_until = v_now + interval '45 seconds', lease_started_at = v_now, lease_connection_id = p_connection_id,
    lease_auth_version = v_auth_version, updated_at = v_now
    where user_id = p_user_id and principal = v_principal and route_key = p_route_key and channel = p_channel;
  return jsonb_build_object('state','claimed','leaseId',v_lease,'previous',v_row.payload);
end $$;
revoke all on function public.tradovate_shared_read_v1(uuid,uuid,text,text,text,text,uuid,jsonb,integer,integer) from public, anon, authenticated;
grant execute on function public.tradovate_shared_read_v1(uuid,uuid,text,text,text,text,uuid,jsonb,integer,integer) to service_role;
comment on table public.tradovate_shared_reads is 'Shared display/read snapshots and fenced read leases. No broker credentials or execution authority. Bounded retention removes rows idle > 2 days when a new channel is created.';

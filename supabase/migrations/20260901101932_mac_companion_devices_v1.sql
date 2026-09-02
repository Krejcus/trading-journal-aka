-- Read-only macOS menu-bar companion credentials. The companion credential is
-- intentionally unrelated to tradovate_copier_devices: it can read one
-- allowlisted status endpoint and cannot obtain a broker lease or relay a
-- copier command.

begin;

create table public.mac_companion_devices (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete cascade,
  device_name text not null check (
    device_name = btrim(device_name)
    and char_length(device_name) between 1 and 120
  ),
  platform text not null default 'macos' check (platform = 'macos'),
  secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  pairing_code_hash text check (pairing_code_hash is null or pairing_code_hash ~ '^[0-9a-f]{64}$'),
  pairing_expires_at timestamptz,
  audience text not null default 'mac-companion' check (audience = 'mac-companion'),
  scope text not null default 'copier.status.read' check (scope = 'copier.status.read'),
  created_at timestamptz not null default now(),
  paired_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint mac_companion_devices_pairing_state check (
    (
      user_id is null
      and paired_at is null
      and pairing_code_hash is not null
      and pairing_expires_at is not null
      and revoked_at is null
    )
    or
    (
      user_id is not null
      and paired_at is not null
      and pairing_code_hash is null
      and pairing_expires_at is null
    )
  ),
  constraint mac_companion_devices_pairing_expiry check (
    pairing_expires_at is null or pairing_expires_at > created_at
  )
);

create unique index mac_companion_devices_pairing_code_idx
  on public.mac_companion_devices (pairing_code_hash)
  where pairing_code_hash is not null;

create index mac_companion_devices_owner_idx
  on public.mac_companion_devices (user_id, created_at desc)
  where user_id is not null;

create index mac_companion_devices_active_owner_idx
  on public.mac_companion_devices (user_id, last_used_at desc nulls last)
  where user_id is not null and revoked_at is null;

alter table public.mac_companion_devices enable row level security;

-- Every operation is mediated by a Vercel function. Browser sessions and
-- anonymous callers never receive direct Data API access to these rows.
revoke all on table public.mac_companion_devices from public, anon, authenticated;
grant select, insert, update, delete on table public.mac_companion_devices to service_role;

comment on table public.mac_companion_devices is
  'Server-only SHA-256 digests for revocable, read-only AlphaTrade macOS companion credentials.';
comment on column public.mac_companion_devices.scope is
  'Fixed least-privilege scope; never authorizes copier relay or broker access.';

-- A Vercel instance-local limiter is not a security boundary. Keep a small,
-- service-only sliding window keyed by a server-HMAC of the client address.
create table public.mac_companion_pairing_rate_limits (
  bucket_key text primary key check (
    bucket_key = 'global' or bucket_key ~ '^ip:[0-9a-f]{64}$'
  ),
  hits timestamptz[] not null default '{}'::timestamptz[],
  updated_at timestamptz not null default now()
);

create index mac_companion_pairing_rate_limits_updated_idx
  on public.mac_companion_pairing_rate_limits (updated_at)
  where bucket_key <> 'global';

create index mac_companion_pending_expiry_idx
  on public.mac_companion_devices (pairing_expires_at)
  where user_id is null and paired_at is null;

alter table public.mac_companion_pairing_rate_limits enable row level security;
revoke all on table public.mac_companion_pairing_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.mac_companion_pairing_rate_limits to service_role;

create or replace function public.consume_mac_companion_pairing_start_limit(target_ip_hash text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  observed_at timestamptz := clock_timestamp();
  global_hits timestamptz[];
  ip_hits timestamptz[];
  retry_after_seconds integer;
  ip_bucket_key text;
begin
  if target_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid mac companion rate key';
  end if;
  ip_bucket_key := 'ip:' || target_ip_hash;

  -- Lock global first for a consistent lock order across all serverless
  -- instances. Do not create a new IP row if the global bucket is already full.
  insert into public.mac_companion_pairing_rate_limits (bucket_key, hits, updated_at)
  values ('global', '{}'::timestamptz[], observed_at)
  on conflict (bucket_key) do nothing;

  select hits into global_hits
    from public.mac_companion_pairing_rate_limits
   where bucket_key = 'global'
   for update;

  select coalesce(array_agg(hit order by hit), '{}'::timestamptz[])
    into global_hits
    from unnest(global_hits) as hit
   where hit > observed_at - interval '10 minutes';

  if cardinality(global_hits) >= 120 then
    retry_after_seconds := greatest(1, least(600, ceil(extract(epoch from (
      global_hits[1] + interval '10 minutes' - observed_at
    )))::integer));
    update public.mac_companion_pairing_rate_limits
       set hits = global_hits, updated_at = observed_at
     where bucket_key = 'global';
    return jsonb_build_object(
      'allowed', false,
      'retryAfterSeconds', retry_after_seconds
    );
  end if;

  insert into public.mac_companion_pairing_rate_limits (bucket_key, hits, updated_at)
  values (ip_bucket_key, '{}'::timestamptz[], observed_at)
  on conflict (bucket_key) do nothing;

  select hits into ip_hits
    from public.mac_companion_pairing_rate_limits
   where bucket_key = ip_bucket_key
   for update;

  select coalesce(array_agg(hit order by hit), '{}'::timestamptz[])
    into ip_hits
    from unnest(ip_hits) as hit
   where hit > observed_at - interval '10 minutes';

  if cardinality(ip_hits) >= 10 then
    retry_after_seconds := greatest(1, least(600, ceil(extract(epoch from (
      ip_hits[1] + interval '10 minutes' - observed_at
    )))::integer));
    update public.mac_companion_pairing_rate_limits
       set hits = global_hits, updated_at = observed_at
     where bucket_key = 'global';
    update public.mac_companion_pairing_rate_limits
       set hits = ip_hits, updated_at = observed_at
     where bucket_key = ip_bucket_key;
    return jsonb_build_object(
      'allowed', false,
      'retryAfterSeconds', retry_after_seconds
    );
  end if;

  update public.mac_companion_pairing_rate_limits
     set hits = array_append(global_hits, observed_at), updated_at = observed_at
   where bucket_key = 'global';
  update public.mac_companion_pairing_rate_limits
     set hits = array_append(ip_hits, observed_at), updated_at = observed_at
   where bucket_key = ip_bucket_key;

  -- Bounded opportunistic retention. A one-hour grace preserves the native
  -- client's authoritative 410 response after the ten-minute pairing expiry.
  delete from public.mac_companion_devices
   where id in (
     select id
       from public.mac_companion_devices
      where user_id is null
        and paired_at is null
        and revoked_at is null
        and pairing_expires_at < observed_at - interval '1 hour'
      order by pairing_expires_at
      limit 200
   );
  delete from public.mac_companion_pairing_rate_limits
   where bucket_key in (
     select bucket_key
       from public.mac_companion_pairing_rate_limits
      where bucket_key <> 'global'
        and updated_at < observed_at - interval '1 hour'
      order by updated_at
      limit 200
   );

  return jsonb_build_object('allowed', true, 'retryAfterSeconds', 0);
end;
$$;

revoke all on function public.consume_mac_companion_pairing_start_limit(text)
  from public, anon, authenticated;
grant execute on function public.consume_mac_companion_pairing_start_limit(text)
  to service_role;

comment on table public.mac_companion_pairing_rate_limits is
  'Server-only sliding windows; IP bucket keys are HMAC digests, never raw addresses.';

commit;

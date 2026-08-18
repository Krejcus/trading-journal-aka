create table public.tradovate_copier_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.tradovate_copier_devices(id) on delete cascade,
  connection_id uuid not null references public.tradovate_oauth_connections(id) on delete cascade,
  command_type text not null check (command_type in ('copy-command', 'arm-live', 'shadow', 'disarm', 'kill-switch')),
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 160),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'succeeded', 'rejected', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error text,
  constraint tradovate_copier_commands_expiry check (expires_at > created_at),
  constraint tradovate_copier_commands_idempotency unique (user_id, device_id, idempotency_key)
);

create index tradovate_copier_commands_claim_idx
  on public.tradovate_copier_commands (device_id, status, expires_at, created_at);
create index tradovate_copier_commands_owner_idx
  on public.tradovate_copier_commands (user_id, created_at desc);

alter table public.tradovate_copier_commands enable row level security;
revoke all on table public.tradovate_copier_commands from public, anon, authenticated;

create table public.tradovate_copier_device_runtime (
  device_id uuid primary key references public.tradovate_copier_devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.tradovate_oauth_connections(id) on delete cascade,
  status jsonb not null,
  last_seen_at timestamptz not null default now(),
  started_at timestamptz not null
);

create index tradovate_copier_device_runtime_owner_idx
  on public.tradovate_copier_device_runtime (user_id, last_seen_at desc);

alter table public.tradovate_copier_device_runtime enable row level security;
revoke all on table public.tradovate_copier_device_runtime from public, anon, authenticated;

create or replace function public.claim_tradovate_copier_command(target_device_id uuid)
returns setof public.tradovate_copier_commands
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.tradovate_copier_commands
     set status = 'expired', completed_at = now(), error = 'command-expired'
   where device_id = target_device_id
     and status = 'pending'
     and expires_at <= now();

  return query
  with candidate as (
    select id
      from public.tradovate_copier_commands
     where device_id = target_device_id
       and status = 'pending'
       and expires_at > now()
     order by created_at, id
     for update skip locked
     limit 1
  )
  update public.tradovate_copier_commands command
     set status = 'claimed', claimed_at = now()
    from candidate
   where command.id = candidate.id
  returning command.*;
end;
$$;

revoke all on function public.claim_tradovate_copier_command(uuid) from public, anon, authenticated;
grant execute on function public.claim_tradovate_copier_command(uuid) to service_role;

comment on table public.tradovate_copier_commands is
  'Short-lived, one-time server relay for explicitly confirmed DEMO copier commands.';
comment on table public.tradovate_copier_device_runtime is
  'Ephemeral Mac copier worker heartbeat; stale rows never authorize execution.';

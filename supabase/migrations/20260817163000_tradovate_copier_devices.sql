-- Revocable, least-privilege credentials for a user's own local copier worker.
-- The clear device secret never enters Postgres; only its SHA-256 digest is kept.

create table public.tradovate_copier_devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.tradovate_oauth_connections(id) on delete cascade,
  environment text not null default 'demo' check (environment = 'demo'),
  device_name text not null check (char_length(device_name) between 1 and 120),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  public_key text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint tradovate_copier_devices_owner_connection_unique unique (user_id, connection_id, id)
);

create index tradovate_copier_devices_owner_idx
  on public.tradovate_copier_devices (user_id, created_at desc);

create index tradovate_copier_devices_connection_idx
  on public.tradovate_copier_devices (connection_id);

alter table public.tradovate_copier_devices enable row level security;

-- Device rows are intentionally server-only. Pair/revoke operations authenticate
-- the AlphaTrade user in Vercel functions and use the service role there.
revoke all on table public.tradovate_copier_devices from public, anon, authenticated;

comment on table public.tradovate_copier_devices is
  'Revocable credentials for loopback/VPS copier workers. Stores only a device-secret digest.';

begin;

create table public.native_live_activity_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id text not null check (activity_id ~ '^[A-Za-z0-9._-]{1,160}$'),
  push_token text not null check (push_token ~ '^[0-9a-f]{64,240}$'),
  environment text not null check (environment in ('development', 'production')),
  bundle_id text not null default 'app.alphatrade.native'
    check (bundle_id = 'app.alphatrade.native'),
  last_payload_hash text,
  last_payload_at timestamptz,
  expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, activity_id),
  unique (push_token, environment, bundle_id)
);

alter table public.native_live_activity_subscriptions enable row level security;

-- Tokeny ActivityKit nikdy nejsou dostupné webovému klientu. Přihlášená
-- appka je registruje přes serverový endpoint, který ověří její JWT a zapisuje
-- service_role klientem. Provider APNs je čte stejnou privilegovanou cestou.
revoke all on table public.native_live_activity_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table public.native_live_activity_subscriptions to service_role;

create index if not exists native_live_activity_subscriptions_user_active_idx
  on public.native_live_activity_subscriptions (user_id, updated_at desc)
  where expires_at is null;

comment on table public.native_live_activity_subscriptions is
  'Server-only ActivityKit push tokens; financial payloads are never persisted here.';

commit;

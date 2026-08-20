-- Push-to-start tokens let APNs create the read-only AlphaTrade Live Activity
-- while the app is force-quit. They are device-scoped addresses, never client
-- database credentials, and stay inaccessible to anon/authenticated roles.

begin;

create table public.native_live_activity_start_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  installation_id uuid not null,
  push_token text not null check (push_token ~ '^[0-9a-f]{64,240}$'),
  environment text not null check (environment in ('development', 'production')),
  bundle_id text not null default 'app.alphatrade.native'
    check (bundle_id = 'app.alphatrade.native'),
  last_start_trigger text check (last_start_trigger is null or char_length(last_start_trigger) between 1 and 240),
  last_started_at timestamptz,
  expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, installation_id),
  unique (push_token, environment, bundle_id)
);

create index native_live_activity_start_user_active_idx
  on public.native_live_activity_start_subscriptions (user_id, updated_at desc)
  where expires_at is null;

alter table public.native_live_activity_start_subscriptions enable row level security;
revoke all on table public.native_live_activity_start_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table public.native_live_activity_start_subscriptions to service_role;

comment on table public.native_live_activity_start_subscriptions is
  'Server-only ActivityKit push-to-start tokens. No financial payload or broker command is persisted.';

commit;

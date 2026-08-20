-- Native APNs device registry. The client never talks to this table directly:
-- an authenticated Vercel endpoint verifies the Supabase JWT and writes via
-- service_role. Keeping device tokens server-only avoids exposing addresses
-- that can target a specific AlphaTrade installation.

begin;

create table public.native_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_token text not null check (device_token ~ '^[0-9a-f]{64,200}$'),
  environment text not null check (environment in ('development', 'production')),
  bundle_id text not null default 'app.alphatrade.native'
    check (bundle_id = 'app.alphatrade.native'),
  platform text not null default 'ios' check (platform = 'ios'),
  app_version text,
  device_model text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expired_at timestamptz,
  last_error text,
  constraint native_push_subscriptions_token_unique unique (device_token, environment, bundle_id)
);

create index native_push_subscriptions_user_active_idx
  on public.native_push_subscriptions (user_id, last_seen_at desc)
  where expired_at is null;

alter table public.native_push_subscriptions enable row level security;

-- Intentional: there are no anon/authenticated policies. Registration and
-- deletion go through /api/native-push-subscription after server-side getUser().
revoke all on table public.native_push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table public.native_push_subscriptions to service_role;

comment on table public.native_push_subscriptions is
  'Server-only APNs device tokens for the native AlphaTrade iOS app.';

alter table public.alert_deliveries
  add column native_subscription_id uuid
  references public.native_push_subscriptions(id) on delete set null;

alter table public.alert_deliveries
  add constraint alert_deliveries_native_device_unique
  unique (user_id, alert_type, alert_date, native_subscription_id);

create index alert_deliveries_native_subscription_idx
  on public.alert_deliveries (native_subscription_id)
  where native_subscription_id is not null;

commit;

-- Persistent user-owned metadata for broker accounts. OAuth credentials live in
-- tradovate_oauth_connections and may be deleted independently; reconnecting the
-- same external account therefore restores its profile by stable account ID.
--
-- Prepared locally only. Back up/export the hosted project, review advisors and
-- obtain explicit approval before applying this migration remotely.

create table public.tradovate_account_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'tradovate',
  environment text not null,
  external_account_id text not null,
  account_name text not null,
  display_name text,
  prop_firm text,
  plan_name text,
  account_type text,
  account_size numeric(14, 2),
  drawdown_type text,
  max_loss numeric(14, 2),
  daily_loss_limit numeric(14, 2),
  consistency_pct numeric(7, 3),
  profit_target numeric(14, 2),
  max_mini integer,
  max_micro integer,
  status text not null default 'active',
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tradovate_account_profiles_provider_valid check (provider = 'tradovate'),
  constraint tradovate_account_profiles_environment_valid check (environment in ('demo', 'live')),
  constraint tradovate_account_profiles_external_id_nonempty check (length(trim(external_account_id)) > 0),
  constraint tradovate_account_profiles_account_name_nonempty check (length(trim(account_name)) > 0),
  constraint tradovate_account_profiles_account_type_valid check (
    account_type is null or account_type in ('evaluation', 'funded', 'live')
  ),
  constraint tradovate_account_profiles_drawdown_type_valid check (
    drawdown_type is null or drawdown_type in ('trailing', 'eod_trailing', 'static', 'none')
  ),
  constraint tradovate_account_profiles_status_valid check (status in ('active', 'archived')),
  constraint tradovate_account_profiles_account_size_nonnegative check (account_size is null or account_size >= 0),
  constraint tradovate_account_profiles_max_loss_nonnegative check (max_loss is null or max_loss >= 0),
  constraint tradovate_account_profiles_daily_loss_nonnegative check (daily_loss_limit is null or daily_loss_limit >= 0),
  constraint tradovate_account_profiles_consistency_range check (
    consistency_pct is null or (consistency_pct >= 0 and consistency_pct <= 100)
  ),
  constraint tradovate_account_profiles_profit_target_nonnegative check (profit_target is null or profit_target >= 0),
  constraint tradovate_account_profiles_max_mini_nonnegative check (max_mini is null or max_mini >= 0),
  constraint tradovate_account_profiles_max_micro_nonnegative check (max_micro is null or max_micro >= 0),
  constraint tradovate_account_profiles_identity_unique unique (
    user_id, provider, environment, external_account_id
  )
);

create index tradovate_account_profiles_user_status_idx
  on public.tradovate_account_profiles (user_id, environment, status, updated_at desc);

alter table public.tradovate_account_profiles enable row level security;

-- The browser never accesses these rows directly. Vercel functions validate the
-- caller's Supabase JWT, scope every query to that user_id, and use service_role.
revoke all on table public.tradovate_account_profiles from public, anon, authenticated;
grant select, insert, update, delete on table public.tradovate_account_profiles to service_role;

comment on table public.tradovate_account_profiles is
  'Tradovate account labels and prop-firm rules, stored independently from OAuth credentials.';

-- Durable, read-only Tradovate reporting backfill. The sync state keeps a
-- resumable queue of date ranges; normalized Performance rows are deduplicated
-- independently of the OAuth connection so reconnecting never duplicates data.
--
-- Prepared locally only. Back up/export the hosted project, review advisors and
-- obtain explicit approval before applying this migration remotely.

create table public.tradovate_history_syncs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.tradovate_oauth_connections(id) on delete set null,
  environment text not null,
  external_account_id text not null,
  account_name text not null,
  report_name text not null default 'Performance',
  requested_start date not null,
  requested_end date not null,
  pending_ranges jsonb not null default '[]'::jsonb,
  active_range jsonb,
  lease_expires_at timestamptz,
  status text not null default 'pending',
  revision bigint not null default 0,
  rows_seen bigint not null default 0,
  rows_imported bigint not null default 0,
  synced_through date,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tradovate_history_syncs_environment_valid check (environment in ('demo', 'live')),
  constraint tradovate_history_syncs_report_valid check (report_name = 'Performance'),
  constraint tradovate_history_syncs_status_valid check (status in ('pending', 'running', 'complete', 'error')),
  constraint tradovate_history_syncs_date_order check (requested_start <= requested_end),
  constraint tradovate_history_syncs_external_id_nonempty check (length(trim(external_account_id)) > 0),
  constraint tradovate_history_syncs_account_name_nonempty check (length(trim(account_name)) > 0),
  constraint tradovate_history_syncs_ranges_array check (jsonb_typeof(pending_ranges) = 'array'),
  constraint tradovate_history_syncs_active_range_object check (
    active_range is null or jsonb_typeof(active_range) = 'object'
  ),
  constraint tradovate_history_syncs_identity_unique unique (
    user_id, environment, external_account_id, report_name
  )
);

create index tradovate_history_syncs_user_status_idx
  on public.tradovate_history_syncs (user_id, environment, status, updated_at desc);

create table public.tradovate_historical_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  environment text not null,
  external_account_id text not null,
  account_name text not null,
  source_report text not null default 'Performance',
  source_key text not null,
  symbol text,
  buy_fill_id bigint,
  sell_fill_id bigint,
  quantity numeric(18, 6),
  buy_price numeric(18, 8),
  sell_price numeric(18, 8),
  gross_pnl numeric(18, 6),
  bought_at timestamptz,
  sold_at timestamptz,
  trade_date date,
  raw_row jsonb not null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tradovate_historical_trades_environment_valid check (environment in ('demo', 'live')),
  constraint tradovate_historical_trades_report_valid check (source_report = 'Performance'),
  constraint tradovate_historical_trades_source_key_nonempty check (length(source_key) >= 16),
  constraint tradovate_historical_trades_identity_unique unique (
    user_id, environment, external_account_id, source_report, source_key
  )
);

create index tradovate_historical_trades_user_account_time_idx
  on public.tradovate_historical_trades (user_id, environment, external_account_id, sold_at desc);

alter table public.tradovate_history_syncs enable row level security;
alter table public.tradovate_historical_trades enable row level security;

-- Browser access is intentionally disabled. Authenticated Vercel functions
-- validate the Supabase JWT, scope every query by user_id and use service_role.
revoke all on table public.tradovate_history_syncs from public, anon, authenticated;
revoke all on table public.tradovate_historical_trades from public, anon, authenticated;
grant select, insert, update, delete on table public.tradovate_history_syncs to service_role;
grant select, insert, update, delete on table public.tradovate_historical_trades to service_role;

comment on table public.tradovate_history_syncs is
  'Resumable date-range queue for read-only Tradovate historical reports.';
comment on table public.tradovate_historical_trades is
  'Normalized and deduplicated Tradovate Performance report rows.';

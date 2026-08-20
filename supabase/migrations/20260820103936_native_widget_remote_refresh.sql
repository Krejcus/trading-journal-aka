-- Server-only, revocable credentials for WidgetKit background reads plus a
-- durable idempotent ledger of broker-confirmed copier closes. Raw widget
-- tokens never enter Postgres; the app and extension keep the opaque token in
-- their App Group and the server stores only SHA-256.

begin;

create table public.native_widget_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  bundle_id text not null default 'app.alphatrade.native'
    check (bundle_id = 'app.alphatrade.native'),
  platform text not null default 'ios' check (platform = 'ios'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expired_at timestamptz,
  constraint native_widget_devices_token_unique unique (token_hash, bundle_id)
);

create index native_widget_devices_user_active_idx
  on public.native_widget_devices (user_id, last_seen_at desc)
  where expired_at is null;

alter table public.native_widget_devices enable row level security;
revoke all on table public.native_widget_devices from public, anon, authenticated;
grant select, insert, update, delete on table public.native_widget_devices to service_role;

comment on table public.native_widget_devices is
  'Server-only SHA-256 digests of revocable, read-only WidgetKit access tokens.';

create table public.tradovate_copier_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.tradovate_copier_devices(id) on delete cascade,
  connection_id uuid not null references public.tradovate_oauth_connections(id) on delete cascade,
  trade_id text not null check (char_length(trade_id) between 1 and 160),
  symbol text not null check (char_length(symbol) between 1 and 32),
  side text not null check (side in ('Long', 'Short')),
  quantity numeric(14, 4) not null check (quantity > 0),
  realized_pnl_usd numeric(18, 6),
  follower_count integer not null default 0 check (follower_count >= 0),
  opened_at timestamptz,
  closed_at timestamptz not null,
  source text not null default 'leader-fill-ledger'
    check (source = 'leader-fill-ledger'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tradovate_copier_trades_identity_unique unique (device_id, trade_id)
);

create index tradovate_copier_trades_user_closed_idx
  on public.tradovate_copier_trades (user_id, closed_at desc);
create index tradovate_copier_trades_connection_closed_idx
  on public.tradovate_copier_trades (connection_id, closed_at desc);

alter table public.tradovate_copier_trades enable row level security;
revoke all on table public.tradovate_copier_trades from public, anon, authenticated;
grant select, insert, update, delete on table public.tradovate_copier_trades to service_role;

comment on table public.tradovate_copier_trades is
  'Idempotent broker-confirmed leader closes emitted by the copier worker; read-only analytics source.';

commit;

create table public.backtest_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid,
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed', 'archived')),
  initial_capital numeric(18, 2) not null check (initial_capital > 0),
  base_currency text not null default 'USD' check (char_length(base_currency) = 3),
  start_at timestamptz not null,
  end_at timestamptz not null,
  execution_symbol text not null default 'MNQ' check (execution_symbol in ('MNQ', 'NQ')),
  replay_interval text not null default '1m' check (replay_interval = '1m'),
  cursor_at timestamptz,
  config jsonb not null default '{}'::jsonb,
  workspace_state jsonb not null default '{}'::jsonb,
  runtime_state jsonb not null default '{}'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  schema_version integer not null default 1 check (schema_version > 0),
  last_opened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint backtest_runs_valid_range check (end_at > start_at)
);

create table public.backtest_orders (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.backtest_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  instrument text not null check (instrument in ('MNQ', 'NQ')),
  side text not null check (side in ('buy', 'sell')),
  order_type text not null check (order_type in ('market', 'limit', 'stop')),
  status text not null default 'pending' check (status in ('pending', 'filled', 'cancelled', 'rejected')),
  quantity integer not null check (quantity > 0),
  remaining_quantity integer not null check (remaining_quantity >= 0 and remaining_quantity <= quantity),
  limit_price numeric(18, 6),
  stop_price numeric(18, 6),
  stop_loss numeric(18, 6),
  take_profit numeric(18, 6),
  reduce_only boolean not null default false,
  filled_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint backtest_orders_limit_price check (order_type <> 'limit' or limit_price is not null),
  constraint backtest_orders_stop_price check (order_type <> 'stop' or stop_price is not null)
);

create table public.backtest_fills (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.backtest_runs(id) on delete cascade,
  order_id uuid references public.backtest_orders(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  instrument text not null check (instrument in ('MNQ', 'NQ')),
  side text not null check (side in ('buy', 'sell')),
  quantity integer not null check (quantity > 0),
  price numeric(18, 6) not null check (price > 0),
  commission numeric(18, 6) not null default 0 check (commission >= 0),
  realized_pnl numeric(18, 6) not null default 0,
  reason text not null check (reason in ('entry', 'manual', 'stop-loss', 'take-profit', 'order')),
  filled_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.trades add column if not exists backtest_run_id uuid references public.backtest_runs(id) on delete set null;

create index backtest_runs_user_status_updated_idx on public.backtest_runs (user_id, status, updated_at desc);
create index backtest_runs_user_last_opened_idx on public.backtest_runs (user_id, last_opened_at desc);
create index backtest_orders_run_status_created_idx on public.backtest_orders (run_id, status, created_at);
create index backtest_orders_user_id_idx on public.backtest_orders (user_id);
create index backtest_fills_run_filled_idx on public.backtest_fills (run_id, filled_at);
create index backtest_fills_user_id_idx on public.backtest_fills (user_id);
create index backtest_fills_order_id_idx on public.backtest_fills (order_id) where order_id is not null;
create index trades_backtest_run_id_idx on public.trades (backtest_run_id) where backtest_run_id is not null;

alter table public.backtest_runs enable row level security;
alter table public.backtest_orders enable row level security;
alter table public.backtest_fills enable row level security;

create policy "backtest_runs_select_own" on public.backtest_runs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "backtest_runs_insert_own" on public.backtest_runs
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "backtest_runs_update_own" on public.backtest_runs
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "backtest_runs_delete_own" on public.backtest_runs
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "backtest_orders_select_own" on public.backtest_orders
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "backtest_orders_insert_own" on public.backtest_orders
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.backtest_runs run where run.id = run_id and run.user_id = (select auth.uid()))
  );
create policy "backtest_orders_update_own" on public.backtest_orders
  for update to authenticated using ((select auth.uid()) = user_id) with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.backtest_runs run where run.id = run_id and run.user_id = (select auth.uid()))
  );
create policy "backtest_orders_delete_own" on public.backtest_orders
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "backtest_fills_select_own" on public.backtest_fills
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "backtest_fills_insert_own" on public.backtest_fills
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.backtest_runs run where run.id = run_id and run.user_id = (select auth.uid()))
    and (
      order_id is null
      or exists (
        select 1
        from public.backtest_orders backtest_order
        where backtest_order.id = order_id
          and backtest_order.run_id = run_id
          and backtest_order.user_id = (select auth.uid())
      )
    )
  );
create policy "backtest_fills_delete_own" on public.backtest_fills
  for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.backtest_runs to authenticated;
grant select, insert, update, delete on table public.backtest_orders to authenticated;
grant select, insert, delete on table public.backtest_fills to authenticated;

comment on table public.backtest_runs is 'Durable, resumable chart replay sessions. Existing backtest_sessions remains reserved for pre/post journal blocks.';
comment on column public.backtest_runs.workspace_state is 'Versioned layout, drawings, indicators and viewport snapshot. Market candles are never stored here.';
comment on column public.backtest_runs.runtime_state is 'Crash-recovery snapshot; fills remain the authoritative financial event log.';

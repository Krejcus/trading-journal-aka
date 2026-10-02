-- 2. 10. 2026: nevzaté obchody — zrušené vstupní limity/stopy s bracketem,
-- zadané bez otevřené pozice. Import (service role) zapisuje fakta z Tradovate
-- do `data`; vlastník smí měnit jen `review` (důvod zrušení, poznámka,
-- snímek výsledku „kdybys nezrušil“). Do statistik strategie ani P&L se
-- nepočítají.
create table if not exists public.tradovate_journal_untaken_orders (
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.tradovate_oauth_connections(id) on delete cascade,
  order_id text not null check (order_id ~ '^[0-9]{1,20}$'),
  external_account_id text not null check (external_account_id ~ '^[0-9]{1,20}$'),
  journal_account_id uuid not null,
  placed_at timestamptz not null,
  ended_at timestamptz not null,
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) < 16384),
  review jsonb check (review is null or (jsonb_typeof(review) = 'object' and octet_length(review::text) < 8192)),
  updated_at timestamptz not null default now(),
  primary key (user_id, connection_id, order_id)
);

create index if not exists tradovate_journal_untaken_orders_placed_idx
  on public.tradovate_journal_untaken_orders (user_id, placed_at desc);

alter table public.tradovate_journal_untaken_orders enable row level security;
revoke all on table public.tradovate_journal_untaken_orders from public, anon, authenticated;
grant select on table public.tradovate_journal_untaken_orders to authenticated;
grant update (review) on table public.tradovate_journal_untaken_orders to authenticated;
grant select, insert, update, delete on table public.tradovate_journal_untaken_orders to service_role;

drop policy if exists tradovate_journal_untaken_orders_select_own on public.tradovate_journal_untaken_orders;
create policy tradovate_journal_untaken_orders_select_own
  on public.tradovate_journal_untaken_orders for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists tradovate_journal_untaken_orders_review_own on public.tradovate_journal_untaken_orders;
create policy tradovate_journal_untaken_orders_review_own
  on public.tradovate_journal_untaken_orders for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

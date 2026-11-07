-- Slepé hodnocení v Backtestu: sadu případů vkládá Claude přes CLI, Filip jen doplňuje odpovědi.
-- Nezávislé na backtest_runs a deníku, nic z toho se nedostane do statistik.
create table if not exists public.backtest_blind_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  cases jsonb not null,
  answers jsonb not null default '{}'::jsonb,
  marks jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists backtest_blind_reviews_user_created_idx
  on public.backtest_blind_reviews (user_id, created_at desc);

alter table public.backtest_blind_reviews enable row level security;

create policy "backtest_blind_reviews_select_own" on public.backtest_blind_reviews
  for select to authenticated using ((select auth.uid()) = user_id);

-- Klient mění jen odpovědi a značky; samotná sada případů je mimo jeho práva.
create policy "backtest_blind_reviews_update_own" on public.backtest_blind_reviews
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.backtest_blind_reviews from anon, authenticated;
grant select on public.backtest_blind_reviews to authenticated;
grant update (answers, marks, updated_at) on public.backtest_blind_reviews to authenticated;

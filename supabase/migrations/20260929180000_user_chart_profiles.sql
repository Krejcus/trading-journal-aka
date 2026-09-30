-- Profil grafu uživatele (zapnuté indikátory, jejich styl, nastavení grafu).
-- Dosud jen v localStorage prohlížeče; na serveru ho potřebuje vykreslovací
-- stránka automatických snímků (skrytý prohlížeč workeru) a nové zařízení.
-- Záměrně NE v profiles.preferences: profiles má veřejné čtení.
create table if not exists public.user_chart_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile jsonb not null check (jsonb_typeof(profile) = 'object' and pg_column_size(profile) <= 65536),
  updated_at timestamptz not null default now()
);

alter table public.user_chart_profiles enable row level security;
revoke all on public.user_chart_profiles from public, anon, authenticated;
grant select, insert, update on public.user_chart_profiles to authenticated;
grant select on public.user_chart_profiles to service_role;

create policy user_chart_profiles_select_own on public.user_chart_profiles
  for select to authenticated using ((select auth.uid()) = user_id);
create policy user_chart_profiles_insert_own on public.user_chart_profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy user_chart_profiles_update_own on public.user_chart_profiles
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

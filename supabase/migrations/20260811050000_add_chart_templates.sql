-- Pojmenované šablony vzhledu grafu (indikátory i kreslicí nástroje).
--
-- Dosud žily jen v localStorage, takže se nepřenesly mezi localhostem,
-- produkcí ani zařízeními. Tabulka je záměrně generická: `indicator` je stejný
-- klíč, jaký používá IndicatorTemplateMenu ('levels', 'drawing:fib-retracement',
-- 'chart', …), takže přibývající nástroje nevyžadují další migraci.

create table public.chart_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  indicator text not null check (char_length(indicator) between 1 and 120),
  name text not null check (char_length(trim(name)) between 1 and 60),
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Uložení pod stejným názvem přepíše původní šablonu; porovnání je
-- case-insensitive stejně jako v UI.
create unique index chart_templates_user_indicator_name_idx
  on public.chart_templates (user_id, indicator, lower(trim(name)));
create index chart_templates_user_updated_idx
  on public.chart_templates (user_id, updated_at desc);

alter table public.chart_templates enable row level security;

create policy "chart_templates_select_own" on public.chart_templates
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "chart_templates_insert_own" on public.chart_templates
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "chart_templates_update_own" on public.chart_templates
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "chart_templates_delete_own" on public.chart_templates
  for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.chart_templates to authenticated;

comment on table public.chart_templates is 'Pojmenované šablony nastavení indikátorů a kreslicích nástrojů, sdílené napříč sessions a zařízeními.';
comment on column public.chart_templates.indicator is 'Klíč nástroje z IndicatorTemplateMenu — např. levels, fvg, structure, chart, drawing:fib-retracement.';

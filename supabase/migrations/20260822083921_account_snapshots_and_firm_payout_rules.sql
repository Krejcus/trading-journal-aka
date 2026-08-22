-- Datová vrstva budoucího Kokpitu účtů. Migrace je připravená lokálně;
-- před aplikací je nutný samostatný export/záloha produkčního Supabase.

begin;

create table public.copier_account_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.tradovate_oauth_connections(id) on delete cascade,
  external_account_id text not null check (char_length(trim(external_account_id)) between 1 and 120),
  captured_at timestamptz not null,
  balance double precision not null check (
    balance not in ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
  ),
  realized_pnl_day double precision check (
    realized_pnl_day is null or realized_pnl_day not in (
      'Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision
    )
  ),
  open_pnl double precision check (
    open_pnl is null or open_pnl not in (
      'Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision
    )
  ),
  created_at timestamptz not null default now()
);

create index copier_account_snapshots_user_account_captured_idx
  on public.copier_account_snapshots (user_id, external_account_id, captured_at desc);
-- Kryje FK i globální/per-connection dotaz 15min throttlu; několik účtů
-- uvnitř krátkého okna se pak levně dofiltruje podle external_account_id.
create index copier_account_snapshots_connection_captured_idx
  on public.copier_account_snapshots (connection_id, captured_at desc);

alter table public.copier_account_snapshots enable row level security;

create policy copier_account_snapshots_select_own
  on public.copier_account_snapshots for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.copier_account_snapshots from public, anon, authenticated;
grant select on table public.copier_account_snapshots to authenticated;
grant select, insert on table public.copier_account_snapshots to service_role;

comment on table public.copier_account_snapshots is
  'Nejvýše 15min balance/equity snapshoty OAuth účtů, zapisované pouze serverovým cronem.';

create table public.firm_payout_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  firm_key text not null check (char_length(trim(firm_key)) between 1 and 120),
  plan_name text not null check (char_length(trim(plan_name)) between 1 and 160),
  rules jsonb not null check (jsonb_typeof(rules) = 'object'),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint firm_payout_rules_user_firm_unique unique (user_id, firm_key)
);

alter table public.firm_payout_rules enable row level security;

create policy firm_payout_rules_select_own
  on public.firm_payout_rules for select to authenticated
  using ((select auth.uid()) = user_id);
create policy firm_payout_rules_insert_own
  on public.firm_payout_rules for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy firm_payout_rules_update_own
  on public.firm_payout_rules for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy firm_payout_rules_delete_own
  on public.firm_payout_rules for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.firm_payout_rules from public, anon, authenticated;
grant select, insert, update, delete on table public.firm_payout_rules to authenticated;
grant select, insert, update, delete on table public.firm_payout_rules to service_role;

comment on table public.firm_payout_rules is
  'Uživatelsky upravitelná payout pravidla prop firem; kódové šablony jsou pouze fallback.';

commit;

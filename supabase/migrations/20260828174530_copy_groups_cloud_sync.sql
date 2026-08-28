-- Uživatelská knihovna copy-group profilů sdílená mezi webem a nativní appkou.
-- Execution stav sem záměrně nepatří: `enabled` musí být vždy false a jediným
-- zdrojem ARMED/aktivní skupiny zůstává autoritativní copier worker.
--
-- Před aplikací do produkce ověř aktuální Supabase backup/restore point.

create table public.copy_groups (
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id text not null,
  config jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, group_id),
  constraint copy_groups_group_id_shape check (
    char_length(group_id) between 1 and 120
    and group_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint copy_groups_config_shape check (
    jsonb_typeof(config) = 'object'
    and config ?& array['id', 'name', 'enabled', 'leaderAccountId', 'followers', 'safety']
    and config ->> 'id' = group_id
    and jsonb_typeof(config -> 'name') = 'string'
    and char_length(trim(config ->> 'name')) between 1 and 120
    and config -> 'enabled' = 'false'::jsonb
    and jsonb_typeof(config -> 'leaderAccountId') in ('number', 'null')
    and jsonb_typeof(config -> 'followers') = 'array'
    and jsonb_array_length(config -> 'followers') <= 100
    and jsonb_typeof(config -> 'safety') = 'object'
    and octet_length(config::text) <= 65536
    and not (config ? 'localOnly')
  )
);

create index copy_groups_user_updated_idx
  on public.copy_groups (user_id, updated_at desc);

alter table public.copy_groups enable row level security;

create policy "copy_groups_select_own" on public.copy_groups
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "copy_groups_insert_own" on public.copy_groups
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "copy_groups_update_own" on public.copy_groups
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "copy_groups_delete_own" on public.copy_groups
  for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.copy_groups from public, anon;
grant select, insert, update, delete on table public.copy_groups to authenticated;

comment on table public.copy_groups is
  'Per-user saved copier profiles shared across devices; never authoritative for ARMED execution state.';
comment on column public.copy_groups.config is
  'Sanitized CopyGroupConfig with enabled=false and without localOnly; runtime state stays on the copier worker.';

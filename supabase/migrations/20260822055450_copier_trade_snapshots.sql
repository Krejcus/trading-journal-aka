-- F1b: read-only TradingView evidence captured by the local copier worker.
-- Prepared only; intentionally not applied by this task.

alter table public.tradovate_copier_trades
  add column if not exists episode_id uuid null;

create table if not exists public.copier_trade_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  episode_id uuid not null,
  kind text not null check (kind in ('entry', 'exit', 'sl-moved')),
  at timestamptz not null,
  symbol text not null check (char_length(symbol) between 1 and 32),
  storage_path text not null,
  created_at timestamptz not null default now(),
  unique (user_id, episode_id, kind, at)
);

alter table public.copier_trade_snapshots enable row level security;

grant select on table public.copier_trade_snapshots to authenticated;
grant all on table public.copier_trade_snapshots to service_role;

drop policy if exists copier_trade_snapshots_select_own on public.copier_trade_snapshots;
create policy copier_trade_snapshots_select_own
  on public.copier_trade_snapshots
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Serverless instance memory is not a security boundary. This tiny service-only
-- row makes the 12/min/device limit atomic across concurrent Vercel instances.
create table if not exists public.copier_snapshot_rate_limits (
  device_id uuid primary key references public.tradovate_copier_devices(id) on delete cascade,
  hits timestamptz[] not null default '{}'::timestamptz[],
  updated_at timestamptz not null default now()
);

alter table public.copier_snapshot_rate_limits enable row level security;
revoke all on table public.copier_snapshot_rate_limits from anon, authenticated;
grant select, insert, update, delete on table public.copier_snapshot_rate_limits to service_role;

create or replace function public.consume_copier_snapshot_rate_limit(target_device_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  recent_hits timestamptz[];
  observed_at timestamptz := clock_timestamp();
begin
  insert into public.copier_snapshot_rate_limits (device_id, hits, updated_at)
  values (target_device_id, '{}'::timestamptz[], observed_at)
  on conflict (device_id) do nothing;

  select hits into recent_hits
    from public.copier_snapshot_rate_limits
   where device_id = target_device_id
   for update;

  select coalesce(array_agg(hit order by hit), '{}'::timestamptz[])
    into recent_hits
    from unnest(recent_hits) as hit
   where hit > observed_at - interval '1 minute';

  if cardinality(recent_hits) >= 12 then
    update public.copier_snapshot_rate_limits
       set hits = recent_hits, updated_at = observed_at
     where device_id = target_device_id;
    return false;
  end if;

  update public.copier_snapshot_rate_limits
     set hits = array_append(recent_hits, observed_at), updated_at = observed_at
   where device_id = target_device_id;
  return true;
end;
$$;

revoke all on function public.consume_copier_snapshot_rate_limit(uuid) from public, anon, authenticated;
grant execute on function public.consume_copier_snapshot_rate_limit(uuid) to service_role;

insert into storage.buckets (id, name, public)
values ('copier-snapshots', 'copier-snapshots', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists copier_snapshots_select_own on storage.objects;
create policy copier_snapshots_select_own
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'copier-snapshots'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

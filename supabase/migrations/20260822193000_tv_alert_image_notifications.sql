-- F2a: TradingView alert webhook stream and image-ready notification payloads.
-- Prepared only; intentionally not applied by this task.

create table if not exists public.tv_alert_webhooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now(),
  last_alert_at timestamptz null,
  constraint tv_alert_webhooks_token_length check (char_length(token) = 64),
  constraint tv_alert_webhooks_token_hex check (token ~ '^[0-9a-f]+$')
);

alter table public.tv_alert_webhooks enable row level security;
revoke all on table public.tv_alert_webhooks from anon, authenticated;
grant select on table public.tv_alert_webhooks to authenticated;
grant select, insert, update, delete on table public.tv_alert_webhooks to service_role;

drop policy if exists tv_alert_webhooks_select_own on public.tv_alert_webhooks;
create policy tv_alert_webhooks_select_own
  on public.tv_alert_webhooks
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.tv_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null check (char_length(symbol) between 1 and 32),
  name text not null check (char_length(name) between 1 and 120),
  price text null check (price is null or char_length(price) between 1 and 32),
  timeframe text null check (timeframe is null or char_length(timeframe) between 1 and 16),
  created_at timestamptz not null default now(),
  snapshot_path text null
);

create index if not exists tv_alerts_user_created_idx
  on public.tv_alerts (user_id, created_at desc);
create index if not exists tv_alerts_pending_snapshot_idx
  on public.tv_alerts (user_id, created_at desc)
  where snapshot_path is null;

alter table public.tv_alerts enable row level security;
revoke all on table public.tv_alerts from anon, authenticated;
grant select on table public.tv_alerts to authenticated;
grant select, insert, update, delete on table public.tv_alerts to service_role;

drop policy if exists tv_alerts_select_own on public.tv_alerts;
create policy tv_alerts_select_own
  on public.tv_alerts
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Instance-local memory is only a fast path. This service-only row keeps the
-- 30/min/token limit atomic across concurrent Vercel instances.
create table if not exists public.tv_alert_webhook_rate_limits (
  webhook_id uuid primary key references public.tv_alert_webhooks(id) on delete cascade,
  hits timestamptz[] not null default '{}'::timestamptz[],
  updated_at timestamptz not null default now()
);

alter table public.tv_alert_webhook_rate_limits enable row level security;
revoke all on table public.tv_alert_webhook_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.tv_alert_webhook_rate_limits to service_role;

create or replace function public.consume_tv_alert_webhook_rate_limit(target_webhook_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  recent_hits timestamptz[];
  observed_at timestamptz := clock_timestamp();
begin
  insert into public.tv_alert_webhook_rate_limits (webhook_id, hits, updated_at)
  values (target_webhook_id, '{}'::timestamptz[], observed_at)
  on conflict (webhook_id) do nothing;

  select hits into recent_hits
    from public.tv_alert_webhook_rate_limits
   where webhook_id = target_webhook_id
   for update;

  select coalesce(array_agg(hit order by hit), '{}'::timestamptz[])
    into recent_hits
    from unnest(recent_hits) as hit
   where hit > observed_at - interval '1 minute';

  if cardinality(recent_hits) >= 30 then
    update public.tv_alert_webhook_rate_limits
       set hits = recent_hits, updated_at = observed_at
     where webhook_id = target_webhook_id;
    return false;
  end if;

  update public.tv_alert_webhook_rate_limits
     set hits = array_append(recent_hits, observed_at), updated_at = observed_at
   where webhook_id = target_webhook_id;
  return true;
end;
$$;

revoke all on function public.consume_tv_alert_webhook_rate_limit(uuid) from public, anon, authenticated;
grant execute on function public.consume_tv_alert_webhook_rate_limit(uuid) to service_role;

-- Reuse the existing private copier-snapshots bucket and metadata table.
alter table public.copier_trade_snapshots
  drop constraint if exists copier_trade_snapshots_kind_check;
alter table public.copier_trade_snapshots
  add constraint copier_trade_snapshots_kind_check
  check (kind in ('entry', 'exit', 'sl-moved', 'tv-alert'));

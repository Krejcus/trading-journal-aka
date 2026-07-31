-- Tradecopia import baseline + integrity fixes.
--
-- The import tables already exist in production. CREATE IF NOT EXISTS keeps this
-- migration safe there while making a clean checkout reproducible.

begin;

create schema if not exists private;

create table if not exists public.import_tokens (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  token_hash text not null,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists public.imported_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source text not null default 'tradecopia',
  external_key text not null,
  account_ext_id bigint not null,
  account_name text,
  entity_id text,
  symbol text not null,
  qty integer not null,
  buy_price double precision not null,
  sell_price double precision not null,
  pnl double precision not null,
  bought_at timestamptz not null,
  sold_at timestamptz not null,
  entry_at timestamptz generated always as (least(bought_at, sold_at)) stored,
  exit_at timestamptz generated always as (greatest(bought_at, sold_at)) stored,
  duration text,
  platform text,
  direction text,
  entry_order_type text,
  tp_price double precision,
  sl_final double precision,
  sl_moves jsonb,
  group_key text,
  raw jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'matched', 'ambiguous', 'incident', 'ignored', 'linked', 'imported')),
  linked_trade_id uuid,
  match_score double precision,
  incident_ref text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, source, external_key)
);

create table if not exists public.imported_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source text not null default 'tradecopia',
  account_ext_id bigint not null,
  broker_order_id text not null,
  account_name text,
  entity_id text,
  symbol text,
  side text,
  order_type text,
  quantity integer,
  filled_qty integer,
  limit_price double precision,
  stop_price double precision,
  avg_fill_price double precision,
  status text,
  platform text,
  placed_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, source, account_ext_id, broker_order_id)
);

create table if not exists public.import_account_map (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source text not null default 'tradecopia',
  account_ext_id bigint not null,
  account_name text,
  entity_id text,
  mapped_account_id uuid references public.accounts(id) on delete set null,
  status text not null default 'new' check (status in ('new', 'mapped', 'ignored')),
  is_connected boolean not null default true,
  import_from_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, account_ext_id)
);

create index if not exists imported_trades_user_pending_entry_idx
  on public.imported_trades (user_id, entry_at desc)
  where status = 'pending';
create index if not exists imported_trades_linked_trade_idx
  on public.imported_trades (linked_trade_id)
  where linked_trade_id is not null;
create unique index if not exists imported_trades_one_match_per_trade_idx
  on public.imported_trades (user_id, linked_trade_id)
  where status = 'matched' and linked_trade_id is not null;
create index if not exists imported_orders_user_account_idx
  on public.imported_orders (user_id, account_ext_id, placed_at desc);
create index if not exists import_account_map_mapped_account_idx
  on public.import_account_map (mapped_account_id)
  where mapped_account_id is not null;
create index if not exists import_tokens_user_idx
  on public.import_tokens (user_id);

alter table public.import_tokens enable row level security;
alter table public.imported_trades enable row level security;
alter table public.imported_orders enable row level security;
alter table public.import_account_map enable row level security;

drop policy if exists import_tokens_owner_select on public.import_tokens;
create policy import_tokens_owner_select on public.import_tokens
  for select using ((select auth.uid()) = user_id);

drop policy if exists imported_trades_owner_select on public.imported_trades;
create policy imported_trades_owner_select on public.imported_trades
  for select using ((select auth.uid()) = user_id);

drop policy if exists imported_orders_owner_select on public.imported_orders;
create policy imported_orders_owner_select on public.imported_orders
  for select using ((select auth.uid()) = user_id);

drop policy if exists import_account_map_owner_all on public.import_account_map;
create policy import_account_map_owner_all on public.import_account_map
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.import_tokens from anon, authenticated;
grant select (user_id, label, last_used_at, created_at)
  on public.import_tokens to authenticated;
revoke all on public.imported_trades from anon, authenticated;
grant select on public.imported_trades to authenticated;
revoke all on public.imported_orders from anon, authenticated;
grant select on public.imported_orders to authenticated;
revoke all on public.import_account_map from anon, authenticated;
grant select, insert, update on public.import_account_map to authenticated;

do $migration$
begin
  if to_regprocedure('public.get_import_overview()') is null then
    execute $function$
      create function public.get_import_overview()
      returns table (
        account_ext_id bigint,
        account_name text,
        entity_id text,
        platform text,
        trade_count bigint,
        total_pnl numeric,
        first_trade timestamptz,
        last_trade timestamptz
      )
      language sql
      stable
      security invoker
      set search_path = ''
      as $body$
        select
          it.account_ext_id,
          max(it.account_name) as account_name,
          max(it.entity_id) as entity_id,
          max(it.platform) as platform,
          count(*)::bigint as trade_count,
          coalesce(sum(it.pnl), 0)::numeric as total_pnl,
          min(it.entry_at) as first_trade,
          max(it.exit_at) as last_trade
        from public.imported_trades it
        where it.user_id = (select auth.uid())
        group by it.account_ext_id
        order by max(it.exit_at) desc nulls last;
      $body$
    $function$;
  end if;
end
$migration$;

revoke all on function public.get_import_overview() from public, anon;
grant execute on function public.get_import_overview() to authenticated;

-- Atomic execution -> journal trade match. The privileged implementation lives
-- outside the exposed schema and validates auth.uid() on every affected row.
create or replace function private.apply_import_match(
  p_execution_id uuid,
  p_trade_id uuid,
  p_match_score numeric default null,
  p_duration_minutes integer default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_exec public.imported_trades%rowtype;
  v_trade public.trades%rowtype;
  v_entry numeric;
  v_exit numeric;
  v_data jsonb;
  v_estimated_pnl jsonb;
  v_estimated_exit jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_exec
  from public.imported_trades
  where id = p_execution_id and user_id = v_user_id
  for update;
  if not found then
    raise exception 'import execution not found' using errcode = 'P0002';
  end if;
  if v_exec.status not in ('pending', 'matched') then
    raise exception 'import execution is already resolved';
  end if;
  if v_exec.status = 'matched' and v_exec.linked_trade_id is distinct from p_trade_id then
    raise exception 'import execution is linked to another trade';
  end if;

  select * into v_trade
  from public.trades
  where id = p_trade_id and user_id = v_user_id
  for update;
  if not found then
    raise exception 'journal trade not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.imported_trades
    where user_id = v_user_id
      and linked_trade_id = p_trade_id
      and status = 'matched'
      and id <> p_execution_id
  ) then
    raise exception 'journal trade is already linked to another execution' using errcode = '23505';
  end if;

  if v_exec.direction = 'Short' then
    v_entry := v_exec.sell_price;
    v_exit := v_exec.buy_price;
  else
    v_entry := v_exec.buy_price;
    v_exit := v_exec.sell_price;
  end if;

  v_estimated_pnl := case
    when coalesce(v_trade.data, '{}'::jsonb) ? 'estimatedPnl' then v_trade.data -> 'estimatedPnl'
    when coalesce(v_trade.data, '{}'::jsonb) ? 'pnl' then v_trade.data -> 'pnl'
    else to_jsonb(v_trade.pnl)
  end;
  v_estimated_exit := case
    when coalesce(v_trade.data, '{}'::jsonb) ? 'estimatedExitPrice' then v_trade.data -> 'estimatedExitPrice'
    when coalesce(v_trade.data, '{}'::jsonb) ? 'exitPrice' then v_trade.data -> 'exitPrice'
    else 'null'::jsonb
  end;

  v_data := coalesce(v_trade.data, '{}'::jsonb) || jsonb_build_object(
    'entryPrice', v_entry,
    'exitPrice', v_exit,
    'pnl', v_exec.pnl,
    'pnlSource', 'tradecopia',
    'importExecutionId', v_exec.id,
    'estimatedPnl', v_estimated_pnl,
    'estimatedExitPrice', v_estimated_exit,
    'duration', v_exec.duration
  );
  if p_duration_minutes is not null then
    v_data := v_data || jsonb_build_object('durationMinutes', p_duration_minutes);
  end if;

  update public.trades
  set pnl = v_exec.pnl, data = v_data
  where id = p_trade_id and user_id = v_user_id;

  update public.imported_trades
  set status = 'matched',
      linked_trade_id = p_trade_id,
      match_score = p_match_score,
      incident_ref = null,
      resolved_at = now()
  where id = p_execution_id and user_id = v_user_id;

  return true;
end;
$$;

create or replace function public.apply_import_match(
  p_execution_id uuid,
  p_trade_id uuid,
  p_match_score numeric default null,
  p_duration_minutes integer default null
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select private.apply_import_match(p_execution_id, p_trade_id, p_match_score, p_duration_minutes);
$$;

-- Atomically creates a real DailyReview incident and resolves its staging rows.
create or replace function private.assign_import_incident(
  p_execution_ids uuid[],
  p_title text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_requested_count integer;
  v_found_count integer;
  v_date text;
  v_timestamp bigint;
  v_incident_id text := 'import-incident-' || gen_random_uuid()::text;
  v_title text := coalesce(nullif(btrim(p_title), ''), 'Tradecopia incident');
  v_allocations jsonb := '[]'::jsonb;
  v_incident jsonb;
  v_review jsonb;
  v_row record;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  v_requested_count := cardinality(array(select distinct unnest(p_execution_ids)));
  if coalesce(v_requested_count, 0) = 0 then
    raise exception 'no executions selected';
  end if;

  perform 1
  from public.imported_trades
  where user_id = v_user_id and id = any(p_execution_ids)
  for update;

  select count(*),
         min((entry_at at time zone 'Europe/Prague')::date)::text,
         (extract(epoch from min(entry_at)) * 1000)::bigint
  into v_found_count, v_date, v_timestamp
  from public.imported_trades
  where user_id = v_user_id
    and id = any(p_execution_ids)
    and status = 'pending';

  if v_found_count <> v_requested_count then
    raise exception 'some import executions are missing or already resolved';
  end if;

  if exists (
    select 1
    from public.imported_trades it
    left join public.import_account_map m
      on m.user_id = it.user_id
     and m.source = it.source
     and m.account_ext_id = it.account_ext_id
    where it.user_id = v_user_id
      and it.id = any(p_execution_ids)
      and (m.mapped_account_id is null or m.status = 'ignored')
  ) then
    raise exception 'all incident executions must have an active account mapping';
  end if;

  for v_row in
    select m.mapped_account_id as account_id,
           coalesce(a.name, max(it.account_name), m.mapped_account_id::text) as account_name,
           sum(it.pnl)::numeric as net_pnl
    from public.imported_trades it
    join public.import_account_map m
      on m.user_id = it.user_id
     and m.source = it.source
     and m.account_ext_id = it.account_ext_id
     and m.mapped_account_id is not null
    left join public.accounts a
      on a.id = m.mapped_account_id and a.user_id = v_user_id
    where it.user_id = v_user_id and it.id = any(p_execution_ids)
    group by m.mapped_account_id, a.name
  loop
    if v_row.net_pnl >= 0 then
      raise exception 'incident selection must be net-negative on every account';
    end if;
    v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'scopeType', 'account',
      'scopeId', v_row.account_id,
      'label', v_row.account_name,
      'lossAmount', abs(v_row.net_pnl),
      'currency', 'USD'
    ));
  end loop;

  if jsonb_array_length(v_allocations) = 0 then
    raise exception 'incident has no account allocations';
  end if;

  v_incident := jsonb_build_object(
    'id', v_incident_id,
    'timestamp', v_timestamp,
    'type', 'gambling',
    'title', v_title,
    'whatHappened', format('Importováno z Tradecopie: %s exekucí bez odpovídajícího záznamu v deníku.', v_found_count),
    'allocations', v_allocations
  );

  insert into public.daily_reviews (user_id, date, data)
  values (
    v_user_id,
    v_date,
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'date', v_date,
      'mainTakeaway', '',
      'mistakes', '[]'::jsonb,
      'lessons', '',
      'rating', 0,
      'incidents', jsonb_build_array(v_incident)
    )
  )
  on conflict (user_id, date) do update
  set data = jsonb_set(
    coalesce(daily_reviews.data, '{}'::jsonb),
    '{incidents}',
    coalesce(daily_reviews.data -> 'incidents', '[]'::jsonb) || jsonb_build_array(v_incident),
    true
  )
  returning data into v_review;

  update public.imported_trades
  set status = 'incident', incident_ref = v_incident_id, linked_trade_id = null, resolved_at = now()
  where user_id = v_user_id and id = any(p_execution_ids);

  return v_review;
end;
$$;

create or replace function public.assign_import_incident(
  p_execution_ids uuid[],
  p_title text default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.assign_import_incident(p_execution_ids, p_title);
$$;

create or replace function private.ignore_import_executions(p_execution_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  update public.imported_trades
  set status = 'ignored', resolved_at = now()
  where user_id = v_user_id and id = any(p_execution_ids) and status = 'pending';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.ignore_import_executions(p_execution_ids uuid[])
returns integer
language sql
security invoker
set search_path = ''
as $$
  select private.ignore_import_executions(p_execution_ids);
$$;

revoke all on function private.apply_import_match(uuid, uuid, numeric, integer) from public;
revoke all on function private.assign_import_incident(uuid[], text) from public;
revoke all on function private.ignore_import_executions(uuid[]) from public;
grant usage on schema private to authenticated;
grant execute on function private.apply_import_match(uuid, uuid, numeric, integer) to authenticated;
grant execute on function private.assign_import_incident(uuid[], text) to authenticated;
grant execute on function private.ignore_import_executions(uuid[]) to authenticated;

revoke all on function public.apply_import_match(uuid, uuid, numeric, integer) from public, anon;
revoke all on function public.assign_import_incident(uuid[], text) from public, anon;
revoke all on function public.ignore_import_executions(uuid[]) from public, anon;
grant execute on function public.apply_import_match(uuid, uuid, numeric, integer) to authenticated;
grant execute on function public.assign_import_incident(uuid[], text) to authenticated;
grant execute on function public.ignore_import_executions(uuid[]) to authenticated;

commit;

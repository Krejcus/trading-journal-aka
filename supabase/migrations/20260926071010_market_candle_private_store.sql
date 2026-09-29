-- Private, server-only market data cache. Activation requires a separate remote
-- backup/export and approval; this migration is intentionally not deployed here.
create schema if not exists alphatrade_private;

create table if not exists alphatrade_private.market_candle_periods (
  schema_name text not null check (schema_name in ('ohlcv-1m', 'ohlcv-1h')),
  symbol text not null check (symbol ~ '^(MNQ|NQ)([HMUZ][0-9]{1,2}|\.(c|n|v)\.[0-9]+)$'),
  period_start timestamptz not null,
  period_end timestamptz not null,
  state text not null check (state in ('fetching', 'ready', 'failed')),
  lease_token uuid,
  lease_until timestamptz,
  object_path text,
  source_symbol text,
  record_count integer check (record_count is null or record_count >= 0),
  content_sha256 text,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (schema_name, symbol, period_start),
  check (period_end > period_start),
  check (state <> 'ready' or (object_path is not null and content_sha256 is not null and record_count is not null))
);

alter table alphatrade_private.market_candle_periods enable row level security;
revoke all on alphatrade_private.market_candle_periods from public, anon, authenticated;
grant usage on schema alphatrade_private to service_role;
grant select, insert, update on alphatrade_private.market_candle_periods to service_role;

-- No authenticated SELECT policy: only the Edge Function's service-role client
-- reads objects. Public URLs and direct user access are deliberately absent.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('market-candles-private', 'market-candles-private', false, 4194304, array['application/gzip'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Restrictive policy also blocks any broad legacy authenticated Storage policy.
create policy market_candles_private_service_only on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'market-candles-private')
  with check (bucket_id <> 'market-candles-private');

create or replace function public.market_candle_claim_period_v1(
  p_schema text, p_symbol text, p_start timestamptz, p_end timestamptz,
  p_token uuid, p_lease_seconds integer default 180
) returns table(state text, lease_token uuid, lease_until timestamptz,
  object_path text, content_sha256 text, record_count integer, source_symbol text,
  acquired boolean)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_schema not in ('ohlcv-1m', 'ohlcv-1h')
    or p_symbol !~ '^(MNQ|NQ)([HMUZ][0-9]{1,2}|\.(c|n|v)\.[0-9]+)$'
    or p_start is null or p_end is null or p_end <= p_start
    or p_token is null or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'invalid-market-candle-period' using errcode = '22023';
  end if;

  insert into alphatrade_private.market_candle_periods as cached
    (schema_name, symbol, period_start, period_end, state, lease_token, lease_until)
  values (p_schema, p_symbol, p_start, p_end, 'fetching', p_token,
    clock_timestamp() + make_interval(secs => p_lease_seconds))
  on conflict (schema_name, symbol, period_start) do update
    set state = 'fetching', lease_token = excluded.lease_token,
      lease_until = excluded.lease_until, period_end = excluded.period_end,
      object_path = null, source_symbol = null, record_count = null,
      content_sha256 = null, last_error = null, updated_at = clock_timestamp()
    where cached.state <> 'ready' and cached.lease_until <= clock_timestamp();

  return query select cached.state, cached.lease_token, cached.lease_until,
    cached.object_path, cached.content_sha256, cached.record_count,
    cached.source_symbol, cached.state = 'fetching' and cached.lease_token = p_token
    from alphatrade_private.market_candle_periods cached
    where cached.schema_name = p_schema and cached.symbol = p_symbol
      and cached.period_start = p_start and cached.period_end = p_end;
end; $$;

create or replace function public.market_candle_complete_period_v1(
  p_schema text, p_symbol text, p_start timestamptz, p_token uuid,
  p_object_path text, p_sha256 text, p_record_count integer, p_source_symbol text
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_token is null or p_object_path is null or length(p_object_path) not between 1 and 300
    or p_sha256 is null or p_sha256 !~ '^[a-f0-9]{64}$'
    or p_record_count is null or p_record_count < 0 then
    raise exception 'invalid-market-candle-completion' using errcode = '22023';
  end if;
  update alphatrade_private.market_candle_periods cached
    set state = 'ready', object_path = p_object_path, content_sha256 = p_sha256,
      record_count = p_record_count, source_symbol = p_source_symbol,
      lease_token = null, lease_until = null, last_error = null,
      updated_at = clock_timestamp()
    where cached.schema_name = p_schema and cached.symbol = p_symbol
      and cached.period_start = p_start and cached.state = 'fetching'
      and cached.lease_token = p_token and cached.lease_until > clock_timestamp();
  return found;
end; $$;

create or replace function public.market_candle_fail_period_v1(
  p_schema text, p_symbol text, p_start timestamptz, p_token uuid, p_reason text
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update alphatrade_private.market_candle_periods cached
    set state = 'failed', lease_token = null,
      lease_until = clock_timestamp() + interval '30 seconds',
      last_error = left(coalesce(p_reason, 'unknown'), 160),
      updated_at = clock_timestamp()
    where cached.schema_name = p_schema and cached.symbol = p_symbol
      and cached.period_start = p_start and cached.state = 'fetching'
      and cached.lease_token = p_token;
  return found;
end; $$;

revoke all on function public.market_candle_claim_period_v1(text,text,timestamptz,timestamptz,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.market_candle_complete_period_v1(text,text,timestamptz,uuid,text,text,integer,text)
  from public, anon, authenticated;
revoke all on function public.market_candle_fail_period_v1(text,text,timestamptz,uuid,text)
  from public, anon, authenticated;
grant execute on function public.market_candle_claim_period_v1(text,text,timestamptz,timestamptz,uuid,integer)
  to service_role;
grant execute on function public.market_candle_complete_period_v1(text,text,timestamptz,uuid,text,text,integer,text)
  to service_role;
grant execute on function public.market_candle_fail_period_v1(text,text,timestamptz,uuid,text)
  to service_role;

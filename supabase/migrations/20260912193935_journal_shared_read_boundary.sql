-- Local draft; activate only together with the RPC client after an approved backup.
-- A restrictive policy composes with the actual production "Trades visibility"
-- and any legacy permissive policy. Public links retain their narrow existing RPC.
alter table public.trades enable row level security;
create policy journal_root_owner_only on public.trades as restrictive
  for select to anon, authenticated using (
    (select auth.uid())=user_id or (
      journal_projection_status is null
      and coalesce(data->>'copierTradeId','') not like 'journal:%'
    )
  );

create schema if not exists journal_private;
revoke all on schema journal_private from public, anon;
grant usage on schema journal_private to authenticated;

-- Definer is required here: clients cannot read another owner's raw journal
-- rows. The only output is the allowlisted projection below, with authorization
-- derived from auth.uid() and receiver-owned connection consent on every call.
create function journal_private.read_shared_trades_v1(
  p_owner_ids uuid[], p_group_id text default null, p_after_id uuid default null,
  p_limit integer default 250, p_recent boolean default false
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare viewer uuid := auth.uid(); result jsonb;
begin
  if viewer is null then raise exception 'authentication-required' using errcode='42501'; end if;
  if p_owner_ids is null or cardinality(p_owner_ids) not between 1 and 50
     or array_position(p_owner_ids,null) is not null
     or p_limit is null or p_limit not between 1 and 1000
     or p_recent is null or (p_recent and p_after_id is not null)
     or (p_group_id is not null and (cardinality(p_owner_ids)<>1 or length(p_group_id) not between 1 and 2048)) then
    raise exception 'invalid-shared-trade-scope' using errcode='22023';
  end if;
  with owners as (
    select distinct unnest(p_owner_ids) owner_id
  ), consents as (
    select o.owner_id,
      case when o.owner_id=viewer then '{"pnlFormat":"usd","canSeeScreenshots":true}'::jsonb
      else (select (jsonb_agg(c.permissions)->0) from public.connections c
        where c.sender_id=viewer and c.receiver_id=o.owner_id and c.status='accepted' having count(*)=1) end as permissions
    from owners o
  ), scopes as (
    select owner_id, permissions,
      case when permissions->>'pnlFormat' in ('usd','rr','hidden') then permissions->>'pnlFormat'
        when not (permissions ? 'pnlFormat') and permissions->'canSeePnl'='true'::jsonb then 'usd' else 'hidden' end as unit
    from consents where jsonb_typeof(permissions)='object'
  ), eligible as not materialized (
    select t.*, s.unit, s.permissions,
      case when coalesce(t.data->>'copierTradeId','') not like 'journal:%'
        and jsonb_typeof(t.data->'riskAmount')='number' and (t.data->>'riskAmount')::numeric>0
        then (t.data->>'riskAmount')::numeric end as initial_risk
    from public.trades t join scopes s on s.owner_id=t.user_id
    where not (t.data ? 'journalSupersededBy') and (
      (t.journal_projection_status='confirmed' and coalesce(t.data->>'copierTradeId','') like 'journal:%')
      or (t.journal_projection_status is null and coalesce(t.data->>'copierTradeId','') not like 'journal:%'
        and not coalesce(t.data->>'source'='copier',false)))
      and (p_after_id is null or t.id>p_after_id)
      and (p_group_id is null or t.data->>'groupId'=p_group_id)
      and (t.user_id=viewer or not (s.permissions ? 'allowedAccountIds') or s.permissions->'allowedAccountIds'='[]'::jsonb
        or (jsonb_typeof(s.permissions->'allowedAccountIds')='array' and s.permissions->'allowedAccountIds' ? t.account_id::text))
  ), page as (
    select * from eligible order by case when p_recent then timestamp end desc nulls last, id asc limit p_limit
  ), projected as (
    select t.id,t.timestamp,
      jsonb_build_object('id',t.id,'user_id',t.user_id,'account_id',t.account_id,
        'account_name',(select a.name from public.accounts a where a.id=t.account_id and a.user_id=t.user_id),
        'instrument',t.instrument,'direction',t.direction,'date',t.date,'timestamp',t.timestamp,'pnl_format',t.unit,
        'pnl',case when t.pnl::text not in ('NaN','Infinity','-Infinity') then
          case when t.unit='usd' then t.pnl when t.unit='rr' and t.initial_risk>0 then t.pnl/t.initial_risk end end,
        'data',
          coalesce((select jsonb_object_agg(e.key,e.value) from jsonb_each(case when jsonb_typeof(t.data)='object' then t.data else '{}'::jsonb end) e
            where e.key in ('groupId','isMaster','signal','setupType','duration','durationMinutes','entryTime','entryDate','exitDate','executionStatus')
              and jsonb_typeof(e.value) in ('string','number','boolean')), '{}'::jsonb)
          || case when coalesce(t.data->>'copierTradeId','') like 'journal:%' then '{"copierTradeId":"journal:shared"}'::jsonb else '{}'::jsonb end
          || case when t.unit='usd' then
            coalesce((select jsonb_object_agg(e.key,e.value) from jsonb_each(t.data) e
              where e.key in ('entryPrice','exitPrice','stopLoss','takeProfit','positionSize') and jsonb_typeof(e.value)='number'), '{}'::jsonb)
            || jsonb_strip_nulls(jsonb_build_object('riskAmount',t.initial_risk))
            when t.unit='rr' and t.initial_risk>0 then '{"riskAmount":1}'::jsonb else '{}'::jsonb end
          || case when t.permissions->'canSeeScreenshots'='true'::jsonb then
            (case when jsonb_typeof(t.data->'screenshot')='string' then jsonb_build_object('screenshot',t.data->'screenshot') else '{}'::jsonb end)
            || jsonb_build_object('screenshots',coalesce((select jsonb_agg(value) from jsonb_array_elements(
              case when jsonb_typeof(t.data->'screenshots')='array' then t.data->'screenshots' else '[]'::jsonb end) where jsonb_typeof(value)='string'), '[]'::jsonb))
            else '{}'::jsonb end
      ) as row
    from page t
  ) select jsonb_build_object('rows',coalesce((select jsonb_agg(row order by case when p_recent then timestamp end desc nulls last,id) from projected),'[]'::jsonb),
    'count',(select count(*) from eligible)) into result;
  if octet_length(result::text)>8*1024*1024 then raise exception 'shared-trade-response-too-large' using errcode='54000'; end if;
  return result;
end; $$;
revoke all on function journal_private.read_shared_trades_v1(uuid[],text,uuid,integer,boolean) from public,anon;
grant execute on function journal_private.read_shared_trades_v1(uuid[],text,uuid,integer,boolean) to authenticated;

create function public.read_shared_trades_v1(
  p_owner_ids uuid[], p_group_id text default null, p_after_id uuid default null,
  p_limit integer default 250, p_recent boolean default false
) returns jsonb language sql stable security invoker set search_path='' as $$
  select journal_private.read_shared_trades_v1(p_owner_ids,p_group_id,p_after_id,p_limit,p_recent);
$$;
revoke all on function public.read_shared_trades_v1(uuid[],text,uuid,integer,boolean) from public,anon;
grant execute on function public.read_shared_trades_v1(uuid[],text,uuid,integer,boolean) to authenticated;

create index journal_shared_group_read_idx on public.trades (user_id,(data->>'groupId'),id)
  where journal_projection_status='confirmed';

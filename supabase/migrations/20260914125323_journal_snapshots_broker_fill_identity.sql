-- connection_id on the copier ledger identifies the relay device, which can
-- carry a Lucid leader through a Tradeify connection. Resolve media ownership
-- from the exact broker fill in the completed journal instead. Never use the
-- current group, follower count, a nearby timestamp, or a relay account as proof.
create or replace view public.journal_trade_snapshots with (security_invoker=true) as
with candidates as (
  select distinct j.user_id,j.trade_id,j.connection_id,j.journal_account_id,
    l.trade_id as fill_id,l.episode_id
  from public.tradovate_journal_positions j
  join public.trades t on t.user_id=j.user_id and t.id=j.trade_id and t.account_id=j.journal_account_id
  join public.tradovate_journal_projection_heads h on h.user_id=j.user_id and h.connection_id=j.connection_id
    and h.revision=j.revision and h.completed_revision=h.revision
  cross join lateral (
    select min(f->>'id') as fill_id,count(*) as matches,
      bool_and(f->'accountId'=to_jsonb(j.external_account_id)) as owned
    from jsonb_array_elements(case when jsonb_typeof(j.history->'fills')='array' then j.history->'fills' else '[]'::jsonb end) f
    where f->>'role'='exit' and f->'at'=j.history#>'{position,closedAt}'
  ) final_fill
  join public.tradovate_copier_trades l on l.user_id=j.user_id
    and l.trade_id=final_fill.fill_id and final_fill.matches=1 and final_fill.owned
    and j.history#>'{position,closedAt}'=to_jsonb((extract(epoch from l.closed_at)*1000)::bigint)
    and (l.opened_at is null or j.history#>'{position,openedAt}'=to_jsonb((extract(epoch from l.opened_at)*1000)::bigint))
    and upper(j.facts->>'instrument')=regexp_replace(upper(l.symbol),'[FGHJKMNQUVXZ][0-9]{1,2}$','')
    and j.facts->>'direction'=l.side
  where j.status='confirmed' and j.history#>>'{position,status}'='closed'
    and j.history->>'environment'='demo'
    and j.history->>'connectionId'=j.connection_id::text
    and j.history->'accountId'=to_jsonb(j.external_account_id)
    and l.episode_id is not null
    and not exists(select 1 from public.tradovate_copier_trades conflict
      where conflict.user_id=l.user_id and conflict.trade_id=l.trade_id
        and conflict.episode_id is not null and conflict.episode_id<>l.episode_id)
    and not exists(select 1 from public.tradovate_copier_trades other
      where other.user_id=l.user_id and other.episode_id=l.episode_id and other.trade_id<>l.trade_id)
), unambiguous as (
  select candidates.*,
    count(*) over (partition by user_id,fill_id) as fill_matches,
    count(*) over (partition by user_id,episode_id) as episode_matches
  from candidates
)
select (j.trade_id::text || ':' || s.id::text) collate "C" as page_key,
  j.user_id,j.trade_id,j.connection_id,j.journal_account_id,
  s.id as snapshot_id,s.episode_id,s.kind,s.at,s.storage_path
from unambiguous j
join public.copier_trade_snapshots s on s.user_id=j.user_id and s.episode_id=j.episode_id
where j.fill_matches=1 and j.episode_matches=1 and s.kind in ('entry','exit','sl-moved');

comment on view public.journal_trade_snapshots is
  'Owner-only screenshot links proven by a unique exact broker close fill; copier ledger connection_id is relay provenance, not broker account ownership.';

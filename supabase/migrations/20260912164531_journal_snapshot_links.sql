-- Read-only linkage: exact final broker fill -> copier episode -> private media.
-- Current copier membership and account multipliers never participate.
create index if not exists tradovate_copier_trades_journal_fill_idx on public.tradovate_copier_trades(user_id,connection_id,trade_id);
create index if not exists tradovate_copier_trades_journal_episode_idx on public.tradovate_copier_trades(user_id,episode_id);
create view public.journal_trade_snapshots with (security_invoker=true) as
select (j.trade_id::text || ':' || s.id::text) collate "C" as page_key,
  j.user_id,j.trade_id,j.connection_id,j.journal_account_id,
  s.id as snapshot_id,s.episode_id,s.kind,s.at,s.storage_path
from public.tradovate_journal_positions j
join public.trades t on t.user_id=j.user_id and t.id=j.trade_id and t.account_id=j.journal_account_id
join public.tradovate_journal_projection_heads h on h.user_id=j.user_id and h.connection_id=j.connection_id
  and h.revision=j.revision and h.completed_revision=h.revision
cross join lateral (
  select min(f->>'id') as fill_id,count(*) as matches
  from jsonb_array_elements(case when jsonb_typeof(j.history->'fills')='array' then j.history->'fills' else '[]'::jsonb end) f
  where f->>'role'='exit' and f->'at'=j.history#>'{position,closedAt}'
) final_fill
join (select distinct user_id,connection_id,trade_id,episode_id from public.tradovate_copier_trades where episode_id is not null) l on l.user_id=j.user_id and l.connection_id=j.connection_id
  and l.trade_id=final_fill.fill_id and final_fill.matches=1
join public.copier_trade_snapshots s on s.user_id=l.user_id and s.episode_id=l.episode_id
where j.status='confirmed' and j.history#>>'{position,status}'='closed'
  and s.kind in ('entry','exit','sl-moved')
  and not exists(select 1 from public.tradovate_copier_trades conflict
    where conflict.user_id=l.user_id and conflict.connection_id=l.connection_id and conflict.trade_id=l.trade_id
      and conflict.episode_id is not null and conflict.episode_id<>l.episode_id)
  and not exists(select 1 from public.tradovate_copier_trades other
    where other.user_id=l.user_id and other.episode_id=l.episode_id
      and (other.connection_id is distinct from l.connection_id or other.trade_id<>l.trade_id));
revoke all on public.journal_trade_snapshots from public,anon,authenticated;
grant select on public.journal_trade_snapshots to authenticated,service_role;

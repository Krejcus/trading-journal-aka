-- Screenshots belong to the leader's episode. Follower trades are separate
-- broker fills, so the exact-fill identity of 20260914125323 can never reach
-- them. Their journal history already records which leader ORDER their entry
-- copied (`facts.groupId = execution:<env>:<leaderConnection>:<leaderOrderId>`,
-- derived from the worker's copylink evidence). The ledger now stores the
-- leader's entry order ids per episode, so a follower links through
--   follower entry fill -> follower entry order -> copylink -> leader entry order -> episode -> images
-- without a nearby-timestamp, symbol or P&L guess. Ambiguity fails closed.

alter table public.tradovate_copier_trades
  add column if not exists leader_entry_order_ids text[];

comment on column public.tradovate_copier_trades.leader_entry_order_ids is
  'Broker order ids of the leader entry fills of this episode; the only key used to link follower journal trades to episode screenshots.';

-- One-off backfill for episodes closed before the worker reported the key.
-- Three proofs, strongest first; each fills only rows still without a key and
-- only when it yields exactly one candidate set.
--
-- 1. The leader's own confirmed journal position, identified by the exact
--    final broker fill (the same rule the view uses): its entry fill orders.
with scope as (
  select l.user_id, l.device_id, l.trade_id, l.closed_at
  from public.tradovate_copier_trades l
  where l.leader_entry_order_ids is null and l.opened_at is not null and l.episode_id is not null
    and l.closed_at >= timestamptz '2026-09-12'
), leader_positions as (
  select s.user_id, s.device_id, s.trade_id,
    (select array_agg(distinct f->>'orderId') from jsonb_array_elements(j.history->'fills') f
      where f->>'role' = 'entry' and f->>'orderId' ~ '^[0-9]{1,32}$') as orders
  from scope s
  join public.tradovate_journal_positions j on j.user_id = s.user_id and j.status = 'confirmed'
    and j.history#>>'{position,status}' = 'closed'
    and j.history#>'{position,closedAt}' = to_jsonb((extract(epoch from s.closed_at)*1000)::bigint)
    and (select count(*) from jsonb_array_elements(j.history->'fills') f
      where f->>'role' = 'exit' and f->>'id' = s.trade_id and f->'accountId' = to_jsonb(j.external_account_id)) = 1
), resolved as (
  select user_id, device_id, trade_id, min(orders) as orders
  from leader_positions
  where orders is not null and array_length(orders, 1) >= 1
  group by user_id, device_id, trade_id
  having count(*) = 1
)
update public.tradovate_copier_trades l
set leader_entry_order_ids = r.orders
from resolved r
where r.user_id = l.user_id and r.device_id = l.device_id and r.trade_id = l.trade_id
  and l.leader_entry_order_ids is null;

-- 2. The leader entry fill in raw evidence: exact broker fill timestamp the
--    worker copied into opened_at, on the leader side of the copy, and the
--    leader's own copylink root (leaderOrderId = orderId). Copies of the same
--    entry can carry the identical millisecond, so the root is what separates
--    the leader from its followers.
with scope as (
  select l.user_id, l.device_id, l.trade_id, l.opened_at, l.closed_at, l.side
  from public.tradovate_copier_trades l
  where l.leader_entry_order_ids is null and l.opened_at is not null and l.episode_id is not null
    and l.closed_at >= timestamptz '2026-09-12'
), leader_fills as (
  select s.user_id, s.device_id, s.trade_id, e.evidence->'entity'->>'orderId' as order_id
  from scope s
  join public.tradovate_journal_projection_heads h on h.user_id = s.user_id
  join public.tradovate_journal_evidence e on e.user_id = h.user_id and e.connection_id = h.connection_id
    and e.entity_type = 'fill'
    and e.received_at >= s.opened_at - interval '1 second' and e.received_at < s.opened_at + interval '10 minutes'
    and (e.evidence->'entity'->>'timestamp')::timestamptz = s.opened_at
    and e.evidence->'entity'->>'action' = case s.side when 'Long' then 'Buy' else 'Sell' end
  where exists (
    select 1 from public.tradovate_journal_evidence c
    where c.user_id = h.user_id and c.connection_id = h.connection_id and c.entity_type = 'copylink'
      and c.received_at >= s.opened_at - interval '1 second' and c.received_at < s.closed_at + interval '10 minutes'
      and c.evidence->'entity'->>'role' = 'entry'
      and c.evidence->'entity'->>'leaderOrderId' = e.evidence->'entity'->>'orderId'
      and c.evidence->'entity'->>'orderId' = e.evidence->'entity'->>'orderId'
  )
), resolved as (
  select user_id, device_id, trade_id, array_agg(distinct order_id) as order_ids
  from leader_fills
  where order_id ~ '^[0-9]{1,32}$'
  group by user_id, device_id, trade_id
  having count(distinct order_id) = 1
)
update public.tradovate_copier_trades l
set leader_entry_order_ids = r.order_ids
from resolved r
where r.user_id = l.user_id and r.device_id = l.device_id and r.trade_id = l.trade_id
  and l.leader_entry_order_ids is null;

-- 3. Confirmed follower positions whose copied leader order is unique across
--    every follower that entered this instrument/direction while the episode
--    was open. The copy identity comes from the follower connection's own
--    copylink evidence; the episode window only decides which flat->flat
--    episode the order belongs to (a leader holds one episode per instrument
--    at a time). A 2 s tolerance covers copies stamped in the same broker
--    batch as the leader fill.
with scope as (
  select l.user_id, l.device_id, l.trade_id, l.opened_at, l.closed_at, l.side, l.symbol
  from public.tradovate_copier_trades l
  where l.leader_entry_order_ids is null and l.opened_at is not null and l.episode_id is not null
    and l.closed_at >= timestamptz '2026-09-12'
), follower_orders as (
  select s.user_id, s.device_id, s.trade_id, split_part(j.facts->>'groupId', ':', 4) as order_id
  from scope s
  join public.tradovate_journal_positions j on j.user_id = s.user_id
    and j.status = 'confirmed' and j.facts->'isMaster' = 'false'::jsonb
    and j.facts->>'groupId' like 'execution:demo:%'
    and split_part(j.facts->>'groupId', ':', 4) ~ '^[0-9]{1,32}$' and split_part(j.facts->>'groupId', ':', 5) = ''
    and (j.history#>>'{position,openedAt}')::numeric
      between (extract(epoch from s.opened_at)*1000)::bigint - 2000 and (extract(epoch from s.closed_at)*1000)::bigint + 2000
    and upper(j.facts->>'instrument') = regexp_replace(upper(s.symbol), '[FGHJKMNQUVXZ][0-9]{1,2}$', '')
    and j.facts->>'direction' = s.side
), resolved as (
  select user_id, device_id, trade_id, array_agg(distinct order_id) as order_ids
  from follower_orders
  group by user_id, device_id, trade_id
  having count(distinct order_id) = 1
)
update public.tradovate_copier_trades l
set leader_entry_order_ids = r.order_ids
from resolved r
where r.user_id = l.user_id and r.device_id = l.device_id and r.trade_id = l.trade_id
  and l.leader_entry_order_ids is null
  -- the order must not already belong to another episode of this owner
  and not exists (select 1 from public.tradovate_copier_trades o
    where o.user_id = l.user_id and o.episode_id is not null and o.episode_id <> l.episode_id
      and o.leader_entry_order_ids && r.order_ids);

create or replace view public.journal_trade_snapshots with (security_invoker=true) as
with confirmed as (
  select j.user_id, j.trade_id, j.connection_id, j.journal_account_id, j.external_account_id, j.history, j.facts
  from public.tradovate_journal_positions j
  join public.trades t on t.user_id=j.user_id and t.id=j.trade_id and t.account_id=j.journal_account_id
  join public.tradovate_journal_projection_heads h on h.user_id=j.user_id and h.connection_id=j.connection_id
    and h.revision=j.revision and h.completed_revision=h.revision
  where j.status='confirmed' and j.history#>>'{position,status}'='closed'
    and j.history->>'environment'='demo'
    and j.history->>'connectionId'=j.connection_id::text
    and j.history->'accountId'=to_jsonb(j.external_account_id)
), fill_candidates as (
  -- Leader card: the unique confirmed final broker fill is the ledger key.
  select distinct j.user_id,j.trade_id,j.connection_id,j.journal_account_id,
    l.trade_id as fill_id,l.episode_id
  from confirmed j
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
  where l.episode_id is not null
    and not exists(select 1 from public.tradovate_copier_trades conflict
      where conflict.user_id=l.user_id and conflict.trade_id=l.trade_id
        and conflict.episode_id is not null and conflict.episode_id<>l.episode_id)
    and not exists(select 1 from public.tradovate_copier_trades other
      where other.user_id=l.user_id and other.episode_id=l.episode_id and other.trade_id<>l.trade_id)
), fill_unambiguous as (
  select fill_candidates.*,
    count(*) over (partition by user_id,fill_id) as fill_matches,
    count(*) over (partition by user_id,episode_id) as episode_matches
  from fill_candidates
), follower_candidates as (
  -- Follower card: its entry copied exactly one leader order that belongs to
  -- exactly one ledger episode and entered while that episode was open (2 s
  -- tolerance for copies stamped in the leader fill's broker batch).
  select distinct j.user_id,j.trade_id,j.connection_id,j.journal_account_id,
    l.trade_id as fill_id,l.episode_id
  from confirmed j
  join public.tradovate_copier_trades l on l.user_id=j.user_id
    and l.leader_entry_order_ids is not null and l.episode_id is not null and l.opened_at is not null
    and split_part(j.facts->>'groupId',':',4) = any(l.leader_entry_order_ids)
    and upper(j.facts->>'instrument')=regexp_replace(upper(l.symbol),'[FGHJKMNQUVXZ][0-9]{1,2}$','')
    and j.facts->>'direction'=l.side
    and (j.history#>>'{position,openedAt}')::numeric >= (extract(epoch from l.opened_at)*1000)::bigint - 2000
    and (j.history#>>'{position,openedAt}')::numeric <= (extract(epoch from l.closed_at)*1000)::bigint + 2000
  where j.facts->'isMaster'='false'::jsonb
    and j.facts->>'groupId' like 'execution:demo:%'
    and split_part(j.facts->>'groupId',':',3)<>'' and split_part(j.facts->>'groupId',':',4) ~ '^[0-9]{1,32}$'
    and split_part(j.facts->>'groupId',':',5)=''
    and not exists(select 1 from public.tradovate_copier_trades other
      where other.user_id=l.user_id and other.episode_id is not null and other.episode_id<>l.episode_id
        and split_part(j.facts->>'groupId',':',4) = any(other.leader_entry_order_ids))
    and not exists(select 1 from public.tradovate_copier_trades other
      where other.user_id=l.user_id and other.episode_id=l.episode_id and other.trade_id<>l.trade_id)
), linked as (
  select user_id,trade_id,connection_id,journal_account_id,episode_id
  from fill_unambiguous where fill_matches=1 and episode_matches=1
  union
  select user_id,trade_id,connection_id,journal_account_id,episode_id
  from follower_candidates
)
select (j.trade_id::text || ':' || s.id::text) collate "C" as page_key,
  j.user_id,j.trade_id,j.connection_id,j.journal_account_id,
  s.id as snapshot_id,s.episode_id,s.kind,s.at,s.storage_path
from linked j
join public.copier_trade_snapshots s on s.user_id=j.user_id and s.episode_id=j.episode_id
where s.kind in ('entry','exit','sl-moved');

comment on view public.journal_trade_snapshots is
  'Owner-only screenshot links: leader cards by the unique exact broker close fill, follower cards by the exact copied leader entry order; never by nearby time, symbol or P&L.';

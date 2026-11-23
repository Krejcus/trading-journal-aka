-- Zmrazení obchodů z Tradovate importu před odstraněním Tradovate (23. 11. 2026).
--
-- Deník dosud bral u obchodů `journal:*` čísla, historii fillů a vazby
-- screenshotů za běhu z tradovate_journal_positions / journal_trade_snapshots.
-- Čísla už jsou v trades (ověřeno: všech 18 povolených polí faktů je u 1 550
-- potvrzených obchodů identických). Tato migrace přenese zbytek:
--   1. historii fillů do soukromé tabulky trade_execution_history (jen vlastník,
--      nikdy do trades.data, které se sdílí ve veřejných pohledech),
--   2. vazby screenshotů do trades.data.copierSnapshots / copierEpisodeId
--      (stejný tvar jako u starších obchodů kopírky; soubory zůstávají v bucketu
--      copier-snapshots),
--   3. značku journalFrozenAt.
-- Nic nemaže. Stará appka funguje dál (Tradovate tabulky zůstávají do DROP
-- migrace); nová appka čte už jen trades + trade_execution_history.

create table public.trade_execution_history (
  trade_id uuid primary key references public.trades(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  history jsonb not null check (jsonb_typeof(history) = 'object'),
  source text not null default 'tradovate-journal',
  created_at timestamptz not null default now()
);
create index trade_execution_history_user_idx on public.trade_execution_history (user_id);

alter table public.trade_execution_history enable row level security;
revoke all on public.trade_execution_history from anon;
revoke insert, update, delete on public.trade_execution_history from authenticated;
grant select on public.trade_execution_history to authenticated;
create policy trade_execution_history_owner_read on public.trade_execution_history
  for select to authenticated
  using ((select auth.uid()) = user_id and exists (
    select 1 from public.trades t where t.id = trade_execution_history.trade_id and t.user_id = (select auth.uid())));

comment on table public.trade_execution_history is
  'Soukromá historie fillů a ochran obchodu (zmrazená z tradovate_journal_positions 23. 11. 2026). Jen pro vlastníka; nesdílí se.';

-- 1. Historie fillů potvrzených obchodů.
insert into public.trade_execution_history (trade_id, user_id, history)
select j.trade_id, j.user_id, j.history
from public.tradovate_journal_positions j
join public.trades t on t.id = j.trade_id and t.user_id = j.user_id
where j.status = 'confirmed'
  and t.data->>'copierTradeId' like 'journal:%'
  and jsonb_typeof(j.history) = 'object';

-- 2. Vazby screenshotů (view počítá jednoznačnou vazbu přes závěrečný fill).
with links as (
  select s.trade_id, s.user_id, min(s.episode_id::text) as episode_id,
    jsonb_agg(jsonb_build_object('kind', s.kind,
      'at', (extract(epoch from s.at) * 1000)::bigint, 'path', s.storage_path)
      order by s.at, s.storage_path) as snapshots
  from public.journal_trade_snapshots s
  group by s.trade_id, s.user_id
  having count(distinct s.episode_id) = 1
)
update public.trades t
set data = t.data || jsonb_build_object('copierSnapshots', l.snapshots, 'copierEpisodeId', l.episode_id)
from links l
where t.id = l.trade_id and t.user_id = l.user_id
  and t.data->>'copierTradeId' like 'journal:%';

-- 3. Značka zmrazení u všech obchodů z importu.
update public.trades t
set data = t.data || jsonb_build_object('journalFrozenAt', '2026-11-23')
where t.data->>'copierTradeId' like 'journal:%';

-- Kontroly: každý potvrzený obchod má historii, každý odkazovaný obchod screenshoty.
do $$
declare missing_history int; missing_snapshots int;
begin
  select count(*) into missing_history
  from public.tradovate_journal_positions j
  join public.trades t on t.id = j.trade_id and t.user_id = j.user_id
  where j.status = 'confirmed' and t.data->>'copierTradeId' like 'journal:%'
    and not exists (select 1 from public.trade_execution_history h where h.trade_id = j.trade_id);
  select count(distinct s.trade_id) into missing_snapshots
  from public.journal_trade_snapshots s
  join public.trades t on t.id = s.trade_id
  where jsonb_array_length(coalesce(t.data->'copierSnapshots', '[]'::jsonb)) = 0;
  if missing_history > 0 then raise exception 'freeze: % obchodů bez historie', missing_history; end if;
  if missing_snapshots > 0 then raise exception 'freeze: % obchodů bez screenshotů', missing_snapshots; end if;
end $$;

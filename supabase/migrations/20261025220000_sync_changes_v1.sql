-- Delta sync obchodů přes verze (docs/reviews/sync-phases-1-2-design-20261025.md).
-- Aditivní: nová tabulka, triggery, funkce. Appka bez nového kódu nic z toho nečte.
-- Rollback: drop trigger sync_log_* na šesti tabulkách, drop function
-- sync_log_change/sync_trade_changes_v1/get_dashboard_meta_v1/sync_prune_v1,
-- drop table sync_changes, sync_meta.

create table public.sync_changes (
  id bigserial primary key,
  user_id uuid not null,
  entity text not null check (entity in ('trade', 'episode')),
  entity_id text not null,
  xid xid8 not null default pg_current_xact_id(),
  created_at timestamptz not null default now()
);
create index sync_changes_user_xid_idx on public.sync_changes (user_id, xid);
create index sync_changes_created_idx on public.sync_changes (created_at);
alter table public.sync_changes enable row level security;
create policy sync_changes_owner_select on public.sync_changes
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.sync_changes from public, anon, authenticated;
grant select on public.sync_changes to authenticated;

-- epoch: zvednout při obnově DB nebo změně výpočtu → všichni klienti plné čtení.
-- horizon_xid: nejvyšší xid smazaný úklidem; starší kurzor = plné čtení.
create table public.sync_meta (
  id int primary key check (id = 1),
  epoch int not null default 1,
  horizon_xid xid8 not null default '0'::xid8,
  updated_at timestamptz not null default now()
);
insert into public.sync_meta (id) values (1);
alter table public.sync_meta enable row level security;
create policy sync_meta_read on public.sync_meta for select to authenticated using (true);
revoke all on public.sync_meta from public, anon, authenticated;
grant select on public.sync_meta to authenticated;

-- Jeden INSERT na řádek, žádný blok EXCEPTION (ten by u importu stovek pozic
-- v jedné transakci znamenal stovky podtransakcí). Hodnoty jsou pevné a
-- user_id se kontroluje, takže zápis nemá čím selhat.
create function public.sync_log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_entity text := case when tg_table_name in ('copier_trade_snapshots', 'tradovate_copier_trades') then 'episode' else 'trade' end;
  v_new_user uuid; v_new_id text; v_old_user uuid; v_old_id text;
begin
  -- Větve IF, ne CASE: PL/pgSQL by v CASE vyhodnotil i pole, které tabulka nemá.
  if tg_op in ('INSERT', 'UPDATE') then
    v_new_user := new.user_id;
    if tg_table_name = 'trades' then v_new_id := new.id::text;
    elsif v_entity = 'episode' then v_new_id := new.episode_id::text;
    else v_new_id := new.trade_id::text;
    end if;
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    v_old_user := old.user_id;
    if tg_table_name = 'trades' then v_old_id := old.id::text;
    elsif v_entity = 'episode' then v_old_id := old.episode_id::text;
    else v_old_id := old.trade_id::text;
    end if;
  end if;
  if v_new_user is not null and v_new_id is not null then
    insert into public.sync_changes (user_id, entity, entity_id) values (v_new_user, v_entity, v_new_id);
  end if;
  -- Přesun mezi obchody/epizodami nebo vlastníky: starý cíl se musí dočíst taky.
  if v_old_user is not null and v_old_id is not null
    and (tg_op = 'DELETE' or v_old_user is distinct from v_new_user or v_old_id is distinct from v_new_id) then
    insert into public.sync_changes (user_id, entity, entity_id) values (v_old_user, v_entity, v_old_id);
  end if;
  return null;
end; $$;
revoke all on function public.sync_log_change() from public, anon, authenticated;

create trigger sync_log_change_write after insert or delete on public.trades
  for each row execute function public.sync_log_change();
create trigger sync_log_change_update after update on public.trades
  for each row when (old.* is distinct from new.*) execute function public.sync_log_change();

-- Holá změna revize projekce se nehlásí: obsah obchodu je stejný a jinak by
-- každá nová revize znamenala dočíst všechny journal obchody.
create trigger sync_log_change_write after insert or delete on public.tradovate_journal_positions
  for each row execute function public.sync_log_change();
create trigger sync_log_change_update after update on public.tradovate_journal_positions
  for each row when ((old.user_id, old.trade_id, old.journal_account_id, old.status, old.facts, old.history)
    is distinct from (new.user_id, new.trade_id, new.journal_account_id, new.status, new.facts, new.history))
  execute function public.sync_log_change();

create trigger sync_log_change_write after insert or delete on public.trade_private_notes
  for each row execute function public.sync_log_change();
create trigger sync_log_change_update after update on public.trade_private_notes
  for each row when (old.* is distinct from new.*) execute function public.sync_log_change();

create trigger sync_log_change_write after insert or delete on public.backtest_trade_note_histories
  for each row execute function public.sync_log_change();
create trigger sync_log_change_update after update on public.backtest_trade_note_histories
  for each row when (old.* is distinct from new.*) execute function public.sync_log_change();

create trigger sync_log_change_write after insert or delete on public.copier_trade_snapshots
  for each row execute function public.sync_log_change();
create trigger sync_log_change_update after update on public.copier_trade_snapshots
  for each row when (old.* is distinct from new.*) execute function public.sync_log_change();

create trigger sync_log_change_write after insert or delete on public.tradovate_copier_trades
  for each row execute function public.sync_log_change();
create trigger sync_log_change_update after update on public.tradovate_copier_trades
  for each row when (old.* is distinct from new.*) execute function public.sync_log_change();

-- Změněné obchody od kurzoru. Kurzor = xmin aktuálního snapshotu: změny
-- transakcí pod ním jsou všechny vidět; běžící transakce nad ním přijdou
-- v dalším volání (řádky ≥ xmin se mohou vrátit dvakrát — čtení je idempotentní).
create function public.sync_trade_changes_v1(p_cursor text default null, p_epoch int default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_snap pg_snapshot := pg_current_snapshot();
  v_next xid8 := pg_snapshot_xmin(v_snap);
  v_epoch int; v_horizon xid8; v_cursor xid8;
  v_rows int; v_trades text[]; v_episodes uuid[]; v_linked text[];
begin
  if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select m.epoch, m.horizon_xid into v_epoch, v_horizon from public.sync_meta m where m.id = 1;
  if v_epoch is null then raise exception 'sync_meta missing' using errcode = '55000'; end if;
  if p_cursor is null or p_cursor !~ '^[0-9]{1,19}$' or p_epoch is distinct from v_epoch then
    return jsonb_build_object('reset', true, 'cursor', v_next::text, 'epoch', v_epoch);
  end if;
  v_cursor := p_cursor::xid8;
  -- Úklid smazal novější změny, nebo je DB vrácená do minulosti (obnova zálohy).
  if v_cursor <= v_horizon or v_cursor > pg_snapshot_xmax(v_snap) then
    return jsonb_build_object('reset', true, 'cursor', v_next::text, 'epoch', v_epoch);
  end if;
  select count(*),
         array_agg(distinct c.entity_id) filter (where c.entity = 'trade'),
         array_agg(distinct c.entity_id::uuid) filter (where c.entity = 'episode')
    into v_rows, v_trades, v_episodes
    from (select s.entity, s.entity_id from public.sync_changes s
           where s.user_id = v_uid and s.xid >= v_cursor limit 20001) c;
  if v_rows > 20000 or coalesce(array_length(v_trades, 1), 0) > 2000 then
    return jsonb_build_object('reset', true, 'cursor', v_next::text, 'epoch', v_epoch);
  end if;
  if v_episodes is not null then
    select array_agg(distinct j.trade_id::text) into v_linked
      from public.journal_trade_snapshots j
     where j.user_id = v_uid and j.episode_id = any(v_episodes);
    v_trades := array(select distinct x from unnest(coalesce(v_trades, '{}') || coalesce(v_linked, '{}')) x);
  end if;
  return jsonb_build_object('reset', false, 'cursor', v_next::text, 'epoch', v_epoch,
    'trade_ids', to_jsonb(coalesce(v_trades, '{}'::text[])));
end; $$;
revoke all on function public.sync_trade_changes_v1(text, int) from public, anon;
grant execute on function public.sync_trade_changes_v1(text, int) to authenticated;

-- Dashboard bez obchodů (ty jdou přes delta sync): totéž co
-- get_dashboard_data_without_trade_notes_light_v1 bez klíče trades.
create function public.get_dashboard_meta_v1() returns jsonb
language plpgsql stable security definer set search_path = 'public', 'auth' set statement_timeout = '30s' as $$
declare result jsonb; v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select jsonb_build_object(
    'user', (select jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name,
        'avatar_url', case when length(p.avatar_url) > 262144 then null else p.avatar_url end,
        'avatar_deferred', coalesce(length(p.avatar_url) > 262144, false), 'role', p.role)
      from profiles p where p.id = v_user_id),
    'preferences', (select p.preferences from profiles p where p.id = v_user_id),
    'accounts', coalesce((select jsonb_agg(to_jsonb(a)) from accounts a where a.user_id = v_user_id), '[]'::jsonb),
    'daily_preps', coalesce((select jsonb_agg(jsonb_build_object('id', dp.id, 'date', dp.date, 'data', dp.data)) from daily_preps dp where dp.user_id = v_user_id), '[]'::jsonb),
    'daily_reviews', coalesce((select jsonb_agg(jsonb_build_object('id', dr.id, 'date', dr.date, 'data', dr.data)) from daily_reviews dr where dr.user_id = v_user_id), '[]'::jsonb),
    'weekly_focus', coalesce((select jsonb_agg(jsonb_build_object('id', wf.id, 'week_iso', wf.week_iso, 'goals', wf.goals)) from weekly_focus wf where wf.user_id = v_user_id), '[]'::jsonb)
  ) into result;
  return result;
end; $$;
revoke all on function public.get_dashboard_meta_v1() from public, anon;
grant execute on function public.get_dashboard_meta_v1() to authenticated;

-- Úklid záznamů starších než p_keep; volá cron journal-import (service_role).
create function public.sync_prune_v1(p_keep interval default interval '3 days', p_batch int default 50000)
returns int language plpgsql security definer set search_path = '' as $$
declare v_max xid8; v_count int;
begin
  with doomed as (
    select s.id from public.sync_changes s where s.created_at < now() - p_keep order by s.id limit p_batch
  ), removed as (
    delete from public.sync_changes s using doomed d where s.id = d.id returning s.xid
  )
  select count(*), (select r.xid from removed r order by r.xid desc limit 1) into v_count, v_max from removed;
  if v_count > 0 then
    update public.sync_meta m set horizon_xid = greatest(m.horizon_xid, v_max), updated_at = now() where m.id = 1;
  end if;
  return v_count;
end; $$;
revoke all on function public.sync_prune_v1(interval, int) from public, anon, authenticated;
grant execute on function public.sync_prune_v1(interval, int) to service_role;

alter publication supabase_realtime add table public.sync_changes;

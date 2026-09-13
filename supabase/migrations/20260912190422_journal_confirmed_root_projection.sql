-- Local draft. Activate only with a separately approved backup/export.
-- Keep the already-shareable financial facts current without exposing the
-- owner-only position/history tables to followers or broadening trade RLS.
alter table public.trades add column journal_projection_status text
  check (journal_projection_status in ('confirmed','pending','invalidated'));

create function public.sync_journal_trade_projection_root() returns trigger
language plpgsql security invoker set search_path='' as $$
declare p public.tradovate_journal_positions%rowtype;
begin
  if current_user in ('authenticated','anon') then
    -- Neither a forged insert nor an owner review can certify broker evidence.
    if tg_op='INSERT' then new.journal_projection_status := null;
    else
      new.journal_projection_status := old.journal_projection_status;
      if old.journal_projection_status is not null then
        new.id := old.id; new.user_id := old.user_id; new.account_id := old.account_id;
      end if;
    end if;
    return new;
  end if;
  select * into p from public.tradovate_journal_positions j
    where j.user_id=new.user_id and j.trade_id=new.id;
  if not found then
    new.journal_projection_status := null;
    return new;
  end if;
  new.journal_projection_status := case when p.journal_account_id is distinct from new.account_id
    then 'invalidated' else p.status end;
  if new.journal_projection_status='confirmed' then
    new.instrument := p.facts->>'instrument';
    new.pnl := (p.facts->>'pnl')::numeric;
    new.direction := p.facts->>'direction';
    new.date := p.facts->>'date';
    new.timestamp := (p.facts->>'timestamp')::bigint;
    -- Replace financial keys only. A missing new SL/risk must remove its old
    -- value; review text, private-note pointers, drawings and images survive.
    new.data := (coalesce(new.data,'{}'::jsonb) - array[
      'instrument','direction','pnl','entryPrice','exitPrice','entryTime','entryDate',
      'timestamp','date','exitDate','positionSize','durationMinutes','duration',
      'groupId','isMaster','stopLoss','takeProfit','pnlEstimated','executionHistory',
      'riskAmount','rr','plannedRR']) || (p.facts - 'executionHistory');
  end if;
  return new;
end; $$;
-- Alphabetical trigger order puts this after the existing identity guard.
create trigger sync_journal_trade_projection_root before insert or update on public.trades
  for each row execute function public.sync_journal_trade_projection_root();

create function public.refresh_journal_trade_projection_root() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    update public.trades t set journal_projection_status=null where t.user_id=old.user_id and t.id=old.trade_id;
    return old;
  end if;
  -- The root trigger reads the new authoritative position in this transaction.
  -- No insert: deleted reviews must not reappear during reimport.
  update public.trades t set journal_projection_status=new.status where t.user_id=new.user_id and t.id=new.trade_id;
  return new;
end; $$;
create trigger refresh_journal_trade_projection_root after insert or update or delete
  on public.tradovate_journal_positions for each row execute function public.refresh_journal_trade_projection_root();
revoke all on function public.sync_journal_trade_projection_root(), public.refresh_journal_trade_projection_root() from public,anon,authenticated;

-- Backfill the new marker/current facts atomically when activating this draft.
update public.trades t set journal_projection_status=p.status
  from public.tradovate_journal_positions p where p.user_id=t.user_id and p.trade_id=t.id;

-- Same trade-row RLS and grants as before; no join to private execution evidence.
-- The certificate column is database-controlled and not writable by a client.
create or replace view public.confirmed_journal_trades with (security_invoker = true) as
select projected.* from public.trades t
cross join lateral jsonb_populate_record(null::public.trades,
  to_jsonb(t) || jsonb_build_object('data', t.data - 'executionHistory')) projected
where not (t.data ? 'journalSupersededBy') and (
  (t.journal_projection_status='confirmed' and coalesce(t.data->>'copierTradeId','') like 'journal:%')
  or (t.journal_projection_status is null and coalesce(t.data->>'copierTradeId','') not like 'journal:%'
    and not coalesce(t.data->>'source'='copier',false))
);

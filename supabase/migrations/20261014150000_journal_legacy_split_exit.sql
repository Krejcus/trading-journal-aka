-- 14. 10. 2026: deník Tradeify stál od 2. 10. na `journal-legacy-reference-
-- ambiguous`: jeden obchod se zavřel jedním příkazem vyplněným dvěma filly ve
-- stejné milisekundě a kopírka měla záznam jen k jednomu z nich. Tento jediný
-- zaznamenaný fill je identita starého záznamu; jinak beze změny.

create or replace function public.journal_legacy_identity(p_user_id uuid, p_connection_id uuid, p_history jsonb, p_facts jsonb, p_positions jsonb)
returns text language plpgsql security invoker set search_path='' as $$
declare source_history jsonb := p_history; source_connection uuid := p_connection_id;
  ids text[]; recorded text[]; raw_id text; parent_count integer; logical_id text;
begin
  if p_facts->'isMaster' = 'false'::jsonb and p_facts->>'groupId' is not null then
    select count(*), (jsonb_agg(p->'history')->0) into parent_count, source_history
      from jsonb_array_elements(p_positions) p where p #>> '{facts,groupId}' = p_facts->>'groupId' and p #>> '{facts,isMaster}' = 'true';
    if parent_count = 0 then
      select count(*), (jsonb_agg(j.history)->0) into parent_count, source_history
        from public.tradovate_journal_positions j where j.user_id=p_user_id
          and j.facts->>'groupId'=p_facts->>'groupId' and j.facts->'isMaster'='true'::jsonb and j.status <> 'invalidated';
    end if;
    if parent_count > 1 then raise exception 'journal-legacy-reference-ambiguous' using errcode='22023'; end if;
    if parent_count = 0 then return null; end if;
    source_connection := (source_history->>'connectionId')::uuid;
  end if;
  if source_history #>> '{position,status}' is distinct from 'closed' then return null; end if;
  select array_agg(distinct f->>'id') into ids from jsonb_array_elements(source_history->'fills') f
    where f->>'role'='exit' and f->'at'=source_history #> '{position,closedAt}';
  if coalesce(array_length(ids,1),0) > 1 then
    -- 14. 10. 2026: finální výstup rozdělený do víc fillů ve stejné ms z
    -- jednoho příkazu (Tradeify 2. 10.: 19 + 1). Identita je ten jediný fill,
    -- ke kterému kopírka uložila záznam; víc záznamů nebo víc příkazů zůstává
    -- nejednoznačné jako dosud.
    select array_agg(l.trade_id) into recorded from public.tradovate_copier_trades l
      where l.user_id=p_user_id and l.connection_id=source_connection and l.trade_id=any(ids);
    if coalesce(array_length(recorded,1),0)=1 and (select count(distinct f->>'orderId') from jsonb_array_elements(source_history->'fills') f
      where f->>'role'='exit' and f->'at'=source_history #> '{position,closedAt}')=1 then
      ids := recorded;
    end if;
  end if;
  if coalesce(array_length(ids,1),0) <> 1 then
    if exists(select 1 from public.tradovate_copier_trades l where l.user_id=p_user_id and l.connection_id=source_connection and l.trade_id=any(ids)) then
      raise exception 'journal-legacy-reference-ambiguous' using errcode='22023';
    end if;
    return null;
  end if;
  raw_id := ids[1];
  logical_id := 'copier-' || raw_id || case when source_connection <> p_connection_id
    or source_history->>'accountId' <> p_history->>'accountId' then '-' || (p_history->>'accountId') else '' end;
  if not exists(select 1 from public.tradovate_copier_trades l where l.user_id=p_user_id and l.connection_id=source_connection and l.trade_id=raw_id) then
    if exists(select 1 from public.trades t where t.user_id=p_user_id and t.data->>'copierTradeId'=logical_id) then
      raise exception 'journal-legacy-connection-unavailable' using errcode='22023';
    end if;
    return null;
  end if;
  if exists(select 1 from public.tradovate_copier_trades l where l.user_id=p_user_id and l.trade_id=raw_id and l.connection_id is distinct from source_connection) then
    raise exception 'journal-legacy-reference-ambiguous' using errcode='22023';
  end if;
  return logical_id;
end; $$;
revoke all on function public.journal_legacy_identity(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.journal_legacy_identity(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

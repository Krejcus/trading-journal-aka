-- 14. 10. 2026: zápis pozic deníku trval 11,4 s pro 594 pozic (Lucid, přepočet
-- po návratu kontrolního bodu) a 1,7 s pro běžné okno; 10,4 s z toho bylo
-- párování se starými záznamy kopírky (journal_legacy_identity):
--  * kontrola `trades.data->>'copierTradeId'` bez indexu četla všech ~4,6k
--    obchodů i s velkým `data` (kresby, poznámky) — ~16 ms na pozici;
--  * pozice followera hledala leadera průchodem celého snímku (2,3 MB) —
--    O(n²).
-- Index na copierTradeId a mapa leaderů sestavená jednou za zápis. Výsledek
-- párování se nemění (stejná pravidla, stejná data). Nutné před návratem
-- service_role na 8 s timeout.

create index if not exists trades_copier_trade_id_idx on public.trades (user_id, (data->>'copierTradeId'));

create or replace function public.journal_legacy_identity(p_user_id uuid, p_connection_id uuid, p_history jsonb, p_facts jsonb, p_positions jsonb)
returns text language plpgsql security invoker set search_path='' as $$
declare source_history jsonb := p_history; source_connection uuid := p_connection_id;
  ids text[]; recorded text[]; raw_id text; parent_count integer; logical_id text;
begin
  if p_facts->'isMaster' = 'false'::jsonb and p_facts->>'groupId' is not null then
    -- Objekt = předem sestavená mapa skupina → leaderovy pozice (persist);
    -- pole = starý tvar (celý snímek).
    if jsonb_typeof(p_positions) = 'object' then
      parent_count := coalesce(jsonb_array_length(p_positions->(p_facts->>'groupId')),0);
      source_history := p_positions->(p_facts->>'groupId')->0->'history';
    else
      select count(*), (jsonb_agg(p->'history')->0) into parent_count, source_history
        from jsonb_array_elements(p_positions) p where p #>> '{facts,groupId}' = p_facts->>'groupId' and p #>> '{facts,isMaster}' = 'true';
    end if;
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

create or replace function public.persist_tradovate_journal_positions(
  p_user_id uuid, p_connection_id uuid, p_revision bigint, p_positions jsonb, p_import_receipt jsonb default null,
  p_staged_id uuid default null, p_checkpoint_epoch bigint default null, p_input_generation bigint default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  head public.tradovate_journal_projection_heads%rowtype;
  input_head public.tradovate_journal_input_heads%rowtype;
  stored public.tradovate_journal_positions%rowtype;
  item jsonb;
  facts jsonb;
  private_history jsonb;
  account_id uuid;
  account_meta jsonb;
  external_id bigint;
  position_key text;
  confirmed boolean;
  legacy_id text; legacy_ids uuid[]; adopted_id uuid;
  staged public.tradovate_journal_import_runs%rowtype;
  staged_positions jsonb;
  has_legacy_reviews boolean;
  legacy_masters jsonb;
  changed_ids jsonb := '[]'::jsonb;
  allowed_keys text[] := array['instrument','direction','pnl','entryPrice','exitPrice','entryTime','entryDate','timestamp','date','exitDate',
    'positionSize','durationMinutes','duration','groupId','isMaster','stopLoss','takeProfit','pnlEstimated'];
begin
  -- A complete server-computed snapshot commits in ONE transaction. Never
  -- publish partial account batches or accept browser-supplied financial facts.
  if p_revision is null or p_revision < 0 or jsonb_typeof(p_positions) is distinct from 'array'
     or jsonb_array_length(p_positions) > (case when p_staged_id is null then 2000 else 50000 end)
     or octet_length(p_positions::text) > (case when p_staged_id is null then 8000000 else 128000000 end) then
    raise exception 'invalid-journal-projection' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(p_positions)) is distinct from
     (select count(distinct value->>'positionId') from jsonb_array_elements(p_positions)) then
    raise exception 'invalid-journal-duplicate-position' using errcode = '22023';
  end if;
  perform 1 from public.tradovate_oauth_connections c where c.id = p_connection_id and c.user_id = p_user_id and c.environment = 'demo';
  if not found then raise exception 'invalid-journal-owner' using errcode = '42501'; end if;
  if p_revision > coalesce((select max(e.ingest_id) from public.tradovate_journal_evidence e
      where e.user_id = p_user_id and e.connection_id = p_connection_id), 0) then
    raise exception 'invalid-journal-revision' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('journal:' || p_user_id::text,0));
  -- Živý deník (14. 10. 2026): po zmrazení smí zapisovat jen okno nad
  -- stejným kontrolním bodem a stejnou generací vstupu. Starší nasazení
  -- s plnou projekcí by jinak zneplatnilo zmrazené obchody.
  if p_checkpoint_epoch is null then
    if exists(select 1 from public.tradovate_journal_positions j where j.user_id=p_user_id and j.connection_id=p_connection_id
      and j.frozen_epoch is not null) then
      raise exception 'journal-import-upgrade-required' using errcode='55000';
    end if;
  else
    select * into input_head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id for update;
    if not found or input_head.checkpoint_epoch is distinct from p_checkpoint_epoch
      or input_head.generation is distinct from p_input_generation then
      return jsonb_build_object('accepted',false,'stale',true);
    end if;
  end if;
  if p_staged_id is not null then
    select * into staged from public.tradovate_journal_import_runs r where r.id=p_staged_id
      and r.user_id=p_user_id and r.connection_id=p_connection_id for update;
    if not found or staged.published or staged.revision<>p_revision
      or staged.import_receipt is distinct from p_import_receipt
      or staged.position_count<>jsonb_array_length(p_positions)
      or staged.chunk_count<>(select count(*) from public.tradovate_journal_import_chunks c where c.run_id=staged.id) then
      raise exception 'invalid-journal-stage' using errcode='22023';
    end if;
    select jsonb_agg(p.value order by c.chunk_index,p.ordinality) into staged_positions
      from public.tradovate_journal_import_chunks c cross join lateral jsonb_array_elements(c.positions) with ordinality p
      where c.run_id=staged.id;
    if staged_positions is distinct from p_positions then raise exception 'journal-stage-conflict' using errcode='22023'; end if;
    staged_positions := null;
  end if;
  insert into public.tradovate_journal_projection_heads (user_id, connection_id) values (p_user_id, p_connection_id) on conflict do nothing;
  select * into head from public.tradovate_journal_projection_heads h where h.user_id = p_user_id and h.connection_id = p_connection_id for update;
  if p_revision < head.revision then return jsonb_build_object('accepted', false, 'stale', true); end if;
  update public.tradovate_journal_projection_heads h set revision = p_revision, generation = h.generation + 1
    where h.user_id = p_user_id and h.connection_id = p_connection_id;
  if p_import_receipt is not null then
    if jsonb_typeof(p_import_receipt) is distinct from 'object' or octet_length(p_import_receipt::text)>250000
      or p_import_receipt->>'version' is distinct from '2'
      or p_import_receipt->'accounts' is distinct from public.journal_import_bindings(p_user_id,p_connection_id)
      or (p_import_receipt->>'confirmed')::int is distinct from (select count(*) from jsonb_array_elements(p_positions) p where p->>'status'='confirmed')
      or (p_import_receipt->>'pending')::int is distinct from (select count(*) from jsonb_array_elements(p_positions) p where p->>'status'='pending')
      or coalesce((p_import_receipt->>'unassigned')::bigint,-1) not between 0 and 100000 then
      raise exception 'journal-import-checkpoint-mismatch' using errcode='22023';
    end if;
  end if;
  select exists(select 1 from public.trades t where t.user_id=p_user_id
    and coalesce(t.data->>'copierTradeId','') ~ '^copier-[0-9]+(-[0-9]+)?$') into has_legacy_reviews;
  -- Leaderovy pozice podle skupiny jednou (dřív každá pozice followera
  -- procházela celé pole: 590 pozic = 7 s).
  if has_legacy_reviews then
    select coalesce(jsonb_object_agg(s.g, s.hs),'{}'::jsonb) into legacy_masters from (
      select p #>> '{facts,groupId}' g, jsonb_agg(jsonb_build_object('facts',p->'facts','history',p->'history')) hs
      from jsonb_array_elements(p_positions) p where p #>> '{facts,groupId}' is not null and p #>> '{facts,isMaster}' = 'true' group by 1) s;
  end if;
  for item in select * from jsonb_array_elements(p_positions) loop
    position_key := item->>'positionId'; external_id := (item->>'externalAccountId')::bigint;
    facts := item->'facts'; private_history := item->'history';
    account_id := nullif(item->>'journalAccountId', '')::uuid;
    confirmed := item->>'status' = 'confirmed';
    if position_key is null or external_id is null or external_id <= 0
       or position_key not like ('demo:' || p_connection_id::text || ':position:' || external_id::text || ':%')
       or jsonb_typeof(facts) is distinct from 'object' or jsonb_typeof(private_history) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(facts) k where not (k = any(allowed_keys)))
       or private_history->>'connectionId' is distinct from p_connection_id::text
       or private_history->>'environment' is distinct from 'demo'
       or private_history->>'accountId' is distinct from external_id::text
       or coalesce(item->>'status', '') not in ('confirmed', 'pending')
       or (confirmed and item->>'pendingReason' is not null)
       or (not confirmed and coalesce(item->>'pendingReason','') not in ('account-not-linked', 'account-link-conflict', 'invalid-journal-account', 'open', 'incomplete', 'accounting-pending'))
       or private_history #>> '{position,id}' is distinct from position_key then
      raise exception 'invalid-journal-position' using errcode = '22023';
    end if;
    if account_id is not null then
      select a.meta into account_meta from public.accounts a where a.id = account_id and a.user_id = p_user_id;
      if not found or account_meta #>> '{oauth,provider}' is distinct from 'tradovate'
        or account_meta #>> '{oauth,environment}' is distinct from 'demo'
        or account_meta #>> '{oauth,connectionId}' is distinct from p_connection_id::text
        or account_meta #>> '{oauth,externalAccountId}' is distinct from external_id::text then
        raise exception 'invalid-journal-account' using errcode = '42501';
      end if;
      if (select count(*) from public.accounts a where a.user_id = p_user_id
        and a.meta #>> '{oauth,provider}' = 'tradovate' and a.meta #>> '{oauth,environment}' = 'demo'
        and a.meta #>> '{oauth,connectionId}' = p_connection_id::text
        and a.meta #>> '{oauth,externalAccountId}' = external_id::text) <> 1 then
        raise exception 'invalid-journal-ambiguous-account' using errcode = '42501';
      end if;
    end if;
    if confirmed and (account_id is null or jsonb_typeof(facts->'pnl') is distinct from 'number'
      or facts->'pnl' is distinct from private_history->'netPnl'
      or private_history #>> '{position,status}' is distinct from 'closed'
      or jsonb_typeof(facts->'entryTime') is distinct from 'number' or jsonb_typeof(facts->'timestamp') is distinct from 'number'
      or jsonb_typeof(facts->'entryPrice') is distinct from 'number' or jsonb_typeof(facts->'exitPrice') is distinct from 'number'
      or (facts->>'timestamp')::numeric < (facts->>'entryTime')::numeric
      or jsonb_typeof(facts->'positionSize') is distinct from 'number' or (facts->>'positionSize')::numeric <= 0
      or jsonb_typeof(facts->'date') is distinct from 'string'
      or jsonb_typeof(facts->'entryDate') is distinct from 'string'
      or jsonb_typeof(facts->'exitDate') is distinct from 'string'
      or facts->'pnlEstimated' is distinct from 'false'::jsonb
      or coalesce(facts->>'direction','') not in ('Long','Short') or coalesce(facts->>'instrument','') = '') then
      raise exception 'invalid-journal-confirmed-position' using errcode = '22023';
    end if;
    select * into stored from public.tradovate_journal_positions j
      where j.user_id = p_user_id and j.connection_id = p_connection_id and j.position_id = position_key for update;
    if found and stored.frozen_epoch is not null then
      raise exception 'journal-frozen-conflict' using errcode = '22023';
    end if;
    if found and stored.trade_created and account_id is not null and stored.journal_account_id is distinct from account_id then
      raise exception 'journal-account-reassignment-forbidden' using errcode = '22023';
    end if;
    insert into public.tradovate_journal_positions as j (user_id, connection_id, position_id, external_account_id, journal_account_id, revision, status, pending_reason, facts, history)
      values (p_user_id, p_connection_id, position_key, external_id, account_id, p_revision, item->>'status', item->>'pendingReason', facts, private_history)
      on conflict (user_id, connection_id, position_id) do update set revision = excluded.revision,
        journal_account_id = case when j.trade_created then j.journal_account_id else excluded.journal_account_id end,
        status = excluded.status, pending_reason = excluded.pending_reason, facts = excluded.facts, history = excluded.history
      returning * into stored;
    if has_legacy_reviews and account_id is not null and private_history #>> '{position,status}' = 'closed'
      and not exists(select 1 from public.trades t where t.id=stored.trade_id and t.user_id=p_user_id and t.data ? 'journalLegacyCopierTradeId') then
      legacy_id := public.journal_legacy_identity(p_user_id,p_connection_id,private_history,facts,legacy_masters);
      if legacy_id is not null then
        -- Lock exact legacy rows before selecting the canonical UUID. Distinct
        -- reviews survive as linked originals; never merge their text by guess.
        perform 1 from public.trades t where t.user_id=p_user_id and t.data->>'copierTradeId'=legacy_id order by t.id for update;
        select array_agg(t.id order by t.created_at,t.id) into legacy_ids from public.trades t
          where t.user_id=p_user_id and t.data->>'copierTradeId'=legacy_id;
        if coalesce(array_length(legacy_ids,1),0)>0 then
          if not stored.trade_created then
            adopted_id := legacy_ids[1];
            update public.tradovate_journal_positions j set trade_id=adopted_id, trade_created=true
              where j.user_id=p_user_id and j.connection_id=p_connection_id and j.position_id=position_key returning * into stored;
            update public.trades t set account_id=stored.journal_account_id,
              data=(t.data - 'journalSupersededBy') || jsonb_build_object('copierTradeId','journal:' || adopted_id::text,
                'journalLegacyCopierTradeId',legacy_id,'journalLegacyAccountId',t.account_id)
              where t.user_id=p_user_id and t.id=adopted_id;
          end if;
          update public.trades t set data=t.data || jsonb_build_object('journalSupersededBy',stored.trade_id::text)
            where t.user_id=p_user_id and t.id=any(legacy_ids) and t.id<>stored.trade_id;
        end if;
      end if;
    end if;
    if confirmed then
      if not stored.trade_created then
        insert into public.trades (id, user_id, account_id, instrument, signal, pnl, direction, date, timestamp, data)
          values (stored.trade_id, p_user_id, account_id, facts->>'instrument', 'Copier', (facts->>'pnl')::numeric,
            facts->>'direction', facts->>'date', (facts->>'timestamp')::bigint,
            facts || jsonb_build_object('copierTradeId','journal:' || stored.trade_id::text, 'source','copier', 'needsReview',true,'runUp',0,'drawdown',0));
        update public.tradovate_journal_positions j set trade_created = true
          where j.user_id = p_user_id and j.connection_id = p_connection_id and j.position_id = position_key;
      else
        -- Numeric root facts stay current. Never replace the review JSON, drawings or screenshots.
        update public.trades t set instrument = facts->>'instrument', pnl = (facts->>'pnl')::numeric,
          direction = facts->>'direction', date = facts->>'date', timestamp = (facts->>'timestamp')::bigint
          where t.id = stored.trade_id and t.user_id = p_user_id and t.account_id = stored.journal_account_id;
      end if;
    end if;
    if p_staged_id is null then changed_ids := changed_ids || to_jsonb(stored.trade_id::text); end if;
  end loop;
  begin
    -- The server supplied every projected position, including pending ones.
    with supplied as materialized (select p->>'positionId' as id from jsonb_array_elements(p_positions) p)
    update public.tradovate_journal_positions j set status = 'invalidated', revision = p_revision
      where j.user_id = p_user_id and j.connection_id = p_connection_id and j.frozen_epoch is null
        and not exists (select 1 from supplied p where p.id = j.position_id);
    -- Zmrazené řádky se nepřepočítávají; čtení (i starší appky) vyžaduje
    -- stejnou revizi u všech řádků, takže se jim dorovná jen revize.
    update public.tradovate_journal_positions j set revision = p_revision
      where j.user_id = p_user_id and j.connection_id = p_connection_id and j.frozen_epoch is not null and j.revision <> p_revision;
    update public.tradovate_journal_projection_heads h set completed_revision = p_revision, import_receipt = p_import_receipt
      where h.user_id = p_user_id and h.connection_id = p_connection_id;
  end;
  if p_staged_id is not null then
    return jsonb_build_object('accepted',true,'through',p_revision,'positionCount',jsonb_array_length(p_positions));
  end if;
  return jsonb_build_object('accepted',true,'tradeIds',changed_ids);
end;
$$;

-- 14. 10. 2026: živý deník (docs/JOURNAL_LIVE_PLAN.md). Import už nepřepočítává
-- celou historii: obchody před kontrolním bodem K (všechny účty ověřeně flat,
-- žádný pracující příkaz) se zmrazí a jejich vstup archivuje. Každý import
-- čte jen živý vstup od K a zapisuje jen pozice od K. Posun K se v TS ověří
-- proti dosavadnímu výpočtu; pozdní evidence k zmrazeným datům K vrátí zpět.
-- Bez kontrolního bodu (epoch 0) se nic nemění.

alter table public.tradovate_journal_input_heads add column checkpoint_epoch bigint not null default 0;
alter table public.tradovate_journal_input_entities add column archived_epoch bigint;
alter table public.tradovate_journal_input_retained add column archived_epoch bigint;
alter table public.tradovate_journal_positions add column frozen_epoch bigint;
alter table public.tradovate_journal_projection_heads add column evaluated_through bigint not null default 0;
alter table public.tradovate_journal_import_runs add column checkpoint_epoch bigint, add column input_generation bigint;

create index tradovate_journal_input_entities_live_idx on public.tradovate_journal_input_entities (user_id, connection_id, entity_key)
  where archived_epoch is null;
create index tradovate_journal_input_entities_epoch_idx on public.tradovate_journal_input_entities (user_id, connection_id, archived_epoch)
  where archived_epoch is not null;
create index tradovate_journal_input_retained_live_idx on public.tradovate_journal_input_retained (user_id, connection_id, event_id)
  where archived_epoch is null;
create index tradovate_journal_input_retained_epoch_idx on public.tradovate_journal_input_retained (user_id, connection_id, archived_epoch)
  where archived_epoch is not null;
create index tradovate_journal_positions_frozen_idx on public.tradovate_journal_positions (user_id, connection_id, frozen_epoch)
  where frozen_epoch is not null;

create table public.tradovate_journal_checkpoints (
  user_id uuid not null,
  connection_id uuid not null,
  epoch bigint not null check (epoch > 0),
  at_ms bigint not null check (at_ms > 0),
  flat_accounts bigint[] not null,
  bindings jsonb not null,
  status text not null check (status in ('archiving', 'active')),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  primary key (user_id, connection_id, epoch),
  foreign key (user_id, connection_id) references public.tradovate_journal_input_heads on delete cascade
);
-- ID zmrazených dat (fill, order, command, pair, ledger, copylink, pozice):
-- živý řádek, který na ně odkazuje, je pozdní evidence → znovuotevření.
create table public.tradovate_journal_archived_refs (
  user_id uuid not null,
  connection_id uuid not null,
  kind text not null,
  ref_id text not null,
  epoch bigint not null,
  fingerprint text,
  primary key (user_id, connection_id, kind, ref_id),
  foreign key (user_id, connection_id) references public.tradovate_journal_input_heads on delete cascade
);
create index tradovate_journal_archived_refs_epoch_idx on public.tradovate_journal_archived_refs (user_id, connection_id, epoch);
alter table public.tradovate_journal_checkpoints enable row level security;
alter table public.tradovate_journal_archived_refs enable row level security;
revoke all on public.tradovate_journal_checkpoints, public.tradovate_journal_archived_refs from public, anon, authenticated;
grant select, insert, update, delete on public.tradovate_journal_checkpoints, public.tradovate_journal_archived_refs to service_role;

-- Věcná změna archivované entity (broker oprava, bust, pozdní stav) ji vrátí
-- do živého vstupu; import ji pak najde v archivovaných ID a K vrátí zpět.
-- Pouhé znovupozorování (jiný receipt, stejná data) ji nechá archivovanou.
-- Trigger platí pro jakýkoli RPC, i ze staršího nasazení.
create function public.journal_input_entity_unarchive() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if old.archived_epoch is not null and (old.latest->'entity' is distinct from new.latest->'entity'
    or old.latest->>'eventType' is distinct from new.latest->>'eventType') then
    new.archived_epoch := null;
  end if;
  return new;
end; $$;
create trigger journal_input_entity_unarchive before update on public.tradovate_journal_input_entities
  for each row execute function public.journal_input_entity_unarchive();
revoke all on function public.journal_input_entity_unarchive() from public, anon, authenticated;

-- Obchod se přepisuje jen při změně toho, co z pozice čte (status, účet,
-- fakta, obchod). Dorovnání revize nebo nová historie bez nových faktů už
-- nepřepisuje řádek v trades (dřív každý import přepsal všechny obchody).
drop trigger refresh_journal_trade_projection_root on public.tradovate_journal_positions;
create trigger refresh_journal_trade_projection_root after insert or delete
  on public.tradovate_journal_positions for each row execute function public.refresh_journal_trade_projection_root();
create trigger refresh_journal_trade_projection_root_update after update
  on public.tradovate_journal_positions for each row
  when (old.status is distinct from new.status or old.journal_account_id is distinct from new.journal_account_id
    or old.facts is distinct from new.facts or old.trade_id is distinct from new.trade_id)
  execute function public.refresh_journal_trade_projection_root();

drop function public.persist_tradovate_journal_positions(uuid,uuid,bigint,jsonb,jsonb,uuid);
create function public.persist_tradovate_journal_positions(
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
      legacy_id := public.journal_legacy_identity(p_user_id,p_connection_id,private_history,facts,p_positions);
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
revoke all on function public.persist_tradovate_journal_positions(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,bigint) from public, anon, authenticated;
grant execute on function public.persist_tradovate_journal_positions(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,bigint) to service_role;

drop function public.begin_journal_position_stage(uuid,uuid,bigint,text,int,int,jsonb);
create function public.begin_journal_position_stage(p_user_id uuid,p_connection_id uuid,p_revision bigint,
  p_run_key text,p_chunk_count int,p_position_count int,p_import_receipt jsonb,
  p_checkpoint_epoch bigint default null,p_input_generation bigint default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare run public.tradovate_journal_import_runs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('journal:' || p_user_id::text,0));
  if not exists(select 1 from public.tradovate_oauth_connections c where c.id=p_connection_id and c.user_id=p_user_id and c.environment='demo') then
    raise exception 'journal-connection-not-found' using errcode='42501';
  end if;
  if p_revision is null or p_revision<0 or p_revision>coalesce((select max(e.ingest_id) from public.tradovate_journal_evidence e where e.user_id=p_user_id and e.connection_id=p_connection_id),0)
    or p_run_key is null or p_run_key !~ '^[0-9a-f]{64}$'
    or p_chunk_count is null or p_chunk_count not between 1 and 5000
    or p_position_count is null or p_position_count not between 1 and 50000
    or jsonb_typeof(p_import_receipt) is distinct from 'object' or octet_length(p_import_receipt::text)>250000
    or p_import_receipt->>'version' is distinct from '2'
    or p_import_receipt->'accounts' is distinct from public.journal_import_bindings(p_user_id,p_connection_id)
    or coalesce((p_import_receipt->>'confirmed')::bigint,-1)<0 or coalesce((p_import_receipt->>'pending')::bigint,-1)<0
    or (p_import_receipt->>'confirmed')::bigint+(p_import_receipt->>'pending')::bigint is distinct from p_position_count::bigint
    or coalesce((p_import_receipt->>'unassigned')::bigint,-1) not between 0 and 100000 then
    raise exception 'invalid-journal-stage' using errcode='22023';
  end if;
  if exists(select 1 from public.tradovate_journal_projection_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id and h.revision>p_revision) then
    return jsonb_build_object('accepted',false,'stale',true);
  end if;
  delete from public.tradovate_journal_import_runs r where r.user_id=p_user_id and r.connection_id=p_connection_id and r.created_at<now()-interval '24 hours';
  -- A newer immutable boundary or account mapping supersedes unfinished work.
  -- Its old caller can fail/retry; it can never publish a mixed generation.
  delete from public.tradovate_journal_import_runs r where r.user_id=p_user_id and r.connection_id=p_connection_id and not r.published
    and (r.revision<p_revision or (r.revision=p_revision and r.import_receipt->'accounts' is distinct from p_import_receipt->'accounts'));
  select * into run from public.tradovate_journal_import_runs r where r.user_id=p_user_id and r.connection_id=p_connection_id and r.run_key=p_run_key for update;
  if found then
    if run.revision<>p_revision or run.chunk_count<>p_chunk_count or run.position_count<>p_position_count or run.import_receipt is distinct from p_import_receipt
      or run.checkpoint_epoch is distinct from p_checkpoint_epoch or run.input_generation is distinct from p_input_generation then
      raise exception 'journal-stage-conflict' using errcode='22023';
    end if;
    if run.published and not exists(select 1 from public.tradovate_journal_projection_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id
      and h.revision=p_revision and h.completed_revision=p_revision and h.import_receipt=run.import_receipt) then
      delete from public.tradovate_journal_import_chunks c where c.run_id=run.id;
      update public.tradovate_journal_import_runs r set published=false where r.id=run.id;
    end if;
  else
    if (select count(*) from public.tradovate_journal_import_runs r where r.user_id=p_user_id and r.connection_id=p_connection_id and not r.published)>=4 then
      raise exception 'journal-stage-capacity' using errcode='54000';
    end if;
    insert into public.tradovate_journal_import_runs(user_id,connection_id,run_key,revision,chunk_count,position_count,import_receipt,checkpoint_epoch,input_generation)
      values(p_user_id,p_connection_id,p_run_key,p_revision,p_chunk_count,p_position_count,p_import_receipt,p_checkpoint_epoch,p_input_generation) returning * into run;
  end if;
  return jsonb_build_object('accepted',true,'runId',run.id,'completedChunks',
    (select coalesce(jsonb_agg(c.chunk_index order by c.chunk_index),'[]'::jsonb) from public.tradovate_journal_import_chunks c where c.run_id=run.id));
end; $$;
revoke all on function public.begin_journal_position_stage(uuid,uuid,bigint,text,int,int,jsonb,bigint,bigint) from public,anon,authenticated;
grant execute on function public.begin_journal_position_stage(uuid,uuid,bigint,text,int,int,jsonb,bigint,bigint) to service_role;

create or replace function public.publish_journal_position_stage(p_user_id uuid,p_connection_id uuid,p_run_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare run public.tradovate_journal_import_runs%rowtype; positions jsonb; ack jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('journal:' || p_user_id::text,0));
  select * into run from public.tradovate_journal_import_runs r where r.id=p_run_id and r.user_id=p_user_id and r.connection_id=p_connection_id for update;
  if not found then raise exception 'journal-stage-not-found' using errcode='42501'; end if;
  if exists(select 1 from public.tradovate_journal_projection_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id and h.revision>run.revision) then
    return jsonb_build_object('accepted',false,'stale',true);
  end if;
  if run.import_receipt->'accounts' is distinct from public.journal_import_bindings(p_user_id,p_connection_id) then
    raise exception 'journal-import-checkpoint-mismatch' using errcode='22023';
  end if;
  if run.published then
    if not exists(select 1 from public.tradovate_journal_projection_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id
      and h.revision=run.revision and h.completed_revision=run.revision and h.import_receipt=run.import_receipt) then
      raise exception 'journal-stage-superseded' using errcode='22023';
    end if;
    return jsonb_build_object('accepted',true,'through',run.revision,'positionCount',run.position_count);
  end if;
  if (select count(*) from public.tradovate_journal_import_chunks c where c.run_id=run.id)<>run.chunk_count
    or (select sum(c.position_count) from public.tradovate_journal_import_chunks c where c.run_id=run.id) is distinct from run.position_count::bigint then
    raise exception 'journal-stage-incomplete' using errcode='22023';
  end if;
  select jsonb_agg(p.value order by c.chunk_index,p.ordinality) into positions
    from public.tradovate_journal_import_chunks c cross join lateral jsonb_array_elements(c.positions) with ordinality p where c.run_id=run.id;
  ack := public.persist_tradovate_journal_positions(p_user_id,p_connection_id,run.revision,positions,run.import_receipt,run.id,
    run.checkpoint_epoch,run.input_generation);
  if ack->'accepted'='true'::jsonb then
    update public.tradovate_journal_import_runs r set published=true where r.id=run.id;
    update public.tradovate_journal_import_chunks c set positions=null where c.run_id=run.id;
  end if;
  return ack;
end; $$;

create or replace function public.read_journal_input_batch(p_user_id uuid,p_connection_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare head public.tradovate_journal_input_heads%rowtype; newest bigint; result jsonb;
begin
  if not exists(select 1 from public.tradovate_oauth_connections c where c.user_id=p_user_id and c.id=p_connection_id and c.environment='demo') then
    raise exception 'journal-connection-not-found' using errcode='42501';
  end if;
  insert into public.tradovate_journal_input_heads(user_id,connection_id) values(p_user_id,p_connection_id) on conflict do nothing;
  select * into head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id for update;
  if head.version<>1 then raise exception 'journal-input-version-mismatch' using errcode='22023'; end if;
  -- Freeze one source snapshot until all its input has been processed and its
  -- financial projection has been published. Continuous arrival cannot starve it.
  if head.through=head.target_through and (head.through=0 or exists(select 1 from public.tradovate_journal_projection_heads h
    where h.user_id=p_user_id and h.connection_id=p_connection_id and greatest(h.completed_revision,h.evaluated_through)>=head.through)) then
    select coalesce(max(e.ingest_id),0) into newest from public.tradovate_journal_evidence e where e.user_id=p_user_id and e.connection_id=p_connection_id;
    if newest>head.target_through then
      update public.tradovate_journal_input_heads h set target_through=newest,generation=h.generation+1
        where h.user_id=p_user_id and h.connection_id=p_connection_id returning * into head;
    end if;
  end if;
  with candidates as materialized (
    select e.ingest_id,e.evidence from public.tradovate_journal_evidence e where e.user_id=p_user_id and e.connection_id=p_connection_id
      and e.ingest_id>head.through and e.ingest_id<=head.target_through order by e.ingest_id limit 251
  ), page as materialized (select * from candidates order by ingest_id limit 250)
  select jsonb_build_object('version',head.version,'generation',head.generation,'after',head.through,'through',head.target_through,
    'ready',head.through=head.target_through,'watermark',head.watermark,
    'hasMore',(select count(*) from candidates)>250,
    'next',case when (select count(*) from candidates)>250 then (select max(ingest_id) from page) else head.target_through end,
    'rows',(select coalesce(jsonb_agg(jsonb_build_object('cursor',ingest_id,'event',evidence) order by ingest_id),'[]'::jsonb) from page),
    'entities',(select coalesce(jsonb_agg(jsonb_build_object('key',c.entity_key,'latest',c.latest,'orderedThrough',c.ordered_through)),'[]'::jsonb)
      from public.tradovate_journal_input_entities c where c.user_id=p_user_id and c.connection_id=p_connection_id and c.entity_key in (
        select public.journal_input_key(evidence) from page where public.journal_input_mode(evidence)='entity'))) into result;
  return result;
end; $$;

create or replace function public.read_journal_input_snapshot_latest(p_user_id uuid,p_connection_id uuid,p_generation bigint,
  p_after text default '',p_limit integer default 1000)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare head public.tradovate_journal_input_heads%rowtype; result jsonb;
begin
  select * into head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id;
  if not found or head.version<>1 or head.generation is distinct from p_generation or head.through<>head.target_through then
    raise exception 'journal-input-changed' using errcode='55000';
  end if;
  if p_after is null or length(p_after)>800 then raise exception 'invalid-journal-input-page' using errcode='22023'; end if;
  if p_limit is null or p_limit<1 or p_limit>2000 then raise exception 'invalid-journal-input-page' using errcode='22023'; end if;
  with entity_page as (
    select ('e:'||c.entity_key) collate "C" as key,
      jsonb_build_object('key',c.entity_key,'latest',c.latest) as entity,
      null::jsonb as event
    from public.tradovate_journal_input_entities c
    where c.user_id=p_user_id and c.connection_id=p_connection_id
      and (c.archived_epoch is null or c.archived_epoch>head.checkpoint_epoch)
      and ('e:'||c.entity_key) collate "C" > p_after collate "C"
    order by ('e:'||c.entity_key) collate "C" limit p_limit
  ), retained_page as (
    select ('r:'||r.event_id) collate "C" as key, null::jsonb as entity, r.evidence as event
    from public.tradovate_journal_input_retained r
    where r.user_id=p_user_id and r.connection_id=p_connection_id
      and (r.archived_epoch is null or r.archived_epoch>head.checkpoint_epoch)
      and ('r:'||r.event_id) collate "C" > p_after collate "C"
    order by ('r:'||r.event_id) collate "C" limit p_limit
  ), page as (
    select * from (select * from entity_page union all select * from retained_page) u
    order by u.key collate "C" limit p_limit
  )
  select jsonb_build_object('generation',head.generation,'through',head.through,'watermark',head.watermark,'checkpointEpoch',head.checkpoint_epoch,
    'rows',coalesce(jsonb_agg(jsonb_build_object('key',key,'entity',entity,'event',event) order by key collate "C"),'[]'::jsonb)) into result from page;
  return result;
end; $$;

-- Vyhodnoceno beze změny pozic: posune vstup dál bez zápisu (žádná nová
-- generace pro čtenáře). Jen nad aktuální generací vstupu a kontrolním bodem.
create function public.mark_journal_projection_evaluated(p_user_id uuid, p_connection_id uuid, p_revision bigint,
  p_checkpoint_epoch bigint, p_input_generation bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare input_head public.tradovate_journal_input_heads%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('journal:' || p_user_id::text,0));
  select * into input_head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id for update;
  if not found or input_head.checkpoint_epoch is distinct from p_checkpoint_epoch or input_head.generation is distinct from p_input_generation
    or input_head.through is distinct from p_revision or input_head.through<>input_head.target_through then
    return jsonb_build_object('accepted',false,'stale',true);
  end if;
  update public.tradovate_journal_projection_heads h set evaluated_through=greatest(h.evaluated_through,p_revision)
    where h.user_id=p_user_id and h.connection_id=p_connection_id and h.revision=h.completed_revision;
  if not found then return jsonb_build_object('accepted',false,'stale',true); end if;
  return jsonb_build_object('accepted',true,'through',p_revision);
end; $$;

create function public.read_journal_checkpoints(p_user_id uuid, p_connection_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'epoch', coalesce((select h.checkpoint_epoch from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id),0),
    'checkpoints', coalesce((select jsonb_agg(jsonb_build_object('epoch',c.epoch,'at',c.at_ms,'flatAccounts',to_jsonb(c.flat_accounts),
      'bindings',c.bindings,'status',c.status) order by c.epoch)
      from public.tradovate_journal_checkpoints c where c.user_id=p_user_id and c.connection_id=p_connection_id),'[]'::jsonb))
$$;

-- Nový kontrolní bod: nejdřív `archiving` (archivace po dávkách, čtení vstupu
-- ji ještě vidí), pak aktivace. Rozpracovaný starší pokus se zahodí.
create function public.begin_journal_checkpoint(p_user_id uuid, p_connection_id uuid, p_expected_epoch bigint,
  p_at_ms bigint, p_flat_accounts bigint[], p_bindings jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare input_head public.tradovate_journal_input_heads%rowtype; previous bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('journal:' || p_user_id::text,0));
  select * into input_head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id for update;
  if not found or input_head.checkpoint_epoch is distinct from p_expected_epoch then
    return jsonb_build_object('accepted',false,'stale',true);
  end if;
  select coalesce(max(c.at_ms),0) into previous from public.tradovate_journal_checkpoints c
    where c.user_id=p_user_id and c.connection_id=p_connection_id and c.status='active';
  -- Rozpracovaný stejný bod se dokončí (dávky archivace jsou idempotentní).
  if exists(select 1 from public.tradovate_journal_checkpoints c where c.user_id=p_user_id and c.connection_id=p_connection_id
    and c.epoch=p_expected_epoch+1 and c.status='archiving' and c.at_ms=p_at_ms and c.bindings=p_bindings
    and c.flat_accounts=p_flat_accounts) then
    return jsonb_build_object('accepted',true,'epoch',p_expected_epoch+1,'resumed',true);
  end if;
  if p_at_ms is null or p_at_ms<=previous or p_at_ms>(extract(epoch from now())*1000)::bigint
    or p_flat_accounts is null or cardinality(p_flat_accounts) not between 1 and 250
    or jsonb_typeof(p_bindings) is distinct from 'array'
    or p_bindings is distinct from public.journal_import_bindings(p_user_id,p_connection_id) then
    raise exception 'invalid-journal-checkpoint' using errcode='22023';
  end if;
  update public.tradovate_journal_input_entities e set archived_epoch=null
    where e.user_id=p_user_id and e.connection_id=p_connection_id and e.archived_epoch>p_expected_epoch;
  update public.tradovate_journal_input_retained r set archived_epoch=null
    where r.user_id=p_user_id and r.connection_id=p_connection_id and r.archived_epoch>p_expected_epoch;
  delete from public.tradovate_journal_archived_refs a where a.user_id=p_user_id and a.connection_id=p_connection_id and a.epoch>p_expected_epoch;
  delete from public.tradovate_journal_checkpoints c where c.user_id=p_user_id and c.connection_id=p_connection_id and c.epoch>p_expected_epoch;
  insert into public.tradovate_journal_checkpoints(user_id,connection_id,epoch,at_ms,flat_accounts,bindings,status)
    values(p_user_id,p_connection_id,p_expected_epoch+1,p_at_ms,p_flat_accounts,p_bindings,'archiving');
  return jsonb_build_object('accepted',true,'epoch',p_expected_epoch+1);
end; $$;

-- Jedna dávka archivace. Řádek už archivovaný starším bodem se nemění.
create function public.archive_journal_checkpoint_chunk(p_user_id uuid, p_connection_id uuid, p_epoch bigint,
  p_entity_keys text[], p_retained_ids text[], p_refs jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare entities int; retained int; refs int;
begin
  if not exists(select 1 from public.tradovate_journal_checkpoints c where c.user_id=p_user_id and c.connection_id=p_connection_id
    and c.epoch=p_epoch and c.status='archiving') then
    return jsonb_build_object('accepted',false,'stale',true);
  end if;
  if coalesce(cardinality(p_entity_keys),0)+coalesce(cardinality(p_retained_ids),0)>10000
    or jsonb_typeof(p_refs) is distinct from 'array' or jsonb_array_length(p_refs)>20000 then
    raise exception 'invalid-journal-checkpoint-chunk' using errcode='22023';
  end if;
  update public.tradovate_journal_input_entities e set archived_epoch=p_epoch
    where e.user_id=p_user_id and e.connection_id=p_connection_id and e.entity_key=any(p_entity_keys) and e.archived_epoch is null;
  get diagnostics entities = row_count;
  update public.tradovate_journal_input_retained r set archived_epoch=p_epoch
    where r.user_id=p_user_id and r.connection_id=p_connection_id and r.event_id=any(p_retained_ids) and r.archived_epoch is null;
  get diagnostics retained = row_count;
  insert into public.tradovate_journal_archived_refs(user_id,connection_id,kind,ref_id,epoch,fingerprint)
    select p_user_id,p_connection_id,x->>'kind',x->>'id',p_epoch,x->>'fingerprint' from jsonb_array_elements(p_refs) x
    where coalesce(x->>'kind','')<>'' and coalesce(x->>'id','')<>''
    on conflict do nothing;
  get diagnostics refs = row_count;
  return jsonb_build_object('accepted',true,'entities',entities,'retained',retained,'refs',refs);
end; $$;

-- Aktivace: zmrazí pozice před K a přepne čtení na živý vstup. CAS na
-- předchozí bod; nová generace vstupu zneplatní rozpracované výpočty.
create function public.activate_journal_checkpoint(p_user_id uuid, p_connection_id uuid, p_epoch bigint, p_position_ids text[])
returns jsonb language plpgsql security invoker set search_path='' as $$
declare input_head public.tradovate_journal_input_heads%rowtype; point public.tradovate_journal_checkpoints%rowtype; frozen int;
begin
  perform pg_advisory_xact_lock(hashtextextended('journal:' || p_user_id::text,0));
  select * into input_head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id for update;
  select * into point from public.tradovate_journal_checkpoints c where c.user_id=p_user_id and c.connection_id=p_connection_id and c.epoch=p_epoch for update;
  if input_head.checkpoint_epoch is distinct from p_epoch-1 or point.status is distinct from 'archiving'
    or point.bindings is distinct from public.journal_import_bindings(p_user_id,p_connection_id) then
    return jsonb_build_object('accepted',false,'stale',true);
  end if;
  if exists(select 1 from public.tradovate_journal_positions j where j.user_id=p_user_id and j.connection_id=p_connection_id
    and j.position_id=any(p_position_ids) and (j.frozen_epoch is not null or j.status='invalidated')) then
    raise exception 'invalid-journal-checkpoint-positions' using errcode='22023';
  end if;
  update public.tradovate_journal_positions j set frozen_epoch=p_epoch
    where j.user_id=p_user_id and j.connection_id=p_connection_id and j.position_id=any(p_position_ids);
  get diagnostics frozen = row_count;
  if frozen<>coalesce(cardinality(p_position_ids),0) then raise exception 'invalid-journal-checkpoint-positions' using errcode='22023'; end if;
  update public.tradovate_journal_checkpoints c set status='active', activated_at=now()
    where c.user_id=p_user_id and c.connection_id=p_connection_id and c.epoch=p_epoch;
  update public.tradovate_journal_input_heads h set checkpoint_epoch=p_epoch, generation=h.generation+1
    where h.user_id=p_user_id and h.connection_id=p_connection_id;
  return jsonb_build_object('accepted',true,'epoch',p_epoch,'frozen',frozen);
end; $$;

-- Znovuotevření (pozdní evidence, změna propojení účtů): vrátí vše po
-- `p_to_epoch` do živého stavu. Stejná ID pozic → stejné obchody.
create function public.reopen_journal_checkpoint(p_user_id uuid, p_connection_id uuid, p_to_epoch bigint, p_expected_epoch bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare input_head public.tradovate_journal_input_heads%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('journal:' || p_user_id::text,0));
  select * into input_head from public.tradovate_journal_input_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id for update;
  if not found or input_head.checkpoint_epoch is distinct from p_expected_epoch or p_to_epoch is null or p_to_epoch<0 or p_to_epoch>=p_expected_epoch then
    return jsonb_build_object('accepted',false,'stale',true);
  end if;
  update public.tradovate_journal_input_entities e set archived_epoch=null
    where e.user_id=p_user_id and e.connection_id=p_connection_id and e.archived_epoch>p_to_epoch;
  update public.tradovate_journal_input_retained r set archived_epoch=null
    where r.user_id=p_user_id and r.connection_id=p_connection_id and r.archived_epoch>p_to_epoch;
  update public.tradovate_journal_positions j set frozen_epoch=null
    where j.user_id=p_user_id and j.connection_id=p_connection_id and j.frozen_epoch>p_to_epoch;
  delete from public.tradovate_journal_archived_refs a where a.user_id=p_user_id and a.connection_id=p_connection_id and a.epoch>p_to_epoch;
  delete from public.tradovate_journal_checkpoints c where c.user_id=p_user_id and c.connection_id=p_connection_id and c.epoch>p_to_epoch;
  update public.tradovate_journal_input_heads h set checkpoint_epoch=p_to_epoch, generation=h.generation+1
    where h.user_id=p_user_id and h.connection_id=p_connection_id;
  return jsonb_build_object('accepted',true,'epoch',p_to_epoch);
end; $$;

-- Které z odkazů živého vstupu míří do zmrazených dat (a s jakým otiskem).
create function public.journal_archived_ref_hits(p_user_id uuid, p_connection_id uuid, p_refs jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if jsonb_typeof(p_refs) is distinct from 'array' or jsonb_array_length(p_refs)>20000 then
    raise exception 'invalid-journal-refs' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind',a.kind,'id',a.ref_id,'epoch',a.epoch,'fingerprint',a.fingerprint)),'[]'::jsonb) into result
    from (select distinct x->>'kind' kind, x->>'id' id from jsonb_array_elements(p_refs) x) r
    join public.tradovate_journal_archived_refs a on a.user_id=p_user_id and a.connection_id=p_connection_id and a.kind=r.kind and a.ref_id=r.id;
  return result;
end; $$;

revoke all on function public.mark_journal_projection_evaluated(uuid,uuid,bigint,bigint,bigint), public.read_journal_checkpoints(uuid,uuid),
  public.begin_journal_checkpoint(uuid,uuid,bigint,bigint,bigint[],jsonb), public.archive_journal_checkpoint_chunk(uuid,uuid,bigint,text[],text[],jsonb),
  public.activate_journal_checkpoint(uuid,uuid,bigint,text[]), public.reopen_journal_checkpoint(uuid,uuid,bigint,bigint),
  public.journal_archived_ref_hits(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.mark_journal_projection_evaluated(uuid,uuid,bigint,bigint,bigint), public.read_journal_checkpoints(uuid,uuid),
  public.begin_journal_checkpoint(uuid,uuid,bigint,bigint,bigint[],jsonb), public.archive_journal_checkpoint_chunk(uuid,uuid,bigint,text[],text[],jsonb),
  public.activate_journal_checkpoint(uuid,uuid,bigint,text[]), public.reopen_journal_checkpoint(uuid,uuid,bigint,bigint),
  public.journal_archived_ref_hits(uuid,uuid,jsonb) to service_role;

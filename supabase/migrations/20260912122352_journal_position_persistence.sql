-- Local draft; coordinate activation with a separately approved backup/export.
create table public.tradovate_journal_projection_heads (
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  revision bigint not null default 0,
  completed_revision bigint not null default 0,
  generation bigint not null default 0,
  import_receipt jsonb,
  primary key (user_id, connection_id)
);
create table public.tradovate_journal_positions (
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  position_id text not null,
  external_account_id bigint not null,
  journal_account_id uuid,
  -- Retained after a user deletes the review row, preventing automatic resurrection.
  trade_id uuid not null default gen_random_uuid(),
  trade_created boolean not null default false,
  revision bigint not null,
  status text not null check (status in ('confirmed', 'pending', 'invalidated')),
  pending_reason text check (pending_reason in ('account-not-linked', 'account-link-conflict', 'invalid-journal-account', 'open', 'incomplete', 'accounting-pending')),
  facts jsonb not null,
  history jsonb not null,
  primary key (user_id, connection_id, position_id),
  unique (user_id, trade_id)
);
create index tradovate_journal_positions_revision_idx on public.tradovate_journal_positions (user_id, connection_id, revision);
alter table public.tradovate_journal_projection_heads enable row level security;
alter table public.tradovate_journal_positions enable row level security;
revoke all on public.tradovate_journal_projection_heads, public.tradovate_journal_positions from public, anon, authenticated;
grant select on public.tradovate_journal_projection_heads, public.tradovate_journal_positions to authenticated;
grant select, insert, update on public.tradovate_journal_projection_heads, public.tradovate_journal_positions to service_role;
create policy "Owner reads projection head" on public.tradovate_journal_projection_heads for select to authenticated using ((select auth.uid()) = user_id);
create policy "Owner reads position evidence" on public.tradovate_journal_positions for select to authenticated using ((select auth.uid()) = user_id);

-- Unpublished large imports are service-only. No partial account set can enter
-- owner reads or statistics. Completed chunks retain hashes for safe retries.
create table public.tradovate_journal_import_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  run_key text not null,
  revision bigint not null,
  chunk_count int not null,
  position_count int not null,
  import_receipt jsonb not null,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  unique(user_id,connection_id,run_key)
);
create table public.tradovate_journal_import_chunks (
  run_id uuid not null references public.tradovate_journal_import_runs(id) on delete cascade,
  chunk_index int not null,
  position_count int not null,
  payload_bytes int not null,
  payload_hash text not null,
  positions jsonb,
  primary key(run_id,chunk_index)
);
alter table public.tradovate_journal_import_runs enable row level security;
alter table public.tradovate_journal_import_chunks enable row level security;
revoke all on public.tradovate_journal_import_runs,public.tradovate_journal_import_chunks from public,anon,authenticated;
grant select,insert,update,delete on public.tradovate_journal_import_runs,public.tradovate_journal_import_chunks to service_role;

-- Legacy identity is the exact final leader fill ID, scoped by its connection.
-- Follower identity additionally requires the recorded copy group and account.
create function public.journal_legacy_identity(p_user_id uuid, p_connection_id uuid, p_history jsonb, p_facts jsonb, p_positions jsonb)
returns text language plpgsql security invoker set search_path='' as $$
declare source_history jsonb := p_history; source_connection uuid := p_connection_id;
  ids text[]; raw_id text; parent_count integer; logical_id text;
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

-- All legacy inserts and new imports share the same owner lock. After cutover,
-- an older browser cannot re-create the obsolete synthetic copier rows.
create function public.protect_journal_trade_identity() returns trigger
language plpgsql security invoker set search_path='' as $$
declare
  k text;
  v jsonb;
  review jsonb := '{}'::jsonb;
begin
  if tg_op='INSERT' and coalesce(new.data->>'copierTradeId','') ~ '^copier-[0-9]+(-[0-9]+)?$' then
    perform pg_advisory_xact_lock(hashtextextended('journal:' || new.user_id::text,0));
    if exists(select 1 from public.tradovate_journal_projection_heads h where h.user_id=new.user_id) then
      raise exception 'journal-legacy-import-retired' using errcode='22023';
    end if;
  elsif tg_op='UPDATE' and current_user in ('authenticated','anon') then
    if old.data ? 'journalSupersededBy' then new.data := new.data || jsonb_build_object('journalSupersededBy',old.data->'journalSupersededBy'); end if;
    if coalesce(old.data->>'copierTradeId','') like 'journal:%' then
      -- Owner review cannot modify broker facts or erase provenance, even from
      -- an older browser that sends a full trade snapshot. Service import owns facts.
      for k,v in select key,value from jsonb_each(coalesce(new.data,'{}'::jsonb)) loop
        if k in ('notes','sessionPreNotes','sessionPostNotes','screenshot','screenshots','drawings',
          'signal','emotions','mistakes','planAdherence','isValid','executionStatus','needsReview',
          'setupType','tags','htfConfluence','ltfConfluence','enrichmentSkipped','isBE',
          'slPlacement','targetType','targetLevel','management','shareNotes','isPublic',
          'miniViewRange','miniViewLayout','miniViewSecondaryRange','miniViewSecondaryTimeframe')
          and (k <> 'executionStatus' or v in ('"Valid"'::jsonb,'"Invalid"'::jsonb)) then
          review := review || jsonb_build_object(k,v);
        end if;
      end loop;
      new.data := old.data || review;
      new.user_id := old.user_id;
      new.instrument := old.instrument;
      new.pnl := old.pnl;
      new.direction := old.direction;
      new.date := old.date;
      new.timestamp := old.timestamp;
      new.data := new.data || jsonb_build_object('copierTradeId',old.data->'copierTradeId');
      if old.data ? 'journalLegacyCopierTradeId' then new.data := new.data || jsonb_build_object('journalLegacyCopierTradeId',old.data->'journalLegacyCopierTradeId'); end if;
      new.account_id := old.account_id;
    end if;
  end if;
  return new;
end; $$;
create trigger protect_journal_trade_identity before insert or update on public.trades for each row execute function public.protect_journal_trade_identity();

-- A stable snapshot of every exact account binding used by the projection.
create function public.journal_import_bindings(p_user_id uuid,p_connection_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'oauth',a.meta->'oauth') order by a.id),'[]'::jsonb)
  from public.accounts a where a.user_id=p_user_id
    and a.meta @> jsonb_build_object('oauth',jsonb_build_object('provider','tradovate','environment','demo','connectionId',p_connection_id::text))
$$;
revoke all on function public.journal_import_bindings(uuid,uuid) from public,anon,authenticated;
grant execute on function public.journal_import_bindings(uuid,uuid) to service_role;

-- One MVCC statement verifies source boundary, projection version and mappings.
-- An unchanged checkpoint is a processed stored snapshot, never broker freshness.
create function public.read_journal_import_checkpoint(p_user_id uuid,p_connection_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare receipt jsonb;
begin
  if not exists(select 1 from public.tradovate_oauth_connections c where c.id=p_connection_id and c.user_id=p_user_id and c.environment='demo') then
    raise exception 'journal-connection-not-found' using errcode='42501';
  end if;
  select jsonb_build_object('accepted',true,'unchanged',true,'through',h.completed_revision,
    'confirmed',h.import_receipt->'confirmed','pending',h.import_receipt->'pending','unassigned',h.import_receipt->'unassigned') into receipt
    from public.tradovate_journal_projection_heads h where h.user_id=p_user_id and h.connection_id=p_connection_id
      and h.revision=h.completed_revision
      and h.completed_revision=coalesce((select max(e.ingest_id) from public.tradovate_journal_evidence e where e.user_id=p_user_id and e.connection_id=p_connection_id and e.environment='demo'),0)
      and h.import_receipt->>'version'='2'
      and h.import_receipt->'accounts'=public.journal_import_bindings(p_user_id,p_connection_id);
  return receipt;
end; $$;
revoke all on function public.read_journal_import_checkpoint(uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_journal_import_checkpoint(uuid,uuid) to service_role;

create function public.persist_tradovate_journal_positions(
  p_user_id uuid, p_connection_id uuid, p_revision bigint, p_positions jsonb, p_import_receipt jsonb default null,
  p_staged_id uuid default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  head public.tradovate_journal_projection_heads%rowtype;
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
      where j.user_id = p_user_id and j.connection_id = p_connection_id
        and not exists (select 1 from supplied p where p.id = j.position_id);
    update public.tradovate_journal_projection_heads h set completed_revision = p_revision, import_receipt = p_import_receipt
      where h.user_id = p_user_id and h.connection_id = p_connection_id;
  end;
  if p_staged_id is not null then
    return jsonb_build_object('accepted',true,'through',p_revision,'positionCount',jsonb_array_length(p_positions));
  end if;
  return jsonb_build_object('accepted',true,'tradeIds',changed_ids);
end;
$$;
revoke all on function public.persist_tradovate_journal_positions(uuid,uuid,bigint,jsonb,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.persist_tradovate_journal_positions(uuid,uuid,bigint,jsonb,jsonb,uuid) to service_role;

create function public.begin_journal_position_stage(p_user_id uuid,p_connection_id uuid,p_revision bigint,
  p_run_key text,p_chunk_count int,p_position_count int,p_import_receipt jsonb)
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
    if run.revision<>p_revision or run.chunk_count<>p_chunk_count or run.position_count<>p_position_count or run.import_receipt is distinct from p_import_receipt then
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
    insert into public.tradovate_journal_import_runs(user_id,connection_id,run_key,revision,chunk_count,position_count,import_receipt)
      values(p_user_id,p_connection_id,p_run_key,p_revision,p_chunk_count,p_position_count,p_import_receipt) returning * into run;
  end if;
  return jsonb_build_object('accepted',true,'runId',run.id,'completedChunks',
    (select coalesce(jsonb_agg(c.chunk_index order by c.chunk_index),'[]'::jsonb) from public.tradovate_journal_import_chunks c where c.run_id=run.id));
end; $$;

create function public.write_journal_position_stage(p_user_id uuid,p_connection_id uuid,p_run_id uuid,p_chunk_index int,p_positions jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare run public.tradovate_journal_import_runs%rowtype; previous public.tradovate_journal_import_chunks%rowtype;
  fingerprint text; size int; rows int;
begin
  select * into run from public.tradovate_journal_import_runs r where r.id=p_run_id and r.user_id=p_user_id and r.connection_id=p_connection_id for update;
  if not found then raise exception 'journal-stage-not-found' using errcode='42501'; end if;
  if p_chunk_index is null or p_chunk_index<0 or p_chunk_index>=run.chunk_count
    or jsonb_typeof(p_positions) is distinct from 'array' or jsonb_array_length(p_positions) not between 1 and 100
    or octet_length(p_positions::text)>2000000 then raise exception 'invalid-journal-stage-chunk' using errcode='22023'; end if;
  fingerprint := encode(sha256(convert_to(p_positions::text,'UTF8')),'hex');
  size := octet_length(p_positions::text); rows := jsonb_array_length(p_positions);
  select * into previous from public.tradovate_journal_import_chunks c where c.run_id=p_run_id and c.chunk_index=p_chunk_index;
  if found then
    if previous.payload_hash<>fingerprint or previous.position_count<>rows or previous.payload_bytes<>size then
      raise exception 'journal-stage-conflict' using errcode='22023';
    end if;
  else
    if run.published then raise exception 'journal-stage-conflict' using errcode='22023'; end if;
    if rows+coalesce((select sum(c.position_count) from public.tradovate_journal_import_chunks c where c.run_id=p_run_id),0)>run.position_count
      or size+coalesce((select sum(c.payload_bytes) from public.tradovate_journal_import_chunks c where c.run_id=p_run_id),0)>128000000 then
      raise exception 'invalid-journal-stage-size' using errcode='22023';
    end if;
    insert into public.tradovate_journal_import_chunks values(p_run_id,p_chunk_index,rows,size,fingerprint,p_positions);
  end if;
  return jsonb_build_object('accepted',true,'chunkIndex',p_chunk_index,'positionCount',rows);
end; $$;

create function public.publish_journal_position_stage(p_user_id uuid,p_connection_id uuid,p_run_id uuid)
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
  ack := public.persist_tradovate_journal_positions(p_user_id,p_connection_id,run.revision,positions,run.import_receipt,run.id);
  if ack->'accepted'='true'::jsonb then
    update public.tradovate_journal_import_runs r set published=true where r.id=run.id;
    update public.tradovate_journal_import_chunks c set positions=null where c.run_id=run.id;
  end if;
  return ack;
end; $$;
revoke all on function public.begin_journal_position_stage(uuid,uuid,bigint,text,int,int,jsonb),public.write_journal_position_stage(uuid,uuid,uuid,int,jsonb),public.publish_journal_position_stage(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_journal_position_stage(uuid,uuid,bigint,text,int,int,jsonb),public.write_journal_position_stage(uuid,uuid,uuid,int,jsonb),public.publish_journal_position_stage(uuid,uuid,uuid) to service_role;

-- Read-only projection for server analytics. Invalidated/pending positions
-- retain their review in trades but cannot enter aggregates as an old result.
-- JSON keys from broker facts replace only the financial allowlist; private
-- execution history never becomes part of this shareable projection.
create view public.confirmed_journal_trades with (security_invoker = true) as
select projected.*
from public.trades t
left join public.tradovate_journal_positions p on p.user_id = t.user_id and p.trade_id = t.id
cross join lateral jsonb_populate_record(null::public.trades,
  case when p.trade_id is null then to_jsonb(t) - 'data' || jsonb_build_object('data', t.data - 'executionHistory')
  else to_jsonb(t) || jsonb_build_object(
    'instrument', p.facts->'instrument', 'pnl', p.facts->'pnl', 'direction', p.facts->'direction',
    'date', p.facts->'date', 'timestamp', p.facts->'timestamp',
    'data', (t.data - array['instrument','direction','pnl','entryPrice','exitPrice','entryTime','entryDate','timestamp','date','exitDate',
      'positionSize','durationMinutes','duration','groupId','isMaster','stopLoss','takeProfit','pnlEstimated','executionHistory']) || p.facts)
  end) projected
where not (t.data ? 'journalSupersededBy') and (
  (p.trade_id is null and coalesce(t.data->>'copierTradeId','') not like 'journal:%'
    and not coalesce(t.data->>'source'='copier',false))
  or (p.status = 'confirmed' and p.journal_account_id = t.account_id));
revoke all on public.confirmed_journal_trades from public, anon, authenticated;
grant select on public.confirmed_journal_trades to authenticated, service_role;

-- Extend the existing public-note scrubber for the new private broker ledger.
-- Its existing grants and three explicitly shareable note fields are preserved.
create or replace function public.strip_trade_private_note_fields_v1(value jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare result jsonb; k text; v jsonb;
begin
  if jsonb_typeof(value) = 'object' then
    result := '{}'::jsonb;
    for k,v in select * from jsonb_each(value) loop
      if k not in ('notes','sessionPreNotes','sessionPostNotes','noteHistory','executionHistory') then
        result := result || jsonb_build_object(k, public.strip_trade_private_note_fields_v1(v));
      end if;
    end loop;
    return result;
  elsif jsonb_typeof(value) = 'array' then
    select coalesce(jsonb_agg(public.strip_trade_private_note_fields_v1(e.value) order by e.ord), '[]'::jsonb)
      into result from jsonb_array_elements(value) with ordinality e(value,ord);
    return result;
  end if;
  return value;
end; $$;

-- Preserve the existing limited public RPC and its necessary definer boundary:
-- only an explicitly public, currently confirmed trade may be returned to anon.
create or replace function public.get_public_trade(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',t.id,'user_id',t.user_id,'account_id',t.account_id,
    'instrument',t.instrument,'pnl',t.pnl,'direction',t.direction,'date',t.date,'timestamp',t.timestamp,
    'drawings',t.drawings,'is_public',t.is_public,'created_at',t.created_at,'share_notes',coalesce(t.share_notes,false),
    'data',public.strip_trade_private_note_fields_v1(coalesce(t.data,'{}'::jsonb)) ||
      case when t.share_notes=true then public.trade_note_fields_v1(n.notes) else '{}'::jsonb end)
  from public.confirmed_journal_trades t left join public.trade_private_notes n on n.trade_id=t.id and n.user_id=t.user_id
  where t.id=p_id and t.is_public=true;
$$;
revoke all on function public.get_public_trade(uuid) from public;
grant execute on function public.get_public_trade(uuid) to anon,authenticated;

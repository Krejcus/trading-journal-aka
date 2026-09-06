-- PREPARED ONLY. Apply only after approved DB backup and coordinated client/server release.
-- Transaction rollback preserves the old schema/data if ANY backfill/ACL check fails.
begin;
lock table public.trades, public.connections in access exclusive mode;

create table public.trade_private_notes (
  trade_id uuid primary key references public.trades(id) on delete cascade deferrable initially deferred,
  user_id uuid not null references auth.users(id) on delete cascade,
  notes jsonb not null default '{}'::jsonb check (jsonb_typeof(notes) = 'object'),
  legacy_fragments jsonb not null default '[]'::jsonb check (jsonb_typeof(legacy_fragments)='array'),
  updated_at timestamptz not null default now()
);
create index trade_private_notes_owner_idx on public.trade_private_notes(user_id);
alter table public.trade_private_notes enable row level security;
revoke all on public.trade_private_notes from public, anon, authenticated;
grant select on public.trade_private_notes to authenticated, service_role;
create policy trade_private_notes_owner_read on public.trade_private_notes for select to authenticated
  using ((select auth.uid()) = user_id and exists (select 1 from public.trades t where t.id = trade_id and t.user_id = (select auth.uid())));

-- Remove copies at EVERY nested location. Preserve their exact JSON in the
-- owner-only recovery column; only the three explicit top-level fields are shared.
create function public.strip_trade_private_note_fields_v1(value jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare result jsonb; k text; v jsonb;
begin
  if jsonb_typeof(value) = 'object' then
    result := '{}'::jsonb;
    for k,v in select * from jsonb_each(value) loop
      if k not in ('notes','sessionPreNotes','sessionPostNotes','noteHistory') then
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
create function public.extract_trade_private_note_fields_v1(value jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare result jsonb := '{}'::jsonb; k text; v jsonb; child jsonb;
begin
  if jsonb_typeof(value) = 'object' then
    for k,v in select * from jsonb_each(value) loop
      if k in ('notes','sessionPreNotes','sessionPostNotes','noteHistory') then result := result || jsonb_build_object(k,v);
      else
        child := public.extract_trade_private_note_fields_v1(v);
        if child is not null then result := result || jsonb_build_object(k,child); end if;
      end if;
    end loop;
  elsif jsonb_typeof(value) = 'array' then
    for k,v in select (ordinality-1)::text, e.value from jsonb_array_elements(value) with ordinality e(value,ordinality) loop
      child := public.extract_trade_private_note_fields_v1(v);
      if child is not null then result := result || jsonb_build_object(k,child); end if;
    end loop;
  end if;
  return nullif(result, '{}'::jsonb);
end; $$;
create function public.trade_note_fields_v1(value jsonb) returns jsonb
language sql immutable security invoker set search_path = '' as $$
  select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) from jsonb_each(case when jsonb_typeof(value)='object' then value else '{}'::jsonb end) e
    where e.key in ('notes','sessionPreNotes','sessionPostNotes');
$$;
revoke all on function public.strip_trade_private_note_fields_v1(jsonb), public.extract_trade_private_note_fields_v1(jsonb), public.trade_note_fields_v1(jsonb) from public, anon;
grant execute on function public.strip_trade_private_note_fields_v1(jsonb), public.trade_note_fields_v1(jsonb) to authenticated;

insert into public.trade_private_notes(trade_id,user_id,notes,legacy_fragments)
  select t.id,t.user_id,public.trade_note_fields_v1(t.data),jsonb_build_array(public.extract_trade_private_note_fields_v1(t.data))
  from public.trades t where public.extract_trade_private_note_fields_v1(t.data) is not null;
update public.trades set data=public.strip_trade_private_note_fields_v1(data)
  where public.extract_trade_private_note_fields_v1(data) is not null;
-- This check fails the transaction if any recognized private key survived.
do $$ begin
  if exists(select 1 from public.trades where public.extract_trade_private_note_fields_v1(data) is not null) then
    raise exception 'Private note backfill verification failed';
  end if;
end; $$;

-- SECURITY DEFINER is deliberate: clients cannot write/read another user's
-- private table. This row trigger only handles the owner row already authorized
-- by trades RLS, and enforces identity before writing its private counterpart.
create function public.capture_trade_private_notes_v1() returns trigger
language plpgsql security definer set search_path = '' as $$
declare note_patch jsonb; recovered jsonb;
begin
  if auth.uid() is not null and auth.uid() is distinct from new.user_id then
    raise exception 'Trade note owner mismatch' using errcode='42501';
  end if;
  if tg_op='UPDATE' and (new.id is distinct from old.id or new.user_id is distinct from old.user_id) then
    raise exception 'Trade private note identity cannot change' using errcode='42501';
  end if;
  note_patch := public.trade_note_fields_v1(new.data);
  recovered := public.extract_trade_private_note_fields_v1(new.data);
  if recovered is not null then
    insert into public.trade_private_notes(trade_id,user_id,notes,legacy_fragments)
      values(new.id,new.user_id,note_patch,jsonb_build_array(recovered))
      on conflict(trade_id) do update set
        notes = trade_private_notes.notes || excluded.notes,
        -- Preserve exact distinct legacy/nested captures for owner recovery.
        -- They are never exposed by the public/connection projection RPC.
        legacy_fragments = case when trade_private_notes.legacy_fragments @> excluded.legacy_fragments
          then trade_private_notes.legacy_fragments else trade_private_notes.legacy_fragments || excluded.legacy_fragments end,
        updated_at=now()
      where trade_private_notes.user_id=new.user_id;
    if not found then raise exception 'Private note write rejected' using errcode='42501'; end if;
  end if;
  new.data := public.strip_trade_private_note_fields_v1(new.data);
  return new;
end; $$;
revoke all on function public.capture_trade_private_notes_v1() from public,anon,authenticated;
create trigger capture_trade_private_notes_v1 before insert or update on public.trades
  for each row execute function public.capture_trade_private_notes_v1();

create table public.connection_trade_note_consents (
  connection_id uuid primary key references public.connections(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  scope jsonb not null,
  confirmed_at timestamptz not null default now()
);
alter table public.connection_trade_note_consents enable row level security;
revoke all on public.connection_trade_note_consents from public, anon, authenticated;
-- No client policies/grants: marker is server-owned and exposed only as a boolean.

create function public.trade_note_consent_scope_v1(permissions jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare enabled boolean; accounts jsonb;
begin
  enabled := case when permissions ? 'canSeeReviewNotes' and permissions->'canSeeReviewNotes' <> 'null'::jsonb
    then permissions->'canSeeReviewNotes' = 'true'::jsonb else coalesce(permissions->'canSeeNotes' = 'true'::jsonb,false) end;
  if permissions->'allowedAccountIds' is null or permissions->'allowedAccountIds' = 'null'::jsonb then accounts:='[]'::jsonb;
  elsif jsonb_typeof(permissions->'allowedAccountIds') <> 'array' then accounts:='["invalid-scope"]'::jsonb;
  elsif exists(select 1 from jsonb_array_elements(permissions->'allowedAccountIds') e where jsonb_typeof(e) <> 'string') then accounts:='["invalid-scope"]'::jsonb;
  else select coalesce(jsonb_agg(value order by value::text),'[]'::jsonb) into accounts from (select distinct value from jsonb_array_elements(permissions->'allowedAccountIds')) a;
  end if;
  return jsonb_build_object('enabled',coalesce(enabled,false),'accounts',accounts);
end; $$;
revoke all on function public.trade_note_consent_scope_v1(jsonb) from public,anon,authenticated;

create function public.guard_connection_owner_consent_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Connection changes require authenticated participant' using errcode='42501'; end if;
  if tg_op='INSERT' then
    if new.sender_id is distinct from auth.uid() or new.status is distinct from 'pending' or new.sender_id=new.receiver_id then
      raise exception 'Only a pending follow request can be created by the sender' using errcode='42501';
    end if;
    -- A request never carries a receiver's privacy consent.
    new.permissions := '{}'::jsonb;
  else
    if new.id is distinct from old.id or new.sender_id is distinct from old.sender_id or new.receiver_id is distinct from old.receiver_id then
      raise exception 'Connection identity is immutable' using errcode='42501';
    end if;
    if auth.uid() is distinct from old.receiver_id then
      if auth.uid() is distinct from old.sender_id or new.status='accepted' or new.permissions is distinct from old.permissions then
        raise exception 'Only the receiver can accept or change sharing permissions' using errcode='42501';
      end if;
    end if;
    if new.status is distinct from old.status or public.trade_note_consent_scope_v1(new.permissions) is distinct from public.trade_note_consent_scope_v1(old.permissions) then
      delete from public.connection_trade_note_consents where connection_id=old.id;
    end if;
  end if;
  return new;
end; $$;
revoke all on function public.guard_connection_owner_consent_v1() from public,anon,authenticated;
create trigger guard_connection_owner_consent_v1 before insert or update on public.connections
  for each row execute function public.guard_connection_owner_consent_v1();

create function public.get_connection_trade_note_consent_v1(p_connection_id uuid,p_expected_permissions jsonb default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c public.connections%rowtype; valid boolean;
begin
  select * into c from public.connections where id=p_connection_id and receiver_id=auth.uid();
  if not found then raise exception 'Connection receiver required' using errcode='42501'; end if;
  select exists(select 1 from public.connection_trade_note_consents m where m.connection_id=c.id
    and m.receiver_id=c.receiver_id and m.sender_id=c.sender_id and m.scope=public.trade_note_consent_scope_v1(c.permissions)) into valid;
  return jsonb_build_object('version',1,'confirmed',c.status='accepted' and valid and (p_expected_permissions is null or c.permissions=p_expected_permissions),'enabled',public.trade_note_consent_scope_v1(c.permissions)->'enabled');
end; $$;

create function public.confirm_connection_trade_notes_v1(p_connection_id uuid,p_expected_permissions jsonb,p_accept boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.connections%rowtype; scope jsonb;
begin
  select * into c from public.connections where id=p_connection_id and receiver_id=auth.uid() for update;
  if not found then raise exception 'Only the receiver can confirm note sharing' using errcode='42501'; end if;
  if c.permissions is distinct from p_expected_permissions and not (p_accept and c.status='pending') then
    raise exception 'Connection settings changed; reload before confirming' using errcode='40001';
  end if;
  if p_accept then
    if c.status is distinct from 'pending' then raise exception 'Request is no longer pending' using errcode='40001'; end if;
    if jsonb_typeof(p_expected_permissions) is distinct from 'object' then raise exception 'Invalid permissions' using errcode='22023'; end if;
    update public.connections set status='accepted',permissions=p_expected_permissions where id=c.id;
    c.status:='accepted'; c.permissions:=p_expected_permissions;
  end if;
  if c.status is distinct from 'accepted' then raise exception 'Accepted connection required' using errcode='22023'; end if;
  scope := public.trade_note_consent_scope_v1(c.permissions);
  if scope->'enabled'='true'::jsonb then
    insert into public.connection_trade_note_consents(connection_id,receiver_id,sender_id,scope)
      values(c.id,c.receiver_id,c.sender_id,scope)
      on conflict(connection_id) do update set scope=excluded.scope,confirmed_at=now(),receiver_id=excluded.receiver_id,sender_id=excluded.sender_id;
  else delete from public.connection_trade_note_consents where connection_id=c.id;
  end if;
  return public.get_connection_trade_note_consent_v1(c.id);
end; $$;
revoke all on function public.get_connection_trade_note_consent_v1(uuid,jsonb), public.confirm_connection_trade_notes_v1(uuid,jsonb,boolean) from public,anon;
grant execute on function public.get_connection_trade_note_consent_v1(uuid,jsonb), public.confirm_connection_trade_notes_v1(uuid,jsonb,boolean) to authenticated;

create function public.get_trade_note_projection_v1(p_trade_ids uuid[],p_context text default 'owner') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;
begin
  if p_context not in ('owner','connection','public') or p_context is null or coalesce(array_length(p_trade_ids,1),0)>200 then
    raise exception 'Invalid trade note projection request' using errcode='22023';
  end if;
  if p_context <> 'public' and auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('tradeId',t.id,'notes',public.trade_note_fields_v1(n.notes))),'[]'::jsonb) into rows
    from public.trades t left join public.trade_private_notes n on n.trade_id=t.id and n.user_id=t.user_id
    where t.id=any(p_trade_ids) and (
      (p_context in ('owner','connection') and t.user_id=auth.uid())
      or (p_context='public' and t.is_public=true and t.share_notes=true)
      or (p_context='connection' and exists (
        select 1 from public.connections c join public.connection_trade_note_consents m on m.connection_id=c.id
        where c.sender_id=auth.uid() and c.receiver_id=t.user_id and c.status='accepted'
          and m.sender_id=c.sender_id and m.receiver_id=c.receiver_id
          and m.scope=public.trade_note_consent_scope_v1(c.permissions) and m.scope->'enabled'='true'::jsonb
          and (m.scope->'accounts'='[]'::jsonb or m.scope->'accounts' ? t.account_id::text)
      ))
    );
  return jsonb_build_object('version',1,'rows',rows);
end; $$;
revoke all on function public.get_trade_note_projection_v1(uuid[],text) from public;
grant execute on function public.get_trade_note_projection_v1(uuid[],text) to anon,authenticated;

-- Keep existing public share URLs/API shape; explicit share_notes is independent
-- of connection reconfirmation. No noteHistory/recovery fragments are projected.
create or replace function public.get_public_trade(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',t.id,'user_id',t.user_id,'account_id',t.account_id,
    'instrument',t.instrument,'pnl',t.pnl,'direction',t.direction,'date',t.date,'timestamp',t.timestamp,
    'drawings',t.drawings,'is_public',t.is_public,'created_at',t.created_at,'share_notes',coalesce(t.share_notes,false),
    'data',public.strip_trade_private_note_fields_v1(coalesce(t.data,'{}'::jsonb)) ||
      case when t.share_notes=true then public.trade_note_fields_v1(n.notes) else '{}'::jsonb end)
  from public.trades t left join public.trade_private_notes n on n.trade_id=t.id and n.user_id=t.user_id
  where t.id=p_id and t.is_public=true;
$$;
revoke all on function public.get_public_trade(uuid) from public;
grant execute on function public.get_public_trade(uuid) to anon,authenticated;

-- Preserve the owner review snapshot and legacy-note CAS after physical splitting.
create or replace function public.patch_backtest_trade_review_private_v1(
  p_trade_id text,
  p_owner_id uuid,
  p_updates jsonb default '{}'::jsonb,
  p_expected jsonb default '{}'::jsonb,
  p_append_screenshot text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  original public.trades%rowtype;
  patched public.trades%rowtype;
  next_data jsonb;
  field text;
  gallery jsonb;
  prior_history jsonb;
  new_history jsonb;
  entry jsonb;
  entry_index bigint;
begin
  if auth.uid() is null or p_owner_id is distinct from auth.uid() then
    raise exception 'Review owner changed or is not authenticated' using errcode = '42501';
  end if;
  if jsonb_typeof(p_updates) is distinct from 'object' or jsonb_typeof(p_expected) is distinct from 'object' then
    raise exception 'Review patch and expected fields must be objects' using errcode = '22023';
  end if;
  if p_updates ?| array['id', 'user_id', 'accountId', 'backtestRunId'] then
    raise exception 'Review cannot move a trade or change its identity' using errcode = '22023';
  end if;
  select t.* into original from public.trades t
    where t.id = (jsonb_populate_record(null::public.trades, jsonb_build_object('id', p_trade_id))).id
      and t.user_id = p_owner_id
    for update;
  if not found then raise exception 'Backtest trade not found' using errcode = 'P0002'; end if;
  if original.backtest_run_id is null and nullif(original.data->>'backtestRunId', '') is null then
    raise exception 'Atomic backtest review only accepts a backtest trade' using errcode = '22023';
  end if;
  next_data := coalesce(original.data, '{}'::jsonb) - 'noteHistory';
  -- CAS compares the authoritative private legacy fields, not the stripped blob.
  next_data := next_data || coalesce((select n.notes from public.trade_private_notes n
    where n.trade_id=original.id and n.user_id=p_owner_id), '{}'::jsonb);
  select h.history into prior_history from public.backtest_trade_note_histories h
    where h.trade_id = original.id and h.user_id = p_owner_id;
  if prior_history is not null then next_data := next_data || jsonb_build_object('noteHistory', prior_history); end if;
  if jsonb_typeof(next_data) is distinct from 'object' then
    raise exception 'Stored backtest review is not an object; preserve it for recovery' using errcode = '22023';
  end if;
  -- Identity and root trade facts come from canonical columns, never stale JSON.
  next_data := next_data || jsonb_build_object(
    'id', original.id, 'accountId', original.account_id,
    'backtestRunId', coalesce(original.backtest_run_id::text, nullif(next_data->>'backtestRunId', '')),
    'instrument', original.instrument, 'pnl', original.pnl, 'direction', original.direction,
    'date', original.date, 'timestamp', original.timestamp,
    'drawings', coalesce(original.drawings, next_data->'drawings', '[]'::jsonb), 'isPublic', original.is_public);
  -- An uncertain successful append may be retried after another append. The
  -- exact already-stored prefix is an ACK, never a request to erase the suffix.
  if prior_history is not null and p_updates ? 'noteHistory' then
    new_history := p_updates->'noteHistory';
    if new_history->>'version' = '1' and jsonb_typeof(new_history->'revisions') = 'array' then
      if jsonb_array_length(new_history->'revisions') > 0
         and new_history->'revision' = to_jsonb(jsonb_array_length(new_history->'revisions'))
         and jsonb_array_length(new_history->'revisions') <= jsonb_array_length(prior_history->'revisions')
         and not exists (select 1 from jsonb_array_elements(new_history->'revisions') with ordinality e(value, ord)
           where prior_history->'revisions'->(e.ord::int - 1) is distinct from e.value) then
        p_updates := jsonb_set(p_updates, '{noteHistory}', prior_history);
      end if;
    end if;
  end if;
  -- Empty patch is a read-only readiness/snapshot check before an image upload.
  if p_updates = '{}'::jsonb and p_append_screenshot is null then
    return jsonb_build_object('id', original.id, 'data', next_data, 'privateNotes', jsonb_build_object('version', 1, 'storage', 'owner-table'));
  end if;
  for field in select jsonb_object_keys(p_updates) loop
    if (next_data->field) is distinct from (p_expected->field)
       and (next_data->field) is distinct from (p_updates->field) then
      raise exception 'Review field changed concurrently: %', field using errcode = '40001';
    end if;
  end loop;
  if p_updates ? 'noteHistory' then
    new_history := p_updates->'noteHistory';
    if jsonb_typeof(new_history) is distinct from 'object'
       or new_history->>'version' is distinct from '1'
       or jsonb_typeof(new_history->'revisions') is distinct from 'array'
       or jsonb_typeof(new_history->'revision') is distinct from 'number' then
      raise exception 'Invalid private note history envelope' using errcode = '22023';
    end if;
    if (new_history->>'revision')::numeric <> jsonb_array_length(new_history->'revisions') then
      raise exception 'Private note history revision count mismatch' using errcode = '22023';
    end if;
    -- Existing history is immutable: later edits append revisions; retries may
    -- resend exactly the same history. This is not authenticated market time.
    if prior_history is not null then
      if jsonb_array_length(new_history->'revisions') < jsonb_array_length(prior_history->'revisions') then
        raise exception 'Private note history cannot lose revisions' using errcode = '22023';
      end if;
      for entry, entry_index in select value, ordinality from jsonb_array_elements(prior_history->'revisions') with ordinality loop
        if new_history->'revisions'->(entry_index::int - 1) is distinct from entry then
          raise exception 'Private note history cannot rewrite prior revisions' using errcode = '22023';
        end if;
      end loop;
    end if;
    if new_history is distinct from prior_history then
      if octet_length(new_history::text) > 2097152 then
        raise exception 'Private note history exceeds 2 MiB; preserve the draft' using errcode = '22023';
      end if;
      for entry, entry_index in select value, ordinality from jsonb_array_elements(new_history->'revisions') with ordinality loop
        if jsonb_typeof(entry) is distinct from 'object'
           or coalesce(entry->>'phase', '') not in ('before', 'during', 'after')
           or coalesce(entry->>'operation', '') not in ('write', 'clear')
           or entry->>'source' is distinct from 'user'
           or jsonb_typeof(entry->'text') is distinct from 'string'
           or entry->'revision' is distinct from to_jsonb(entry_index)
           or entry->'parentRevision' is distinct from to_jsonb(entry_index - 1) then
          raise exception 'Invalid private note revision' using errcode = '22023';
        end if;
        if entry_index > coalesce(jsonb_array_length(prior_history->'revisions'), 0)
           and length(entry->>'text') > 20000 then
          raise exception 'New private note exceeds text limit; preserve the draft' using errcode = '22023';
        end if;
      end loop;
      insert into public.backtest_trade_note_histories(trade_id, user_id, history)
        values (original.id, p_owner_id, new_history)
        on conflict (trade_id) do update set history = excluded.history, updated_at = now()
        where backtest_trade_note_histories.user_id = p_owner_id;
      if not found then raise exception 'Private note write was not confirmed' using errcode = '42501'; end if;
    end if;
  end if;
  next_data := next_data || p_updates;
  if p_append_screenshot is not null then
    if p_append_screenshot !~ '^https?://' or length(p_append_screenshot) > 8192 then
      raise exception 'Invalid uploaded screenshot URL' using errcode = '22023';
    end if;
    if p_updates ?| array['screenshot', 'screenshots'] then
      raise exception 'Append and replace gallery cannot be combined' using errcode = '22023';
    end if;
    -- Preserve the first occurrence and primary image while appending atomically.
    select coalesce(jsonb_agg(to_jsonb(url) order by first_seen), '[]'::jsonb) into gallery
      from (
        select url, min(ord) as first_seen
        from jsonb_array_elements_text(
          (case when jsonb_typeof(next_data->'screenshots') = 'array' then next_data->'screenshots' else '[]'::jsonb end)
          || (case when nullif(next_data->>'screenshot', '') is not null then jsonb_build_array(next_data->>'screenshot') else '[]'::jsonb end)
          || jsonb_build_array(p_append_screenshot)
        ) with ordinality as urls(url, ord)
        group by url
      ) unique_urls;
    next_data := next_data || jsonb_build_object(
      'screenshot', coalesce(nullif(next_data->>'screenshot', ''), p_append_screenshot), 'screenshots', gallery);
  end if;
  -- Known root columns keep the same types as the existing trades schema.
  select * into patched from jsonb_populate_record(original, p_updates || jsonb_build_object(
    'data', next_data - 'noteHistory', 'is_public', case when p_updates ? 'isPublic' then p_updates->'isPublic' else to_jsonb(original.is_public) end));
  update public.trades t set
    data = next_data - 'noteHistory', instrument = patched.instrument, pnl = patched.pnl,
    direction = patched.direction, date = patched.date, timestamp = patched.timestamp,
    signal = patched.signal, drawings = patched.drawings, is_public = patched.is_public
    where t.id = original.id and t.user_id = p_owner_id;
  if not found then raise exception 'Backtest review update was not confirmed' using errcode = '42501'; end if;
  return jsonb_build_object('id', original.id, 'data', next_data, 'privateNotes', jsonb_build_object('version', 1, 'storage', 'owner-table'));
end;
$$;

-- Common older clients use get_dashboard_data; preserve its owner payload shape.
-- The renamed implementation retains its original auth check, data and grants.
alter function public.get_dashboard_data() rename to get_dashboard_data_without_trade_notes_v1;
create function public.get_dashboard_data() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb; projected jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  result := public.get_dashboard_data_without_trade_notes_v1();
  select coalesce(jsonb_agg(jsonb_set(e.value,'{data}',
    public.strip_trade_private_note_fields_v1(coalesce(e.value->'data','{}'::jsonb)) || public.trade_note_fields_v1(n.notes)
  ) order by e.ord),'[]'::jsonb) into projected
  from jsonb_array_elements(coalesce(result->'trades','[]'::jsonb)) with ordinality e(value,ord)
  left join public.trade_private_notes n on n.trade_id::text=e.value->>'id' and n.user_id=auth.uid();
  return jsonb_set(result,'{trades}',projected);
end; $$;
revoke all on function public.get_dashboard_data() from public,anon;
grant execute on function public.get_dashboard_data() to authenticated;
notify pgrst, 'reload schema';
commit;

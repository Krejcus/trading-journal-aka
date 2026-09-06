-- PREPARED ONLY. Requires separate approved DB activation after backup.
-- History stays out of public/shareable trades.data and old public RPCs.
create table public.backtest_trade_note_histories (
  trade_id uuid primary key references public.trades(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  history jsonb not null check (jsonb_typeof(history) = 'object'),
  updated_at timestamptz not null default now()
);
create index backtest_trade_note_histories_owner_idx on public.backtest_trade_note_histories(user_id);
alter table public.backtest_trade_note_histories enable row level security;
revoke all on public.backtest_trade_note_histories from public, anon, authenticated;
grant select, insert, update on public.backtest_trade_note_histories to authenticated;
create policy private_trade_note_select on public.backtest_trade_note_histories for select to authenticated
  using ((select auth.uid()) = user_id and exists (
    select 1 from public.trades t where t.id = trade_id and t.user_id = (select auth.uid())));
create policy private_trade_note_insert on public.backtest_trade_note_histories for insert to authenticated
  with check ((select auth.uid()) = user_id and exists (
    select 1 from public.trades t where t.id = trade_id and t.user_id = (select auth.uid())
      and (t.backtest_run_id is not null or nullif(t.data->>'backtestRunId', '') is not null)));
create policy private_trade_note_update on public.backtest_trade_note_histories for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id and exists (
    select 1 from public.trades t where t.id = trade_id and t.user_id = (select auth.uid())
      and (t.backtest_run_id is not null or nullif(t.data->>'backtestRunId', '') is not null)));
comment on table public.backtest_trade_note_histories is
  'Owner-only note revision history. Never merged into trades.data, public shares or social projections. Client capture times are not server-attested.';

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
revoke all on function public.patch_backtest_trade_review_private_v1(text, uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.patch_backtest_trade_review_private_v1(text, uuid, jsonb, jsonb, text) to authenticated;

-- Upgrade the old route as well, while new clients require the versioned name
-- for history writes. Missing/old servers therefore fail before upload/write.
create or replace function public.patch_backtest_trade_review(
  p_trade_id text, p_owner_id uuid, p_updates jsonb default '{}'::jsonb,
  p_expected jsonb default '{}'::jsonb, p_append_screenshot text default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select public.patch_backtest_trade_review_private_v1(p_trade_id, p_owner_id, p_updates, p_expected, p_append_screenshot);
$$;
revoke all on function public.patch_backtest_trade_review(text, uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.patch_backtest_trade_review(text, uuid, jsonb, jsonb, text) to authenticated;

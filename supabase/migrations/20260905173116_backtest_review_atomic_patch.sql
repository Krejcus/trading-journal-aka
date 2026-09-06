-- Activate only after a separately approved database backup and deployment.
-- No table shape/RLS changes. Invoker privileges and the existing policies apply.
create or replace function public.patch_backtest_trade_review(
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
  next_data := coalesce(original.data, '{}'::jsonb);
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
  -- Empty patch is a read-only readiness/snapshot check before an image upload.
  if p_updates = '{}'::jsonb and p_append_screenshot is null then
    return jsonb_build_object('id', original.id, 'data', next_data);
  end if;
  for field in select jsonb_object_keys(p_updates) loop
    if (next_data->field) is distinct from (p_expected->field)
       and (next_data->field) is distinct from (p_updates->field) then
      raise exception 'Review field changed concurrently: %', field using errcode = '40001';
    end if;
  end loop;
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
    'data', next_data, 'is_public', case when p_updates ? 'isPublic' then p_updates->'isPublic' else to_jsonb(original.is_public) end));
  update public.trades t set
    data = next_data, instrument = patched.instrument, pnl = patched.pnl,
    direction = patched.direction, date = patched.date, timestamp = patched.timestamp,
    signal = patched.signal, drawings = patched.drawings, is_public = patched.is_public
    where t.id = original.id and t.user_id = p_owner_id;
  if not found then raise exception 'Backtest review update was not confirmed' using errcode = '42501'; end if;
  return jsonb_build_object('id', original.id, 'data', next_data);
end;
$$;
revoke all on function public.patch_backtest_trade_review(text, uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.patch_backtest_trade_review(text, uuid, jsonb, jsonb, text) to authenticated;
comment on function public.patch_backtest_trade_review(text, uuid, jsonb, jsonb, text) is
  'Owner-scoped atomic backtest review patch; preserves unrelated concurrent changes and appends screenshots under row lock.';

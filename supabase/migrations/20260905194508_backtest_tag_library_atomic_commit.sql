-- LOCAL ONLY: activate after approved backup and RLS/API exposure review.
-- alphatrade_private must NOT be in Data API / GraphQL exposed schemas.
create schema if not exists alphatrade_private;
revoke all on schema alphatrade_private from public, anon;
grant usage on schema alphatrade_private to authenticated;

create table alphatrade_private.backtest_tag_libraries (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null check (revision >= 0),
  library jsonb not null,
  updated_at timestamptz not null default now()
);
create table alphatrade_private.backtest_tag_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id text not null check (operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  request_hash text not null check (length(request_hash) = 64),
  library_revision bigint not null,
  committed_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);
alter table alphatrade_private.backtest_tag_libraries enable row level security;
alter table alphatrade_private.backtest_tag_operations enable row level security;
create policy backtest_tag_library_owner on alphatrade_private.backtest_tag_libraries to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy backtest_tag_operation_owner on alphatrade_private.backtest_tag_operations to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on alphatrade_private.backtest_tag_libraries, alphatrade_private.backtest_tag_operations from public, anon, authenticated;
grant select, insert, update on alphatrade_private.backtest_tag_libraries to authenticated;
grant select, insert on alphatrade_private.backtest_tag_operations to authenticated;

-- Client-compatible NFC/caseless identity; this does not authorize any trade write.
create function alphatrade_private.backtest_tag_key_v1(p_label text) returns text
language sql immutable security invoker set search_path = '' as $fn$
  select normalize(coalesce(string_agg(coalesce(fold.mapping->>chars.c, lower(chars.c)), '' order by chars.ord), ''), NFC)
  from regexp_split_to_table(normalize(regexp_replace(btrim(p_label), '\s+', ' ', 'g'), NFC), '') with ordinality chars(c, ord)
  cross join (select $fold${"\u00b5":"\u03bc","\u00df":"ss","\u0149":"\u02bcn","\u017f":"s","\u01f0":"j\u030c","\u0345":"\u03b9","\u0390":"\u03b9\u0308\u0301","\u03b0":"\u03c5\u0308\u0301","\u03c2":"\u03c3","\u03d0":"\u03b2","\u03d1":"\u03b8","\u03d5":"\u03c6","\u03d6":"\u03c0","\u03f0":"\u03ba","\u03f1":"\u03c1","\u03f5":"\u03b5","\u0587":"\u0565\u0582","\u13a0":"\u13a0","\u13a1":"\u13a1","\u13a2":"\u13a2","\u13a3":"\u13a3","\u13a4":"\u13a4","\u13a5":"\u13a5","\u13a6":"\u13a6","\u13a7":"\u13a7","\u13a8":"\u13a8","\u13a9":"\u13a9","\u13aa":"\u13aa","\u13ab":"\u13ab","\u13ac":"\u13ac","\u13ad":"\u13ad","\u13ae":"\u13ae","\u13af":"\u13af","\u13b0":"\u13b0","\u13b1":"\u13b1","\u13b2":"\u13b2","\u13b3":"\u13b3","\u13b4":"\u13b4","\u13b5":"\u13b5","\u13b6":"\u13b6","\u13b7":"\u13b7","\u13b8":"\u13b8","\u13b9":"\u13b9","\u13ba":"\u13ba","\u13bb":"\u13bb","\u13bc":"\u13bc","\u13bd":"\u13bd","\u13be":"\u13be","\u13bf":"\u13bf","\u13c0":"\u13c0","\u13c1":"\u13c1","\u13c2":"\u13c2","\u13c3":"\u13c3","\u13c4":"\u13c4","\u13c5":"\u13c5","\u13c6":"\u13c6","\u13c7":"\u13c7","\u13c8":"\u13c8","\u13c9":"\u13c9","\u13ca":"\u13ca","\u13cb":"\u13cb","\u13cc":"\u13cc","\u13cd":"\u13cd","\u13ce":"\u13ce","\u13cf":"\u13cf","\u13d0":"\u13d0","\u13d1":"\u13d1","\u13d2":"\u13d2","\u13d3":"\u13d3","\u13d4":"\u13d4","\u13d5":"\u13d5","\u13d6":"\u13d6","\u13d7":"\u13d7","\u13d8":"\u13d8","\u13d9":"\u13d9","\u13da":"\u13da","\u13db":"\u13db","\u13dc":"\u13dc","\u13dd":"\u13dd","\u13de":"\u13de","\u13df":"\u13df","\u13e0":"\u13e0","\u13e1":"\u13e1","\u13e2":"\u13e2","\u13e3":"\u13e3","\u13e4":"\u13e4","\u13e5":"\u13e5","\u13e6":"\u13e6","\u13e7":"\u13e7","\u13e8":"\u13e8","\u13e9":"\u13e9","\u13ea":"\u13ea","\u13eb":"\u13eb","\u13ec":"\u13ec","\u13ed":"\u13ed","\u13ee":"\u13ee","\u13ef":"\u13ef","\u13f0":"\u13f0","\u13f1":"\u13f1","\u13f2":"\u13f2","\u13f3":"\u13f3","\u13f4":"\u13f4","\u13f5":"\u13f5","\u13f8":"\u13f0","\u13f9":"\u13f1","\u13fa":"\u13f2","\u13fb":"\u13f3","\u13fc":"\u13f4","\u13fd":"\u13f5","\u1c80":"\u0432","\u1c81":"\u0434","\u1c82":"\u043e","\u1c83":"\u0441","\u1c84":"\u0442","\u1c85":"\u0442","\u1c86":"\u044a","\u1c87":"\u0463","\u1c88":"\ua64b","\u1e96":"h\u0331","\u1e97":"t\u0308","\u1e98":"w\u030a","\u1e99":"y\u030a","\u1e9a":"a\u02be","\u1e9b":"\u1e61","\u1e9e":"ss","\u1f50":"\u03c5\u0313","\u1f52":"\u03c5\u0313\u0300","\u1f54":"\u03c5\u0313\u0301","\u1f56":"\u03c5\u0313\u0342","\u1f80":"\u1f00\u03b9","\u1f81":"\u1f01\u03b9","\u1f82":"\u1f02\u03b9","\u1f83":"\u1f03\u03b9","\u1f84":"\u1f04\u03b9","\u1f85":"\u1f05\u03b9","\u1f86":"\u1f06\u03b9","\u1f87":"\u1f07\u03b9","\u1f88":"\u1f00\u03b9","\u1f89":"\u1f01\u03b9","\u1f8a":"\u1f02\u03b9","\u1f8b":"\u1f03\u03b9","\u1f8c":"\u1f04\u03b9","\u1f8d":"\u1f05\u03b9","\u1f8e":"\u1f06\u03b9","\u1f8f":"\u1f07\u03b9","\u1f90":"\u1f20\u03b9","\u1f91":"\u1f21\u03b9","\u1f92":"\u1f22\u03b9","\u1f93":"\u1f23\u03b9","\u1f94":"\u1f24\u03b9","\u1f95":"\u1f25\u03b9","\u1f96":"\u1f26\u03b9","\u1f97":"\u1f27\u03b9","\u1f98":"\u1f20\u03b9","\u1f99":"\u1f21\u03b9","\u1f9a":"\u1f22\u03b9","\u1f9b":"\u1f23\u03b9","\u1f9c":"\u1f24\u03b9","\u1f9d":"\u1f25\u03b9","\u1f9e":"\u1f26\u03b9","\u1f9f":"\u1f27\u03b9","\u1fa0":"\u1f60\u03b9","\u1fa1":"\u1f61\u03b9","\u1fa2":"\u1f62\u03b9","\u1fa3":"\u1f63\u03b9","\u1fa4":"\u1f64\u03b9","\u1fa5":"\u1f65\u03b9","\u1fa6":"\u1f66\u03b9","\u1fa7":"\u1f67\u03b9","\u1fa8":"\u1f60\u03b9","\u1fa9":"\u1f61\u03b9","\u1faa":"\u1f62\u03b9","\u1fab":"\u1f63\u03b9","\u1fac":"\u1f64\u03b9","\u1fad":"\u1f65\u03b9","\u1fae":"\u1f66\u03b9","\u1faf":"\u1f67\u03b9","\u1fb2":"\u1f70\u03b9","\u1fb3":"\u03b1\u03b9","\u1fb4":"\u03ac\u03b9","\u1fb6":"\u03b1\u0342","\u1fb7":"\u03b1\u0342\u03b9","\u1fbc":"\u03b1\u03b9","\u1fbe":"\u03b9","\u1fc2":"\u1f74\u03b9","\u1fc3":"\u03b7\u03b9","\u1fc4":"\u03ae\u03b9","\u1fc6":"\u03b7\u0342","\u1fc7":"\u03b7\u0342\u03b9","\u1fcc":"\u03b7\u03b9","\u1fd2":"\u03b9\u0308\u0300","\u1fd3":"\u03b9\u0308\u0301","\u1fd6":"\u03b9\u0342","\u1fd7":"\u03b9\u0308\u0342","\u1fe2":"\u03c5\u0308\u0300","\u1fe3":"\u03c5\u0308\u0301","\u1fe4":"\u03c1\u0313","\u1fe6":"\u03c5\u0342","\u1fe7":"\u03c5\u0308\u0342","\u1ff2":"\u1f7c\u03b9","\u1ff3":"\u03c9\u03b9","\u1ff4":"\u03ce\u03b9","\u1ff6":"\u03c9\u0342","\u1ff7":"\u03c9\u0342\u03b9","\u1ffc":"\u03c9\u03b9","\uab70":"\u13a0","\uab71":"\u13a1","\uab72":"\u13a2","\uab73":"\u13a3","\uab74":"\u13a4","\uab75":"\u13a5","\uab76":"\u13a6","\uab77":"\u13a7","\uab78":"\u13a8","\uab79":"\u13a9","\uab7a":"\u13aa","\uab7b":"\u13ab","\uab7c":"\u13ac","\uab7d":"\u13ad","\uab7e":"\u13ae","\uab7f":"\u13af","\uab80":"\u13b0","\uab81":"\u13b1","\uab82":"\u13b2","\uab83":"\u13b3","\uab84":"\u13b4","\uab85":"\u13b5","\uab86":"\u13b6","\uab87":"\u13b7","\uab88":"\u13b8","\uab89":"\u13b9","\uab8a":"\u13ba","\uab8b":"\u13bb","\uab8c":"\u13bc","\uab8d":"\u13bd","\uab8e":"\u13be","\uab8f":"\u13bf","\uab90":"\u13c0","\uab91":"\u13c1","\uab92":"\u13c2","\uab93":"\u13c3","\uab94":"\u13c4","\uab95":"\u13c5","\uab96":"\u13c6","\uab97":"\u13c7","\uab98":"\u13c8","\uab99":"\u13c9","\uab9a":"\u13ca","\uab9b":"\u13cb","\uab9c":"\u13cc","\uab9d":"\u13cd","\uab9e":"\u13ce","\uab9f":"\u13cf","\uaba0":"\u13d0","\uaba1":"\u13d1","\uaba2":"\u13d2","\uaba3":"\u13d3","\uaba4":"\u13d4","\uaba5":"\u13d5","\uaba6":"\u13d6","\uaba7":"\u13d7","\uaba8":"\u13d8","\uaba9":"\u13d9","\uabaa":"\u13da","\uabab":"\u13db","\uabac":"\u13dc","\uabad":"\u13dd","\uabae":"\u13de","\uabaf":"\u13df","\uabb0":"\u13e0","\uabb1":"\u13e1","\uabb2":"\u13e2","\uabb3":"\u13e3","\uabb4":"\u13e4","\uabb5":"\u13e5","\uabb6":"\u13e6","\uabb7":"\u13e7","\uabb8":"\u13e8","\uabb9":"\u13e9","\uabba":"\u13ea","\uabbb":"\u13eb","\uabbc":"\u13ec","\uabbd":"\u13ed","\uabbe":"\u13ee","\uabbf":"\u13ef","\ufb00":"ff","\ufb01":"fi","\ufb02":"fl","\ufb03":"ffi","\ufb04":"ffl","\ufb05":"st","\ufb06":"st","\ufb13":"\u0574\u0576","\ufb14":"\u0574\u0565","\ufb15":"\u0574\u056b","\ufb16":"\u057e\u0576","\ufb17":"\u0574\u056d"}$fold$::jsonb mapping) fold;
$fn$;

create function alphatrade_private.validate_backtest_tag_library_v1(p_library jsonb, p_owner uuid) returns void
language plpgsql security invoker set search_path = '' as $fn$
declare tag jsonb; alias jsonb; node jsonb; labels jsonb := '{}'::jsonb; ids jsonb := '{}'::jsonb; key text; terminal text; seen text[]; name text;
begin
  if jsonb_typeof(p_library) is distinct from 'object' or p_library->'version' is distinct from '1'::jsonb
    or p_library->>'ownerId' is distinct from p_owner::text or jsonb_typeof(p_library->'tags') is distinct from 'array'
    or jsonb_typeof(p_library->'revision') is distinct from 'number' or (p_library->>'revision') !~ '^(0|[1-9][0-9]*)$' or length(p_library->>'revision') > 15
    or (p_library - array['version','ownerId','revision','tags']) <> '{}'::jsonb
    or octet_length(p_library::text) > 1048576 then
    raise exception 'Invalid tag library envelope' using errcode='22023';
  end if;
  if jsonb_array_length(p_library->'tags') > 500 then raise exception 'Tag library exceeds 500 entries' using errcode='22023'; end if;
  for tag in select value from jsonb_array_elements(p_library->'tags') loop
    if jsonb_typeof(tag) is distinct from 'object' or jsonb_typeof(tag->'id') is distinct from 'string' or coalesce(tag->>'id','') !~ '^[A-Za-z0-9_-]{1,160}$' or ids ? (tag->>'id')
      or jsonb_typeof(tag->'label') is distinct from 'string' or length(tag->>'label') not between 1 and 80
      or tag->>'label' <> normalize(regexp_replace(btrim(tag->>'label'), '\s+', ' ', 'g'), NFC) or position(',' in tag->>'label') > 0
      or coalesce(tag->>'category','') not in ('setup','mistake','context') or coalesce(tag->>'status','') not in ('active','archived','deleted','merged')
      or jsonb_typeof(tag->'aliases') is distinct from 'array' or (tag - array['id','label','category','aliases','status','mergedIntoId']) <> '{}'::jsonb
      or (case when tag->>'status' = 'merged' then jsonb_typeof(tag->'mergedIntoId') is distinct from 'string' or coalesce(tag->>'mergedIntoId','') !~ '^[A-Za-z0-9_-]{1,160}$' else tag ? 'mergedIntoId' end) then
      raise exception 'Invalid tag identity, metadata or aliases' using errcode='22023';
    end if;
    if jsonb_array_length(tag->'aliases') > 32 then raise exception 'Tag exceeds 32 aliases' using errcode='22023'; end if;
    seen := array[alphatrade_private.backtest_tag_key_v1(tag->>'label')];
    for alias in select value from jsonb_array_elements(tag->'aliases') loop
      if jsonb_typeof(alias) is distinct from 'string' then raise exception 'Alias must be text' using errcode='22023'; end if;
      name := alias #>> '{}'; key := alphatrade_private.backtest_tag_key_v1(name);
      if length(name) not between 1 and 80 or name <> normalize(regexp_replace(btrim(name), '\s+', ' ', 'g'), NFC)
        or position(',' in name) > 0 or key = any(seen) then raise exception 'Invalid or duplicate alias' using errcode='22023'; end if;
      seen := array_append(seen, key);
    end loop;
    ids := ids || jsonb_build_object(tag->>'id', tag);
  end loop;
  for tag in select value from jsonb_array_elements(p_library->'tags') loop
    node := tag; seen := '{}'::text[];
    while node->>'status' = 'merged' loop
      if node->>'id' = any(seen) or not (ids ? (node->>'mergedIntoId')) then raise exception 'Missing or cyclic merge target' using errcode='22023'; end if;
      seen := array_append(seen,node->>'id'); node := ids->(node->>'mergedIntoId');
    end loop;
    terminal := node->>'id';
    for name in select value from jsonb_array_elements_text(jsonb_build_array(tag->>'label') || (tag->'aliases')) loop
      key := alphatrade_private.backtest_tag_key_v1(name);
      if labels ? key and labels->>key <> terminal then raise exception 'Ambiguous tag alias' using errcode='22023'; end if;
      labels := labels || jsonb_build_object(key,terminal);
    end loop;
  end loop;
end;
$fn$;

create function public.get_backtest_tag_library_v1() returns jsonb
language plpgsql security invoker set search_path = '' as $fn$
declare result jsonb; owner_id uuid := auth.uid();
begin
  if owner_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select l.library into result from alphatrade_private.backtest_tag_libraries l where l.user_id=owner_id;
  return coalesce(result,jsonb_build_object('version',1,'ownerId',owner_id,'revision',0,'tags','[]'::jsonb));
end;
$fn$;

create function public.commit_backtest_tag_library_v1(
  p_owner_id uuid, p_operation_id text, p_expected_library jsonb, p_library jsonb,
  p_scope jsonb, p_scope_snapshots jsonb, p_trade_patches jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $fn$
declare current_library jsonb; empty_library jsonb; request_hash text; receipt_hash text;
  expected jsonb; row_snapshot jsonb; entry jsonb; patch jsonb; field text; value jsonb; generated jsonb;
  requested_id text; scope_fields text[]; comparison_fields text[]; ids text[]; patch_ids text[] := '{}'; snapshot_ids text[] := '{}';
  actual public.trades%rowtype; current_values jsonb; next_data jsonb; result_patches jsonb := '[]'::jsonb;
  already_applied boolean := false; owner_id uuid := auth.uid();
begin
  if owner_id is null or p_owner_id is distinct from owner_id then raise exception 'Tag library owner changed' using errcode='42501'; end if;
  if p_operation_id is null or p_operation_id !~ '^[A-Za-z0-9_-]{1,160}$' then raise exception 'Invalid tag operation ID' using errcode='22023'; end if;
  if octet_length(jsonb_build_array(p_owner_id,p_operation_id,p_expected_library,p_library,p_scope,p_scope_snapshots,p_trade_patches)::text) > 2097152 then
    raise exception 'Tag transaction exceeds 2 MiB' using errcode='22023';
  end if;
  perform alphatrade_private.validate_backtest_tag_library_v1(p_expected_library,owner_id);
  perform alphatrade_private.validate_backtest_tag_library_v1(p_library,owner_id);
  if (p_library->>'revision')::bigint <> (p_expected_library->>'revision')::bigint + 1 then raise exception 'Invalid next library revision' using errcode='22023'; end if;
  -- Stable tag IDs cannot disappear: deletion is an explicit tombstone.
  if exists(select 1 from jsonb_array_elements(p_expected_library->'tags') old where not exists(select 1 from jsonb_array_elements(p_library->'tags') new where new->>'id'=old->>'id')) then
    raise exception 'Historical tag identities cannot be deleted' using errcode='22023';
  end if;
  if jsonb_typeof(p_scope) is distinct from 'object' or (p_scope - array['tradeIds','fields']) <> '{}'::jsonb
    or jsonb_typeof(p_scope->'tradeIds') is distinct from 'array' or jsonb_typeof(p_scope->'fields') is distinct from 'array'
    or jsonb_typeof(p_scope_snapshots) is distinct from 'array' or jsonb_typeof(p_trade_patches) is distinct from 'array' then
    raise exception 'Invalid explicit tag scope' using errcode='22023';
  end if;
  if jsonb_array_length(p_scope->'tradeIds') > 500 or jsonb_array_length(p_scope_snapshots) > 500 or jsonb_array_length(p_trade_patches)>500 then
    raise exception 'Tag scope exceeds 500 trades' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_scope->'tradeIds') v where jsonb_typeof(v) <> 'string')
    or exists(select 1 from jsonb_array_elements(p_scope->'fields') v where jsonb_typeof(v) <> 'string') then raise exception 'Scope entries must be strings' using errcode='22023'; end if;
  select coalesce(array_agg(v.item),'{}') into ids from jsonb_array_elements_text(p_scope->'tradeIds') v(item);
  select coalesce(array_agg(v.item),'{}') into scope_fields from jsonb_array_elements_text(p_scope->'fields') v(item);
  if cardinality(ids) <> (select count(distinct x) from unnest(ids) x) or cardinality(scope_fields) <> (select count(distinct x) from unnest(scope_fields) x)
    or not scope_fields <@ array['tags','htfConfluence','ltfConfluence']::text[] then raise exception 'Duplicate or invalid tag scope' using errcode='22023'; end if;
  comparison_fields := scope_fields;
  if scope_fields && array['htfConfluence','ltfConfluence'] then comparison_fields := array_append(comparison_fields,'autoConfluence'); end if;
  for entry in select * from jsonb_array_elements(p_scope_snapshots) loop
    if jsonb_typeof(entry) is distinct from 'object' or (entry - array['tradeId','expected']) <> '{}'::jsonb or not (entry->>'tradeId'=any(ids))
      or jsonb_typeof(entry->'tradeId') is distinct from 'string' or entry->>'tradeId'=any(snapshot_ids) or jsonb_typeof(entry->'expected') is distinct from 'object'
      or ((entry->'expected') - (comparison_fields || array['id','accountId','backtestRunId'])) <> '{}'::jsonb
      or jsonb_typeof(entry->'expected'->'id') is distinct from 'string'
      or jsonb_typeof(entry->'expected'->'accountId') is distinct from 'string'
      or jsonb_typeof(entry->'expected'->'backtestRunId') is distinct from 'string'
      or entry->'expected'->>'id' is distinct from entry->>'tradeId' then raise exception 'Invalid scoped trade snapshot' using errcode='22023'; end if;
    snapshot_ids := array_append(snapshot_ids,entry->>'tradeId');
  end loop;
  if cardinality(snapshot_ids) <> cardinality(ids) then raise exception 'Every selected trade requires a snapshot' using errcode='22023'; end if;
  for patch in select * from jsonb_array_elements(p_trade_patches) loop
    if jsonb_typeof(patch) is distinct from 'object' or (patch-array['tradeId','expected','updates']) <> '{}'::jsonb
      or jsonb_typeof(patch->'tradeId') is distinct from 'string' or not (patch->>'tradeId'=any(ids)) or patch->>'tradeId'=any(patch_ids)
      or jsonb_typeof(patch->'updates') is distinct from 'object' or patch->'updates'='{}'::jsonb
      or ((patch->'updates') - comparison_fields) <> '{}'::jsonb then raise exception 'Invalid tag patch or field outside scope' using errcode='22023'; end if;
    select s->'expected' into expected from jsonb_array_elements(p_scope_snapshots) s where s->>'tradeId'=patch->>'tradeId';
    if patch->'expected' is distinct from expected then raise exception 'Patch expected value differs from scoped snapshot' using errcode='22023'; end if;
    for field,value in select * from jsonb_each(patch->'updates') loop
      if field='autoConfluence' then
        if jsonb_typeof(value) is distinct from 'object' or (value-array['htf','ltf']) <> '{}'::jsonb
          or jsonb_typeof(value->'htf') is distinct from 'array' or jsonb_typeof(value->'ltf') is distinct from 'array' then raise exception 'Invalid tag provenance' using errcode='22023'; end if;
        if not ('htfConfluence'=any(scope_fields)) and value->'htf' is distinct from expected->'autoConfluence'->'htf'
          or not ('ltfConfluence'=any(scope_fields)) and value->'ltf' is distinct from expected->'autoConfluence'->'ltf' then raise exception 'Provenance outside selected scope changed' using errcode='22023'; end if;
        generated := (value->'htf') || (value->'ltf');
      else generated := value;
      end if;
      if jsonb_typeof(generated) is distinct from 'array' then raise exception 'Tags must be arrays' using errcode='22023'; end if;
      if jsonb_array_length(generated)>1000 or exists(select 1 from jsonb_array_elements(generated) v where jsonb_typeof(v)<>'string' or length(v#>>'{}')>20000) then raise exception 'Invalid tag array values' using errcode='22023'; end if;
    end loop;
    patch_ids := array_append(patch_ids,patch->>'tradeId');
  end loop;
  request_hash := encode(sha256(convert_to(jsonb_build_array(p_owner_id,p_expected_library,p_library,p_scope,p_scope_snapshots,p_trade_patches)::text,'UTF8')),'hex');
  empty_library := jsonb_build_object('version',1,'ownerId',owner_id,'revision',0,'tags','[]'::jsonb);
  insert into alphatrade_private.backtest_tag_libraries(user_id,revision,library) values(owner_id,0,empty_library) on conflict(user_id) do nothing;
  select l.library into current_library from alphatrade_private.backtest_tag_libraries l where l.user_id=owner_id for update;
  select o.request_hash into receipt_hash from alphatrade_private.backtest_tag_operations o where o.user_id=owner_id and o.operation_id=p_operation_id;
  if found then
    if receipt_hash <> request_hash then raise exception 'Operation ID reused with different tag request' using errcode='22023'; end if;
    already_applied := true;
  elsif current_library is distinct from p_expected_library then raise exception 'Tag library changed concurrently' using errcode='40001';
  end if;
  -- Lock in canonical ID order. Later failure rolls back all prior tag writes.
  for requested_id in select x from unnest(ids) x order by x loop
    select t.* into actual from public.trades t where t.id=(jsonb_populate_record(null::public.trades,jsonb_build_object('id',requested_id))).id and t.user_id=owner_id for update;
    if not found then raise exception 'Selected owned trade missing' using errcode='P0002'; end if;
    select s->'expected' into expected from jsonb_array_elements(p_scope_snapshots) s where s->>'tradeId'=requested_id;
    if actual.account_id::text is distinct from expected->>'accountId'
      or coalesce(actual.backtest_run_id::text,nullif(actual.data->>'backtestRunId','')) is distinct from expected->>'backtestRunId'
      or coalesce(actual.backtest_run_id::text,nullif(actual.data->>'backtestRunId','')) is null then raise exception 'Selected trade account or backtest run changed' using errcode='40001'; end if;
    if not exists(select 1 from public.accounts a where a.id=actual.account_id and a.user_id=owner_id)
      or not exists(select 1 from public.backtest_runs r where r.id::text=expected->>'backtestRunId' and r.user_id=owner_id and r.account_id=actual.account_id) then
      raise exception 'Selected trade account or run is not owned and linked' using errcode='42501';
    end if;
    if jsonb_typeof(actual.data) is distinct from 'object' then raise exception 'Stored trade JSON is invalid' using errcode='22023'; end if;
    current_values := jsonb_build_object('id',actual.id,'accountId',actual.account_id,'backtestRunId',coalesce(actual.backtest_run_id::text,nullif(actual.data->>'backtestRunId','')));
    for field in select unnest(comparison_fields) loop
      if actual.data ? field then current_values := current_values || jsonb_build_object(field,actual.data->field); end if;
    end loop;
    if not already_applied and current_values is distinct from expected then raise exception 'Scoped trade tags changed concurrently' using errcode='40001'; end if;
    select p into patch from jsonb_array_elements(p_trade_patches) p where p->>'tradeId'=requested_id;
    if patch is not null then
      if not already_applied then
        next_data := actual.data || (patch->'updates');
        update public.trades t set data=next_data where t.id=actual.id and t.user_id=owner_id;
        if not found then raise exception 'Trade update not confirmed' using errcode='42501'; end if;
      else next_data := actual.data;
      end if;
      -- A retry acknowledges fresh truth, never the old requested tag values.
      current_values := '{}'::jsonb;
      for field in select jsonb_object_keys(patch->'updates') loop
        current_values := current_values || jsonb_build_object(field,coalesce(next_data->field,'null'::jsonb));
      end loop;
      result_patches := result_patches || jsonb_build_array(jsonb_build_object('tradeId',requested_id,'updates',current_values));
    end if;
  end loop;
  if not already_applied then
    update alphatrade_private.backtest_tag_libraries l set library=p_library,revision=(p_library->>'revision')::bigint,updated_at=now() where l.user_id=owner_id;
    insert into alphatrade_private.backtest_tag_operations(user_id,operation_id,request_hash,library_revision) values(owner_id,p_operation_id,request_hash,(p_library->>'revision')::bigint);
    current_library := p_library;
  end if;
  return jsonb_build_object('library',current_library,'operationId',p_operation_id,'alreadyApplied',already_applied,'tradePatches',result_patches);
end;
$fn$;
revoke all on function alphatrade_private.backtest_tag_key_v1(text), alphatrade_private.validate_backtest_tag_library_v1(jsonb,uuid) from public, anon;
grant execute on function alphatrade_private.backtest_tag_key_v1(text), alphatrade_private.validate_backtest_tag_library_v1(jsonb,uuid) to authenticated;
revoke all on function public.get_backtest_tag_library_v1(), public.commit_backtest_tag_library_v1(uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb) from public, anon;
grant execute on function public.get_backtest_tag_library_v1(), public.commit_backtest_tag_library_v1(uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb) to authenticated;

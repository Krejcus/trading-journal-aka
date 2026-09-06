-- Prepared only. Back up lab_experiments before activation. No data backfill.
-- Preserve rule history against stale full-document clients. Hashes remain evidence
-- identities verified by the application, not server signatures of human intent.
create or replace function public.guard_backtest_research_rule_history_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  old_case jsonb; new_case jsonb; revisions jsonb; revision jsonb; previous jsonb;
  old_count integer := 0; n integer; i integer; field text; ids text[] := '{}';
begin
  if TG_OP <> 'INSERT' then old_case := old.data->'research'; end if;
  if TG_OP = 'DELETE' then
    if old_case is not null and old_case <> 'null'::jsonb and auth.uid() is not null then
      raise exception 'Výzkumný případ s historií nelze odstranit; ukončete jej.' using errcode='23514';
    end if;
    return old;
  end if;
  new_case := new.data->'research';
  if old_case is not null and old_case <> 'null'::jsonb then
    if new.id is distinct from old.id or new.user_id is distinct from old.user_id then raise exception 'Research identity is immutable' using errcode='23514'; end if;
    foreach field in array array['id','world','createdAt','startTs','clock','baselineTradeIds','accountIds'] loop
      if new.data->field is distinct from old.data->field then raise exception 'Research baseline is immutable: %',field using errcode='23514'; end if;
    end loop;
    if new_case is null or new_case='null'::jsonb then raise exception 'Research history cannot be removed' using errcode='23514'; end if;
    old_count := jsonb_array_length(old_case->'revisions');
  end if;
  if new_case is null or new_case='null'::jsonb then return new; end if;
  if new.data->>'world' is distinct from 'backtest' or new.data->>'id' is distinct from new.id
    or jsonb_typeof(new_case) is distinct from 'object' or new_case->'version' is distinct from '1'::jsonb
    or jsonb_typeof(new_case->'revisions') is distinct from 'array'
    or octet_length(new_case::text)>2097152 then raise exception 'Invalid research case' using errcode='23514'; end if;
  revisions := new_case->'revisions'; n := jsonb_array_length(revisions);
  if n<1 or n>500 or n<old_count or (old_count>0 and n>old_count+1) then raise exception 'Invalid research revision count' using errcode='23514'; end if;
  for i in 0..n-1 loop
    revision := revisions->i;
    if i<old_count and revision is distinct from old_case->'revisions'->i then raise exception 'Existing rule revision cannot change' using errcode='23514'; end if;
    if jsonb_typeof(revision) is distinct from 'object' or jsonb_typeof(revision->'id') is distinct from 'string'
      or length(revision->>'id') not between 1 and 160 or revision->>'id'=any(ids)
      or revision->'version' is distinct from to_jsonb(i+1)
      or coalesce(revision->'parentId','null'::jsonb) is distinct from coalesce(previous->'id','null'::jsonb)
      or jsonb_typeof(revision->'reason') is distinct from 'string' or length(btrim(revision->>'reason')) not between 1 and 1000
      or jsonb_typeof(revision->'hash') is distinct from 'string' or revision->>'hash' !~ '^sha256:[0-9a-f]{64}$'
      or jsonb_typeof(revision->'definition') is distinct from 'object'
      then raise exception 'Invalid rule revision chain' using errcode='23514'; end if;
    if revision->>'source'='legacy-import' then
      if i<>0 or revision->'recordedAt' is distinct from 'null'::jsonb then raise exception 'Invalid legacy provenance' using errcode='23514'; end if;
    else
      if revision->>'source' is distinct from (case when i=0 then 'created' else 'edited' end)
        or jsonb_typeof(revision->'recordedAt') is distinct from 'number' then raise exception 'Invalid revision provenance' using errcode='23514'; end if;
      if (revision->>'recordedAt')::numeric<=0 or (revision->>'recordedAt')::numeric>8640000000000000
        or trunc((revision->>'recordedAt')::numeric)<>(revision->>'recordedAt')::numeric
        or (previous->>'recordedAt' is not null and (revision->>'recordedAt')::numeric<(previous->>'recordedAt')::numeric)
        then raise exception 'Invalid revision time' using errcode='23514'; end if;
    end if;
    foreach field in array array['hypothesis','rule','falsification','timeZone'] loop
      if jsonb_typeof(revision->'definition'->field) is distinct from 'string' or length(btrim(revision->'definition'->>field))=0
        or length(revision->'definition'->>field)>(case when field='rule' then 20000 else 10000 end)
        then raise exception 'Invalid research definition' using errcode='23514'; end if;
    end loop;
    if jsonb_typeof(revision->'definition'->'targetPositions') is distinct from 'number'
      then raise exception 'Missing target position count' using errcode='23514'; end if;
    if (revision->'definition'->>'targetPositions')::numeric not between 5 and 100000
      or trunc((revision->'definition'->>'targetPositions')::numeric)<>(revision->'definition'->>'targetPositions')::numeric
      then raise exception 'Invalid target position count' using errcode='23514'; end if;
    ids:=array_append(ids,revision->>'id'); previous:=revision;
  end loop;
  if new.data->'hypothesis' is distinct from previous->'definition'->'hypothesis'
    or new.data->'rule' is distinct from previous->'definition'->'rule'
    or new.data->'targetTrades' is distinct from previous->'definition'->'targetPositions'
    then raise exception 'Current research rule must match its latest revision' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_backtest_research_rule_history_v1() from public,anon,authenticated;
drop trigger if exists guard_backtest_research_rule_history_v1 on public.lab_experiments;
create trigger guard_backtest_research_rule_history_v1 before insert or update or delete on public.lab_experiments
for each row execute function public.guard_backtest_research_rule_history_v1();
-- Rollback (history data is retained):
-- drop trigger guard_backtest_research_rule_history_v1 on public.lab_experiments;
-- drop function public.guard_backtest_research_rule_history_v1();

-- 25. 10. 2026: same retry storm as 20260917154500 (journal-input-changed),
-- this time from `patch_backtest_trade_review_private_v1`. A stale-field CAS
-- conflict was raised with SQLSTATE 40001 (serialization_failure); the HTTP
-- layer in front of Postgres retries 40001 with the identical stale request,
-- so one review save from two windows looped from 08:55Z for 4 h (~100 failing
-- calls/s, 1.4 M log lines/day, 10 M rollbacks lifetime) and drove the
-- instance above 80 % CPU. A CAS conflict is not transient for the caller, so
-- every remaining 40001 raise in the public schema moves to 55000
-- (object_not_in_prerequisite_state). Messages and behaviour are unchanged;
-- the TypeScript mappings accept both codes.
--
-- The functions are rewritten from their live definitions so this migration
-- changes only the error code, nothing else. In each of them '40001' occurs
-- only as an errcode literal and '55000' did not occur before (checked on
-- production). Rollback = the same block with the two codes swapped.

do $$
declare r record; def text;
begin
  for r in
    select p.oid, p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('patch_backtest_trade_review_private_v1',
                        'commit_backtest_tag_library_v1',
                        'confirm_connection_trade_notes_v1')
      and p.prosrc like '%40001%'
  loop
    def := pg_get_functiondef(r.oid);
    if def like '%55000%' then
      raise exception 'Unexpected 55000 already in %; refusing blind rewrite', r.sig;
    end if;
    execute replace(def, '40001', '55000');
  end loop;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.prosrc like '%40001%') then
    raise exception 'A public function still raises 40001';
  end if;
end $$;

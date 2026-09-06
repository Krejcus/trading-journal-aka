-- READ-ONLY preflight for the prepared B16 migration. No note text is returned.
-- Run only against an explicitly approved target; this file has NOT been run remotely.
begin read only;
select to_regprocedure('public.patch_backtest_trade_review_private_v1(text,uuid,jsonb,jsonb,text)') as private_review_prerequisite,
       to_regprocedure('public.get_dashboard_data()') as dashboard_prerequisite,
       to_regclass('public.trade_private_notes') as already_migrated_private_table,
       to_regclass('public.connection_trade_note_consents') as already_migrated_consent_table;
select count(*) as trade_count,
       count(*) filter (where user_id is null) as missing_owner,
       count(*) filter (where data ?| array['notes','sessionPreNotes','sessionPostNotes','noteHistory']) as top_level_note_rows,
       count(*) filter (where is_public and share_notes) as explicit_public_note_shares
from public.trades;
select status,count(*) as connection_count from public.connections group by status order by status;
select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies
where schemaname='public' and tablename in ('trades','connections','profiles','daily_preps','daily_reviews','accounts','backtest_runs')
order by tablename,policyname;
select n.nspname,p.proname,p.prosecdef,pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('get_public_trade','get_dashboard_data','patch_backtest_trade_review_private_v1');
commit;

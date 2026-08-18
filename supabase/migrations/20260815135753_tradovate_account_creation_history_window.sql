-- Preserve the current durable queue before changing its historical window.
create schema if not exists migration_backups;
revoke all on schema migration_backups from public, anon, authenticated;

create table migration_backups.tradovate_history_syncs_pre_account_origin_20260815
as table public.tradovate_history_syncs;

revoke all on table migration_backups.tradovate_history_syncs_pre_account_origin_20260815
  from public, anon, authenticated;

alter table public.tradovate_history_syncs
  add column account_created_at timestamptz,
  add column history_start_basis text not null default 'rolling_12_months';

alter table public.tradovate_history_syncs
  add constraint tradovate_history_syncs_start_basis_valid
  check (history_start_basis in ('account_created_at', 'rolling_12_months'));

-- Existing scans started in 2010 and have not imported any rows. Replace only
-- those empty queues with a bounded one-year fallback. Once the deployed API
-- reads Account.timestamp it will replace this window with the exact broker
-- creation date and mark the basis as account_created_at.
update public.tradovate_history_syncs
set requested_start = (requested_end::date - interval '1 year')::date,
    pending_ranges = jsonb_build_array(jsonb_build_object(
      'startDate', ((requested_end::date - interval '1 year')::date)::text,
      'endDate', requested_end::text
    )),
    active_range = null,
    lease_expires_at = null,
    status = 'pending',
    rows_seen = 0,
    synced_through = null,
    last_error = null,
    completed_at = null,
    history_start_basis = 'rolling_12_months',
    revision = revision + 1,
    updated_at = now()
where rows_imported = 0;

comment on column public.tradovate_history_syncs.account_created_at is
  'Exact Tradovate Account.timestamp when exposed by the broker.';
comment on column public.tradovate_history_syncs.history_start_basis is
  'Whether backfill starts at the exact broker account timestamp or a rolling 12-month fallback.';

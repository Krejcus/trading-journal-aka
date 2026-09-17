-- 17. 9. 2026: several clients (web, iPhone, localhost) imported the same
-- connection at once. Every committed batch bumped the head generation for
-- the others, whose snapshot reads then failed with `journal-input-changed`
-- and restarted. One importer per (user, connection) at a time: the API
-- claims a short lease, the others answer `processing` and return with the
-- next cycle. A holder that dies simply lets the lease expire.

create table if not exists public.tradovate_journal_import_leases (
  user_id uuid not null,
  connection_id uuid not null,
  holder uuid not null,
  lease_until timestamptz not null,
  primary key (user_id, connection_id)
);
alter table public.tradovate_journal_import_leases enable row level security;
revoke all on table public.tradovate_journal_import_leases from public, anon, authenticated;

create or replace function public.claim_journal_import_lease(p_user_id uuid, p_connection_id uuid, p_holder uuid, p_ttl_ms integer)
returns boolean language plpgsql security invoker set search_path='' as $$
declare acquired boolean;
begin
  if p_user_id is null or p_connection_id is null or p_holder is null
     or p_ttl_ms is null or p_ttl_ms < 1000 or p_ttl_ms > 300000 then
    raise exception 'invalid-journal-lease' using errcode='22023';
  end if;
  insert into public.tradovate_journal_import_leases as l (user_id, connection_id, holder, lease_until)
    values (p_user_id, p_connection_id, p_holder, now() + make_interval(secs => p_ttl_ms / 1000.0))
  on conflict (user_id, connection_id) do update
    set holder = excluded.holder, lease_until = excluded.lease_until
    where l.lease_until <= now() or l.holder = excluded.holder
  returning true into acquired;
  return coalesce(acquired, false);
end; $$;
revoke all on function public.claim_journal_import_lease(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_journal_import_lease(uuid,uuid,uuid,integer) to service_role;

create or replace function public.release_journal_import_lease(p_user_id uuid, p_connection_id uuid, p_holder uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  delete from public.tradovate_journal_import_leases l
    where l.user_id = p_user_id and l.connection_id = p_connection_id and l.holder = p_holder;
end; $$;
revoke all on function public.release_journal_import_lease(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.release_journal_import_lease(uuid,uuid,uuid) to service_role;

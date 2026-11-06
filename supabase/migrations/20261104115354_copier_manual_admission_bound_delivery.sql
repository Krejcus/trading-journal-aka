-- Ruční vstup/správa může při čerstvé nečinné worker delivery přeskočit
-- samostatné claim RPC. Admission i navázání proběhnou v jedné transakci:
-- nejdřív zámek uživatele z v1 admission, potom zámek zařízení používaný
-- claim_v2. Selhání optimalizace nechá řádek pending a stará claim/poll cesta
-- jej doručí beze změny bezpečnostních pravidel.

create function public.admit_tradovate_copier_manual_command_v2(
  p_user_id uuid,
  p_device_id uuid,
  p_connection_id uuid,
  p_operation_id text,
  p_payload jsonb,
  p_now timestamptz,
  p_expires_at timestamptz,
  p_entry_min_interval_ms integer,
  p_manage_min_interval_ms integer,
  p_entry_cap integer,
  p_manage_cap integer,
  p_delivery_id uuid
)
returns table (
  result_code text,
  id uuid,
  status text,
  expires_at timestamptz,
  device_id uuid,
  delivery_id uuid,
  created_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_admission record;
  v_created_at timestamptz;
  v_bound record;
begin
  -- v1 zůstává jediným zdrojem pravidel admission. Její advisory xact lock
  -- zůstává držený až do commitu této vnější RPC transakce.
  select * into v_admission
    from public.admit_tradovate_copier_manual_command(
      p_user_id,
      p_device_id,
      p_connection_id,
      p_operation_id,
      p_payload,
      p_now,
      p_expires_at,
      p_entry_min_interval_ms,
      p_manage_min_interval_ms,
      p_entry_cap,
      p_manage_cap
    );
  if not found then
    raise exception 'copier-admission-v2-empty-response';
  end if;

  if v_admission.id is not null then
    select c.created_at into v_created_at
      from public.tradovate_copier_commands c
     where c.id = v_admission.id;
  end if;

  -- Existující/idempotentní řádek se touto zkratkou nikdy nově neváže.
  -- Jeho původní delivery může být právě vykonávána; fallback claim_v2 umí
  -- bezpečně dohledat jen delivery, kterou worker skutečně drží.
  if v_admission.result_code = 'inserted' and p_delivery_id is not null then
    -- Globální pořadí zámků: uživatel (v1 admission) -> zařízení (claim_v2).
    -- claim_v2 bere pouze zařízení, proto nevzniká opačná hrana deadlocku.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_device_id::text, 917)
    );

    begin
      update public.tradovate_copier_commands c
         set status = 'claimed',
             claimed_at = pg_catalog.clock_timestamp(),
             delivery_id = p_delivery_id
       where c.id = v_admission.id
         and c.user_id = p_user_id
         and c.device_id = p_device_id
         and c.connection_id = p_connection_id
         and c.status = 'pending'
         and c.expires_at > pg_catalog.clock_timestamp()
         and exists (
           select 1
             from public.tradovate_copier_device_runtime r
            where r.device_id = p_device_id
              and r.user_id = p_user_id
              and r.connection_id = p_connection_id
              and r.last_seen_at >= pg_catalog.clock_timestamp() - interval '4 seconds'
              and r.status #>> '{relayIdle,deliveryId}' = p_delivery_id::text
         )
         and not exists (
           select 1
             from public.tradovate_copier_commands occupied
            where occupied.device_id = p_device_id
              and occupied.delivery_id = p_delivery_id
              and occupied.id <> c.id
         )
      returning c.id, c.status, c.expires_at, c.device_id, c.delivery_id, c.created_at
           into v_bound;
    exception
      -- Starší/nečekaný zapisovatel mimo device lock může delivery obsadit.
      -- Optimalizace se v tom případě zahodí; vložený pending řádek zůstává
      -- a běžný claim/poll ho bezpečně doručí.
      when unique_violation then
        v_bound := null;
    end;

    if v_bound.id is not null then
      return query select
        'inserted-claimed'::text,
        v_bound.id,
        v_bound.status,
        v_bound.expires_at,
        v_bound.device_id,
        v_bound.delivery_id,
        v_bound.created_at;
      return;
    end if;
  end if;

  return query select
    v_admission.result_code::text,
    v_admission.id::uuid,
    v_admission.status::text,
    v_admission.expires_at::timestamptz,
    v_admission.device_id::uuid,
    null::uuid,
    v_created_at;
end;
$$;

revoke execute on function public.admit_tradovate_copier_manual_command_v2(
  uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz,
  integer, integer, integer, integer, uuid
) from public, anon, authenticated;
grant execute on function public.admit_tradovate_copier_manual_command_v2(
  uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz,
  integer, integer, integer, integer, uuid
) to service_role;

comment on function public.admit_tradovate_copier_manual_command_v2(
  uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz,
  integer, integer, integer, integer, uuid
) is 'Atomická admission v1 + volitelné navázání nového pending příkazu na čerstvou nečinnou durable delivery; fallback zůstává pending.';

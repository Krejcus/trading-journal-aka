-- Atomická admission ručního vstupu a správy z grafu (1. 11. 2026, INV-RELAY-01).
-- Dřív relay četl existující operaci, busy/rozestup a denní strop jedním SELECTem
-- a teprve pak vkládal: dva souběžné požadavky (PC + telefon, dvě záložky) prošly
-- oba. Teď jedna transakce pod jediným zámkem na uživatele: existující operace →
-- brzda → busy/rozestup → strop → insert. Pořadí kontrol i chybové kódy zůstávají.
-- Aditivní: nic nemaže ani nemění; relay ji volá bez fallbacku (chyba = 5xx).

create function public.admit_tradovate_copier_manual_command(
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
  p_manage_cap integer
)
returns table (result_code text, id uuid, status text, expires_at timestamptz, device_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
set lock_timeout = '2s'
as $$
#variable_conflict use_column
declare
  v_command jsonb := p_payload -> 'command';
  v_type text;
  v_hash text;
  v_action text;
  v_trade jsonb;
  v_found record;
  v_count bigint;
begin
  -- Serializaci nese zámek; jiná izolace by změnila, co vidí čtení po zámku.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'copier-admission-isolation-unsupported';
  end if;
  if p_user_id is null or p_device_id is null or p_operation_id is null or p_payload is null
    or p_now is null or p_expires_at is null
    or p_entry_min_interval_ms is null or p_manage_min_interval_ms is null
    or p_entry_cap is null or p_manage_cap is null then
    raise exception 'copier-admission-invalid-arguments';
  end if;
  if p_entry_cap <= 0 or p_manage_cap <= 0 or p_entry_min_interval_ms <= 0 or p_manage_min_interval_ms <= 0
    or p_expires_at <= p_now or p_expires_at - p_now > interval '15 seconds' then
    raise exception 'copier-admission-invalid-arguments';
  end if;
  -- p_now jsou hodiny Node (stejné jako created_at ostatních řádků); velký rozdíl
  -- proti DB by posunul okna rozestupu a stropu.
  if abs(extract(epoch from (pg_catalog.clock_timestamp() - p_now))) >= 2 then
    raise exception 'copier-admission-clock-skew';
  end if;

  v_type := v_command ->> 'type';
  if v_type is null or v_type not in ('place-leader-entry', 'manage-leader-order') then
    raise exception 'copier-admission-unsupported-command';
  end if;
  v_hash := v_command ->> 'payloadHash';
  if v_hash is null or v_hash = '' then
    raise exception 'copier-admission-invalid-payload';
  end if;
  if (v_command ->> 'operationId') is distinct from p_operation_id then
    raise exception 'copier-admission-invalid-payload';
  end if;
  if v_type = 'manage-leader-order' then
    if pg_catalog.jsonb_typeof(v_command -> 'entryOperationId') = 'string' then
      v_trade := pg_catalog.jsonb_build_object('entryOperationId', v_command ->> 'entryOperationId');
    elsif pg_catalog.jsonb_typeof(v_command -> 'leaderEntryOrderId') = 'string' then
      v_trade := pg_catalog.jsonb_build_object('leaderEntryOrderId', v_command ->> 'leaderEntryOrderId');
    else
      raise exception 'copier-admission-invalid-payload';
    end if;
    v_action := v_command ->> 'action';
  end if;

  if not exists (
    select 1 from public.tradovate_copier_devices d
     where d.id = p_device_id and d.user_id = p_user_id and d.revoked_at is null
  ) then
    raise exception 'copier-admission-device-invalid';
  end if;

  -- Jediný zámek na uživatele (vstupy i správa, všechna zařízení): žádné pořadí
  -- více zámků, tedy žádný deadlock. Uvolní se commitem RPC transakce.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('copier-manual-admission:' || p_user_id::text, 0)
  );

  -- 1) Tatáž operace per uživatel (i přes jiné zařízení): shodný otisk = původní
  --    řádek, jiný = konflikt. Nikdy druhý řádek.
  select c.id, c.status, c.expires_at, c.device_id, c.payload -> 'command' ->> 'payloadHash' as hash
    into v_found
    from public.tradovate_copier_commands c
   where c.user_id = p_user_id
     and c.command_type = 'copy-command'
     and c.idempotency_key = p_operation_id
   limit 1;
  if found then
    if v_found.hash is not distinct from v_hash then
      return query select 'existing'::text, v_found.id, v_found.status, v_found.expires_at, v_found.device_id;
    else
      return query select 'entry-conflict'::text, null::uuid, null::text, null::timestamptz, null::uuid;
    end if;
    return;
  end if;

  -- 2) Brzda těsně před admission (INV-RELAY-03): její supersede update už
  --    tenhle řádek nemusí vidět. Zrušení čekajícího vstupu snižuje riziko a projde.
  if v_action is distinct from 'cancel-entry' and exists (
    select 1 from public.tradovate_copier_commands c
     where c.user_id = p_user_id
       and c.command_type in ('disarm', 'kill-switch', 'lock-until-session-end')
       and c.created_at >= p_now - interval '500 milliseconds'
  ) then
    return query select 'superseded-by-brake'::text, null::uuid, null::text, null::timestamptz, null::uuid;
    return;
  end if;

  -- 3) Busy + rozestup. Visící `claimed` starší než 2 min neblokuje navždy.
  if v_type = 'place-leader-entry' then
    if exists (
      select 1 from public.tradovate_copier_commands c
       where c.user_id = p_user_id
         and c.command_type = 'copy-command'
         and c.payload @> '{"command":{"type":"place-leader-entry"}}'::jsonb
         and c.created_at >= p_now - interval '2 minutes'
         and (c.created_at > p_now - p_entry_min_interval_ms * interval '1 millisecond'
           or c.status = 'claimed'
           or (c.status = 'pending' and c.expires_at > p_now))
    ) then
      return query select 'entry-busy'::text, null::uuid, null::text, null::timestamptz, null::uuid;
      return;
    end if;
  else
    if exists (
      select 1 from public.tradovate_copier_commands c
       where c.user_id = p_user_id
         and c.command_type = 'copy-command'
         and c.payload @> pg_catalog.jsonb_build_object('command',
           pg_catalog.jsonb_build_object('type', 'manage-leader-order') || v_trade)
         and c.created_at >= p_now - interval '2 minutes'
         and (c.created_at > p_now - p_manage_min_interval_ms * interval '1 millisecond'
           or c.status = 'claimed'
           or (c.status = 'pending' and c.expires_at > p_now))
    ) then
      return query select 'entry-busy'::text, null::uuid, null::text, null::timestamptz, null::uuid;
      return;
    end if;
  end if;

  -- 4) Denní strop (24 h na uživatele). Zavření obchodu snižuje riziko: COUNT vůbec neběží.
  if v_type = 'place-leader-entry' then
    select pg_catalog.count(*) into v_count
      from public.tradovate_copier_commands c
     where c.user_id = p_user_id
       and c.command_type = 'copy-command'
       and c.payload @> '{"command":{"type":"place-leader-entry"}}'::jsonb
       and c.created_at >= p_now - interval '24 hours';
    if v_count >= p_entry_cap then
      return query select 'entry-daily-cap'::text, null::uuid, null::text, null::timestamptz, null::uuid;
      return;
    end if;
  elsif v_action is distinct from 'close-position' then
    select pg_catalog.count(*) into v_count
      from public.tradovate_copier_commands c
     where c.user_id = p_user_id
       and c.command_type = 'copy-command'
       and c.payload @> '{"command":{"type":"manage-leader-order"}}'::jsonb
       and c.created_at >= p_now - interval '24 hours';
    if v_count >= p_manage_cap then
      return query select 'entry-daily-cap'::text, null::uuid, null::text, null::timestamptz, null::uuid;
      return;
    end if;
  end if;

  -- 5) Insert. Konflikt tu znamená zapisovatele mimo zámek (starý relay během
  --    rolloutu): vítěz zůstává, otisk rozhodne mezi existing a konfliktem.
  insert into public.tradovate_copier_commands as c (
    user_id, device_id, connection_id, command_type, payload, idempotency_key, status, created_at, expires_at
  ) values (
    p_user_id, p_device_id, p_connection_id, 'copy-command', p_payload, p_operation_id, 'pending', p_now, p_expires_at
  )
  on conflict (user_id, device_id, idempotency_key) do nothing
  returning c.id, c.status, c.expires_at, c.device_id into v_found;
  if found then
    return query select 'inserted'::text, v_found.id, v_found.status, v_found.expires_at, v_found.device_id;
    return;
  end if;
  select c.id, c.status, c.expires_at, c.device_id, c.payload -> 'command' ->> 'payloadHash' as hash
    into v_found
    from public.tradovate_copier_commands c
   where c.user_id = p_user_id and c.device_id = p_device_id and c.idempotency_key = p_operation_id;
  if v_found.hash is not distinct from v_hash then
    return query select 'existing'::text, v_found.id, v_found.status, v_found.expires_at, v_found.device_id;
  else
    return query select 'entry-conflict'::text, null::uuid, null::text, null::timestamptz, null::uuid;
  end if;
end;
$$;

revoke execute on function public.admit_tradovate_copier_manual_command(
  uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.admit_tradovate_copier_manual_command(
  uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz, integer, integer, integer, integer
) to service_role;

comment on function public.admit_tradovate_copier_manual_command(
  uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz, integer, integer, integer, integer
) is 'Atomická admission ručního vstupu/správy z grafu: existing → brzda → busy → strop → insert pod zámkem uživatele.';

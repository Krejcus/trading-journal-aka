-- Before production: export and compare the existing function definition and grants.
-- Same user lock, scope, deadlines and privileges; add remove-leg and add-leg take profit to brake supersession.
-- Adding a stop loss stays: it only lowers risk.
create or replace function public.enqueue_tradovate_copier_brake(
  p_user_id uuid,
  p_device_id uuid,
  p_connection_id uuid,
  p_command_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_now timestamptz,
  p_expires_at timestamptz
)
returns table (
  result_code text, id uuid, status text, expires_at timestamptz, device_id uuid,
  superseded_arms integer, superseded_manual integer
)
language plpgsql
volatile
security invoker
set search_path = ''
set lock_timeout = '500ms'
as $$
#variable_conflict use_column
declare
  v_row record;
  v_code text := 'inserted';
  v_arms integer;
  v_manual integer;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'copier-brake-isolation-unsupported';
  end if;
  -- Hodiny se tu záměrně neověřují: brzda nesmí selhat kvůli posunu hodin.
  if p_user_id is null or p_device_id is null or p_connection_id is null or p_payload is null
    or p_idempotency_key is null or p_now is null or p_expires_at is null
    or p_command_type is null or p_command_type not in ('disarm', 'kill-switch', 'lock-until-session-end')
    or p_expires_at <= p_now or p_expires_at - p_now > interval '10 minutes' then
    raise exception 'copier-brake-invalid-arguments';
  end if;
  -- Stejná trojice jako admission: připojení patří uživateli a zařízení je
  -- spárované právě s ním. Kontrola na devices nestačí — connection_id je od
  -- 20261004120000 nullable s FK ON DELETE SET NULL, vlastnictví negarantuje.
  if not exists (
    select 1 from public.tradovate_oauth_connections o
     where o.id = p_connection_id and o.user_id = p_user_id
  ) then
    raise exception 'copier-brake-connection-invalid';
  end if;
  if not exists (
    select 1 from public.tradovate_copier_devices d
     where d.id = p_device_id and d.user_id = p_user_id and d.revoked_at is null
       and d.connection_id = p_connection_id
  ) then
    raise exception 'copier-brake-device-invalid';
  end if;

  -- Stejný zámek jako admission: rozběhnutá admission (ms) doběhne dřív a její
  -- řádek tu zneplatníme; pozdější admission uvidí už commitnutou brzdu.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('copier-manual-admission:' || p_user_id::text, 0)
  );

  insert into public.tradovate_copier_commands as c (
    user_id, device_id, connection_id, command_type, payload, idempotency_key, status, created_at, expires_at
  ) values (
    p_user_id, p_device_id, p_connection_id, p_command_type, p_payload, p_idempotency_key, 'pending', p_now, p_expires_at
  )
  on conflict (user_id, device_id, idempotency_key) do nothing
  returning c.id, c.status, c.expires_at, c.created_at, c.command_type into v_row;
  if not found then
    -- Opakovaný POST téže brzdy: původní řádek. Supersede se zopakuje (idempotentní).
    v_code := 'existing';
    select c.id, c.status, c.expires_at, c.created_at, c.command_type into v_row
      from public.tradovate_copier_commands c
     where c.user_id = p_user_id and c.device_id = p_device_id and c.idempotency_key = p_idempotency_key;
    if not found then
      -- Konfliktní řádek mezi insertem a selectem zmizel (jen ruční zásah;
      -- kód řádky nemaže). Není to konflikt typů: relay jde zálohou a brzdu vloží.
      raise exception 'copier-brake-row-vanished';
    end if;
    if v_row.command_type is distinct from p_command_type then
      raise exception 'copier-brake-idempotency-conflict';
    end if;
  end if;

  -- ARM/SHADOW stejného zařízení (jako dosud; brake epoch je per zařízení).
  update public.tradovate_copier_commands c
     set status = 'expired', completed_at = v_row.created_at, error = 'superseded-by-brake'
   where c.device_id = p_device_id
     and c.status = 'pending'
     and c.command_type in ('arm-live', 'shadow')
     and c.created_at <= v_row.created_at;
  get diagnostics v_arms = row_count;
  -- Ruční vstup a posun/zavření celého uživatele; zrušení vstupu snižuje riziko a zůstává.
  -- Řádek, který claim_v2 právě drží, počká na jeho commit a už `pending` není.
  update public.tradovate_copier_commands c
     set status = 'expired', completed_at = v_row.created_at, error = 'superseded-by-brake'
   where c.user_id = p_user_id
     and c.status = 'pending'
     and c.command_type = 'copy-command'
     and c.created_at <= v_row.created_at
     and (c.payload @> '{"command":{"type":"place-leader-entry"}}'::jsonb
       or (c.payload @> '{"command":{"type":"manage-leader-order"}}'::jsonb
         and ((c.payload -> 'command' ->> 'action') in ('move-stop', 'move-target', 'move-limit', 'close-position', 'remove-leg')
            or ((c.payload -> 'command' ->> 'action') = 'add-leg' and (c.payload -> 'command' ->> 'leg') = 'takeProfit'))));
  get diagnostics v_manual = row_count;

  return query select v_code, v_row.id, v_row.status, v_row.expires_at, p_device_id, v_arms, v_manual;
end;
$$;

revoke execute on function public.enqueue_tradovate_copier_brake(
  uuid, uuid, uuid, text, jsonb, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.enqueue_tradovate_copier_brake(
  uuid, uuid, uuid, text, jsonb, text, timestamptz, timestamptz
) to service_role;

comment on function public.enqueue_tradovate_copier_brake(
  uuid, uuid, uuid, text, jsonb, text, timestamptz, timestamptz
) is 'Brzda: insert/dohledání + supersede ARM/SHADOW a ručních příkazů jedním commitem pod zámkem admission.';

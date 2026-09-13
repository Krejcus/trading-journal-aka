-- Additive v2 transport. Legacy claimed/unknown commands are deliberately untouched.
alter table public.tradovate_copier_commands add column delivery_id uuid;
create unique index tradovate_copier_commands_delivery_idx
  on public.tradovate_copier_commands (device_id, delivery_id) where delivery_id is not null;
alter table public.tradovate_copier_device_runtime
  add column relay_revision bigint not null default 0;

-- A delivery ID is persisted on the worker BEFORE this call. Lost responses
-- recover the same row; they never put an unknown command back in pending.
create function public.claim_tradovate_copier_command_v2(target_device_id uuid, target_delivery_id uuid)
returns setof public.tradovate_copier_commands
language plpgsql security invoker set search_path = '' as $$
begin
  if target_delivery_id is null then raise exception 'invalid-delivery-id'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_device_id::text, 917));
  return query select * from public.tradovate_copier_commands
    where device_id = target_device_id and delivery_id = target_delivery_id;
  if found then return; end if;
  update public.tradovate_copier_commands
    set status = 'expired', completed_at = now(), error = 'command-expired'
    where device_id = target_device_id and status = 'pending' and expires_at <= now();
  return query with candidate as (
    select id from public.tradovate_copier_commands
      where device_id = target_device_id and status = 'pending' and expires_at > now()
      order by created_at, id for update skip locked limit 1
  ) update public.tradovate_copier_commands command
    set status = 'claimed', claimed_at = now(), delivery_id = target_delivery_id
    from candidate where command.id = candidate.id returning command.*;
end;
$$;

-- A slow background heartbeat must not overwrite the newer command ACK.
create function public.heartbeat_tradovate_copier_v2(
  target_device_id uuid, snapshot jsonb, revision bigint
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare owner_id uuid; connection uuid; worker_start timestamptz;
begin
  if revision <= 0 or revision is null or jsonb_typeof(snapshot) <> 'object'
    or snapshot->>'startedAt' is null then raise exception 'invalid-relay-heartbeat'; end if;
  worker_start := (snapshot->>'startedAt')::timestamptz;
  select user_id, connection_id into owner_id, connection from public.tradovate_copier_devices
    where id = target_device_id and revoked_at is null and environment = 'demo';
  if not found then raise exception 'invalid-copier-device-auth'; end if;
  insert into public.tradovate_copier_device_runtime as runtime
    (device_id, user_id, connection_id, status, last_seen_at, started_at, relay_revision)
    values (target_device_id, owner_id, connection, snapshot || '{"nonce":""}'::jsonb, now(), worker_start, revision)
    on conflict (device_id) do update set status = excluded.status, last_seen_at = excluded.last_seen_at,
      started_at = excluded.started_at, relay_revision = excluded.relay_revision
    where runtime.started_at < excluded.started_at
      or (runtime.started_at = excluded.started_at and runtime.relay_revision < excluded.relay_revision);
  return found;
end;
$$;

-- Completion and its authoritative status commit together, before notifications.
-- Retrying an identical ACK succeeds without changing completed_at or status.
create function public.complete_tradovate_copier_command_v2(
  target_device_id uuid, target_delivery_id uuid, target_command_id uuid,
  command_result jsonb, command_error text, snapshot jsonb, revision bigint
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare cmd public.tradovate_copier_commands; terminal text;
begin
  select * into cmd from public.tradovate_copier_commands
    where id = target_command_id and device_id = target_device_id and delivery_id = target_delivery_id for update;
  if not found then return false; end if;
  terminal := case when command_error is null then 'succeeded' else 'rejected' end;
  if cmd.status in ('succeeded', 'rejected') then
    return cmd.status = terminal and cmd.result is not distinct from command_result
      and cmd.error is not distinct from command_error;
  end if;
  if cmd.status <> 'claimed' then return false; end if;
  perform public.heartbeat_tradovate_copier_v2(target_device_id, snapshot, revision);
  -- The upsert locks this runtime row even when the older snapshot is ignored.
  -- A superseded worker cannot publish an authoritative success for a new boot.
  if exists (select 1 from public.tradovate_copier_device_runtime
    where device_id = target_device_id and started_at > (snapshot->>'startedAt')::timestamptz)
    then return false; end if;
  update public.tradovate_copier_commands set status = terminal, result = command_result,
    error = command_error, completed_at = now() where id = cmd.id;
  return true;
end;
$$;
revoke all on function public.claim_tradovate_copier_command_v2(uuid, uuid) from public, anon, authenticated;
revoke all on function public.heartbeat_tradovate_copier_v2(uuid, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.complete_tradovate_copier_command_v2(uuid, uuid, uuid, jsonb, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.claim_tradovate_copier_command_v2(uuid, uuid) to service_role;
grant execute on function public.heartbeat_tradovate_copier_v2(uuid, jsonb, bigint) to service_role;
grant execute on function public.complete_tradovate_copier_command_v2(uuid, uuid, uuid, jsonb, text, jsonb, bigint) to service_role;
